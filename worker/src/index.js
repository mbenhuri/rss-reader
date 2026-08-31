// Personal RSS Reader — feed poller
// Runs on a Cron Trigger, fetches every subscribed feed, parses RSS/Atom,
// and inserts new items into D1. Also exposes POST /refresh for a manual
// "check now" button in the frontend.
//
// Shape of this file, top to bottom:
//   1. XML helpers        — flatten fast-xml-parser output into plain strings
//   2. normalize*         — map one RSS/RDF/Atom entry onto our `items` columns
//   3. fetchAndParseFeed  — fetch a URL, sniff which of the 3 formats it is
//   4. pollFeeds          — the actual job: loop every feed, upsert its items
//   5. export default     — the two entry points (cron `scheduled`, HTTP `fetch`)
//
// Deploy with `cd worker && wrangler deploy`. This worker is NOT wired to the
// git integration, so pushing to main does not update it.

import { XMLParser } from 'fast-xml-parser';

// One parser instance reused for every feed — it is stateless, so hoisting it
// out of the request path avoids rebuilding it on each poll.
//   ignoreAttributes:false + attributeNamePrefix — we need attributes because
//   Atom puts the article URL in <link href="...">, exposed here as `@_href`.
//   textNodeName '#text' — when an element has BOTH attributes and text, the
//   text lands under this key instead of the value being a bare string. That
//   is why `text()` below has to handle the object case.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

// Coerce whatever the parser produced for an element into a plain string.
// The same element can come back as a string, a number (fast-xml-parser
// auto-parses numeric-looking text), or an object like {'@_type':'html',
// '#text':'...'} — this flattens all three.
function text(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && '#text' in val) return String(val['#text']);
  return String(val);
}

// Atom feeds carry several <link> elements (alternate = the article page,
// self = the feed itself, replies/enclosure = other things). We want the
// alternate; a missing rel attribute also means alternate per the spec.
// `linkField` is a single object when there is one link, an array when many.
function atomLink(linkField) {
  if (!linkField) return '';
  const links = Array.isArray(linkField) ? linkField : [linkField];
  const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate');
  return (alt || links[0])?.['@_href'] || '';
}

// RSS 2.0 <item> and RSS 1.0/RDF <item> → our internal item shape.
// Field notes:
//   guid  — may be <guid isPermaLink="false">, i.e. an object. Fall back to
//           the link, then the title, because guid is what dedupes items via
//           the UNIQUE(feed_id, guid) constraint; an item with no guid at all
//           would be re-inserted on every poll.
//   author— WordPress and most RSS use the dc: namespace rather than <author>.
//   content — <content:encoded> is the full post; <description> is usually an
//           excerpt. Prefer the full one, fall back to the excerpt.
function normalizeRssItem(raw) {
  const guid = typeof raw.guid === 'object' ? raw.guid['#text'] : raw.guid;
  return {
    guid: guid || raw.link || text(raw.title),
    title: text(raw.title),
    link: typeof raw.link === 'object' ? raw.link['#text'] : raw.link || '',
    author: text(raw['dc:creator'] || raw.author),
    published: raw.pubDate || raw['dc:date'] || null,
    content: raw['content:encoded'] || text(raw.description) || '',
    summary: text(raw.description) || '',
  };
}

// Atom <entry> → the same internal item shape as normalizeRssItem, so
// pollFeeds below can treat all three formats identically.
function normalizeAtomEntry(raw) {
  return {
    guid: raw.id || atomLink(raw.link),
    title: text(raw.title),
    link: atomLink(raw.link),
    author: text(raw.author?.name) || text(raw.author),
    published: raw.published || raw.updated || null,
    content: text(raw.content) || text(raw.summary) || '',
    summary: text(raw.summary) || '',
  };
}

