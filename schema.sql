-- Personal RSS Reader — D1 schema
-- Apply with (from worker/, where wrangler.toml lives):
--   wrangler d1 execute rss-reader --remote --file=../schema.sql
--
-- Everything is CREATE ... IF NOT EXISTS, so re-running this file is safe and
-- is how you add a new table or index. It does NOT migrate existing tables —
-- adding a column to `items` means a separate ALTER TABLE run by hand.
--
-- Three tables: folders 1—N feeds 1—N items.
-- Dates are stored as ISO-8601 TEXT (SQLite has no date type); booleans are
-- INTEGER 0/1.

-- Sidebar groupings. A feed may have no folder ("unfiled"), and deleting a
-- folder keeps its feeds (see the ON DELETE SET NULL below).
-- sort_order is reserved for manual ordering — nothing writes it yet.
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0
);

-- One subscription. Only `url` is supplied when you subscribe; title,
-- site_url and last_fetched are filled in by the poller worker on its first
-- successful fetch. last_error holds the reason the most recent poll failed
-- (NULL when the last poll was fine) and drives the warning styling in the
-- sidebar.
CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  site_url TEXT,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  last_fetched TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- One article. The UNIQUE(feed_id, guid) at the bottom is the load-bearing
-- constraint of the whole system: the poller re-reads every feed on each run
-- and relies on an INSERT ... ON CONFLICT DO NOTHING against it to skip items
-- it has already stored. guid is the feed's own identifier for the item, so a
-- publisher that changes its guids will produce duplicates.
--
-- content = the full article HTML if the feed ships it; summary = the excerpt.
-- Both are rendered client-side through a sanitizer before being injected.
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT,
  link TEXT,
  author TEXT,
  published_at TEXT,
  content TEXT,
  summary TEXT,
  is_read INTEGER DEFAULT 0,
  is_starred INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(feed_id, guid)
);

-- Indexes for the three access paths: per-feed lists, the default
-- newest-first ordering, and the unread/starred filters.
CREATE INDEX IF NOT EXISTS idx_items_feed ON items(feed_id);
CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_unread ON items(is_read);
CREATE INDEX IF NOT EXISTS idx_items_starred ON items(is_starred);
