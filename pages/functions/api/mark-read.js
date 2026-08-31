// Route: POST /api/mark-read — bulk-mark items as read.
// Cloudflare Pages Functions use file-based routing: this file's path under
// pages/functions/ IS its URL. Each exported onRequest<Method> handles that
// HTTP verb; anything not exported returns 405 automatically.
// `context` gives you { env, request, params, waitUntil, next, data };
// `env.DB` is the D1 binding — it must be named exactly DB in the Pages
// project's settings or it arrives undefined and every query 500s.

// POST /api/mark-read  { feed_id? | folder_id? } — bulk "mark all read".
// Scope is chosen by which key is present, in order of narrowness:
//   feed_id   → that feed        folder_id → every feed in that folder
//   neither   → EVERY item in the database
// That last case is deliberate (it backs the button while viewing "All
// items") but it is also unrecoverable — there is no undo — so be careful
// if you ever call this endpoint from somewhere new.
export async function onRequestPost(context) {
  const { env, request } = context;
  const body = await request.json().catch(() => ({}));

  if (body.feed_id) {
    await env.DB.prepare('UPDATE items SET is_read = 1 WHERE feed_id = ?').bind(body.feed_id).run();
  } else if (body.folder_id) {
    await env.DB.prepare(
      `UPDATE items SET is_read = 1 WHERE feed_id IN (SELECT id FROM feeds WHERE folder_id = ?)`
    ).bind(body.folder_id).run();
  } else {
    await env.DB.prepare('UPDATE items SET is_read = 1').run();
  }

  return new Response('OK');
}
