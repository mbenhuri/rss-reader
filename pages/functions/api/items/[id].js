// Route: PATCH /api/items/:id — toggle read / starred on one article.
// Cloudflare Pages Functions use file-based routing: this file's path under
// pages/functions/ IS its URL. Each exported onRequest<Method> handles that
// HTTP verb; anything not exported returns 405 automatically.
// `context` gives you { env, request, params, waitUntil, next, data };
// `env.DB` is the D1 binding — it must be named exactly DB in the Pages
// project's settings or it arrives undefined and every query 500s.

// PATCH /api/items/:id  { is_read?, is_starred? } — the read and star
// toggles. Same dynamic-SET pattern as feeds/[id].js: only keys present in
// the body are touched, so marking read never disturbs the star and vice
// versa. Values are coerced to 1/0 because SQLite has no boolean type.
// The frontend updates its own state first and fires this call afterwards
// (optimistic update), so a failure here shows a toast but leaves the UI
// out of sync until the next reload.
export async function onRequestPatch(context) {
  const { env, params, request } = context;
  const body = await request.json().catch(() => ({}));
  const fields = [];
  const values = [];

  if ('is_read' in body) { fields.push('is_read = ?'); values.push(body.is_read ? 1 : 0); }
  if ('is_starred' in body) { fields.push('is_starred = ?'); values.push(body.is_starred ? 1 : 0); }

  if (!fields.length) return new Response('No fields to update', { status: 400 });

  values.push(params.id);
  await env.DB.prepare(`UPDATE items SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  return new Response('OK');
}
