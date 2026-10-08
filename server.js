import express from "express";
import { fal } from "@fal-ai/client";

const app = express();
const port = process.env.PORT || 3000;
const model = process.env.VIDEO_MODEL || "fal-ai/veo3.1";

if (!process.env.FAL_KEY) {
  console.warn("FAL_KEY is not set. Add it to .env before generating.");
}

fal.config({ credentials: process.env.FAL_KEY });

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, aspect_ratio = "9:16", duration = "5" } = req.body || {};
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
      return res.status(400).json({ error: "Prompt trop court." });
    }

    const safePrompt = prompt.trim().slice(0, 4000);
    const result = await fal.subscribe(model, {
      input: {
        prompt: safePrompt,
        aspect_ratio,
        duration: Number(duration)
      },
      logs: false
    });

    const videoUrl = result?.data?.video?.url;
    if (!videoUrl) {
      return res.status(502).json({ error: "Le fournisseur n'a pas retourné de vidéo." });
    }

    res.json({
      ok: true,
      videoUrl,
      model,
      status: "completed"
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error?.message || "Erreur pendant la génération."
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "ClapIA Video", model });
});

app.listen(port, () => {
  console.log(`ClapIA Video running on port ${port}`);
});
