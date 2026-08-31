// Date handling tests.
//
// Feeds publish dates in whatever format they like, and some publish garbage.
// `new Date(x).toISOString()` throws a RangeError on anything unparseable, and
// because that call sat inside the poller's per-feed try/catch, a single bad
// item used to discard every remaining item in that feed — on every poll,
// permanently. toIsoDate() exists to make that impossible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIsoDate } from '../src/index.js';

test('real date formats round-trip exactly', () => {
  // RFC 822 (RSS) and ISO 8601 (Atom) are the two that matter.
  assert.equal(toIsoDate('Mon, 30 Jun 2025 10:00:00 GMT'), '2025-06-30T10:00:00.000Z');
  assert.equal(toIsoDate('2025-06-30T10:00:00Z'), '2025-06-30T10:00:00.000Z');
  assert.equal(toIsoDate('Fri, 31 Jul 2026 00:00:00 +0000'), '2026-07-31T00:00:00.000Z');
  assert.equal(toIsoDate('2026-08-31T02:26:00+00:00'), '2026-08-31T02:26:00.000Z');
});

test('an offset is normalised to UTC rather than dropped', () => {
  assert.equal(toIsoDate('Mon, 30 Jun 2025 10:00:00 +0200'), '2025-06-30T08:00:00.000Z');
});

test('unparseable values fall back instead of throwing', () => {
  // Each of these makes new Date() return an Invalid Date, whose
  // toISOString() throws. The whole point of the function is that none of
  // them can take a feed down.
  for (const junk of ['0000-00-00', '', '   ', 'not a date', 'Mon, 99 Zzz 9999', null, undefined]) {
    assert.doesNotThrow(() => toIsoDate(junk), `threw on ${JSON.stringify(junk)}`);
    const out = toIsoDate(junk);
    assert.ok(!Number.isNaN(Date.parse(out)), `produced an unusable date for ${JSON.stringify(junk)}`);
  }
});

test('the fallback is a valid ISO timestamp near now', () => {
  const before = Date.now();
  const out = toIsoDate('total nonsense');
  const parsed = Date.parse(out);
  assert.ok(parsed >= before - 1000 && parsed <= Date.now() + 1000, `fallback was ${out}`);
  assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('output is always a string SQLite can sort', () => {
  // published_at is TEXT and the item list orders by it, so the format has to
  // be lexicographically sortable — which ISO 8601 in UTC is, and RFC 822 is not.
  const a = toIsoDate('Mon, 30 Jun 2025 10:00:00 GMT');
  const b = toIsoDate('Tue, 01 Jul 2025 10:00:00 GMT');
  assert.ok(a < b, 'ISO strings must sort chronologically as plain text');
});
