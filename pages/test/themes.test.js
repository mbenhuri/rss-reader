// Theme validation tests.
//
// Theme token values are written into an inline style declaration on <html>,
// and themes arrive from two untrusted places: a JSON file the user imports,
// and localStorage (written by an older version of this code, or by hand in
// devtools). validateTheme() is the only thing standing between those and the
// CSSOM, so what is asserted here is that it is an allowlist — a value shape
// it does not recognise is rejected, rather than a list of known-bad
// characters being stripped.
//
// Run with:  npm test        (from pages/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateTheme, isColor, isFont, isFontImport, resolveTokens, allThemes, PAPER, BUILTIN } = require('../public/themes.js');

const ok = (tokens) => validateTheme({ id: 't', name: 'T', tokens });

test('colour tokens accept hex and functional notation', () => {
  for (const v of ['#fff', '#ffff', '#1C1E1B', '#1C1E1BAA', 'rgb(12, 34, 56)', 'rgba(12,34,56,0.5)', 'hsl(120 50% 20%)']) {
    assert.equal(isColor(v), true, v);
  }
});

test('colour tokens reject anything that could fetch or escape the declaration', () => {
  const attacks = [
    'url(https://evil.example/pixel.png)',
    '#fff; background-image: url(https://evil.example/p.png)',
    '#fff} body { display: none',
    'var(--paper)',
    'red',                       // named colours are not accepted at all
    'expression(alert(1))',
    'image-set("https://evil.example/p.png")',
    '#ggg',
    '',
  ];
  for (const v of attacks) assert.equal(isColor(v), false, v);
});

test('font stacks accept ordinary families and reject url() and declaration breaks', () => {
  assert.equal(isFont("'IBM Plex Mono', ui-monospace, Menlo, monospace"), true);
  assert.equal(isFont('Georgia, serif'), true);
  for (const v of [
    'monospace; background: url(https://evil.example/p.png)',
    'monospace} .item-row { display: none',
    "local('x'), url(https://evil.example/f.woff2)",
    '"unclosed',
  ]) {
    assert.equal(isFont(v), false, v);
  }
});

test('invalid tokens are dropped, not passed through, and are reported', () => {
  const { theme, errors } = ok({ paper: '#000', ink: 'url(https://evil.example/p.png)' });
  assert.equal(theme.tokens.paper, '#000');
  assert.equal('ink' in theme.tokens, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ink/);
});

test('unknown token names are refused', () => {
  // A theme cannot invent custom properties: only names in the registry are
  // written to the CSSOM, so a theme file cannot reach rules it was never
  // meant to touch.
  const { theme, errors } = ok({ 'x-injected': '#000' });
  assert.deepEqual(theme.tokens, {});
  assert.match(errors[0], /Unknown token/);
});

test('a theme with no usable id or name is rejected outright', () => {
  assert.equal(validateTheme({ id: 'Has Spaces', name: 'T', tokens: {} }).theme, null);
  assert.equal(validateTheme({ id: 't', name: '', tokens: {} }).theme, null);
  assert.equal(validateTheme(null).theme, null);
  assert.equal(validateTheme([]).theme, null);
  assert.equal(validateTheme('{}').theme, null);
});

test('font imports are limited to the one host the CSP allows', () => {
  assert.equal(isFontImport('https://fonts.googleapis.com/css2?family=Inter'), true);
  for (const v of [
    'https://evil.example/css2?family=Inter',
    'http://fonts.googleapis.com/css2',
    'https://fonts.googleapis.com.evil.example/css2',
    'https://fonts.googleapis.com/css2?family=A" onload="x',
  ]) {
    assert.equal(isFontImport(v), false, v);
  }
  assert.equal(ok({}).theme.fontImport, null);
  assert.equal(validateTheme({ id: 't', name: 'T', tokens: {}, fontImport: 'https://evil.example/f.css' }).theme.fontImport, null);
});

test('a partial theme resolves to a complete token set', () => {
  // Midnight defines no fonts. Without the fallback, switching to it would
  // leave whatever fonts the previous theme set still applied.
  const midnight = BUILTIN.find((t) => t.id === 'midnight');
  const resolved = resolveTokens(midnight);
  assert.equal(resolved['font-display'], PAPER.tokens['font-display']);
  assert.equal(resolved.paper, midnight.tokens.paper);
  for (const name of Object.keys(PAPER.tokens)) assert.ok(resolved[name], name);
});

test('every built-in theme passes its own validator', () => {
  for (const t of BUILTIN) {
    const { theme, errors } = validateTheme(t);
    assert.deepEqual(errors, [], `${t.id}: ${errors.join(', ')}`);
    assert.equal(theme.id, t.id);
  }
});

test('a custom theme overrides a built-in of the same id', () => {
  const mine = ok({ paper: '#000' }).theme;
  const forked = { ...mine, id: 'terminal', name: 'My Terminal' };
  const list = allThemes([forked]);
  assert.equal(list.filter((t) => t.id === 'terminal').length, 1);
  assert.equal(list.find((t) => t.id === 'terminal').name, 'My Terminal');
});
