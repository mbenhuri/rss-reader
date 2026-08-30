export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const feedId = url.searchParams.get('feed_id');
  const folderId = url.searchParams.get('folder_id');
  const unreadOnly = url.searchParams.get('unread') === '1';
  const starredOnly = url.searchParams.get('starred') === '1';
  const q = url.searchParams.get('q');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '80', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  let query = `
    SELECT i.*, f.title AS feed_title
    FROM items i
    JOIN feeds f ON f.id = i.feed_id
    WHERE 1=1`;
  const binds = [];

  if (feedId) { query += ' AND i.feed_id = ?'; binds.push(feedId); }
  if (folderId) { query += ' AND f.folder_id = ?'; binds.push(folderId); }
  if (unreadOnly) { query += ' AND i.is_read = 0'; }
  if (starredOnly) { query += ' AND i.is_starred = 1'; }
  if (q) { query += ' AND (i.title LIKE ? OR i.summary LIKE ?)'; binds.push(`%${q}%`, `%${q}%`); }

  query += ' ORDER BY i.published_at DESC, i.id DESC LIMIT ? OFFSET ?';
  binds.push(limit, offset);

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return Response.json(results);
}
