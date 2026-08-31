# Reader — personal RSS reader

A minimal, ad-free, keyboard-driven RSS/Atom reader. No frameworks, no
build step for the frontend. Runs entirely on Cloudflare's free tier.

## Architecture

Two separately-deployed pieces sharing one D1 database:

- **`pages/`** — Cloudflare Pages project. Static frontend (`pages/public/`,
  vanilla JS/HTML/CSS, no bundler) plus Pages Functions (`pages/functions/`)
  that serve `/api/*`. Deployed via the Git integration (push to `main` →
  auto-deploys). Inside `public/`: `app.js` is the whole UI, `sanitize.js`
  holds the URL-scheme rules and **must load before it**, `themes.js` holds
  the theme registry and loads from `<head>` (before first paint), and
  `_headers` carries the Content-Security-Policy. Tests live in `pages/test/` — outside
  the build output directory, so they are not deployed.
- **`worker/`** — standalone Cloudflare Worker with a Cron Trigger. Polls
  every subscribed feed on a schedule, parses RSS/Atom/RDF, writes new
  items to D1. Also exposes `POST /refresh` for the app's manual "check
  now" button. Deployed manually with `wrangler deploy` — **not** connected
  to git, changes here don't auto-deploy.
- **D1 (`rss-reader`)** — shared SQLite database. Schema in `schema.sql`
  at repo root.
- **Tests** — `worker/test/` and `pages/test/`, using node's built-in runner
  (no test framework installed). `.github/workflows/test.yml` runs both on
  every push and PR.

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

# Tests — no framework, nothing to install beyond the worker's deps
cd worker && npm test    # feed parser, date normalising
cd pages  && npm test    # URL-scheme rules, theme validation

# Inspect the live database
cd worker && wrangler d1 execute rss-reader --remote \
  --command "SELECT id, title, last_error, last_fetched FROM feeds"
```

There is still no local dev server for the Pages side (no `wrangler pages
dev` config committed), so browser behaviour — CSP effects, layout, whether
a control actually reads as responsive — is verified by deploying and
watching the Network/Console tabs.

The tests cover pure logic only: parsing feed XML, normalising dates,
deciding which URL schemes are safe, and validating theme token values. That is deliberate. Configuration
errors, CSP effects and query performance are not reachable from a unit
test, and roughly a third of the bugs found in this codebase were of that
kind — see the README's "What is tested, and what isn't".

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
- **Themes are token maps, and the CSS must stay token-only.** Every colour,
  font and radius in `style.css` reads a custom property declared in
  `:root`; `themes.js` applies a theme by writing those same properties
  inline on `<html>`. A hardcoded colour anywhere in a rule is a bug — it
  will look fine in Paper and wrong in every dark theme. The one sanctioned
  exception is the small `[data-theme="…"]` block near the bottom of
  `style.css`, for things a token cannot express (Terminal's uppercase
  chrome and blinking cursor). Rules there are invisible to the in-app
  designer, which only edits tokens.
- **Theme values end up in an inline style declaration**, and themes come
  from imported JSON and localStorage — both untrusted. `validateTheme()`
  in `themes.js` is an **allowlist on value shape** (hex/rgb/hsl for
  colours, quoted-or-bare families for fonts), not a blocklist on bad
  characters, because a CSS value can both fetch (`url(...)`) and escape
  its own declaration (`}`). `pages/test/themes.test.js` asserts that
  directly; loosening those patterns turns a theme file into a CSS
  injection.
- **`themes.js` loads from `<head>`, not with the other scripts.** It
  applies the stored theme as it parses. Moving it to the bottom of
  `<body>` still works, but every load of a dark theme flashes Paper first.
- **`sanitize.js` must stay loaded before `app.js`** in `index.html`.
  `app.js` destructures `globalThis.FeedUrls` at the top of its IIFE, so
  the wrong order throws immediately and the entire app fails to start —
  not just the sanitizer.
- **Adding an outbound request from the frontend means updating the CSP.**
  `pages/public/_headers` pins `connect-src` to `'self'` plus
  `https://*.workers.dev`. A new origin (a custom domain for the poller,
  say) fails as a console CSP error rather than an obvious network error.
- **The worker answers unknown paths with a 200**, not a 404. A refresh URL
  missing its `/refresh` path therefore looks like it succeeded while never
  polling anything. `app.js` now checks the response content-type to catch
  this, but the underlying behaviour is still there.
- **CI does not gate deploys.** Cloudflare's Git integration builds
  independently of GitHub Actions, so a red test run means "that already
  went out broken", not "that was blocked". Making it a real gate would
  mean turning the Git integration off and deploying from the workflow.

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
- Keep the parsing half of the poller pure. `parseFeed(xml)` takes a string
  and returns a plain object; `fetchAndParseFeed(url)` does the network. New
  parsing logic belongs in the former so it stays testable without a network.
- Test fixtures are **real captured feed XML** (`worker/test/fixtures/`),
  not hand-written examples — real feeds are stranger than anything you
  would invent. When a feed misbehaves, save it with `curl` and add it to
  the `FEEDS` table in `parse.test.js`.
- Write the assertion before the fix and watch it fail. Both of the poller
  bugs these suites cover were confirmed by reverting the fix and seeing the
  tests go red; a test that has never failed is not yet known to test
  anything.