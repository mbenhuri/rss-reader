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
