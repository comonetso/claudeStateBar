/*
 * Policy gate — classifies a requested action and decides whether it may run, needs approval, or is refused.
 * Codex consult D6: prompt rules alone are not enough because the Asidewright layer silently ignores options
 * (`trial` really clicks, hidden targets "succeed", confirm() is auto-accepted). This module is the code-enforced half.
 *
 * Classes:  read | ui-action | data-mutation | auth-sensitive | browser-global
 *   read           → automatic
 *   ui-action      → automatic after canAct() checks (single match, visible, not covered) and post-check of activeElement
 *   data-mutation  → refused unless the caller passes an explicit approval token for this exact target
 *   auth-sensitive → refused (login, autofill menu, auth paths via repl fetch, credential values)
 *   browser-global → refused (user tabs, Browser.*, Target.* outside our own target, cookies/storage, fromSurface:false)
 */

export const CLASSES = ['read', 'ui-action', 'data-mutation', 'auth-sensitive', 'browser-global'];

const MUTATION_WORDS = /(보내|전송|저장|삭제|지우|초대|결제|구매|설정 ?변경|게시|올리|제출|수정|탈퇴|나가기|초기화|send|submit|save|delete|remove|invite|pay|publish|post|update|reset|leave)/i;
const AUTH_WORDS = /(로그인|비밀번호|비번|인증|자동 ?채우|채우기|login|password|passwd|credential|autofill|sign ?in|otp|2fa)/i;

/** CDP methods that are never allowed through the raw-CDP paths (B and C). */
export const CDP_DENY = [
  /^Browser\./, /^Storage\./, /^Network\.getAllCookies$/, /^Network\.getCookies$/, /^Network\.setCookie/, /^Network\.deleteCookies$/, /^Network\.clearBrowserCookies$/,
  /^Fetch\./, /^Debugger\.pause$/, /^Debugger\.setBreakpoint/, /^Page\.navigate$/, /^Page\.close$/, /^Page\.crash$/, /^HeapProfiler\./,
];
/** Target.* is denied on B entirely; on C only these three are allowed and only for a target this run created. */
export const CDP_TARGET_ALLOW_C = ['Target.createTarget', 'Target.attachToTarget', 'Target.closeTarget'];
/**
 * Read-only lookups allowed on C even though Target.* / Browser.* are otherwise denied: the tab list and which window a
 * tab is in. They change nothing and are what borrowTab() needs to find "the Mesa tab in the JANDI window".
 */
export const CDP_READ_ALLOW_C = ['Target.getTargets', 'Browser.getWindowForTarget'];
/** Never sent to a borrowed tab or an isolated window: they would pull the user's window to the front or close it. */
export const BORROWED_DENY = ['Page.bringToFront', 'Page.close', 'Page.crash', 'Target.activateTarget', 'Target.closeTarget'];

/** Keys/selectors the automation must never press or click. */
export const INPUT_DENY = {
  keys: [/^(Control|Meta)\+V$/i, /^Shift\+Insert$/i, /^(Control|Meta)\+C$/i, /^F(5|11|12)$/i, /^(Control|Meta)\+(W|T|N|H|J|R|Tab)$/i, /^Alt\+(Left|Right|F4)$/i, /^Alt$/i],
  selectors: [/aside-inline-menu/i, /\bbro-/i, /input\[type=file\]/i, /^select$/i, /input\[type=(date|time|datetime-local|color)\]/i],
};

export function classify(task) {
  const t = task || {};
  const text = String(t.instruction || '');
  if (t.class && CLASSES.includes(t.class)) return t.class;
  if (t.userTab || t.browserGlobal) return 'browser-global';
  if (AUTH_WORDS.test(text) || t.authSensitive) return 'auth-sensitive';
  if (MUTATION_WORDS.test(text) || t.mutates) return 'data-mutation';
  if (t.action) return 'ui-action';
  return 'read';
}

/**
 * Decide. `approval` = { class:'data-mutation', target:'<normalized url>', what:'<verb+object>', by:'user', at:'<iso>' }
 * must match the task exactly for a mutation to run.
 */
export function decide(task, approval) {
  const cls = classify(task);
  if (cls === 'read') return { allow: true, cls };
  if (cls === 'ui-action') return { allow: true, cls, require: ['canAct', 'activeElementCheck', 'denyConfirmIfDestructive'] };
  if (cls === 'data-mutation') {
    const ok = approval && approval.class === 'data-mutation' && approval.target === task.target && approval.what === task.what && approval.by === 'user';
    return ok ? { allow: true, cls, require: ['denyConfirm', 'snapshotDiff', 'cleanupPlan'] } : { allow: false, cls, why: 'explicit user approval required for this exact target/what' };
  }
  return { allow: false, cls, why: cls === 'auth-sensitive' ? 'login/credentials are human-only' : 'user tabs and browser-global operations are forbidden' };
}

/** borrowedTargets: tabs the user lent this run (see CdpClient.borrowTab) — only attachToTarget may name them. */
export function cdpAllowed(method, transport, params, ownedTargets, borrowedTargets) {
  if (transport === 'C' && CDP_READ_ALLOW_C.includes(method)) return { ok: true };
  if (CDP_DENY.some((re) => re.test(method))) return { ok: false, why: 'denied method' };
  if (method === 'Page.captureScreenshot' && params && params.fromSurface === false) return { ok: false, why: 'fromSurface:false captures the user screen' };
  if (method.startsWith('Target.')) {
    if (transport !== 'C') return { ok: false, why: 'Target.* not allowed on this transport' };
    if (!CDP_TARGET_ALLOW_C.includes(method)) return { ok: false, why: 'Target method not in C allow-list' };
    if (method !== 'Target.createTarget') {
      const id = params && params.targetId;
      const lent = method === 'Target.attachToTarget' && borrowedTargets && borrowedTargets.has(id);
      if (!id || (!lent && (!ownedTargets || !ownedTargets.has(id)))) return { ok: false, why: 'target not owned by this run' };
    }
  }
  return { ok: true };
}

/** Methods a write guard lets through untouched. */
export const SAFE_HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Does a write request pass the guard's allow-list? Entries are exact; a trailing `*` makes one a prefix.
 * "/api/v1/auth/refresh" matches that path on any origin; "https://host:port/path" matches origin+path. Query and hash
 * are never compared.
 */
export function writeAllowed(allow, url) {
  let u; try { u = new URL(url); } catch { return false; }
  const full = u.origin + u.pathname;
  return (allow || []).some((a) => {
    const s = String(a); const pre = s.endsWith('*'); const p = pre ? s.slice(0, -1) : s;
    const subject = /^https?:\/\//i.test(p) ? full : u.pathname;
    return pre ? subject.startsWith(p) : subject === p;
  });
}

/**
 * URL pattern for picking tabs. With `*` it is a glob over origin+path; without, a substring of origin+path
 * ("mesa.example.invalid:8443"). Query and hash are never looked at, so a link that merely mentions a host can't match.
 */
export function urlMatches(pattern, url) {
  if (!pattern) return false;
  let subject; try { const u = new URL(url); subject = u.origin + u.pathname; } catch { return false; }
  const p = String(pattern);
  if (!p.includes('*')) return subject.includes(p);
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*') + '$').test(subject);
}

export function keyAllowed(combo) {
  return !INPUT_DENY.keys.some((re) => re.test(combo));
}

export function selectorAllowed(sel) {
  return !INPUT_DENY.selectors.some((re) => re.test(sel));
}
