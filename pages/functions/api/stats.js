export async function onRequestGet(context) {
  const { env } = context;
  const starred = await env.DB.prepare('SELECT COUNT(*) AS c FROM items WHERE is_starred = 1').first();
  return Response.json({ starred_total: starred.c });
}
