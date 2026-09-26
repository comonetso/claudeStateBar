/*
 * Central redactor — every artifact, log line, dump and event that leaves the plugin passes through here.
 * Rules (Codex consult D6): metadata-first; never store URL query/hash, authorization/cookie/set-cookie headers,
 * password/token/code-like fields, or request/response bodies unredacted. Fixture-tested in test/redact.test.mjs.
 */
export const SECRET_KEY =
  /^(password|new_?password|current_?password|old_?password|temporary_?password|initial_?password|pass|passwd|pwd|token|access_?token|refresh_?token|id_?token|reset_?token|challenge_?token|ticket|secret|client_?secret|api_?key|authorization|cookie|set-cookie|otp|verification_?code|auth_?code|code|session|csrf|xsrf)$/i;

const SECRET_QUERY = /([?&](?:ticket|token|access_token|refresh_token|code|sig|signature|key|session|auth)=)[^&#]*/gi;
const KV_TEXT = /((?:^|[&\s"'`,{])(?:password|pass|pwd|token|access_token|refresh_token|ticket|secret|otp|code|authorization)\s*[=:]\s*)["']?[^&\s"'`,}]*/gi;
const BEARER = /\b(Bearer|Basic|AsideDaemonSessionToken)\s+[A-Za-z0-9._~+/=-]{8,}/g;

export function redactUrl(u) {
  if (typeof u !== 'string') return u;
  try {
    const x = new URL(u);
    return x.origin + x.pathname + (x.search ? x.search.replace(SECRET_QUERY, '$1***') : '');
  } catch {
    return u.replace(SECRET_QUERY, '$1***').replace(/#.*$/, '');
  }
}

/** Drop query and hash entirely (for site matching and artifact names). */
export function normalizeUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u).split(/[?#]/)[0]; }
}

export function redactText(s) {
  if (typeof s !== 'string') return s;
  return s.replace(BEARER, '$1 ***').replace(KV_TEXT, '$1***').replace(SECRET_QUERY, '$1***');
}

function walk(v, depth) {
  if (depth > 12) return '[depth]';
  if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
  if (v && typeof v === 'object') {
    const r = {};
    for (const k of Object.keys(v)) {
      if (SECRET_KEY.test(k)) { r[k] = '***'; continue; }
      if (/^(url|href|src|location|referrer)$/i.test(k) && typeof v[k] === 'string') { r[k] = redactUrl(v[k]); continue; }
      if (/^(headers|requestHeaders|responseHeaders)$/i.test(k) && v[k] && typeof v[k] === 'object') { r[k] = redactHeaders(v[k]); continue; }
      r[k] = walk(v[k], depth + 1);
    }
    return r;
  }
  if (typeof v === 'string') return redactText(v);
  return v;
}

export function redactHeaders(h) {
  const out = {};
  for (const [k, val] of Object.entries(h || {})) {
    out[k] = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token)$/i.test(k) ? '***' : val;
  }
  return out;
}

/** Deep-redact any JSON-serialisable value (objects, arrays, strings). Returns a new value. */
export function redact(v) {
  return walk(v, 0);
}

/** Redact a text body if it looks like JSON, else apply key=value masking. Clips to `max` chars. */
export function redactBody(text, max = 2000) {
  if (typeof text !== 'string') return text;
  let out = text;
  const s = text.trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try { out = JSON.stringify(redact(JSON.parse(s))); } catch { out = redactText(text); }
  } else out = redactText(text);
  return out.length > max ? out.slice(0, max) + '…(' + out.length + ')' : out;
}
