// Routes: GET  /api/opml — download subscriptions.opml
//         POST /api/opml — import an OPML file (raw XML body, not JSON)
//
// OPML is the interchange format every reader speaks, so this file is your
// escape hatch: it is what makes the data in D1 portable to and from Feedly,
// Inoreader, NetNewsWire, etc. Both directions handle exactly one level of
// folder nesting, which is what those tools produce in practice.
// Minimal XML attribute escaping for the export side. & must be replaced
// first, otherwise it would re-escape the ampersands introduced by the later
// replacements (&lt; would become &amp;lt;).
function esc(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// The inverse, for the import side. Mirror-image ordering: &amp; goes LAST
// here for the same reason it went first above — decoding it early would turn
// a literal "&amp;lt;" into "<".
// Only the five predefined XML entities are handled; numeric entities like
// &#39; in a feed title come through as-is.
function unesc(s) {
  return (s || '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ---- Export -------------------------------------------------------------
// Builds the OPML document by hand rather than with an XML library — it is a
// fixed, tiny shape and this avoids a dependency in the Pages build.
// The Content-Disposition header is what makes the plain <a href="/api/opml"
// download> link in index.html save a file instead of navigating to XML.
export async function onRequestGet(context) {
  const { env } = context;
  const { results: feeds } = await env.DB.prepare(
    `SELECT f.*, fo.name AS folder_name
     FROM feeds f LEFT JOIN folders fo ON fo.id = f.folder_id
     ORDER BY fo.sort_order, fo.name, f.title COLLATE NOCASE`
  ).all();

  // Group the flat SQL result into folders. The query already orders rows so
  // that a folder's feeds arrive together and in a sensible order; this loop
  // only has to bucket them.
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

// ---- Import -------------------------------------------------------------
// Small state-machine OPML parser — handles the common one-level-deep
// folder nesting produced by Google Reader, Feedly, Inoreader, NetNewsWire, etc.
//
// Why a regex scanner instead of a real XML parser: Pages Functions have no
// DOMParser, and pulling fast-xml-parser in here would mean giving the Pages
// side a build step (see CLAUDE.md — the frontend is deliberately dependency
// free). The <outline> element is flat and predictable enough that scanning
// tags with a stack is sufficient.
//
// The rule OPML uses: an <outline> WITH an xmlUrl attribute is a feed; an
// <outline> without one is a folder, and its children are its contents.
// So the parser walks tags in order, pushing a folder name onto `folderStack`
// on every opening non-feed outline and popping it on every </outline>. The
// feed rows it meets get filed under whatever is on top of the stack.
//
// Note the body is read with request.text(), not .json() — the browser posts
// the raw file contents.
export async function onRequestPost(context) {
  const { env, request } = context;
  const xml = await request.text();

  // Matches an opening-or-self-closing <outline ...> or a closing </outline>.
  // The /g flag matters: the while loop below relies on lastIndex advancing.
  const tokenRe = /<outline\b[^>]*\/?>|<\/outline\s*>/gi;
  const attrRe = (name) => new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');

  // Stack of enclosing folder names. null means "an outline we are inside but
  // that isn't a folder we file under" — the stack must stay balanced with the
  // </outline> tags, so we push a placeholder rather than skipping.
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

    // `title` is the canonical attribute, `text` is what older exporters use.
    const xmlUrlMatch = tag.match(attrRe('xmlUrl'));
    const titleMatch = tag.match(attrRe('title')) || tag.match(attrRe('text'));
    const selfClosing = /\/>\s*$/.test(tag);

    if (xmlUrlMatch) {
      const xmlUrl = unesc(xmlUrlMatch[1]);
      const title = titleMatch ? unesc(titleMatch[1]) : xmlUrl;
      const folderName = folderStack[folderStack.length - 1] || null;

      // Find-or-create the folder. This runs per feed, so importing a large
      // OPML issues a lot of small sequential queries — see the review notes
      // if this ever needs to get faster (cache the name→id map in a Map).
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
        // The UNIQUE constraint on feeds.url — you are already subscribed.
        // Counted, not fatal: re-importing the same OPML is a no-op.
        skipped++;
      }

      // A feed outline is normally self-closing. If it isn't, push a
      // placeholder so the matching </outline> pops this instead of eating
      // the real folder above it.
      if (!selfClosing) folderStack.push(null);
    // No xmlUrl + has a name + has children ⇒ this is a folder.
    } else if (titleMatch && !selfClosing) {
      folderStack.push(unesc(titleMatch[1]));
    // Anything else with children (an unnamed container) — keep the stack
    // balanced but don't file feeds under it.
    } else if (!selfClosing) {
      folderStack.push(null);
    }
  }

  return Response.json({ imported, skipped });
}
