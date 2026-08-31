// URL safety rules for feed content.
//
// Split out of app.js so it can be tested directly under node — see
// pages/test/sanitize.test.js. This is the security-critical half of the
// sanitizer, and it is pure (a string in, a boolean out), which is exactly
// the shape that is worth testing.
//
// Loaded as a plain <script> before app.js; no bundler, no modules, matching
// the rest of the frontend. The module.exports line at the bottom is inert in
// a browser and is what lets the test runner import it.

(function (root) {
  // Attributes that carry a URL. A hostile scheme in one of these is a
  // script-execution vector, not merely a broken link.
  const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'poster', 'cite',
                     'background', 'longdesc', 'data', 'ping', 'xlink:href'];

  // Schemes we are willing to emit. Everything else — javascript:, vbscript:,
  // data:text/html, and anything exotic — is dropped.
  const SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'ftp:', 'ftps:', 'tel:'];

  // Is this attribute value safe to keep?
  //
  // The subtlety is that browsers are far more permissive than a naive
  // `startsWith('javascript:')` test assumes. They ignore leading and
  // trailing whitespace, and they strip C0 control characters from *inside*
  // the scheme, so every one of these executes:
  //
  //     javascript:alert(1)      JaVaScRiPt:alert(1)
  //      javascript:alert(1)     java<TAB>script:alert(1)
  //     java<LF>script:alert(1)  java<NUL>script:alert(1)
  //
  // So the value is stripped and lowercased before the scheme is read off it.
  // The stripped copy is only used for the test — the original is what stays
  // in the document, so legitimate URLs are never rewritten.
  //
  // No scheme at all means a relative URL ("/post/1", "img.png") or a
  // protocol-relative one ("//host/x"), both of which resolve against the
  // page and are fine.
  function isSafeUrl(value, options) {
    const allowDataImage = !!(options && options.allowDataImage);
    const v = String(value).replace(/[\u0000-\u0020\u007F]/g, '').toLowerCase();
    const m = /^([a-z][a-z0-9+.-]*):/.exec(v);
    if (!m) return true;
    // Inline images are common in feeds and worth keeping. SVG is excluded on
    // purpose: data:image/svg+xml can carry its own <script>.
    if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon)[;,]/.test(v)) return true;
    return SAFE_SCHEMES.indexOf(m[1] + ':') !== -1;
  }

  // srcset holds a comma-separated candidate list ("a.png 1x, b.png 2x"), so
  // each URL has to be checked on its own; unsafe candidates are dropped and
  // the caller removes the attribute entirely if none survive.
  function safeSrcset(value) {
    return String(value)
      .split(',')
      .map(function (part) { return part.trim(); })
      .filter(function (part) {
        return part && isSafeUrl(part.split(/\s+/)[0], { allowDataImage: true });
      })
      .join(', ');
  }

  root.FeedUrls = { URL_ATTRS: URL_ATTRS, SAFE_SCHEMES: SAFE_SCHEMES, isSafeUrl: isSafeUrl, safeSrcset: safeSrcset };
})(typeof globalThis !== 'undefined' ? globalThis : this);

// Inert in the browser (`module` is undefined there); the test runner uses it.
if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.FeedUrls;
