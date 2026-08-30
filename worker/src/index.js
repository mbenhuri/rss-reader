// Personal RSS Reader — feed poller
// Runs on a Cron Trigger, fetches every subscribed feed, parses RSS/Atom,
// and inserts new items into D1. Also exposes POST /refresh for a manual
// "check now" button in the frontend.

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

function text(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && '#text' in val) return String(val['#text']);
  return String(val);
}

function atomLink(linkField) {
  if (!linkField) return '';
  const links = Array.isArray(linkField) ? linkField : [linkField];
  const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate');
  return (alt || links[0])?.['@_href'] || '';
}

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

async function fetchAndParseFeed(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PersonalRSSReader/1.0 (+self-hosted)' },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const data = parser.parse(xml);

  if (data.rss?.channel) {
    const channel = data.rss.channel;
    const items = [].concat(channel.item || []);
    return {
      title: text(channel.title),
      siteUrl: typeof channel.link === 'object' ? channel.link['#text'] : channel.link,
      items: items.map(normalizeRssItem),
    };
  }

  if (data['rdf:RDF']) {
    // RSS 1.0 / RDF feeds
    const root = data['rdf:RDF'];
    const items = [].concat(root.item || []);
    return {
      title: text(root.channel?.title),
      siteUrl: typeof root.channel?.link === 'object' ? root.channel.link['#text'] : root.channel?.link,
      items: items.map(normalizeRssItem),
    };
  }

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

async function pollFeeds(env) {
  const { results: feeds } = await env.DB.prepare('SELECT * FROM feeds').all();
  const summary = { checked: 0, newItems: 0, errors: 0 };

  for (const feed of feeds) {
    summary.checked++;
    try {
      const parsed = await fetchAndParseFeed(feed.url);

      await env.DB.prepare(
        `UPDATE feeds SET
           title = COALESCE(title, ?),
           site_url = COALESCE(site_url, ?),
           last_fetched = ?,
           last_error = NULL
         WHERE id = ?`
      ).bind(parsed.title || feed.url, parsed.siteUrl || '', new Date().toISOString(), feed.id).run();

      for (const item of parsed.items) {
        if (!item.guid) continue;
        const result = await env.DB.prepare(
          `INSERT INTO items (feed_id, guid, title, link, author, published_at, content, summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(feed_id, guid) DO NOTHING`
        ).bind(
          feed.id,
          String(item.guid).slice(0, 500),
          item.title || '(untitled)',
          item.link || '',
          item.author || '',
          item.published ? new Date(item.published).toISOString() : new Date().toISOString(),
          item.content || '',
          item.summary || ''
        ).run();
        if (result.meta.changes > 0) summary.newItems++;
      }
    } catch (err) {
      summary.errors++;
      await env.DB.prepare('UPDATE feeds SET last_error = ?, last_fetched = ? WHERE id = ?')
        .bind(String(err.message || err).slice(0, 300), new Date().toISOString(), feed.id)
        .run();
    }
  }

  return summary;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollFeeds(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/refresh' && req.method === 'POST') {
      if (env.REFRESH_SECRET) {
        const auth = req.headers.get('Authorization') || '';
        if (auth !== `Bearer ${env.REFRESH_SECRET}`) {
          return new Response('Unauthorized', { status: 401 });
        }
      }
      const summary = await pollFeeds(env);
      return Response.json(summary);
    }

    return new Response('RSS poller worker is running. POST /refresh to trigger a manual check.', {
      status: 200,
    });
  },
};
