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

export async function onRequestDelete(context) {
  const { env, params } = context;
  await env.DB.prepare('DELETE FROM feeds WHERE id = ?').bind(params.id).run();
  return new Response('OK');
}
