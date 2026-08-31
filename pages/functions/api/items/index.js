// Route: GET /api/items — the article list, filtered/searched/paged.
// Cloudflare Pages Functions use file-based routing: this file's path under
// pages/functions/ IS its URL. Each exported onRequest<Method> handles that
// HTTP verb; anything not exported returns 405 automatically.
// `context` gives you { env, request, params, waitUntil, next, data };
// `env.DB` is the D1 binding — it must be named exactly DB in the Pages
// project's settings or it arrives undefined and every query 500s.

// GET /api/items — the middle column. Every view in the UI is this one
// endpoint with different query params:
//   feed_id=N     one feed          folder_id=N   every feed in a folder
//   unread=1      hide read items   starred=1     starred only
//   q=text        substring search over title + summary
//   limit/offset  paging (limit capped at 200, default 80)
// Params are combined with AND, so they stack (e.g. folder_id + unread).
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

  // Built as a string because the set of filters is dynamic. Every value is
  // still passed through .bind(), so this is parameterised, not interpolated —
  // keep it that way when adding a filter.
  // `WHERE 1=1` is the usual trick that lets each optional clause below just
  // append ' AND ...' without tracking whether it is the first one.
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
  // Leading-% LIKE cannot use an index, so search is a full scan. Fine at
  // personal scale; if it ever gets slow the answer is an FTS5 virtual table.
  if (q) { query += ' AND (i.title LIKE ? OR i.summary LIKE ?)'; binds.push(`%${q}%`, `%${q}%`); }

  // id DESC is the tiebreaker: many feeds stamp every item in one batch with
  // the same published_at, and without it the order would be unstable across
  // pages.
  query += ' ORDER BY i.published_at DESC, i.id DESC LIMIT ? OFFSET ?';
  binds.push(limit, offset);

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return Response.json(results);
}
