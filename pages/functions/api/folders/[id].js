export async function onRequestPatch(context) {
  const { env, params, request } = context;
  const body = await request.json().catch(() => ({}));
  if (!body.name) return new Response('Missing name', { status: 400 });
  await env.DB.prepare('UPDATE folders SET name = ? WHERE id = ?').bind(body.name, params.id).run();
  return new Response('OK');
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  await env.DB.prepare('UPDATE feeds SET folder_id = NULL WHERE folder_id = ?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM folders WHERE id = ?').bind(params.id).run();
  return new Response('OK');
}
