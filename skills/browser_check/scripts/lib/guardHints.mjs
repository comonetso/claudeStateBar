// Hints about the write guard and login refreshes (2026-10-21, a request from the Mesa conversation).
// The guard also blocks the POST a logged-in page sends to refresh its login, so the page falls to its login screen.
// Allowing only that path (--allow-write) keeps the guard on — but a Claude that did not connect the two kept the guard
// off for weeks on a real account. These hints put the fix in the result, where it is read.

/**
 * Git Bash (MSYS) rewrites an argument that starts with "/" into a Windows path under the Git folder when it starts a
 * Windows program: `--allow-write /api/x` reached node as "C:/Program Files/Git/api/x" and silently allowed nothing
 * (2026-10-21). bin/browser-check cannot turn the rewrite off — the script path and file arguments (`run <file>`) need it
 * (turning it off broke the wrapper, same day) — so it is undone here. A site path never starts with a drive letter.
 */
export function undoMsysPath(v, env = process.env) {
  if (typeof v !== 'string' || !/^[A-Za-z]:[\\/]/.test(v)) return v;
  const norm = v.replace(/\\/g, '/');
  for (const root of [env.EXEPATH, env.MSYS_ROOT].filter(Boolean).map((r) => String(r).replace(/\\/g, '/').replace(/\/+$/, ''))) {
    if (norm.toLowerCase().startsWith(root.toLowerCase() + '/')) return norm.slice(root.length);
  }
  const m = norm.match(/^[A-Za-z]:\/(?:[^/]*\/)*?git\/(.*)$/i);   // …/Git/<rest> — the usual install folder
  return m ? '/' + m[1] : v;
}

const AUTHY = /(resume|refresh|renew|token|session|auth|login|signin|sign-in|oauth|sso)/i;
const LOGIN_PAGE = /(login|signin|sign-in|sign_in|auth|sso)/i;
const SELFTEST = '/__bc_guard_selftest';

const pathOf = (u) => { try { return new URL(u).pathname; } catch { return String(u || '').split(/[?#]/)[0]; } };
const last = (outs, k) => (outs && Array.isArray(outs[k]) && outs[k].length ? outs[k][outs[k].length - 1] : null);
const unique = (items) => [...new Set(items)];
const listed = (items, n = 3) => items.slice(0, n).join(', ') + (items.length > n ? ` (+${items.length - n})` : '');

/**
 * outs    the script's outputs (GUARD_BLOCKED · SENT · PAGE)
 * guardOn the write guard was on
 * site    the matching sites[] rule, or null
 * allow   the --allow-write paths given this run
 * url     the start URL, or null
 */
export function guardHints({ outs = {}, guardOn = false, site = null, allow = [], url = null } = {}) {
  const hints = [];
  const report = last(outs, 'GUARD_BLOCKED');
  const blocked = ((report && report.blocked) || []).filter((b) => b && pathOf(b.url) !== SELFTEST);
  const sentOut = last(outs, 'SENT');   // one list per bc.out('SENT', …) call
  const sent = (Array.isArray(sentOut) ? sentOut : []).filter((s) => s && pathOf(s.url) !== SELFTEST);
  const page = last(outs, 'PAGE');
  const endPath = page && page.url ? pathOf(page.url) : '';
  const startPath = url ? pathOf(url) : '';

  if (guardOn && blocked.length) {
    const authy = unique(blocked.filter((b) => AUTHY.test(pathOf(b.url))).map((b) => `${b.method || 'POST'} ${pathOf(b.url)}`));
    for (const item of authy.slice(0, 3)) {
      const path = item.split(' ').slice(1).join(' ');
      hints.push(`the write guard blocked ${item}, which looks like a login/session refresh — if the page fell back to a login screen, allow just that path: --allow-write ${path} (every other write stays blocked; to stop passing it each run, ask the user to add it to this site's sites[].writeAllow). Keep the guard on.`);
    }
    if (!authy.length && LOGIN_PAGE.test(endPath) && !LOGIN_PAGE.test(startPath)) {
      hints.push(`the page ended on what looks like a login screen (${endPath}) after the write guard blocked ${listed(blocked.map((b) => `${b.method} ${pathOf(b.url)}`))} — if one of them is the site's login refresh, allow only that path with --allow-write <path> and keep the guard on`);
    }
  }

  if (!guardOn && sent.length) {
    const authyOnly = sent.every((s) => AUTHY.test(pathOf(s.url)));
    hints.push(`${sent.length} write request(s) went out without the write guard (${listed(sent.map((s) => `${s.method} ${pathOf(s.url)}${s.status ? ' ' + s.status : ''}`))}) — on a real account keep the guard on: --guard-writes${authyOnly ? ' --allow-write ' + unique(sent.map((s) => pathOf(s.url))).slice(0, 3).join(' --allow-write ') : ' --allow-write <its login refresh path>'}`);
  } else if (!guardOn && site && site.login && site.login !== 'none') {
    hints.push(`ran without the write guard on a site marked logged-in (${site.match}) — a click could really post; --guard-writes with --allow-write <its login refresh path> keeps it safe`);
  }

  if (guardOn && allow.length) {
    const ruled = new Set((site && site.writeAllow) || []);
    const fresh = allow.filter((p) => !ruled.has(p));
    const worked = fresh.filter((p) => sent.some((s) => pathOf(s.url).startsWith(p) && /^2\d\d$/.test(String(s.status))));
    if (worked.length) {
      hints.push(site && site.match   // no matching rule still gives a default site object (match: null)
        ?`--allow-write ${worked.join(' ')} worked here — ask the user to add ${worked.length > 1 ? 'them' : 'it'} to the sites[].writeAllow of ${site.match} so the next run needs no flag`
        : `--allow-write ${worked.join(' ')} worked here — ask the user whether to add a sites[] rule for this site with guardWrites: true and writeAllow: [${worked.map((p) => JSON.stringify(p)).join(', ')}]`);
    }
  }
  return hints;
}
