// Route: GET /api/stats — small aggregate counts for the sidebar.
// Cloudflare Pages Functions use file-based routing: this file's path under
// pages/functions/ IS its URL. Each exported onRequest<Method> handles that
// HTTP verb; anything not exported returns 405 automatically.
// `context` gives you { env, request, params, waitUntil, next, data };
// `env.DB` is the D1 binding — it must be named exactly DB in the Pages
// project's settings or it arrives undefined and every query 500s.

// GET /api/stats — counts the sidebar needs that don't come from /api/feeds.
// Unread counts already ride along on each feed row, so this is just the
// starred total for now; add further aggregates to this same object rather
// than adding another round trip on page load.
export async function onRequestGet(context) {
  const { env } = context;
  const starred = await env.DB.prepare('SELECT COUNT(*) AS c FROM items WHERE is_starred = 1').first();
  return Response.json({ starred_total: starred.c });
}
