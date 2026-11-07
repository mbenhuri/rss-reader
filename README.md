# RSS Reader - a personal RSS reader on Cloudflare

> **Status: wound down as of 2026-11-06 — not currently deployed.**
> The poller worker and the Pages project have been deleted; the D1 database
> and its 9,885 items were kept. See [section 7](#7-wind-down-current-state-and-how-to-bring-it-back)
> for what was removed and how to bring it back.

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
feeds now, `/` to search. Pressing `j` on the last article loads the next
page, so you can read straight through without reaching for the mouse.

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

## 7. Wind-down (current state), and how to bring it back

**This project is currently wound down.** It was taken offline on
2026-11-06. Sections 1–6 above describe a live deployment and are still the
instructions to follow — they just don't describe anything that is running
right now.

### What was removed

| Resource | Name | State |
| --- | --- | --- |
| Poller worker + Cron Trigger | `rss-reader-poller` | **Deleted.** Nothing is polling. |
| Pages project | `rss-reader` (was `rss-reader-1pk.pages.dev`) | **Deleted.** The URL no longer resolves. |
| `REFRESH_SECRET` | — | Gone with the worker; secrets live on the worker, not in the repo. |

The commands used were `wrangler delete --name rss-reader-poller` and
`wrangler pages project delete rss-reader`.

### What is still there

The **D1 database `rss-reader` was deliberately kept**, with
`database_id = 9b91e1cb-53fd-4035-84ce-97b69b9c0097` — the same id already
in `worker/wrangler.toml`, so that file needs no edit to redeploy. At
wind-down it held **6 feeds and 9,885 items** (~25 MB), including read and
starred state.

It is kept because an idle D1 database costs nothing on the free tier and it
is the only copy of the article history and read-state. Nothing can reach it
now that both deployments are gone — it is reachable only via `wrangler`
from a logged-in machine.

A snapshot of just the subscriptions is committed as
[`subscriptions.opml`](subscriptions.opml), exported from D1 at wind-down in
the same format `/api/opml` produces. That is the belt-and-braces copy: it
survives even if the database is later deleted, and it restores the feed
list in one import. It does **not** contain articles or read-state.

Verify the database is still intact at any time with:

```bash
cd worker && wrangler d1 execute rss-reader --remote \
  --command "SELECT (SELECT COUNT(*) FROM feeds) AS feeds, (SELECT COUNT(*) FROM items) AS items"
```

### Deleting the database too, if you decide to

This is **irreversible** and discards the article history and read-state.
Make sure `subscriptions.opml` is current first (it is, as of wind-down), as
it will be the only remaining record of what you subscribed to:

```bash
cd worker && wrangler d1 delete rss-reader
```

### Bringing it back

With the database still in place, redeploying is sections 2–6 **minus
section 2** — skip creating the database and applying `schema.sql`, since
both already exist. Your 9,885 items and read-state come back with it.

1. **Recreate the Pages project** (section 4). Framework preset `None`,
   build command empty, build output directory `public`, root directory
   `pages`. Reconnect the Git integration to re-enable push-to-deploy.
2. **Add the D1 binding before the first deployment.** The variable name
   must be exactly `DB`, pointing at the `rss-reader` database. Dashboard-added
   bindings only apply to *future* deployments, so adding it after the first
   push means an empty `env.DB` and vague 400/500s from `/api/*` until you
   redeploy.
3. **Redeploy the poller worker**: `cd worker && wrangler deploy`. The cron
   schedule and the `DB` binding are already in `worker/wrangler.toml`.
4. **Re-set the refresh secret**: `wrangler secret put REFRESH_SECRET`, then
   paste the same value into the app's ⚙ Settings along with the worker's new
   `https://rss-reader-poller.<subdomain>.workers.dev/refresh` URL. The
   `/refresh` path is required — the worker answers every other path with a
   200, so a URL missing it looks like it worked while polling nothing.
5. **Put Cloudflare Access back in front of it** (section 5). The new Pages
   project will get a *different* random `*.pages.dev` subdomain, so the old
   Access application — which was scoped to `*.rss-reader.pages.dev` — won't
   match and should be deleted and recreated.

If you recreated the database as well, do section 2 first, paste the new
`database_id` into `worker/wrangler.toml`, and import
`subscriptions.opml` with the sidebar's **Import OPML** button. Articles are
not restored that way — the poller refills them from each feed's current
contents on its next run, and read-state starts clean.

### Loose ends from the wind-down

Neither of these is a `wrangler` operation, and both are harmless if left:

- The **Cloudflare Access application** scoped to `*.rss-reader.pages.dev`
  is now orphaned in Zero Trust and can be deleted there.
- The **Pages deploy key** that the Git integration added to the GitHub repo
  is still on the repo's side (Settings → Deploy keys).

## Themes

**⚙ Settings → Theme** switches the look. Three ship with the app:

- **Paper** — the default: warm off-white, serif headlines.
- **Terminal** — phosphor green on near-black, one monospace face
  throughout, uppercase chrome and a blinking block cursor on the status
  line.
- **Midnight** — a plain dark theme that keeps Paper's typography.

A theme is nothing but a map of token names to values — the twelve colours,
three font stacks and one radius that the entire stylesheet is drawn from.
That makes new ones cheap to produce, in three ways:

**In the app.** *Edit / duplicate…* opens a designer with a colour picker
and a text field for every token, grouped by role. It repaints live as you
change values, so you can judge a colour against real articles rather than
against a swatch. *New theme* starts from whatever is currently applied.
Editing a built-in and keeping its name overrides that built-in; renaming it
saves a separate theme, so duplicating never destroys the original.

**By file.** *Export JSON* writes the theme out; *Import…* reads one back.
The format is small enough to hand-write or generate:

```json
{
  "id": "amber-crt",
  "name": "Amber CRT",
  "dark": true,
  "fontImport": "https://fonts.googleapis.com/css2?family=VT323&display=swap",
  "tokens": {
    "paper": "#140F02",
    "ink": "#FFB000",
    "accent": "#FFCC55",
    "font-ui": "'VT323', monospace"
  }
}
```

Any token you leave out falls back to Paper's, so a theme can be four lines
long. `fontImport` may name one Google Fonts stylesheet — that is the only
external host the Content-Security-Policy allows, and a URL anywhere else is
rejected with a message rather than failing silently in the console.

**In the source.** `pages/public/themes.js` holds the built-ins as plain
objects; adding a fourth is a matter of writing one and appending it to
`BUILTIN`. Adding a whole new *token* means adding it to the `TOKENS` list
there and using it in `style.css` — the designer builds its fields from that
list, so the new token becomes editable with no UI work.

Imported themes are validated before anything is applied. Token values go
into an inline style declaration, so the validator is an allowlist on value
shape — hex or `rgb()`/`hsl()` for colours, ordinary font families for type
— which is what stops a theme file from smuggling in a `url()` that phones
home, or a `}` that escapes its declaration and rewrites the rest of the
page. Invalid tokens are dropped and reported; the rest of the theme still
applies. Themes live in `localStorage`, per browser, alongside the refresh
settings.

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
- The article list loads 80 items at a time. A **Load older items** button
  appears at the bottom of the list once there are more, and `j` past the
  last row pulls the next page automatically. Folder headers show the total
  unread count of the feeds inside them, which is mainly useful when the
  folder is collapsed.
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
cd pages  && npm test     # URL sanitizing rules + theme validation
```

They also run automatically on every push and pull request via
`.github/workflows/test.yml`. Note that this reports failures but does **not**
block a deploy — Cloudflare's Git integration builds independently of GitHub
Actions, so a red run means "that went out broken, go look".

### What is tested, and what isn't

The suites cover pure logic: parsing feed XML, normalising dates, deciding
which URL schemes are safe to keep, and deciding which theme token values are
safe to write into a stylesheet. That is where the silent, expensive bugs
have actually been — a feed that fails to parse doesn't crash anything, it
just never appears, which is how one feed went weeks without syncing.

Deliberately not covered, because no unit test can reach them: whether the
Content-Security-Policy breaks page styling (needs a real browser), whether a
theme is actually *readable* (that is a judgement, not an assertion — the
designer's live preview is the tool for it), whether
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
