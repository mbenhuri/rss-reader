-- Personal RSS Reader — D1 schema
-- Apply with: wrangler d1 execute rss-reader --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0
);

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

CREATE INDEX IF NOT EXISTS idx_items_feed ON items(feed_id);
CREATE INDEX IF NOT EXISTS idx_items_published ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_unread ON items(is_read);
CREATE INDEX IF NOT EXISTS idx_items_starred ON items(is_starred);
