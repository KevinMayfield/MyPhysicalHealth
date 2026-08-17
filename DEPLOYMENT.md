# Deploying MyPhysicalHealth

This app is a Node/Express server — it needs Puppeteer (headless Chrome, for
the PDF export) and native image processing (`sharp`), so it can't be hosted
on GitHub Pages (static files only). Instead, GitHub Actions builds and
deploys the app to [Fly.io](https://fly.io) on every push to `main`.

Files involved:

- `Dockerfile` / `.dockerignore` — container image (Node 22 + Chromium's
  shared libraries; Puppeteer downloads its own Chromium binary at build
  time).
- `fly.toml` — Fly app config.
- `.github/workflows/deploy.yml` — CI/CD: runs `flyctl deploy` on push to
  `main`.

This has been tested locally end-to-end (`docker build --platform=linux/amd64`
+ generate a report + export its PDF) — build for `linux/amd64` explicitly if
testing on an Apple Silicon Mac, since Chrome-for-Testing (what Puppeteer
downloads) only ships x86_64 Linux builds, and Fly/Render hosts are amd64
anyway.

## One-time setup

1. **Install flyctl and sign up/log in:**
   ```
   brew install flyctl
   fly auth login
   ```

2. **Pick a unique app name** and put it in `fly.toml` (`app = "..."`) — Fly
   app names are global, so `myphysicalhealth` will likely already be taken.

3. **Create the app on Fly** (doesn't deploy yet):
   ```
   fly apps create <your-app-name>
   ```

4. **Set the Strava secrets** (never commit these — `.env` is gitignored and
   is only used for local dev):
   ```
   fly secrets set STRAVA_CLIENT_ID=xxxxx STRAVA_CLIENT_SECRET=yyyyy
   ```

5. **Update your Strava API app's callback domain.** In the
   [Strava API settings](https://www.strava.com/settings/api), set
   "Authorization Callback Domain" to `<your-app-name>.fly.dev` (domain only,
   no `https://`). The app already sends `trust proxy` correctly so the OAuth
   redirect URI resolves to `https://` in production.

6. **Deploy once manually** to confirm everything works before wiring CI:
   ```
   fly deploy
   fly open
   ```
   Try uploading a GPX from `GPXExamples/` and downloading its PDF.

## Wiring up GitHub Actions

1. **Create a deploy token:**
   ```
   fly tokens create deploy -x 999999h
   ```

2. **Add it as a GitHub repo secret:** repo → Settings → Secrets and
   variables → Actions → New repository secret → name it `FLY_API_TOKEN`,
   paste the token value.

3. **Push to `main`.** The `deploy.yml` workflow builds the Dockerfile and
   runs `flyctl deploy` automatically. Check progress under the repo's
   Actions tab.

## Known limitations

- **Strava sessions don't survive a redeploy.** `.strava-sessions.json` is
  written to the container's local disk, which is replaced on every deploy.
  Users just need to reconnect their Strava account after a deploy — not
  fatal, but worth knowing. Fixing this properly means adding a Fly volume
  *and* making the session file path configurable via an env var (it's
  currently hardcoded relative to the app directory) — a small follow-up
  change, not a deployment-config one.
- **Generated reports are in-memory only** (`reports` Map in `server.js`,
  1 hour TTL) and are lost on restart — this is expected/by design, not a
  side effect of the deploy setup.
- **Image is ~1.7GB** (Chromium + its dependencies dominate this) — normal
  for a Puppeteer-based app, but worth knowing if you're watching Fly's
  bandwidth/storage.
- **Memory**: `fly.toml` requests 1GB — Chromium during PDF export is the
  most memory-hungry moment in the app. Drop to 512MB only if you've
  confirmed PDF export still works reliably.

## Alternative: Render

The same `Dockerfile` works on [Render](https://render.com) — create a new
Web Service, point it at this repo, choose "Docker" as the environment, and
set the `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` env vars in the
dashboard. Render's free tier has ephemeral disk only (no persistent volume),
so the Strava-session caveat above applies there too, and the service spins
down on idle (cold starts).
