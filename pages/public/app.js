(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    folders: [],
    feeds: [],
    items: [],
    view: { type: 'all' }, // {type: 'all'|'starred'|'feed'|'folder', id?}
    selected: -1,
    query: '',
  };

  const layoutEl = $('.layout');
  const statusMsg = $('#statusMsg');

  function say(msg) {
    statusMsg.textContent = msg;
    if (msg) setTimeout(() => { if (statusMsg.textContent === msg) statusMsg.textContent = ''; }, 3000);
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
    });
    if (!res.ok) throw new Error(await res.text());
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }

  // ---------- Data loading ----------

  async function loadAll() {
    const [folders, feeds, stats] = await Promise.all([api('/api/folders'), api('/api/feeds'), api('/api/stats')]);
    state.folders = folders;
    state.feeds = feeds;
    $('#countStarred').textContent = stats.starred_total || '';
    renderSidebar();
    await loadItems();
  }

  async function loadItems() {
    const params = new URLSearchParams();
    if (state.view.type === 'feed') params.set('feed_id', state.view.id);
    if (state.view.type === 'folder') params.set('folder_id', state.view.id);
    if (state.view.type === 'starred') params.set('starred', '1');
    if (state.query) params.set('q', state.query);
    state.items = await api('/api/items?' + params.toString());
    state.selected = state.items.length ? 0 : -1;
    renderItems();
    renderReading();
  }

  // ---------- Sidebar ----------

  function unreadTotal() {
    return state.feeds.reduce((sum, f) => sum + (f.unread_count || 0), 0);
  }
  function renderSidebar() {
    $('#countAll').textContent = unreadTotal();

    const tree = $('#feedTree');
    tree.innerHTML = '';

    const byFolder = new Map(state.folders.map((f) => [f.id, f]));
    const grouped = new Map();
    const unfiled = [];

    for (const feed of state.feeds) {
      if (feed.folder_id && byFolder.has(feed.folder_id)) {
        if (!grouped.has(feed.folder_id)) grouped.set(feed.folder_id, []);
        grouped.get(feed.folder_id).push(feed);
      } else {
        unfiled.push(feed);
      }
    }

    for (const folder of state.folders) {
      const feeds = grouped.get(folder.id) || [];
      const group = document.createElement('div');
      group.className = 'folder-group';

      const header = document.createElement('button');
      header.className = 'folder-header';
      const unread = feeds.reduce((s, f) => s + (f.unread_count || 0), 0);
      header.innerHTML = `<span class="folder-caret">▾</span><span>${escapeHtml(folder.name)}</span>`;
      header.addEventListener('click', () => {
        feedsEl.style.display = feedsEl.style.display === 'none' ? 'block' : 'none';
        header.querySelector('.folder-caret').textContent = feedsEl.style.display === 'none' ? '▸' : '▾';
      });

      // clicking the folder name text also filters to the folder view
      header.querySelector('span:nth-child(2)').addEventListener('click', (e) => {
        e.stopPropagation();
        setView({ type: 'folder', id: folder.id }, folder.name);
      });

      const feedsEl = document.createElement('div');
      feedsEl.className = 'folder-feeds';
      for (const feed of feeds) feedsEl.appendChild(feedRow(feed));

      group.appendChild(header);
      group.appendChild(feedsEl);
      tree.appendChild(group);
    }

    for (const feed of unfiled) tree.appendChild(feedRow(feed));

    $$('.nav-item[data-view]').forEach((el) => {
      const type = el.dataset.view;
      el.classList.toggle('is-active', state.view.type === type);
    });
  }

  function feedRow(feed) {
    const row = document.createElement('button');
    row.className = 'feed-item' + (feed.last_error ? ' has-error' : '');
    row.classList.toggle('is-active', state.view.type === 'feed' && state.view.id === feed.id);
    row.title = feed.last_error ? `Last error: ${feed.last_error}` : feed.url;
    row.innerHTML = `
      <span class="feed-title">${escapeHtml(feed.title || feed.url)}</span>
      <span class="count" data-zero="${feed.unread_count ? '0' : '1'}">${feed.unread_count || ''}</span>
    `;
    row.addEventListener('click', () => setView({ type: 'feed', id: feed.id }, feed.title || feed.url));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (confirm(`Unsubscribe from "${feed.title || feed.url}"?`)) removeFeed(feed.id);
    });
    return row;
  }

  function setView(view, label) {
    state.view = view;
    state.query = '';
    $('#searchInput').value = '';
    $('#listTitle').textContent =
      label || (view.type === 'all' ? 'All items' : view.type === 'starred' ? '★ Starred' : '');
    renderSidebar();
    loadItems();
    showPanel('list');
  }

  $$('.nav-item[data-view]').forEach((el) => {
    el.addEventListener('click', () => setView({ type: el.dataset.view }, el.querySelector('.nav-label')?.textContent));
  });

  // ---------- Item list ----------

  function renderItems() {
    const list = $('#items');
    list.innerHTML = '';
    $('#itemsEmpty').hidden = state.items.length > 0;

    state.items.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'item-row' + (item.is_read ? ' is-read' : '') + (idx === state.selected ? ' is-selected' : '');
      row.innerHTML = `
        <span class="item-dot"></span>
        <div class="item-body">
          <p class="item-title">${item.is_starred ? '<span class="item-star">★</span> ' : ''}${escapeHtml(item.title)}</p>
          <div class="item-meta">
            <span>${escapeHtml(item.feed_title || '')}</span>
            <span>${formatDate(item.published_at)}</span>
          </div>
        </div>
      `;
      row.addEventListener('click', () => selectItem(idx));
      list.appendChild(row);
    });
  }

  function selectItem(idx) {
    state.selected = idx;
    renderItems();
    renderReading();
    const item = state.items[idx];
    if (item && !item.is_read) markRead(item, true);
    showPanel('reading');
  }

  // ---------- Reading pane ----------

  function renderReading() {
    const item = state.items[state.selected];
    $('#readingEmpty').hidden = !!item;
    $('#readingContent').hidden = !item;
    if (!item) return;

    $('#readingFeed').textContent = item.feed_title || '';
    $('#readingDate').textContent = formatDate(item.published_at);
    $('#readingTitle').textContent = item.title;
    $('#readingBody').innerHTML = sanitizeHtml(item.content || item.summary || '(no content)');
    $('#openOriginalLink').href = item.link || '#';
    $('#toggleStarBtn').textContent = item.is_starred ? '★ Unstar (s)' : '☆ Star (s)';
    $('#toggleReadBtn').textContent = item.is_read ? 'Mark unread (m)' : 'Mark read (m)';
  }

  async function markRead(item, read) {
    item.is_read = read ? 1 : 0;
    renderItems();
    renderReading();
    const feed = state.feeds.find((f) => f.id === item.feed_id);
    if (feed) {
      feed.unread_count = Math.max(0, (feed.unread_count || 0) + (read ? -1 : 1));
      renderSidebar();
    }
    try {
      await api(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ is_read: read }) });
    } catch { say('Could not save — check connection'); }
  }

  async function toggleStar(item) {
    item.is_starred = item.is_starred ? 0 : 1;
    const countEl = $('#countStarred');
    countEl.textContent = Math.max(0, (parseInt(countEl.textContent, 10) || 0) + (item.is_starred ? 1 : -1)) || '';
    renderItems();
    renderReading();
    try {
      await api(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ is_starred: !!item.is_starred }) });
    } catch { say('Could not save — check connection'); }
  }

  // ---------- Actions ----------

  async function addFeed() {
    const input = $('#newFeedUrl');
    const url = input.value.trim();
    if (!url) return;
    try {
      await api('/api/feeds', { method: 'POST', body: JSON.stringify({ url }) });
      input.value = '';
      say('Feed added — new items appear after the next check');
      await loadAll();
    } catch (e) {
      say('Could not add feed');
    }
  }

  async function removeFeed(id) {
    await api(`/api/feeds/${id}`, { method: 'DELETE' });
    if (state.view.type === 'feed' && state.view.id === id) setView({ type: 'all' });
    else await loadAll();
  }

  async function markAllRead() {
    const body = {};
    if (state.view.type === 'feed') body.feed_id = state.view.id;
    if (state.view.type === 'folder') body.folder_id = state.view.id;
    await api('/api/mark-read', { method: 'POST', body: JSON.stringify(body) });
    await loadAll();
  }

  async function refreshFeeds() {
    const url = localStorage.getItem('rss_worker_url');
    if (!url) { $('#settingsModal').showModal(); return; }
    say('Checking feeds…');
    try {
      const secret = localStorage.getItem('rss_worker_secret');
      const res = await fetch(url, {
        method: 'POST',
        headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      });
      const summary = await res.json();
      say(`Checked ${summary.checked} feeds, ${summary.newItems} new`);
      await loadAll();
    } catch {
      say('Refresh failed — check the worker URL in Settings');
    }
  }

  async function importOpml(file) {
    const text = await file.text();
    try {
      const result = await api('/api/opml', { method: 'POST', body: text, headers: { 'Content-Type': 'text/xml' } });
      say(`Imported ${result.imported} feeds${result.skipped ? `, ${result.skipped} already subscribed` : ''}`);
      await loadAll();
    } catch {
      say('Import failed — check the OPML file');
    }
  }

  // ---------- Mobile panel switching ----------

  function showPanel(name) {
    if (window.innerWidth > 980) return;
    layoutEl.dataset.panel = name;
  }

  // ---------- Keyboard shortcuts ----------

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    const item = state.items[state.selected];

    switch (e.key) {
      case 'j': case 'ArrowDown':
        e.preventDefault();
        if (state.selected < state.items.length - 1) selectItem(state.selected + 1);
        break;
      case 'k': case 'ArrowUp':
        e.preventDefault();
        if (state.selected > 0) selectItem(state.selected - 1);
        break;
      case 'm':
        if (item) markRead(item, !item.is_read);
        break;
      case 's':
        if (item) toggleStar(item);
        break;
      case 'v':
        if (item?.link) window.open(item.link, '_blank', 'noopener');
        break;
      case 'r':
        refreshFeeds();
        break;
      case '/':
        e.preventDefault();
        $('#searchInput').focus();
        break;
    }
  });

  // ---------- Wiring ----------

  $('#addFeedBtn').addEventListener('click', addFeed);
  $('#newFeedUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFeed(); });
  $('#markAllReadBtn').addEventListener('click', markAllRead);
  $('#refreshBtn').addEventListener('click', refreshFeeds);
  $('#backBtn').addEventListener('click', () => showPanel('list'));
  $('#menuToggle').addEventListener('click', () => showPanel('sidebar'));

  $('#toggleStarBtn').addEventListener('click', () => { const i = state.items[state.selected]; if (i) toggleStar(i); });
  $('#toggleReadBtn').addEventListener('click', () => { const i = state.items[state.selected]; if (i) markRead(i, !i.is_read); });

  let searchDebounce;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.query = e.target.value.trim();
      loadItems();
    }, 300);
  });

  $('#settingsBtn').addEventListener('click', () => {
    $('#workerUrl').value = localStorage.getItem('rss_worker_url') || '';
    $('#workerSecret').value = localStorage.getItem('rss_worker_secret') || '';
    $('#settingsModal').showModal();
  });
  $('#settingsModal').addEventListener('close', (e) => {
    if (e.target.returnValue === 'save') {
      localStorage.setItem('rss_worker_url', $('#workerUrl').value.trim());
      localStorage.setItem('rss_worker_secret', $('#workerSecret').value.trim());
      say('Settings saved');
    }
  });

  $('#addFolderBtn').addEventListener('click', () => {
    $('#newFolderName').value = '';
    $('#folderModal').showModal();
  });
  $('#folderModal').addEventListener('close', async (e) => {
    const name = $('#newFolderName').value.trim();
    if (e.target.returnValue === 'save' && name) {
      await api('/api/folders', { method: 'POST', body: JSON.stringify({ name }) });
      await loadAll();
    }
  });

  $('#opmlFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importOpml(e.target.files[0]);
    e.target.value = '';
  });

  // ---------- Utilities ----------

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // Minimal sanitizer: strips script/style/event handlers before injecting
  // feed HTML into the reading pane. Feeds are content you subscribed to,
  // but this keeps stray tracking scripts from executing.
  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed').forEach((el) => el.remove());
    doc.querySelectorAll('*').forEach((el) => {
      [...el.attributes].forEach((attr) => {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      });
    });
    return doc.body.innerHTML;
  }

  // ---------- Init ----------

  loadAll().catch(() => say('Could not load — check that the D1 binding is configured'));
})();
