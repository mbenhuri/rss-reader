// Reader — frontend.
//
// Plain JS in one IIFE, no framework and no build step (see CLAUDE.md). The
// whole app is a small render loop over a single `state` object:
//
//   load*()    fetch from /api/* into `state`
//   render*()  wipe a container's innerHTML and rebuild it from `state`
//   actions    mutate `state`, re-render immediately, THEN persist via the API
//              (optimistic updates — the UI never waits on the network)
//
// There is no diffing: every render throws away the DOM it owns and rebuilds
// it. At a few hundred items that is imperceptible, and it means you can never
// get a stale node. If you add anything expensive to a row, revisit that.
//
// Reading order: state → api() → data loading → sidebar → item list → reading
// pane → actions → keyboard → event wiring → theming → utilities → init.
(() => {
  // Terse aliases used throughout — $ is one element, $$ is a real Array
  // (querySelectorAll returns a NodeList, which has no .map/.filter).
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // The single source of truth. Everything on screen is derived from this;
  // nothing is read back out of the DOM. `selected` is an INDEX into
  // state.items, not an item id, so it is invalidated whenever items reload.
  const state = {
    folders: [],
    feeds: [],
    items: [],
    view: { type: 'all' }, // {type: 'all'|'starred'|'feed'|'folder', id?}
    selected: -1,
    query: '',
    hasMore: false,   // another page is probably available
    loadingMore: false,
  };

  // Items are fetched a page at a time. /api/items caps limit at 200 and
  // defaults to 80; the value is sent explicitly so the UI and the API agree
  // on the page size rather than the UI inferring it from a server default.
  const PAGE_SIZE = 80;

  const layoutEl = $('.layout');
  const statusMsg = $('#statusMsg');

  // Status line message (bottom right). Self-clears after 3s, but only if
  // nothing else has been said in the meantime — otherwise a stale timer would
  // wipe a newer message.
  //
  // Pass {sticky: true} for "work is in progress" messages: an operation that
  // outlives the 3s timer (a feed poll routinely does) would otherwise clear
  // its own status while still running and look like nothing happened. A
  // sticky message stays until the next say() replaces it.
  function say(msg, { sticky = false } = {}) {
    statusMsg.textContent = msg;
    if (msg && !sticky) {
      setTimeout(() => { if (statusMsg.textContent === msg) statusMsg.textContent = ''; }, 3000);
    }
  }

  // Thin fetch wrapper for /api/*. Sets the JSON content type only when there
  // is a body, throws on non-2xx (with the server's text as the message, which
  // is why the API routes return human-readable strings on error), and parses
  // the response as JSON or text depending on what came back.
  // Note `...opts` comes after `headers`, so an explicit headers option in
  // opts REPLACES the default rather than merging — that is what the OPML
  // import relies on to send text/xml.
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

  // Full refresh: sidebar data + counts + the current item list. Called on
  // boot and after anything that could change feed/folder structure or counts.
  // The three GETs are independent, hence Promise.all.
  async function loadAll() {
    const [folders, feeds, stats] = await Promise.all([api('/api/folders'), api('/api/feeds'), api('/api/stats')]);
    state.folders = folders;
    state.feeds = feeds;
    $('#countStarred').textContent = stats.starred_total || '';
    renderSidebar();
    await loadItems();
  }

  // Reload the middle column for the current view. Every view maps to the one
  // /api/items endpoint with different params (see that route's comments).
  // Resets the selection to the first item, so the reading pane always shows
  // something after a view change.
  // The filter half of an /api/items query — everything except paging.
  // Shared so that loading page 2 cannot drift from page 1's filters.
  function itemParams() {
    const params = new URLSearchParams();
    if (state.view.type === 'feed') params.set('feed_id', state.view.id);
    if (state.view.type === 'folder') params.set('folder_id', state.view.id);
    if (state.view.type === 'starred') params.set('starred', '1');
    if (state.query) params.set('q', state.query);
    params.set('limit', String(PAGE_SIZE));
    return params;
  }

  async function loadItems() {
    const params = itemParams();
    params.set('offset', '0');
    const rows = await api('/api/items?' + params.toString());
    state.items = rows;
    // A full page back means there is probably another one. It may be wrong
    // when the total is an exact multiple of PAGE_SIZE — the next fetch then
    // returns nothing and the control disappears, which is a better failure
    // than a COUNT(*) on every view change.
    state.hasMore = rows.length === PAGE_SIZE;
    state.selected = rows.length ? 0 : -1;
    renderItems();
    renderReading();
    $('#items').scrollTop = 0; // a new view starts at the top
  }

  // Append the next page. Everything already loaded stays put, so the
  // selected index remains valid.
  async function loadMore() {
    if (state.loadingMore || !state.hasMore) return;
    state.loadingMore = true;
    renderItems();
    try {
      const params = itemParams();
      params.set('offset', String(state.items.length));
      const rows = await api('/api/items?' + params.toString());

      // Offset paging assumes a stable result set, and the poller can insert
      // items between pages — which shifts everything down and would repeat a
      // row across the boundary. Dropping ids already held makes that
      // harmless. (An item pushed *past* the boundary by an insert is missed
      // until the next view change; the alternative is keyset paging, which
      // would mean changing the API.)
      const seen = new Set(state.items.map((i) => i.id));
      const fresh = rows.filter((r) => !seen.has(r.id));
      state.items.push(...fresh);
      state.hasMore = rows.length === PAGE_SIZE;
      if (!fresh.length && !state.hasMore) say('No older items');
    } catch {
      say('Could not load older items');
    } finally {
      state.loadingMore = false;
      renderItems();
    }
  }

  // ---------- Sidebar ----------

  // Summed client-side from the per-feed counts already in state, so the
  // "All items" badge costs no extra request.
  function unreadTotal() {
    return state.feeds.reduce((sum, f) => sum + (f.unread_count || 0), 0);
  }
  // Rebuild the folder/feed tree from scratch. Feeds whose folder_id is null
  // — or points at a folder that no longer exists — fall through to `unfiled`
  // and render flat at the bottom, so a feed can never disappear from the
  // sidebar because of a dangling reference.
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
      // Folder total = the sum of its feeds' unread counts. Worth showing
      // in its own right, but it matters most when the folder is collapsed
      // and the per-feed counts are hidden.
      const unread = feeds.reduce((s, f) => s + (f.unread_count || 0), 0);
      header.innerHTML = `
        <span class="folder-caret">▾</span>
        <span class="folder-name">${escapeHtml(folder.name)}</span>
        <span class="count" data-zero="${unread ? '0' : '1'}">${unread || ''}</span>
      `;
      // Clicking the header row collapses/expands the folder. `feedsEl` is
      // declared below with const — that is safe because this callback only
      // runs long after this function has finished (it is not a hoisting bug),
      // but it does mean the two must stay in the same scope.
      header.addEventListener('click', () => {
        feedsEl.style.display = feedsEl.style.display === 'none' ? 'block' : 'none';
        header.querySelector('.folder-caret').textContent = feedsEl.style.display === 'none' ? '▸' : '▾';
      });

      // ...but clicking the folder NAME specifically filters to that folder
      // instead of collapsing it. stopPropagation keeps it from also toggling the collapse.
      header.querySelector('.folder-name').addEventListener('click', (e) => {
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

  // One feed button in the sidebar. Right-click is the unsubscribe affordance
  // (there is no visible delete button anywhere) — worth remembering, since
  // it is undiscoverable.
  function feedRow(feed) {
    const row = document.createElement('button');
    row.className = 'feed-item' + (feed.last_error ? ' has-error' : '');
    row.classList.toggle('is-active', state.view.type === 'feed' && state.view.id === feed.id);
    // A feed the poller failed on gets .has-error styling and the reason in
    // its tooltip; last_error is cleared by the worker on the next good poll.
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

  // Switch the middle column to a different view. Deliberately clears any
  // active search: a query typed while looking at one feed would otherwise
  // silently persist into the next view.
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

  // Rebuild the article list. Rows are built with innerHTML, so every piece of
  // feed-supplied text MUST go through escapeHtml — an unescaped title is a
  // script injection from whatever site you subscribed to.
  function renderItems() {
    const list = $('#items');
    // Every render rebuilds the list, which resets the scroll position. That
    // is wrong for anything but a view change: appending a page, or simply
    // moving the selection with j/k, would otherwise yank you back to the
    // top. loadItems() explicitly zeroes it for genuinely new views.
    const scrollTop = list.scrollTop;
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

    // Paging control lives inside the scrolling list so it sits under the
    // last row rather than being pinned to the panel.
    if (state.hasMore) {
      const more = document.createElement('button');
      more.className = 'load-more';
      more.textContent = state.loadingMore ? 'Loading…' : 'Load older items';
      more.disabled = state.loadingMore;
      more.addEventListener('click', loadMore);
      list.appendChild(more);
    }

    list.scrollTop = scrollTop;
  }

  // Selecting an article also marks it read (the standard reader behaviour)
  // and, on narrow screens, slides over to the reading panel.
  function selectItem(idx) {
    state.selected = idx;
    renderItems();
    renderReading();
    const item = state.items[idx];
    if (item && !item.is_read) markRead(item, true);
    showPanel('reading');
  }

  // ---------- Reading pane ----------

  // Render the right-hand pane from the currently selected item. Note the
  // asymmetry: title/meta go through textContent (safe by construction) while
  // the article body is HTML and therefore goes through sanitizeHtml below.
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

  // Optimistic update: mutate the local item, re-render, adjust the sidebar
  // count by hand, and only then tell the server. Keeping the count in sync
  // locally avoids a full loadAll() on every j/k keypress.
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

  // Same optimistic pattern as markRead. The starred badge is read back out
  // of the DOM here (rather than from state) because the total comes from
  // /api/stats and isn't mirrored in `state`.
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

  // Subscribing only inserts a row; the poller worker is what actually
  // fetches the feed, hence the "appears after the next check" wording.
  // Hit ↻ Refresh to make that happen immediately.
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

  // Scoped to the current view. Note that in the "all" or "starred" view the
  // body is empty, which the API treats as "mark EVERY item read" — there is
  // no undo for that.
  async function markAllRead() {
    const body = {};
    if (state.view.type === 'feed') body.feed_id = state.view.id;
    if (state.view.type === 'folder') body.folder_id = state.view.id;
    await api('/api/mark-read', { method: 'POST', body: JSON.stringify(body) });
    await loadAll();
  }

  // Tracks an in-flight poll so a second click (or the `r` key) can't stack
  // concurrent polls on top of each other.
  let refreshing = false;

  // Drive the Refresh button's busy state: spinner on, label swapped, button
  // disabled. Kept in one place so every early return in refreshFeeds() can
  // hand control back with a single call.
  function setRefreshBusy(busy) {
    refreshing = busy;
    const btn = $('#refreshBtn');
    btn.classList.toggle('is-busy', busy);
    btn.disabled = busy;
    btn.setAttribute('aria-busy', String(busy));
    $('#refreshBtnLabel').textContent = busy ? 'Checking…' : '↻ Refresh';
  }

  // Manual poll. This is the one request that does NOT go through api():
  // it targets the separate poller worker on a different origin, using the URL
  // and optional secret the user pasted into the Settings modal (kept in
  // localStorage, never in the repo). Cross-origin, so the worker has to send
  // CORS headers — see corsHeaders() in worker/src/index.js.
  //
  // A poll takes as long as the slowest feed (each is capped at 10s in the
  // worker), so this can easily run for many seconds. Everything below exists
  // to make that legible: without it the button looks inert and people click
  // it repeatedly.
  async function refreshFeeds() {
    if (refreshing) return;

    const url = localStorage.getItem('rss_worker_url');
    if (!url) {
      say('Set the poller worker URL to enable refresh');
      $('#settingsModal').showModal();
      return;
    }

    setRefreshBusy(true);
    say('Checking feeds…', { sticky: true });
    try {
      const secret = localStorage.getItem('rss_worker_secret');
      const res = await fetch(url, {
        method: 'POST',
        headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      });

      // Previously unchecked: a 401 fell through to res.json(), which threw a
      // parse error and got reported as "check the worker URL" — sending you
      // to fix the one setting that was already correct.
      if (!res.ok) {
        say(res.status === 401
          ? 'Refresh rejected — wrong or missing secret in Settings'
          : `Refresh failed — worker returned ${res.status}`);
        return;
      }

      // A 200 that isn't JSON means we reached the worker but not the polling
      // route — almost always a URL missing the /refresh path, which hits the
      // worker's catch-all and returns plain text. Without this check that
      // sails past res.ok, throws inside res.json(), and gets reported as a
      // generic failure that blames a URL which looks perfectly correct.
      if (!(res.headers.get('content-type') || '').includes('json')) {
        say('URL reached the worker but not /refresh — check the path in Settings');
        return;
      }

      const summary = await res.json();
      const bits = [`Checked ${summary.checked} feed${summary.checked === 1 ? '' : 's'}`];
      bits.push(summary.newItems ? `${summary.newItems} new` : 'nothing new');
      // Surface poll failures here rather than leaving them to be discovered
      // by hovering a feed in the sidebar.
      if (summary.errors) bits.push(`${summary.errors} failed`);
      say(bits.join(', '));

      await loadAll();
    } catch {
      // fetch() itself rejected: bad URL, worker down, DNS, or a missing CORS
      // header on the worker's response.
      say('Refresh failed — check the worker URL in Settings');
    } finally {
      setRefreshBusy(false);
    }
  }

  // Posts the file's raw XML text (not JSON) to /api/opml — the explicit
  // headers option here overrides api()'s JSON default.
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

  // On phones the three columns are stacked and only one is visible at a
  // time; style.css keys off layout[data-panel]. Above 980px all three are
  // shown side by side and this is a no-op.
  function showPanel(name) {
    if (window.innerWidth > 980) return;
    layoutEl.dataset.panel = name;
  }

  // ---------- Keyboard shortcuts ----------

  // Global shortcuts, listed in the footer of index.html. Bound on document
  // rather than per-element so they work no matter what has focus.
  document.addEventListener('keydown', (e) => {
    // ...except while typing in a field, where the keys must reach the input.
    // Escape is the way back out of the search box.
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    const item = state.items[state.selected];

    switch (e.key) {
      case 'j': case 'ArrowDown':
        e.preventDefault();
        if (state.selected < state.items.length - 1) {
          selectItem(state.selected + 1);
        } else if (state.hasMore) {
          // At the bottom of a page, j pulls the next one and keeps going, so
          // reading straight through never requires reaching for the mouse.
          const from = state.selected;
          loadMore().then(() => { if (state.selected === from && from < state.items.length - 1) selectItem(from + 1); });
        }
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

  // Search fires a query 300ms after you stop typing rather than per keystroke.
  let searchDebounce;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.query = e.target.value.trim();
      loadItems();
    }, 300);
  });

  $('#settingsBtn').addEventListener('click', () => {
    renderThemeSelect();
    $('#workerUrl').value = localStorage.getItem('rss_worker_url') || '';
    $('#workerSecret').value = localStorage.getItem('rss_worker_secret') || '';
    $('#settingsModal').showModal();
  });
  // Both modals are native <dialog method="dialog"> forms: submitting sets
  // returnValue to the pressed button's value and fires 'close', so there is
  // no separate submit handler — 'save' vs 'cancel' is decided here.
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

  // Clearing value afterwards lets you re-import the same file twice; without
  // it the second selection wouldn't fire a change event.
  $('#opmlFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importOpml(e.target.files[0]);
    e.target.value = '';
  });

  // ---------- Theming ----------

  // Themes are token maps; the registry, validation and the actual applying
  // live in themes.js (loaded from <head> so the stored theme is on screen
  // before first paint). Everything here is UI: the picker in Settings and
  // the designer dialog.
  //
  // Storage is localStorage, like the worker settings — themes are a per-
  // browser preference, and there is no user table to hang them off.
  const T = globalThis.Themes;

  // Recomputed rather than cached: the custom list changes underneath us on
  // save, delete and import, and a stale copy is how you get a theme that
  // reappears after being deleted.
  function themeList() {
    return T.allThemes(T.loadCustomThemes(localStorage));
  }

  function activeThemeId() {
    return localStorage.getItem(T.ACTIVE_KEY) || T.PAPER.id;
  }

  function activeTheme() {
    return T.findTheme(themeList(), activeThemeId()) || T.PAPER;
  }

  // Apply without persisting — used for live preview while the designer is
  // open, so cancelling can put the old theme back.
  function previewTheme(theme) {
    T.applyTheme(theme, document);
  }

  function useTheme(theme) {
    localStorage.setItem(T.ACTIVE_KEY, theme.id);
    T.applyTheme(theme, document);
    renderThemeSelect();
  }

  function renderThemeSelect() {
    const sel = $('#themeSelect');
    const current = activeThemeId();
    sel.innerHTML = '';
    for (const theme of themeList()) {
      const opt = document.createElement('option');
      opt.value = theme.id;
      opt.textContent = theme.name;
      opt.selected = theme.id === current;
      sel.appendChild(opt);
    }
  }

  // ---------- Theme designer ----------

  // The theme the designer is editing, and the one to restore on cancel.
  let draft = null;
  let themeBeforeEdit = null;

  function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  }

  // Build the token rows from the registry, so a token added to
  // Themes.TOKENS becomes editable here with no change to this file.
  function renderThemeTokens(tokens) {
    const box = $('#themeTokens');
    box.innerHTML = '';
    let group = null;
    for (const token of T.TOKENS) {
      if (token.group !== group) {
        group = token.group;
        const h = document.createElement('div');
        h.className = 'theme-group';
        h.textContent = group;
        box.appendChild(h);
      }
      box.appendChild(tokenRow(token, tokens[token.name]));
    }
  }

  function tokenRow(token, value) {
    const wrap = document.createElement('label');
    wrap.className = 'theme-token';
    wrap.append(token.label);

    const inputs = document.createElement('div');
    inputs.className = 'theme-token-inputs';

    const text = document.createElement('input');
    text.type = 'text';
    text.value = value;
    text.dataset.token = token.name;

    // Colours also get a native picker. It only speaks 6-digit hex, so it is
    // driven from the text field one way and writes back the other; a token
    // holding rgb()/hsl() simply leaves the swatch showing its fallback.
    let swatch = null;
    if (token.type === 'color') {
      swatch = document.createElement('input');
      swatch.type = 'color';
      swatch.setAttribute('aria-label', `${token.label} colour picker`);
      if (/^#[0-9a-f]{6}$/i.test(value)) swatch.value = value;
      swatch.addEventListener('input', () => {
        text.value = swatch.value;
        onTokenInput(token, text, swatch);
      });
      inputs.appendChild(swatch);
    }

    text.addEventListener('input', () => onTokenInput(token, text, swatch));
    inputs.appendChild(text);
    wrap.appendChild(inputs);
    return wrap;
  }

  // Every keystroke re-validates that one token and, if it is valid, repaints
  // the app underneath the dialog. Invalid values are marked and left out of
  // the draft rather than blocking typing — half-typed hex is invalid for a
  // moment on the way to being valid.
  function onTokenInput(token, text, swatch) {
    const value = text.value.trim();
    const ok = T.isValidValue(token.name, value);
    text.classList.toggle('is-invalid', !ok);
    if (!ok) return;
    if (swatch && /^#[0-9a-f]{6}$/i.test(value)) swatch.value = value;
    draft.tokens[token.name] = value;
    previewTheme(draft);
  }

  // `base` is the theme to start from. Editing keeps its id (saving a
  // built-in's id overrides that built-in — see allThemes in themes.js);
  // duplicating clears the name, and the id is derived from whatever name is
  // typed instead.
  function openThemeDesigner(base, { duplicate = false } = {}) {
    themeBeforeEdit = activeTheme();
    draft = {
      id: duplicate ? '' : base.id,
      name: duplicate ? '' : base.name,
      dark: base.dark,
      fontImport: base.fontImport || null,
      tokens: T.resolveTokens(base),
    };

    $('#themeModalTitle').textContent = duplicate ? 'New theme' : `Edit ${base.name}`;
    $('#themeName').value = draft.name;
    $('#themeDark').checked = draft.dark;
    $('#themeFontImport').value = draft.fontImport || '';
    $('#themeError').textContent = '';
    // Deleting a built-in is meaningless — they come from the source file.
    $('#deleteThemeBtn').hidden = duplicate || T.BUILTIN.some((t) => t.id === base.id);
    renderThemeTokens(draft.tokens);
    previewTheme(draft);
    $('#themeModal').showModal();
  }

  // Assemble the draft into a theme object and run it through the same
  // validator an imported file gets. The designer's per-field checks are a
  // convenience; this is the boundary that actually decides.
  function saveDraft() {
    const name = $('#themeName').value.trim();
    if (!name) return { error: 'Give the theme a name' };

    // A renamed theme becomes a new one rather than overwriting what it was
    // duplicated from — otherwise "duplicate and tweak" would quietly destroy
    // the original.
    const original = T.findTheme(themeList(), draft.id);
    const id = (draft.id && original && original.name === name) ? draft.id : slugify(name);
    if (!id) return { error: 'Name must contain a letter or digit' };

    const { theme, errors } = T.validateTheme({
      id,
      name,
      dark: $('#themeDark').checked,
      fontImport: $('#themeFontImport').value.trim() || null,
      tokens: draft.tokens,
    });
    if (!theme) return { error: errors[0] || 'Theme is not valid' };
    if (errors.length) return { error: errors[0] };

    const custom = T.loadCustomThemes(localStorage).filter((t) => t.id !== theme.id);
    custom.push(theme);
    T.saveCustomThemes(localStorage, custom);
    return { theme };
  }

  function deleteTheme(id) {
    T.saveCustomThemes(localStorage, T.loadCustomThemes(localStorage).filter((t) => t.id !== id));
    // If the deleted theme was showing, fall back rather than leaving the
    // page painted with a theme that no longer exists.
    if (activeThemeId() === id) useTheme(T.PAPER);
    else renderThemeSelect();
  }

  // Import is the "designer by file" half of theming: a JSON file with the
  // same shape Export writes. Errors are reported in full rather than as a
  // generic failure — a hand-edited theme file is exactly the case where
  // knowing which token was rejected matters.
  async function importTheme(file) {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      say('Theme file is not valid JSON');
      return;
    }
    const { theme, errors } = T.validateTheme(parsed);
    if (!theme) {
      say(`Theme rejected — ${errors[0] || 'unrecognised format'}`);
      return;
    }
    const custom = T.loadCustomThemes(localStorage).filter((t) => t.id !== theme.id);
    custom.push(theme);
    T.saveCustomThemes(localStorage, custom);
    useTheme(theme);
    say(errors.length ? `Imported "${theme.name}" — ${errors.length} token(s) ignored` : `Theme "${theme.name}" applied`);
  }

  function exportTheme(theme) {
    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${theme.id || 'theme'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- Theme wiring ----------

  // Switching applies immediately — a theme is something you judge by looking
  // at it, so there is no separate confirm step.
  $('#themeSelect').addEventListener('change', (e) => {
    const theme = T.findTheme(themeList(), e.target.value);
    if (theme) useTheme(theme);
  });

  $('#editThemeBtn').addEventListener('click', () => openThemeDesigner(activeTheme()));
  $('#newThemeBtn').addEventListener('click', () => openThemeDesigner(activeTheme(), { duplicate: true }));

  $('#themeFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importTheme(e.target.files[0]);
    e.target.value = '';
  });

  // The dark flag and the font import are the two draft fields not owned by
  // a token row, so they update the draft themselves.
  $('#themeDark').addEventListener('change', (e) => {
    draft.dark = e.target.checked;
    previewTheme(draft);
  });
  $('#themeFontImport').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    const ok = !v || T.isFontImport(v);
    e.target.classList.toggle('is-invalid', !ok);
    $('#themeError').textContent = ok ? '' : `Must start with ${T.FONT_IMPORT_PREFIX}`;
    if (!ok) return;
    draft.fontImport = v || null;
    previewTheme(draft);
  });

  $('#exportThemeBtn').addEventListener('click', () => {
    exportTheme({ ...draft, id: draft.id || slugify($('#themeName').value.trim()) || 'theme', name: $('#themeName').value.trim() || 'Untitled' });
  });

  $('#deleteThemeBtn').addEventListener('click', () => {
    const id = draft.id;
    $('#themeModal').close('deleted');
    deleteTheme(id);
    say('Theme deleted');
  });

  // Same <dialog method="dialog"> pattern as the other two modals. Note the
  // cancel path has to undo the live preview, which has been repainting the
  // app on every keystroke.
  $('#themeModal').addEventListener('close', (e) => {
    if (e.target.returnValue === 'save') {
      const { theme, error } = saveDraft();
      if (error) {
        $('#themeError').textContent = error;
        $('#themeModal').showModal();
        return;
      }
      useTheme(theme);
      say(`Theme "${theme.name}" saved`);
    } else if (e.target.returnValue !== 'deleted') {
      previewTheme(themeBeforeEdit);
    }
    draft = null;
  });

  // ---------- Utilities ----------

  // Escape text before it goes into an innerHTML template string. Everything
  // that came from a feed and is interpolated into markup must use this.
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Compact relative-ish timestamp: time of day for today's items, month+day
  // for anything older. Uses the browser's locale.
  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // URL-scheme rules live in sanitize.js (loaded before this file) so they
  // can be unit-tested under node without a DOM — see pages/test/.
  const { URL_ATTRS, isSafeUrl, safeSrcset } = globalThis.FeedUrls;

  // Minimal sanitizer: strips dangerous elements, event handlers and unsafe
  // URL schemes before injecting feed HTML into the reading pane. Feeds are
  // content you subscribed to, but a compromised or hostile publisher should
  // not be able to run script in the app's origin — where it could read the
  // refresh secret out of localStorage and drive the /api/* routes.
  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // <base> could repoint every relative URL in the document, and
    // <meta http-equiv="refresh"> can navigate the page away; neither belongs
    // in an article body.
    doc.querySelectorAll('script, style, iframe, object, embed, base, meta, link, form')
      .forEach((el) => el.remove());

    doc.querySelectorAll('*').forEach((el) => {
      [...el.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();

        // Event handlers: onclick, onerror, and friends.
        if (/^on/i.test(name)) { el.removeAttribute(attr.name); return; }

        if (name === 'srcset') {
          const kept = safeSrcset(attr.value);
          if (kept) el.setAttribute(attr.name, kept);
          else el.removeAttribute(attr.name);
          return;
        }

        if (URL_ATTRS.includes(name)) {
          const allowDataImage = name === 'src' || name === 'poster';
          if (!isSafeUrl(attr.value, { allowDataImage })) el.removeAttribute(attr.name);
        }
      });
    });

    // Article links open in a new tab, and rel stops the opened page from
    // reaching back through window.opener or leaking the referrer.
    doc.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });

    return doc.body.innerHTML;
  }

  // ---------- Init ----------

  // Boot. The most common failure by far is the D1 binding being missing or
  // misnamed on the Pages project (see CLAUDE.md), which makes every /api/*
  // call fail at once — hence the specific hint in this message.
  renderThemeSelect();
  loadAll().catch(() => say('Could not load — check that the D1 binding is configured'));
})();
