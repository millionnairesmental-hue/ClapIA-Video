import express from "express";
import path from "path";
import dotenv from "dotenv";
import { fal } from "@fal-ai/client";
import Redis from "ioredis";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const model = process.env.VIDEO_MODEL || "fal-ai/veo3.1";
const isProduction = process.env.NODE_ENV === "production";

// JWT secret: mandatory in production, dev fallback otherwise.
if (isProduction && !process.env.JWT_SECRET) {
  console.error("JWT_SECRET is required in production. Set it in the environment and restart.");
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

if (!process.env.FAL_KEY) {
  console.warn("FAL_KEY is not set. Add it to .env before generating.");
}
if (!process.env.ASHNA_API_KEY) {
  console.warn("ASHNA_API_KEY is not set. POST /api/enhance will return 503 until it is configured.");
}
if (!isProduction && !process.env.JWT_SECRET) {
  console.warn("JWT_SECRET is not set. Using a default development secret. Set JWT_SECRET in production.");
}

fal.config({ credentials: process.env.FAL_KEY });

// AshnaAI API (OpenAI-compatible Chat Completions)
const ASHNA_API_URL = process.env.ASHNA_API_URL || "https://api.ashna.ai/v1/api";
const ASHNA_MODEL = process.env.ASHNA_MODEL || "gpt-4o-mini";

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// Redis if available (recommended). Fallback to in-memory Maps for demo/dev.
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
  redis.on("error", (e) => console.error("Redis error", e));
} else {
  console.warn("REDIS_URL not set — using in-memory store (ephemeral).");
}

const inMemoryUsers = new Map(); // email -> { email, passwordHash }
const inMemoryCredits = new Map(); // key -> number

const STARTING_CREDITS = Number(process.env.STARTING_CREDITS) || 20;
const COST_PER_VIDEO = Number(process.env.COST_PER_VIDEO) || 5;

// Server-side input validation
const ASPECT_RATIOS = ["9:16", "16:9", "1:1"];
const DURATIONS = [5, 8, 10];

// Simple per-key rate limiting (in-memory, per instance).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 5;
const rateBuckets = new Map(); // key -> array of recent timestamps

function rateLimitAllows(key) {
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_REQUESTS) {
    rateBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
  return true;
}

function anonKeyFromReq(req) {
  const xfwd = req.headers["x-forwarded-for"];
  if (xfwd) return `anon:${xfwd.split(",")[0].trim()}`;
  return `anon:${req.ip || "unknown"}`;
}

async function getUser(email) {
  if (!email) return null;
  if (redis) {
    const raw = await redis.get(`user:${email}`);
    return raw ? JSON.parse(raw) : null;
  }
  return inMemoryUsers.get(email) || null;
}

async function setUser(email, user) {
  if (redis) {
    await redis.set(`user:${email}`, JSON.stringify(user));
    return;
  }
  inMemoryUsers.set(email, user);
}

// Credits: null means "not initialized yet". A balance of 0 is valid
// and must NOT be reset to STARTING_CREDITS.
async function getCredits(key) {
  if (redis) {
    const v = await redis.get(`credits:${key}`);
    return v === null ? null : Number(v);
  }
  return inMemoryCredits.has(key) ? inMemoryCredits.get(key) : null;
}

async function setCredits(key, value) {
  if (redis) {
    await redis.set(`credits:${key}`, String(value));
    return;
  }
  inMemoryCredits.set(key, value);
}

// Initialize starting credits only if the key does not exist yet.
async function ensureCredits(key) {
  const current = await getCredits(key);
  if (current === null) {
    await setCredits(key, STARTING_CREDITS);
    return STARTING_CREDITS;
  }
  return current;
}

async function refundCredits(key, amount) {
  if (redis) {
    await redis.incrby(`credits:${key}`, amount);
    return;
  }
  const next = (inMemoryCredits.get(key) ?? 0) + amount;
  inMemoryCredits.set(key, next);
}

// Atomic debit: checks balance and decrements in a single Redis operation,
// so concurrent requests cannot overdraw the balance.
const DEBIT_SCRIPT = `
local bal = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
if bal < cost then return -1 end
return redis.call('DECRBY', KEYS[1], cost)
`;

async function debitCredits(key, amount) {
  if (redis) {
    const result = await redis.eval(DEBIT_SCRIPT, 1, `credits:${key}`, amount);
    if (Number(result) === -1) {
      return { ok: false, balance: await getCredits(key) };
    }
    return { ok: true, balance: Number(result) };
  }
  const cur = inMemoryCredits.get(key) ?? 0;
  if (cur < amount) return { ok: false, balance: cur };
  const next = cur - amount;
  inMemoryCredits.set(key, next);
  return { ok: true, balance: next };
}

// Auth helpers
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Public root - serve index
app.get("/", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

// Register
app.post("/api/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "Email et mot de passe requis (6+ caractères)." });
  }
  const existing = await getUser(email);
  if (existing) return res.status(409).json({ error: "Utilisateur déjà existant." });
  const passwordHash = await bcrypt.hash(password, 10);
  await setUser(email, { email, passwordHash });
  await setCredits(`user:${email}`, STARTING_CREDITS);
  const token = signToken({ email });
  res.json({ ok: true, token, credits: STARTING_CREDITS });
});

// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis." });
  const user = await getUser(email);
  if (!user) return res.status(401).json({ error: "Utilisateur non trouvé." });
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: "Mot de passe incorrect." });
  const token = signToken({ email });
  const credits = await ensureCredits(`user:${email}`);
  res.json({ ok: true, token, credits });
});