// Feed dates are wildly inconsistent: valid RFC-822/ISO strings, empty
// strings, "0000-00-00", localized month names, or plain junk. `new Date(x)`
// yields an Invalid Date for those and .toISOString() then THROWS, which
// previously aborted the rest of that feed's items. Fall back to "now" so one
// bad item can't take the whole feed down with it.
function toIsoDate(value) {
  if (value != null && value !== '') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

// How long to wait on any single feed before giving up, in ms. Feeds are
// polled serially, so without a bound one hung server would eat the entire
// cron invocation and starve every feed queued behind it.
const FEED_TIMEOUT_MS = 10000;

// Fetch one feed URL and return {title, siteUrl, items[]}.
// Throws on HTTP errors, a timeout, or an unrecognized document — the caller
// records the message in feeds.last_error so the sidebar shows a warning on
// that feed.
async function fetchAndParseFeed(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PersonalRSSReader/1.0 (+self-hosted)' },
    // cacheTtl 0 — bypass Cloudflare's edge cache. Without it a poll can be
    // served a stale copy and we would miss items published minutes ago.
    cf: { cacheTtl: 0 },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const data = parser.parse(xml);

  // Format sniffing: the three feed dialects have distinct root elements.
  // `[].concat(x || [])` normalizes "one item" (object) and "many items"
  // (array) into an array — a feed with exactly one entry parses as an object.

  // RSS 2.0: <rss><channel><item>...
  if (data.rss?.channel) {
    const channel = data.rss.channel;
    const items = [].concat(channel.item || []);
    return {
      title: text(channel.title),
      siteUrl: typeof channel.link === 'object' ? channel.link['#text'] : channel.link,
      items: items.map(normalizeRssItem),
    };
  }

  // RSS 1.0 / RDF: <rdf:RDF><channel/><item/>... — note the items are
  // siblings of <channel>, not nested inside it, unlike RSS 2.0.
  if (data['rdf:RDF']) {
    const root = data['rdf:RDF'];
    const items = [].concat(root.item || []);
    return {
      title: text(root.channel?.title),
      siteUrl: typeof root.channel?.link === 'object' ? root.channel.link['#text'] : root.channel?.link,
      items: items.map(normalizeRssItem),
    };
  }

  // Atom: <feed><entry>...
  if (data.feed) {
    const feed = data.feed;
    const entries = [].concat(feed.entry || []);
    return {
      title: text(feed.title),
      siteUrl: atomLink(feed.link),
      items: entries.map(normalizeAtomEntry),
    };
  }

  throw new Error('Unrecognized feed format');
}

// The core job. Walks every subscribed feed serially, updates the feed row,
// and inserts any items we have not seen before. Returns a summary the
// frontend shows in the status line after a manual refresh.
//
// Serial (not Promise.all) on purpose: Workers cap the number of concurrent
// subrequests, and one slow feed failing should not abort the others.
async function pollFeeds(env) {
  const { results: feeds } = await env.DB.prepare('SELECT * FROM feeds').all();
  const summary = { checked: 0, newItems: 0, errors: 0 };

  for (const feed of feeds) {
    summary.checked++;
    try {
      const parsed = await fetchAndParseFeed(feed.url);

      // COALESCE(title, ?) — only fill in the title/site_url if they are
      // still NULL. That way a title you renamed by hand (PATCH /api/feeds/:id)
      // is never overwritten by the feed's own title on the next poll.
      await env.DB.prepare(
        `UPDATE feeds SET
           title = COALESCE(title, ?),
           site_url = COALESCE(site_url, ?),
           last_fetched = ?,
           last_error = NULL
         WHERE id = ?`
      ).bind(parsed.title || feed.url, parsed.siteUrl || '', new Date().toISOString(), feed.id).run();

      for (const item of parsed.items) {
        // No guid means no stable identity, so we would duplicate it forever.
        if (!item.guid) continue;
        const result = await env.DB.prepare(
          `INSERT INTO items (feed_id, guid, title, link, author, published_at, content, summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(feed_id, guid) DO NOTHING`  // the dedupe: already-seen items are no-ops
        ).bind(
          feed.id,
          String(item.guid).slice(0, 500),
          item.title || '(untitled)',
          item.link || '',
          item.author || '',
          toIsoDate(item.published),
          item.content || '',
          item.summary || ''
        ).run();
        // changes > 0 means the row was actually inserted rather than skipped
        // by the ON CONFLICT above — i.e. this item is genuinely new.
        if (result.meta.changes > 0) summary.newItems++;
      }
    } catch (err) {
      // Record the failure on the feed row instead of aborting the whole run.
      // The frontend renders feeds with last_error set in a warning style and
      // puts the message in the row's tooltip.
      summary.errors++;
      const message =
        err?.name === 'TimeoutError' || err?.name === 'AbortError'
          ? `Timed out after ${FEED_TIMEOUT_MS / 1000}s`
          : String(err?.message || err);
      await env.DB.prepare('UPDATE feeds SET last_error = ?, last_fetched = ? WHERE id = ?')
        .bind(message.slice(0, 300), new Date().toISOString(), feed.id)
        .run();
    }
  }

  return summary;
}

// The Pages app and this worker live on different origins (*.pages.dev vs
// *.workers.dev), so the manual-refresh fetch from app.js is cross-origin and
// every response — including errors and the OPTIONS preflight — needs these.
// Forget them on a new endpoint and the browser hides the response entirely.
function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  // Cron entry point. Schedule lives in wrangler.toml ([triggers] crons).
  // waitUntil keeps the worker alive until the poll finishes, since `scheduled`
  // itself returns immediately.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollFeeds(env));
  },

  // HTTP entry point. Only one real route: POST /refresh, used by the app's
  // ↻ Refresh button so you don't have to wait for the next cron tick.
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);

    // Preflight — the browser sends this before the real POST because
    // the request carries an Authorization header.
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/refresh' && req.method === 'POST') {
      // Optional shared secret. Set it with `wrangler secret put
      // REFRESH_SECRET`, then paste the same value into the app's Settings
      // modal (it is kept in localStorage). If the secret is unset the
      // endpoint is open to anyone who knows the worker URL.
      if (env.REFRESH_SECRET) {
        const auth = req.headers.get('Authorization') || '';
        if (auth !== `Bearer ${env.REFRESH_SECRET}`) {
          return new Response('Unauthorized', { status: 401, headers: cors });
        }
      }
      const summary = await pollFeeds(env);
      return Response.json(summary, { headers: cors });
    }

    return new Response('RSS poller worker is running. POST /refresh to trigger a manual check.', {
      status: 200,
      headers: cors,
    });
  },
};