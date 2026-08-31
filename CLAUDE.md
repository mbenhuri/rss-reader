# Reader — personal RSS reader

A minimal, ad-free, keyboard-driven RSS/Atom reader. No frameworks, no
build step for the frontend. Runs entirely on Cloudflare's free tier.

## Architecture

Two separately-deployed pieces sharing one D1 database:

- **`pages/`** — Cloudflare Pages project. Static frontend (`pages/public/`,
  vanilla JS/HTML/CSS, no bundler) plus Pages Functions (`pages/functions/`)
  that serve `/api/*`. Deployed via the Git integration (push to `main` →
  auto-deploys).
- **`worker/`** — standalone Cloudflare Worker with a Cron Trigger. Polls
  every subscribed feed on a schedule, parses RSS/Atom/RDF, writes new
  items to D1. Also exposes `POST /refresh` for the app's manual "check
  now" button. Deployed manually with `wrangler deploy` — **not** connected
  to git, changes here don't auto-deploy.
- **D1 (`rss-reader`)** — shared SQLite database. Schema in `schema.sql`
  at repo root.

Both `pages/functions/*` and `worker/src/index.js` reference the database
through a binding literally named `DB`. This must match exactly in both
`worker/wrangler.toml` and the Pages project's Bindings settings — a
mismatched or missing name (e.g. `rss_reader`, which `wrangler d1 create`
suggests by default) fails silently: `env.DB` is `undefined` and API calls
return vague 400/500s rather than a clear error.

## Commands

```bash
# Poller worker — deploy after any change to worker/src/index.js
cd worker && wrangler deploy

# Apply schema changes to the live database
cd worker && wrangler d1 execute rss-reader --remote --file=../schema.sql

# Set/update the manual-refresh secret
cd worker && wrangler secret put REFRESH_SECRET

# Pages frontend/API — just push; Cloudflare's Git integration builds it
git push origin main
```

There is no local dev server wired up for the Pages side (no `wrangler
pages dev` config committed) and no test suite. Changes are verified by
deploying and checking the live app plus the browser Network/Console tabs.

## Known gotchas (learned the hard way — don't reintroduce these)

- **Dashboard-added bindings only apply to future deployments.** Adding
  the D1 binding to the Pages project via the dashboard does *not* affect
  the currently-live deployment. After adding/changing a binding, trigger
  a redeploy (Deployments tab → retry latest, or an empty commit).
- **The worker and the Pages app are different origins**, so any fetch
  from `pages/public/app.js` to the worker (the manual refresh call) is
  cross-origin. The worker's `fetch()` handler must return CORS headers
  (`Access-Control-Allow-Origin`, etc.) and handle `OPTIONS` preflight —
  easy to forget when adding new worker endpoints.
- **`wrangler d1 execute` needs to run from `worker/`**, where
  `wrangler.toml` lives — not from the repo root, even though `schema.sql`
  is at the root (`--file=../schema.sql`).
- **Cloudflare Access on a bare `*.pages.dev` domain** doesn't go through
  the normal "add application → pick domain" flow (pages.dev isn't a zone
  you own, so it won't appear in that dropdown). Instead: Pages project →
  Settings → "Restrict previews" generates a scoped Access app for
  `*.<project>.pages.dev`; edit that app in Zero Trust and remove the `*`
  wildcard from the Subdomain field to extend coverage to the production
  URL too.
- **This repo lives under `~/github-mbenhuri/`, a dual-GitHub-account
  machine.** Never push to a plain `git@github.com:...` remote — it will
  silently pick up the wrong account's SSH key. Remotes here must resolve
  through the `github.com-mbenhuri` SSH host alias (handled automatically
  via the `insteadOf` rewrite in `~/.gitconfig-mbenhuri`, loaded by
  `includeIf "gitdir:~/github-mbenhuri/"` in `~/.gitconfig`).
- **Pages build settings for this monorepo:** Framework preset `None`,
  Build command empty, Build output directory `public`, Root directory
  `pages`. Functions are auto-detected relative to that root directory.

## Conventions

- Frontend is plain JS/HTML/CSS on purpose — no framework, no bundler, no
  `node_modules` to deploy. Keep it that way unless there's a real reason
  to add tooling.
- Each Pages Functions route is its own file under `pages/functions/api/`
  (`onRequestGet`/`onRequestPost`/etc. exports), matching Cloudflare's
  file-based routing rather than one large router.
- Secrets (`REFRESH_SECRET`) are never committed — set via
  `wrangler secret put` and pasted into the app's Settings modal (stored
  in the browser's `localStorage`, not in the repo).