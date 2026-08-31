// Feed parser tests.
//
// These run against fixtures/ — real feed XML captured from live sites, plus
// one hand-written file for an edge case real feeds rarely produce. The point
// of using captured bytes rather than invented XML is that real feeds are
// stranger than anything you would think to write: unusual namespaces, escaped
// HTML by the thousand, Unicode display names, dates in four formats.
//
// Parser breakage is the worst kind of bug in this project because it is
// silent. Nothing crashes and no error reaches the UI beyond a tooltip — a
// feed simply never appears. One of the feeds below went weeks without syncing
// for exactly that reason.
//
// Run with:  npm test        (from worker/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFeed } from '../src/index.js';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// name -> what it is, and what we know is true about it.
const FEEDS = {
  'rss-entity-heavy.xml': {
    format: 'RSS 2.0',
    title: 'Vegan Home Cooks',
    items: 21,
    note: 'The regression case: ~4000 entity refs from escaped HTML in <description>.',
  },
  'rdf-slashdot.xml': {
    format: 'RSS 1.0 / RDF',
    title: 'Slashdot',
    items: 15,
    note: 'Items are siblings of <channel>, not nested inside it.',
  },
  'atom-real.xml': {
    format: 'Atom',
    title: 'The GitHub Blog',
    items: 10,
    note: 'Article URL lives in <link href>, not element text.',
  },
  'rss-single-item.xml': {
    format: 'RSS 2.0',
    title: 'Single Item Blog',
    items: 1,
    note: 'One <item> parses as an object, not an array.',
  },
};

for (const [file, expected] of Object.entries(FEEDS)) {
  test(`${expected.format}: ${file} parses`, () => {
    const feed = parseFeed(fixture(file));
    assert.equal(feed.title, expected.title);
    assert.equal(feed.items.length, expected.items, expected.note);
  });
}

test('every item has a guid', () => {
  // guid is what UNIQUE(feed_id, guid) dedupes on. An item without one is
  // skipped by the poller; if the fallback chain ever broke, feeds would
  // either lose items or re-insert them on every single poll.
  for (const file of Object.keys(FEEDS)) {
    for (const item of parseFeed(fixture(file)).items) {
      assert.ok(String(item.guid || '').length > 0, `${file}: item "${item.title}" has no guid`);
    }
  }
});

test('every item has a title and a link', () => {
  for (const file of Object.keys(FEEDS)) {
    for (const item of parseFeed(fixture(file)).items) {
      assert.ok(String(item.title || '').length > 0, `${file}: an item has no title`);
      assert.ok(String(item.link || '').startsWith('http'), `${file}: "${item.title}" has no usable link`);
    }
  }
});

test('escaped HTML in the body is decoded, not left as entities', () => {
  // This is the assertion that fails if the entity expansion limit is ever
  // lowered again, or if a parser upgrade changes entity handling.
  const feed = parseFeed(fixture('rss-entity-heavy.xml'));
  const body = feed.items[0].content;
  assert.ok(body.includes('<'), 'body should contain real tags');
  assert.ok(!body.includes('&lt;'), 'body should not still hold escaped entities');
});

test('Atom articles link to the page, not to the feed', () => {
  // Atom carries several <link> elements; we want rel="alternate", which is
  // the article. Picking the wrong one sends every "open original" to the feed.
  const feed = parseFeed(fixture('atom-real.xml'));
  for (const item of feed.items) {
    assert.ok(!item.link.endsWith('.xml'), `linked to a feed, not an article: ${item.link}`);
  }
});

test('the site URL is a string, never a parsed object', () => {
  // <link> with attributes parses to an object; storing that yields the
  // literal "[object Object]" in the database.
  for (const file of Object.keys(FEEDS)) {
    const { siteUrl } = parseFeed(fixture(file));
    assert.ok(typeof siteUrl === 'string' || siteUrl === undefined, `${file}: siteUrl is ${typeof siteUrl}`);
    if (siteUrl) assert.ok(!siteUrl.includes('[object'), `${file}: siteUrl not flattened`);
  }
});

test('an unrecognized document is rejected, not silently empty', () => {
  // A feed URL that actually serves an HTML page is a common mistake. It must
  // throw so the reason lands in feeds.last_error, rather than parsing to
  // zero items and looking like a feed that simply has no posts.
  assert.throws(() => parseFeed('<html><body><h1>Not a feed</h1></body></html>'), /Unrecognized feed format/);
  assert.throws(() => parseFeed(''), /Unrecognized feed format/);
});