// Optional auth middleware
async function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return next();
  const parts = auth.split(" ");
  if (parts.length !== 2) return next();
  const payload = verifyToken(parts[1]);
  if (!payload) return next();
  req.user = payload;
  return next();
}

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Authorization required." });
  const parts = auth.split(" ");
  if (parts.length !== 2) return res.status(401).json({ error: "Bad authorization header." });
  const payload = verifyToken(parts[1]);
  if (!payload) return res.status(401).json({ error: "Invalid token." });
  req.user = payload;
  next();
}

// Get credits (authenticated or anonymous)
app.get("/api/credits", optionalAuth, async (req, res) => {
  try {
    let key;
    if (req.user && req.user.email) {
      key = `user:${req.user.email}`;
    } else {
      key = anonKeyFromReq(req);
    }
    const credits = await ensureCredits(key);
    return res.json({ credits });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur lors de la lecture des crédits." });
  }
});

// AshnaAI — turn a rough idea into a rich cinematic video prompt.
async function enhanceWithAshna(idea, style) {
  const res = await fetch(`${ASHNA_API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ASHNA_API_KEY}`,
    },
    body: JSON.stringify({
      model: ASHNA_MODEL,
      messages: [
        {
          role: "system",
          content:
            "Tu es un directeur artistique expert en prompts pour génération vidéo IA. " +
            "Transforme l'idée de l'utilisateur en un prompt cinématographique riche, en anglais : " +
            "scène détaillée, sujet cohérent, mouvement de caméra, éclairage, atmosphère. " +
            "Réponds UNIQUEMENT avec le prompt final, sans guillemets, sans préambule, sans explication. " +
            "Maximum 120 mots.",
        },
        { role: "user", content: `Idée : ${idea}\nStyle souhaité : ${style || "Cinématique réaliste"}` },
      ],
      temperature: 0.7,
      max_tokens: 400,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AshnaAI responded ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("AshnaAI returned no content");
  return text;
}

// Enhance a user idea with AshnaAI (free, rate limited, no credits charged).
app.post("/api/enhance", optionalAuth, async (req, res) => {
  try {
    const { prompt, style } = req.body || {};
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
      return res.status(400).json({ error: "Idée trop courte." });
    }
    if (!process.env.ASHNA_API_KEY) {
      return res.status(503).json({ error: "Amélioration IA non configurée (ASHNA_API_KEY manquante)." });
    }
    const key = req.user && req.user.email ? `user:${req.user.email}` : anonKeyFromReq(req);
    if (!rateLimitAllows(`enhance:${key}`)) {
      return res.status(429).json({ error: "Trop de demandes rapprochées. Réessaie dans une minute." });
    }
    const enhanced = await enhanceWithAshna(prompt.trim().slice(0, 2000), typeof style === "string" ? style : undefined);
    res.json({ ok: true, prompt: enhanced, model: ASHNA_MODEL });
  } catch (e) {
    console.error("enhance error", e);
    res.status(502).json({ error: "Erreur du service d'amélioration IA." });
  }
});

// Generate endpoint: authenticated users are billed by email,
// anonymous ones by IP. Debit is atomic and refunded on provider failure.
app.post("/api/generate", optionalAuth, async (req, res) => {
  try {
    const { prompt, aspect_ratio = "9:16", duration = "5" } = req.body || {};
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
      return res.status(400).json({ error: "Prompt trop court." });
    }
    if (!ASPECT_RATIOS.includes(aspect_ratio)) {
      return res.status(400).json({ error: "Format non supporté." });
    }
    const durationNum = Number(duration);
    if (!DURATIONS.includes(durationNum)) {
      return res.status(400).json({ error: "Durée non supportée." });
    }

    // Determine billing key
    let billingKey;
    if (req.user && req.user.email) {
      billingKey = `user:${req.user.email}`;
    } else {
      billingKey = anonKeyFromReq(req);
    }
    await ensureCredits(billingKey);

    if (!rateLimitAllows(billingKey)) {
      return res.status(429).json({ error: "Trop de générations rapprochées. Réessaie dans une minute." });
    }

    // Atomic debit — refuse if balance is insufficient
    const debit = await debitCredits(billingKey, COST_PER_VIDEO);
    if (!debit.ok) {
      return res.status(402).json({ error: "Crédits insuffisants.", credits: debit.balance });
    }

    const safePrompt = prompt.trim().slice(0, 4000);
    let result;
    try {
      result = await fal.subscribe(model, {
        input: {
          prompt: safePrompt,
          aspect_ratio,
          duration: durationNum,
        },
        logs: false,
      });
    } catch (callErr) {
      console.error("fal.subscribe error", callErr);
      await refundCredits(billingKey, COST_PER_VIDEO);
      return res.status(502).json({ error: "Erreur du fournisseur de vidéo.", credits: await getCredits(billingKey) });
    }

    const videoUrl = result?.data?.video?.url;
    if (!videoUrl) {
      await refundCredits(billingKey, COST_PER_VIDEO);
      return res.status(502).json({ error: "Le fournisseur n'a pas retourné de vidéo.", credits: await getCredits(billingKey) });
    }

    res.json({ ok: true, videoUrl, model, status: "completed", credits: await getCredits(billingKey) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error?.message || "Erreur pendant la génération." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "ClapIA Video", model, enhanceModel: process.env.ASHNA_API_KEY ? ASHNA_MODEL : null });
});

app.listen(port, () => {
  console.log(`ClapIA Video running on port ${port}`);
});
