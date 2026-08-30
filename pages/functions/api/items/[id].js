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
