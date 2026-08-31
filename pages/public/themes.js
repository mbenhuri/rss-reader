// Theme registry and validation.
//
// The whole UI is already drawn from a small set of CSS custom properties, so
// a "theme" is just a map of token name -> value. Applying one sets those
// properties inline on <html>, which wins over the :root defaults in
// style.css without touching any stylesheet.
//
// This file has no DOM dependencies above applyTheme(), and is exported for
// node the same way sanitize.js is, so the validator can be unit-tested.
//
// SECURITY: token values are written into an inline style declaration. That is
// not a script sink, but CSS values can still fetch (url(...)) or escape their
// declaration (a stray ; or }), so validateTheme() is a strict ALLOWLIST on
// value shape, not a blocklist on bad characters. Anything a theme file can
// carry must pass one of the per-type patterns below. Loosen those patterns
// only if you have thought about url() and about `}`.
(() => {
  // The token contract. Order and grouping here drive the designer UI, so a
  // new token shows up in the editor as soon as it is listed — nothing else
  // to register. `type` selects both the validation rule and the input widget.
  const TOKENS = [
    { name: 'paper',        type: 'color', group: 'Surfaces', label: 'Background' },
    { name: 'paper-raised', type: 'color', group: 'Surfaces', label: 'Raised background' },
    { name: 'line',         type: 'color', group: 'Surfaces', label: 'Border' },
    { name: 'line-soft',    type: 'color', group: 'Surfaces', label: 'Border (soft)' },

    { name: 'ink',          type: 'color', group: 'Text', label: 'Text' },
    { name: 'ink-muted',    type: 'color', group: 'Text', label: 'Text (muted)' },
    { name: 'ink-faint',    type: 'color', group: 'Text', label: 'Text (faint)' },

    { name: 'accent',        type: 'color', group: 'Accent', label: 'Accent' },
    { name: 'accent-strong', type: 'color', group: 'Accent', label: 'Accent (strong)' },
    { name: 'accent-soft',   type: 'color', group: 'Accent', label: 'Accent (soft)' },
    { name: 'unread-dot',    type: 'color', group: 'Accent', label: 'Unread dot' },
    { name: 'danger',        type: 'color', group: 'Accent', label: 'Error' },

    { name: 'font-display', type: 'font', group: 'Type', label: 'Headlines & article body' },
    { name: 'font-ui',      type: 'font', group: 'Type', label: 'Interface' },
    { name: 'font-mono',    type: 'font', group: 'Type', label: 'Monospace' },

    { name: 'radius',       type: 'length', group: 'Shape', label: 'Corner radius' },
  ];

  const TOKEN_NAMES = TOKENS.map((t) => t.name);
  const TOKEN_BY_NAME = Object.fromEntries(TOKENS.map((t) => [t.name, t]));

  // ---------- Value validation ----------

  // #rgb / #rrggbb / #rrggbbaa, or rgb()/rgba()/hsl()/hsla() with plain
  // numeric arguments. Deliberately narrow: no var(), no colour functions that
  // take arbitrary nested syntax, no named colours (a typo'd name silently
  // renders black, which is worse than a rejection).
  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const FUNC = /^(?:rgb|rgba|hsl|hsla)\(\s*[-0-9.,%\s/deg]+\)$/i;

  function isColor(v) {
    return typeof v === 'string' && (HEX.test(v.trim()) || FUNC.test(v.trim()));
  }

  // A font stack: comma-separated families, each either a quoted string or a
  // bare identifier. No url(), no semicolons, no braces — so a value cannot
  // close its own declaration and start a new rule.
  const FONT_FAMILY = /^(?:'[^'";{}()]+'|"[^'";{}()]+"|[A-Za-z][A-Za-z0-9\s-]*)$/;

  function isFont(v) {
    if (typeof v !== 'string') return false;
    const parts = v.split(',').map((p) => p.trim());
    return parts.length > 0 && parts.length <= 8 && parts.every((p) => p && FONT_FAMILY.test(p));
  }

  const LENGTH = /^\d{1,3}(?:\.\d+)?(?:px|rem|em|%)?$/;

  function isLength(v) {
    return typeof v === 'string' && LENGTH.test(v.trim());
  }

  const VALIDATORS = { color: isColor, font: isFont, length: isLength };

  function isValidValue(tokenName, value) {
    const token = TOKEN_BY_NAME[tokenName];
    if (!token) return false;
    return VALIDATORS[token.type](value);
  }

  // Web-font stylesheets a theme may pull in. Restricted to the one host the
  // CSP already permits in style-src — a theme naming any other origin would
  // fail as a console CSP error rather than an obvious one, so reject it here
  // where the message can say why.
  const FONT_IMPORT_PREFIX = 'https://fonts.googleapis.com/';

  function isFontImport(v) {
    return typeof v === 'string' && v.startsWith(FONT_IMPORT_PREFIX) && !/["'<>\\\s]/.test(v);
  }

  const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

  // Validate a theme object parsed from JSON (an imported file, or something
  // read back out of localStorage — both are untrusted). Returns
  // { theme, errors }: `theme` is a clean copy containing ONLY recognised
  // tokens with valid values, `errors` lists every rejection. A theme with
  // errors is still usable — the bad tokens simply fall back to the default
  // ones — so the caller decides whether to warn or refuse.
  function validateTheme(input) {
    const errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { theme: null, errors: ['Not a theme object'] };
    }

    const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : '';
    if (!ID.test(id)) errors.push('id must be lowercase letters, digits and dashes');

    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 60) errors.push('name must be 1-60 characters');

    const tokens = {};
    const given = (input.tokens && typeof input.tokens === 'object' && !Array.isArray(input.tokens))
      ? input.tokens
      : (errors.push('tokens must be an object'), {});

    for (const [key, value] of Object.entries(given)) {
      if (!TOKEN_BY_NAME[key]) { errors.push(`Unknown token "${key}"`); continue; }
      if (!isValidValue(key, value)) { errors.push(`Invalid ${TOKEN_BY_NAME[key].type} for "${key}"`); continue; }
      tokens[key] = String(value).trim();
    }

    let fontImport = null;
    if (input.fontImport != null && input.fontImport !== '') {
      if (isFontImport(input.fontImport)) fontImport = input.fontImport;
      else errors.push(`fontImport must start with ${FONT_IMPORT_PREFIX}`);
    }

    // `dark` is a hint, not a colour: it flips the browser's own UI (form
    // controls, scrollbars) via color-scheme so a dark theme doesn't get a
    // white scrollbar nailed to its side.
    const dark = input.dark === true;

    if (!ID.test(id) || !name) return { theme: null, errors };
    return { theme: { id, name, dark, fontImport, tokens }, errors };
  }

  // ---------- Built-in themes ----------

  // Paper is the original design, and doubles as the fallback: any token a
  // theme leaves out is inherited from here rather than from whatever theme
  // happened to be applied before it.
  const PAPER = {
    id: 'paper',
    name: 'Paper',
    dark: false,
    fontImport: null,
    tokens: {
      'paper': '#F1F0EA',
      'paper-raised': '#FBFAF6',
      'ink': '#1C1E1B',
      'ink-muted': '#6B6E64',
      'ink-faint': '#9A9C90',
      'line': '#DDDACE',
      'line-soft': '#E8E6DC',
      'accent': '#2F5D50',
      'accent-strong': '#234840',
      'accent-soft': '#DEE8E2',
      'unread-dot': '#B4552E',
      'danger': '#A6402F',
      'font-display': "'Source Serif 4', Georgia, serif",
      'font-ui': "'Inter', system-ui, sans-serif",
      'font-mono': "'IBM Plex Mono', ui-monospace, Menlo, monospace",
      'radius': '3px',
    },
  };

  // Terminal: one typeface, phosphor green on near-black. accent-strong is
  // BRIGHTER than accent here (the reverse of Paper) because on a dark ground
  // emphasis reads as more light, not less — a theme is free to invert that
  // relationship, nothing in the CSS assumes a direction.
  const TERMINAL = {
    id: 'terminal',
    name: 'Terminal',
    dark: true,
    fontImport: null,
    tokens: {
      'paper': '#080B08',
      'paper-raised': '#0E140E',
      'ink': '#38F26B',
      'ink-muted': '#1F9E45',
      'ink-faint': '#15702F',
      'line': '#173D22',
      'line-soft': '#102A18',
      'accent': '#5BFF8F',
      'accent-strong': '#A8FFC4',
      'accent-soft': '#12301B',
      'unread-dot': '#FFB000',
      'danger': '#FF5F56',
      'font-display': "'IBM Plex Mono', ui-monospace, Menlo, monospace",
      'font-ui': "'IBM Plex Mono', ui-monospace, Menlo, monospace",
      'font-mono': "'IBM Plex Mono', ui-monospace, Menlo, monospace",
      'radius': '0px',
    },
  };

  // Midnight exists to prove the system generalises — a plain dark theme that
  // keeps Paper's typography. If adding a third built-in feels like work, the
  // registry has a problem.
  const MIDNIGHT = {
    id: 'midnight',
    name: 'Midnight',
    dark: true,
    fontImport: null,
    tokens: {
      'paper': '#15171B',
      'paper-raised': '#1C1F24',
      'ink': '#E4E6EB',
      'ink-muted': '#9BA1AC',
      'ink-faint': '#6E747E',
      'line': '#2C3037',
      'line-soft': '#23272D',
      'accent': '#7AA2F7',
      'accent-strong': '#A9C4FF',
      'accent-soft': '#232B3B',
      'unread-dot': '#E0A458',
      'danger': '#F07178',
      'radius': '3px',
    },
  };

  const BUILTIN = [PAPER, TERMINAL, MIDNIGHT];

  // ---------- Storage ----------

  const ACTIVE_KEY = 'rss_theme';
  const CUSTOM_KEY = 'rss_custom_themes';

  // Custom themes come back through validateTheme() on every read: what is in
  // localStorage was written by an earlier version of this code, or by hand,
  // and neither is a reason to trust it.
  function loadCustomThemes(storage) {
    try {
      const raw = storage.getItem(CUSTOM_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((t) => validateTheme(t).theme).filter(Boolean);
    } catch {
      return [];
    }
  }

  function saveCustomThemes(storage, themes) {
    storage.setItem(CUSTOM_KEY, JSON.stringify(themes));
  }

  // Built-ins first, then custom. A custom theme whose id collides with a
  // built-in REPLACES it, which is how you tweak Terminal without forking the
  // file: export it, edit, import under the same id.
  function allThemes(custom) {
    const byId = new Map(BUILTIN.map((t) => [t.id, t]));
    for (const t of custom) byId.set(t.id, t);
    return [...byId.values()];
  }

  function findTheme(themes, id) {
    return themes.find((t) => t.id === id) || null;
  }

  // Fill in from Paper so a partial theme (Midnight defines no fonts) still
  // produces a complete set of properties, and so switching themes can never
  // leave a token behind from the previous one.
  function resolveTokens(theme) {
    return { ...PAPER.tokens, ...(theme ? theme.tokens : {}) };
  }

  // ---------- Applying ----------

  // Write the resolved tokens onto <html> as inline custom properties. Values
  // have been through validateTheme() for anything user-supplied; the built-in
  // themes above are trusted by construction.
  function applyTheme(theme, doc) {
    const root = doc.documentElement;
    const tokens = resolveTokens(theme);
    for (const name of TOKEN_NAMES) root.style.setProperty(`--${name}`, tokens[name]);

    // A few rules in style.css key off the theme id / darkness rather than a
    // token — see the [data-theme] block there.
    root.setAttribute('data-theme', theme ? theme.id : PAPER.id);
    root.style.colorScheme = theme && theme.dark ? 'dark' : 'light';

    applyFontImport(theme && theme.fontImport, doc);
  }

  // A theme may name one Google Fonts stylesheet. Exactly one <link> is
  // reused across theme switches, so cycling themes cannot accumulate them.
  function applyFontImport(href, doc) {
    const ID_ATTR = 'themeFontImport';
    let link = doc.getElementById(ID_ATTR);
    if (!href) { if (link) link.remove(); return; }
    if (!isFontImport(href)) return;
    if (!link) {
      link = doc.createElement('link');
      link.id = ID_ATTR;
      link.rel = 'stylesheet';
      doc.head.appendChild(link);
    }
    if (link.href !== href) link.href = href;
  }

  const api = {
    TOKENS, TOKEN_NAMES, BUILTIN, PAPER,
    ACTIVE_KEY, CUSTOM_KEY, FONT_IMPORT_PREFIX,
    isColor, isFont, isLength, isValidValue, isFontImport,
    validateTheme, resolveTokens, allThemes, findTheme,
    loadCustomThemes, saveCustomThemes, applyTheme,
  };

  globalThis.Themes = api;

  // Apply the stored theme at parse time. themes.js is loaded from <head>,
  // before any of the page renders, so the correct colours are on <html>
  // before first paint — loading it with the other scripts at the end of
  // <body> would show a flash of Paper on every load of a dark theme.
  if (typeof document !== 'undefined') {
    try {
      const stored = localStorage.getItem(ACTIVE_KEY);
      const themes = allThemes(loadCustomThemes(localStorage));
      applyTheme(findTheme(themes, stored) || PAPER, document);
    } catch {
      // Private-mode localStorage throws on read. Paper is the CSS default,
      // so doing nothing here is already the right outcome.
    }
  }
  // Exported for the node test runner, same arrangement as sanitize.js.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
