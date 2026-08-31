# RSS Reader - a personal RSS reader on Cloudflare

A minimal, ad-free, keyboard-driven RSS/Atom reader. Runs entirely on
Cloudflare's free tier:

- **Cloudflare Pages** — serves the static frontend and the `/api/*` routes
  (as Pages Functions).
- **Cloudflare Worker** — polls your feeds on a schedule (Cron Trigger) and
  writes new items to the database. Pages Functions can't run on a schedule,
  so this small standalone worker handles that part.
- **D1** — SQLite database shared by both, storing folders, feeds, and items.
- **Cloudflare Access** — puts a Google/GitHub login in front of the whole
  thing, so it's private to you without any auth code in the app itself.

Shortcuts once it's running: `j`/`k` to move between articles, `m` to
toggle read, `s` to star, `v` to open the original link, `r` to check
feeds now, `/` to search.

## 1. Prerequisites

- A Cloudflare account (free tier is enough)
- Node.js installed locally
- `npm install -g wrangler` (or use `npx wrangler`)
- `wrangler login`

## 2. Create the D1 database

```
wrangler d1 create rss-reader
```

Copy the `database_id` it prints into `worker/wrangler.toml`
(`REPLACE_WITH_YOUR_D1_DATABASE_ID`).

Apply the schema. This has to run from `worker/`, where `wrangler.toml`
lives, even though `schema.sql` is at the repo root — hence the `../`:

```
cd worker
wrangler d1 execute rss-reader --remote --file=../schema.sql
```

The schema is written with `CREATE ... IF NOT EXISTS` throughout, so
re-running it later is safe and is how you add a new table or index. It
does not migrate existing tables — adding a column to `items` means a
separate `ALTER TABLE`.

## 3. Deploy the poller worker

```
cd worker
npm install
wrangler deploy
```

This creates `rss-reader-poller.<your-subdomain>.workers.dev` and schedules
it to run every 30 minutes (edit the cron expression in `wrangler.toml` to
change that — e.g. `*/15 * * * *` for every 15 minutes).

Optional but recommended — lock down the manual refresh endpoint:

```
wrangler secret put REFRESH_SECRET
```

Pick any random string; you'll paste it into the app's Settings later.

## 4. Deploy the Pages project

Either connect this repo through the Cloudflare dashboard (Workers & Pages
→ Create → Pages → connect to Git), or deploy directly:

```
cd pages
npx wrangler pages deploy public --project-name=reader
```

For the Git integration, the build settings for this monorepo are:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | *(empty)* |
| Build output directory | `public` |
| Root directory | `pages` |

Functions are auto-detected relative to that root directory. Note that only
the Pages side auto-deploys on push — the poller worker is not connected to
git, so changes to `worker/` always need a manual `wrangler deploy`.

Then, in the Pages project settings in the dashboard:

**Settings → Functions → D1 database bindings** — add a binding named `DB`
pointing at the `rss-reader` database you created in step 2. This is what
lets `/api/*` read and write your data.

Two things worth knowing here, because both fail quietly:

- The name must be exactly `DB`. `wrangler d1 create` suggests `rss_reader`
  by default, and anything other than `DB` leaves `env.DB` undefined, so
  API calls return vague 400s and 500s rather than a clear error.
- A binding added in the dashboard only applies to *future* deployments. The
  currently-live one keeps running without it, so trigger a redeploy
  afterwards (Deployments → retry latest, or push an empty commit).

## 5. Put Cloudflare Access in front of it

If you've attached a **custom domain**, use the normal flow: **Zero Trust →
Access → Applications → Add an application → Self-hosted**, and pick the
domain from the dropdown.

On a bare `*.pages.dev` domain that flow doesn't work — pages.dev isn't a
zone you own, so it never appears in the dropdown. Instead:

1. Pages project → **Settings → Restrict previews**. This generates a scoped
   Access application covering `*.<project>.pages.dev`.
2. Open that application in Zero Trust and remove the `*` from the Subdomain
   field, so it covers the production URL as well as previews.

Either way, configure the policy as:

