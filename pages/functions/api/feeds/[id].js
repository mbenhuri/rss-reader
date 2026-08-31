// Routes for a single feed. The [id] in the filename becomes params.id.
// Cloudflare Pages Functions use file-based routing: this file's path under
// pages/functions/ IS its URL. Each exported onRequest<Method> handles that
// HTTP verb; anything not exported returns 405 automatically.
// `context` gives you { env, request, params, waitUntil, next, data };
// `env.DB` is the D1 binding — it must be named exactly DB in the Pages
// project's settings or it arrives undefined and every query 500s.

// PATCH /api/feeds/:id  { folder_id?, title? } — move a feed between folders
// or rename it. Builds the SET clause from only the keys actually present in
// the body, so PATCHing one field never clobbers the other. `'x' in body` is
// used rather than a truthiness check so that folder_id: null (= move to
// unfiled) is treated as a real update instead of being ignored.
export async function onRequestPatch(context) {
  const { env, params, request } = context;
  const body = await request.json().catch(() => ({}));
  const fields = [];
  const values = [];

  if ('folder_id' in body) { fields.push('folder_id = ?'); values.push(body.folder_id); }
  if ('title' in body) { fields.push('title = ?'); values.push(body.title); }

  if (!fields.length) return new Response('No fields to update', { status: 400 });

  values.push(params.id);
  await env.DB.prepare(`UPDATE feeds SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  return new Response('OK');
}

// DELETE /api/feeds/:id — unsubscribe. The schema's
// items.feed_id ... ON DELETE CASCADE removes that feed's items too, so
// there is no second query here.
export async function onRequestDelete(context) {
  const { env, params } = context;
  await env.DB.prepare('DELETE FROM feeds WHERE id = ?').bind(params.id).run();
  return new Response('OK');
}
