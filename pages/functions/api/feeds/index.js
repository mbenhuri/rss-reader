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
  } catch (e) {
    return new Response('Could not add feed (maybe already subscribed?): ' + e.message, { status: 400 });
  }
}
