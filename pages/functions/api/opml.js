function esc(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unesc(s) {
  return (s || '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export async function onRequestGet(context) {
  const { env } = context;
  const { results: feeds } = await env.DB.prepare(
    `SELECT f.*, fo.name AS folder_name
     FROM feeds f LEFT JOIN folders fo ON fo.id = f.folder_id
     ORDER BY fo.sort_order, fo.name, f.title COLLATE NOCASE`
  ).all();

  const byFolder = new Map();
  const noFolder = [];
  for (const f of feeds) {
    if (f.folder_name) {
      if (!byFolder.has(f.folder_name)) byFolder.set(f.folder_name, []);
      byFolder.get(f.folder_name).push(f);
    } else {
      noFolder.push(f);
    }
  }

  let body = '';
  for (const [folder, list] of byFolder) {
    body += `<outline text="${esc(folder)}" title="${esc(folder)}">\n`;
    for (const f of list) {
      body += `    <outline type="rss" text="${esc(f.title || f.url)}" title="${esc(f.title || f.url)}" xmlUrl="${esc(f.url)}" htmlUrl="${esc(f.site_url || '')}"/>\n`;
    }
    body += `  </outline>\n`;
  }
  for (const f of noFolder) {
    body += `  <outline type="rss" text="${esc(f.title || f.url)}" title="${esc(f.title || f.url)}" xmlUrl="${esc(f.url)}" htmlUrl="${esc(f.site_url || '')}"/>\n`;
  }

  const opml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n<head><title>RSS Subscriptions</title></head>\n<body>\n${body}</body>\n</opml>\n`;

  return new Response(opml, {
    headers: {
      'Content-Type': 'text/x-opml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="subscriptions.opml"',
    },
  });
}

// Small state-machine OPML parser — handles the common one-level-deep
// folder nesting produced by Google Reader, Feedly, Inoreader, NetNewsWire, etc.
export async function onRequestPost(context) {
  const { env, request } = context;
  const xml = await request.text();

  const tokenRe = /<outline\b[^>]*\/?>|<\/outline\s*>/gi;
  const attrRe = (name) => new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');

  const folderStack = [];
  let imported = 0;
  let skipped = 0;
  let match;

  while ((match = tokenRe.exec(xml))) {
    const tag = match[0];

    if (/^<\/outline/i.test(tag)) {
      folderStack.pop();
      continue;
    }

    const xmlUrlMatch = tag.match(attrRe('xmlUrl'));
    const titleMatch = tag.match(attrRe('title')) || tag.match(attrRe('text'));
    const selfClosing = /\/>\s*$/.test(tag);

    if (xmlUrlMatch) {
      const xmlUrl = unesc(xmlUrlMatch[1]);
      const title = titleMatch ? unesc(titleMatch[1]) : xmlUrl;
      const folderName = folderStack[folderStack.length - 1] || null;

      let folderId = null;
      if (folderName) {
        const existing = await env.DB.prepare('SELECT id FROM folders WHERE name = ?').bind(folderName).first();
        if (existing) {
          folderId = existing.id;
        } else {
          const res = await env.DB.prepare('INSERT INTO folders (name) VALUES (?)').bind(folderName).run();
          folderId = res.meta.last_row_id;
        }
      }

      try {
        await env.DB.prepare('INSERT INTO feeds (url, title, folder_id) VALUES (?, ?, ?)')
          .bind(xmlUrl, title, folderId).run();
        imported++;
      } catch {
        skipped++; // already subscribed
      }

      if (!selfClosing) folderStack.push(null); // rare: feed outline with children
    } else if (titleMatch && !selfClosing) {
      folderStack.push(unesc(titleMatch[1]));
    } else if (!selfClosing) {
      folderStack.push(null);
    }
  }

  return Response.json({ imported, skipped });
}
