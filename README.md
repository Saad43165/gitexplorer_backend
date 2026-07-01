# GitExplorer Backend Proxy

Holds your GitHub PAT and Groq API key server-side so the app never embeds secrets. Every app user shares this one server's quota — that's the tradeoff for "universal, no per-user setup."

## Local test

```bash
cd gitexplorer-backend
npm install
cp .env.example .env
# edit .env with your real GITHUB_PAT and GROQ_API_KEY
npm start
```

Visit `http://localhost:3000/health` — should return `{"status":"ok"}`.

## Deploy for free — Render.com (recommended, ~5 minutes)

1. Push this `gitexplorer-backend` folder to its own GitHub repo (separate from the Flutter app repo).
2. Go to render.com → New → Web Service → connect that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Under Environment, add `GITHUB_PAT` and `GROQ_API_KEY` with your real values.
5. Deploy. Render gives you a URL like `https://gitexplorer-backend.onrender.com`.
6. Put that URL into the Flutter app's `lib/core/constants/api_constants.dart` as `backendBaseUrl`.

**Free tier note:** Render's free tier sleeps after 15 minutes of inactivity and takes ~30-60 seconds to wake up on the next request. Fine for personal/demo use; for a paying client's production app, upgrade to a paid tier (~$7/mo) or use Railway.app (similar free tier, similar tradeoff) so users don't hit that cold-start delay.

## Deploy for free — Railway.app (alternative)

1. `railway login` → `railway init` inside this folder.
2. `railway variables set GITHUB_PAT=... GROQ_API_KEY=...`
3. `railway up`
4. Railway gives you a public URL — same next step as above.

## Rate limiting

The server limits each caller to 60 requests/minute (see `express-rate-limit` in `server.js`) to protect your shared GitHub/Groq quota from any single abusive user. Adjust `max` in `src/server.js` if needed.

## Important: this replaces per-user Settings API keys

Once this is deployed and wired into the app, remove (or keep as an optional "advanced/self-hosted" override) the GitHub PAT / Groq key fields in the app's Settings screen — regular users won't need them anymore.
# gitexplorer_backend
