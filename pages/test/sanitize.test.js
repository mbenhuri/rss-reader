// URL-scheme tests for feed content.
//
// The reading pane injects publisher-supplied HTML with innerHTML, and this
// origin holds the refresh secret in localStorage and can drive every /api/*
// route unauthenticated. Script executing here is therefore worth more than it
// first appears, and these rules are what stop it.
//
// The attack strings below are deliberately NOT derived from the
// implementation — they come from published XSS bypass lists. That matters: a
// test written by reading the code under test only confirms the code does what
// it does, including any mistake. Anchoring to an external source is what makes
// the assertions mean something.
//
// Run with:  npm test        (from pages/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSafeUrl, safeSrcset } = require('../public/sanitize.js');

// Built from character codes so the file contains no literal control bytes —
// those are invisible in review and easily mangled by editors.
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);

test('javascript: is blocked however it is disguised', () => {
  const attacks = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'JAVASCRIPT:alert(1)',
    '   javascript:alert(1)',      // leading whitespace is ignored by browsers
    TAB + 'javascript:alert(1)',
    LF + 'javascript:alert(1)',
    'java' + TAB + 'script:alert(1)',  // control chars *inside* the scheme
    'java' + LF + 'script:alert(1)',
    'java' + CR + 'script:alert(1)',
    'java' + NUL + 'script:alert(1)',
    'java script:alert(1)',
    'javascript' + TAB + ':alert(1)',
  ];
  for (const attack of attacks) {
    assert.equal(isSafeUrl(attack), false, `leaked: ${JSON.stringify(attack)}`);
  }
});

test('other executable schemes are blocked', () => {
  for (const attack of [
    'vbscript:msgbox(1)',
    'VBScript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:application/javascript,alert(1)',
    'file:///etc/passwd',
    'about:blank',
    'blob:https://example.com/x',
    'chrome://settings',
  ]) {
    assert.equal(isSafeUrl(attack), false, `leaked: ${JSON.stringify(attack)}`);
  }
});

test('ordinary links keep working', () => {
  // A sanitizer that blocks real content is its own kind of failure.
  for (const url of [
    'https://example.com/post',
    'http://example.com/post',
    '//example.com/post',          // protocol-relative
    '/relative/path',
    'relative.html',
    '../up.png',
    '#anchor',
    '?q=1',
    'mailto:someone@example.com',
    'tel:+15551234',
    'ftp://files.example.com/x',
    'https://example.com/a?b=c&d=e#f',
  ]) {
    assert.equal(isSafeUrl(url), true, `wrongly blocked: ${JSON.stringify(url)}`);
  }
});

test('data: images are allowed for src but not for href', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  // Inline images are common in feeds, so they are permitted where an image
  // belongs...
  assert.equal(isSafeUrl(png, { allowDataImage: true }), true);
  // ...but never as a link target, where the scheme would be navigable.
  assert.equal(isSafeUrl(png), false);
});

test('data:image/svg+xml is refused even in an image position', () => {
  // SVG is the exception among image types: it can carry its own <script>.
  const svg = 'data:image/svg+xml,<svg onload=alert(1)>';
  assert.equal(isSafeUrl(svg, { allowDataImage: true }), false);
  assert.equal(isSafeUrl('data:image/svg+xml;base64,PHN2Zz4=', { allowDataImage: true }), false);
});

test('srcset drops only the bad candidates', () => {
  // One hostile candidate should not discard a whole responsive image set.
  assert.equal(
    safeSrcset('a.png 1x, javascript:alert(1) 2x, b.png 3x'),
    'a.png 1x, b.png 3x'
  );
  assert.equal(safeSrcset('javascript:alert(1) 1x'), '');
  assert.equal(safeSrcset('a.png 1x, b.png 2x'), 'a.png 1x, b.png 2x');
});

test('the allowlist is a list, not a denylist', () => {
  // Anything unrecognised must fail closed. If a new scheme is invented
  // tomorrow, the answer should be "no" until someone decides otherwise.
  assert.equal(isSafeUrl('totally-made-up-scheme:payload'), false);
  assert.equal(isSafeUrl('x:'), false);
});
