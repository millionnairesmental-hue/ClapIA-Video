# ClapIA Video

MVP mobile-first pour générer une vidéo IA depuis un prompt.

## Architecture
- `public/` : interface mobile
- `server.js` : serveur Express + appel fal.ai
- La clé `FAL_KEY` reste côté serveur et n'est jamais exposée au navigateur.

## Lancer
1. Installer Node.js 20+
2. Copier `.env.example` vers `.env`
3. Mettre ta clé fal.ai dans `FAL_KEY`
4. `npm install`
5. `npm start`
6. Ouvrir `http://localhost:3000`

## Modèle par défaut
`fal-ai/veo3.1`

Le modèle peut être changé avec `VIDEO_MODEL`.

## Important
Les coûts de génération sont facturés par le fournisseur. Vérifie les tarifs actuels avant de vendre des crédits.
