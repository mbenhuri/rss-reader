// Routes: GET  /api/feeds  — list feeds with unread counts
//         POST /api/feeds  — subscribe to a new feed
// Cloudflare Pages Functions use file-based routing: this file's path under
// pages/functions/ IS its URL. Each exported onRequest<Method> handles that
// HTTP verb; anything not exported returns 405 automatically.
// `context` gives you { env, request, params, waitUntil, next, data };
// `env.DB` is the D1 binding — it must be named exactly DB in the Pages
// project's settings or it arrives undefined and every query 500s.

// GET /api/feeds — every subscribed feed plus its unread count, used to
// build the sidebar tree. The correlated subquery counts unread items per
// feed in one round trip rather than one query per feed.
export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT f.*,
       (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND i.is_read = 0) AS unread_count
     FROM feeds f
     ORDER BY f.title COLLATE NOCASE`
  ).all();
  return Response.json(results);
}

// POST /api/feeds  { url, title?, folder_id? } — subscribe to a feed.
// Only the URL is stored; the title and site_url stay NULL until the poller
// worker fetches the feed and fills them in (see COALESCE in worker/src).
// So a newly added feed shows its URL in the sidebar and has no items until
// the next poll — hence the "new items appear after the next check" message.
export async function onRequestPost(context) {
  const { env, request } = context;
  const body = await request.json().catch(() => ({}));
  const url = (body.url || '').trim();
  if (!url) return new Response('Missing url', { status: 400 });

  try {
    const result = await env.DB.prepare(
      'INSERT INTO feeds (url, title, folder_id) VALUES (?, ?, ?)'
    ).bind(url, body.title || null, body.folder_id || null).run();
    return Response.json({ id: result.meta.last_row_id }, { status: 201 });
    // The only expected failure is the UNIQUE constraint on feeds.url,
    // i.e. you are already subscribed.
  } catch (e) {
    return new Response('Could not add feed (maybe already subscribed?): ' + e.message, { status: 400 });
  }
}
