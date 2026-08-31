// Routes: GET/POST /api/folders — the sidebar's folder list.
// Cloudflare Pages Functions use file-based routing: this file's path under
// pages/functions/ IS its URL. Each exported onRequest<Method> handles that
// HTTP verb; anything not exported returns 405 automatically.
// `context` gives you { env, request, params, waitUntil, next, data };
// `env.DB` is the D1 binding — it must be named exactly DB in the Pages
// project's settings or it arrives undefined and every query 500s.

// GET /api/folders — sort_order first (reserved for manual ordering; nothing
// sets it yet, so in practice this is an alphabetical, case-insensitive list).
export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    'SELECT * FROM folders ORDER BY sort_order, name COLLATE NOCASE'
  ).all();
  return Response.json(results);
}

// POST /api/folders  { name } — create a folder. folders.name is UNIQUE, so
// a duplicate name lands in the catch below as a 400.
export async function onRequestPost(context) {
  const { env, request } = context;
  const body = await request.json().catch(() => ({}));
  const name = (body.name || '').trim();
  if (!name) return new Response('Missing name', { status: 400 });

  try {
    const result = await env.DB.prepare('INSERT INTO folders (name) VALUES (?)').bind(name).run();
    return Response.json({ id: result.meta.last_row_id }, { status: 201 });
  } catch (e) {
    return new Response('Could not create folder: ' + e.message, { status: 400 });
  }
}
