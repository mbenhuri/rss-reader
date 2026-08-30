export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    'SELECT * FROM folders ORDER BY sort_order, name COLLATE NOCASE'
  ).all();
  return Response.json(results);
}

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
