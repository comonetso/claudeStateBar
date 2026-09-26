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

export function cdpAllowed(method, transport, params, ownedTargets) {
  if (CDP_DENY.some((re) => re.test(method))) return { ok: false, why: 'denied method' };
  if (method === 'Page.captureScreenshot' && params && params.fromSurface === false) return { ok: false, why: 'fromSurface:false captures the user screen' };
  if (method.startsWith('Target.')) {
    if (transport !== 'C') return { ok: false, why: 'Target.* not allowed on this transport' };
    if (!CDP_TARGET_ALLOW_C.includes(method)) return { ok: false, why: 'Target method not in C allow-list' };
    if (method !== 'Target.createTarget') {
      const id = params && params.targetId;
      if (!id || !ownedTargets || !ownedTargets.has(id)) return { ok: false, why: 'target not owned by this run' };
    }
  }
  return { ok: true };
}

export function keyAllowed(combo) {
  return !INPUT_DENY.keys.some((re) => re.test(combo));
}

export function selectorAllowed(sel) {
  return !INPUT_DENY.selectors.some((re) => re.test(sel));
}
