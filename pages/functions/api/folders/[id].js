// Routes for a single folder. The [id] in the filename becomes params.id.
// Cloudflare Pages Functions use file-based routing: this file's path under
// pages/functions/ IS its URL. Each exported onRequest<Method> handles that
// HTTP verb; anything not exported returns 405 automatically.
// `context` gives you { env, request, params, waitUntil, next, data };
// `env.DB` is the D1 binding — it must be named exactly DB in the Pages
// project's settings or it arrives undefined and every query 500s.

// PATCH /api/folders/:id  { name } — rename a folder.
export async function onRequestPatch(context) {
  const { env, params, request } = context;
  const body = await request.json().catch(() => ({}));
  if (!body.name) return new Response('Missing name', { status: 400 });
  await env.DB.prepare('UPDATE folders SET name = ? WHERE id = ?').bind(body.name, params.id).run();
  return new Response('OK');
}

// DELETE /api/folders/:id — delete a folder but KEEP its feeds, moving them
// to "unfiled". The first statement is what makes that explicit; the schema's
// ON DELETE SET NULL would do the same, but doing it here means the behaviour
// does not depend on D1 having foreign keys enforced.
// Note these are two separate statements, not a transaction — if the second
// fails you are left with orphaned-but-intact feeds, which is the safe side.
export async function onRequestDelete(context) {
  const { env, params } = context;
  await env.DB.prepare('UPDATE feeds SET folder_id = NULL WHERE folder_id = ?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(params.id).run();
  return new Response('OK');
}