- Policy: "Allow" for your email specifically (or "Emails ending in
  @yourdomain.com"), authenticated via Google, GitHub, or a one-time PIN —
  whichever login method you enable under **Settings → Authentication**
- Session duration: whatever you're comfortable re-authenticating at

This protects both the frontend and the `/api/*` functions, since they're
served from the same domain. No login code needed in the app itself.

## 6. Open it and add feeds

Visit your Pages domain, log in via Access, and either:

- Paste feed URLs one at a time into the sidebar, or
- Click **Import OPML** and upload an export from your old reader (Google
  Reader exports, Feedly, Inoreader, and NetNewsWire all produce OPML that
  this understands, including one level of folder nesting)

New items show up after the worker's next scheduled run. To fetch
immediately, click **⚙ Settings** and paste in:

- **Poller worker refresh URL**: `https://rss-reader-poller.<your-subdomain>.workers.dev/refresh`
- **Refresh secret**: the value you set in step 3, if any

The `/refresh` path is required and easy to leave off. The worker answers
every other path with a friendly 200, so a URL without it looks like it
worked while never actually polling anything.

Then the **↻ Refresh** button (or pressing `r`) triggers an immediate check.
The button shows a spinner and reports what happened — how many feeds were
checked, how many items are new, and how many failed.

## Notes

- The database is entirely yours — nothing is sent anywhere except direct
  requests to the feeds you subscribe to and to Cloudflare's own
  infrastructure.
- Article HTML from feeds is sanitized before it reaches the reading pane:
  script/style/iframe/object/embed/base/meta/form elements are removed,
  inline event handlers are stripped, and URL attributes are checked against
  a scheme allowlist so `javascript:` and `data:text/html` links cannot run.
  Inline raster images are kept (`data:image/svg+xml` is not, since SVG can
  carry its own script). Links open in a new tab with
  `rel="noopener noreferrer"`.
- Behind that, `pages/public/_headers` sets a Content-Security-Policy with
  `script-src 'self'` as the backstop, so anything the sanitizer misses
  still cannot execute. That file is commented directive by directive. If
  you move the poller worker to a custom domain, add it to `connect-src` or
  the Refresh button will start failing with a CSP error in the console.
- To change the poll frequency, edit the `crons` line in
  `worker/wrangler.toml` and redeploy the worker.
- Feeds are polled one at a time, each with a 10s timeout, so one slow or
  hung site cannot hold up the rest of the run. A feed that fails is
  recorded rather than retried immediately: its row keeps a `last_error`,
  the sidebar marks it, and the reason shows in its tooltip. The next
  successful poll clears it.
- Costs: D1, Pages, Workers, and Access are all free at personal-use volume.
  You'd only hit a paywall well beyond what one person reading feeds would
  generate.

## Troubleshooting

**Everything in the app fails at once, with vague 400s or 500s.** Almost
always the D1 binding: either it isn't named exactly `DB`, or it was added
in the dashboard without redeploying afterwards. See step 4.

**A single feed shows no items and never gets a title.** Hover it in the
sidebar — the tooltip holds the reason the last poll failed. `Unrecognized
feed format` means the URL isn't RSS/Atom/RDF (often an HTML page rather
than the feed itself); `HTTP 404`/`HTTP 403` mean the publisher moved or
blocks the fetch; `Timed out after 10s` means the site was too slow.

**The Refresh button says the URL reached the worker but not `/refresh`.**
The refresh URL in Settings is missing the `/refresh` path.

**Refresh is rejected.** The secret in Settings doesn't match the worker's
`REFRESH_SECRET`. Re-set it with `wrangler secret put REFRESH_SECRET` and
paste the same value into Settings.

**Refresh fails outright.** The worker URL is wrong, the worker isn't
deployed, or its response is missing CORS headers — the app and the worker
are different origins, so every worker response needs them.

**Checking what's actually in the database:**

```
cd worker
wrangler d1 execute rss-reader --remote --command "SELECT id, title, last_error, last_fetched FROM feeds"
```

## Development notes

There is no build step, no bundler and no frontend dependencies — that's
deliberate. There's also no local dev server wired up for the Pages side, so
browser behaviour is still verified by deploying and watching the Network and
Console tabs.

### Running the tests

Both suites use Node's built-in test runner, so there is nothing to install
beyond the worker's existing dependencies:

```
cd worker && npm test     # feed parser + date handling
cd pages  && npm test     # URL sanitizing rules
```

They also run automatically on every push and pull request via
`.github/workflows/test.yml`. Note that this reports failures but does **not**
block a deploy — Cloudflare's Git integration builds independently of GitHub
Actions, so a red run means "that went out broken, go look".

### What is tested, and what isn't

The suites cover pure logic: parsing feed XML, normalising dates, and deciding
which URL schemes are safe to keep. That is where the silent, expensive bugs
have actually been — a feed that fails to parse doesn't crash anything, it
just never appears, which is how one feed went weeks without syncing.

Deliberately not covered, because no unit test can reach them: whether the
Content-Security-Policy breaks page styling (needs a real browser), whether
your Settings values are correct (that's configuration, not code), and query
performance (use `EXPLAIN QUERY PLAN` against D1 instead).

### Adding a test for a feed that misbehaves

This is the most useful thing you can do when a feed breaks. Save the raw
feed as a fixture and assert what it should produce:

```
curl -sL 'https://example.com/feed.xml' -o worker/test/fixtures/rss-example.xml
```

Then add it to the `FEEDS` table at the top of `worker/test/parse.test.js`.
Real captured XML is worth far more than hand-written examples — real feeds
are stranger than anything you would think to invent. Run the test before
fixing the bug and confirm it fails; a test that has never failed is not yet
known to test anything.
