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

Apply the schema:

```
wrangler d1 execute rss-reader --remote --file=./schema.sql
```

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

From the `pages/` folder, either connect this repo through the Cloudflare
dashboard (Workers & Pages → Create → Pages → connect to Git, build output
directory = `pages/public`), or deploy directly:

```
cd pages
npx wrangler pages deploy public --project-name=reader
```

Then, in the Pages project settings in the dashboard:

**Settings → Functions → D1 database bindings** — add a binding named `DB`
pointing at the `rss-reader` database you created in step 2. This is what
lets `/api/*` read and write your data.

## 5. Put Cloudflare Access in front of it

In the Cloudflare dashboard: **Zero Trust → Access → Applications → Add an
application → Self-hosted**.

- Domain: your Pages project's domain (e.g. `reader.pages.dev` or a custom
  domain if you've attached one)
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

Then the **↻ Refresh** button (or pressing `r`) triggers an immediate check.

## Notes

- The database is entirely yours — nothing is sent anywhere except direct
  requests to the feeds you subscribe to and to Cloudflare's own
  infrastructure.
- Article HTML from feeds is inserted into the reading pane with scripts,
  iframes, and inline event handlers stripped, but feed content isn't
  otherwise sandboxed — a reasonable tradeoff for feeds you've chosen to
  subscribe to.
- To change the poll frequency, edit the `crons` line in
  `worker/wrangler.toml` and redeploy the worker.
- Costs: D1, Pages, Workers, and Access are all free at personal-use volume.
  You'd only hit a paywall well beyond what one person reading feeds would
  generate.
