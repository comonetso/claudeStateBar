/*
 * Private config loader + validator. The public plugin ships only config/schema.json and config/example.json;
 * the real values live in ${CLAUDE_PLUGIN_DATA}/config.json (0600, parent 0700) or $BROWSER_CHECK_CONFIG.
 * Unknown keys are rejected (a typo must not silently disable a policy). No network, no browser contact.
 *
 * schemaVersion 2 = ego lite (2026-10-21). A schemaVersion 1 file is the old Aside layout: it is reported, never
 * read as if it were current — `setup --migrate` rewrites it (site rules kept, the old file backed up).
 */
import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';

const ENUMS = {
  'sites[].login': ['none', 'rotating-refresh', 'session-cookie'],
};

const KNOWN = {
  '': ['schemaVersion', 'ego', 'artifacts', 'sites'],
  ego: ['enabled', 'bin', 'remoteHost', 'relayEntry', 'relayDir', 'callTimeoutMs', 'settleMs', 'light'],
  artifacts: ['dir', 'retentionDays', 'storeScreenshots'],
  'sites[]': ['match', 'login', 'allowDataMutation', 'authPathPrefixes', 'guardWrites', 'writeAllow'],
};

const DEFAULTS = {
  ego: { enabled: true, callTimeoutMs: 300000, settleMs: 15000, light: true },
  artifacts: { retentionDays: 7, storeScreenshots: true },
  site: { login: 'none', allowDataMutation: false, authPathPrefixes: [], guardWrites: false, writeAllow: [] },
};

export function configPath() {
  if (process.env.BROWSER_CHECK_CONFIG) return process.env.BROWSER_CHECK_CONFIG;
  if (process.env.CLAUDE_PLUGIN_DATA) return resolve(process.env.CLAUDE_PLUGIN_DATA, 'config.json');
  return null;
}

function checkKeys(obj, scope, errors) {
  const allowed = KNOWN[scope] || [];
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`unknown key "${scope ? scope + '.' : ''}${k}"`);
}
function checkEnum(path, val, errors) {
  const e = ENUMS[path];
  if (e && val !== undefined && !e.includes(val)) errors.push(`${path} must be one of ${e.join('|')}`);
}
function checkInt(path, val, min, max, errors) {
  if (val === undefined) return;
  if (!Number.isInteger(val) || val < min || val > max) errors.push(`${path} must be an integer in [${min},${max}]`);
}

/** Validate a parsed object. Returns { ok, errors[], config (with defaults applied), oldLayout? }. */
export function validate(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['config must be a JSON object'] };
  if (raw.schemaVersion === 1) return { ok: false, oldLayout: true, errors: ['schemaVersion 1 is the old Aside layout — run `setup --migrate` (keeps the site rules, backs the old file up)'] };
  checkKeys(raw, '', errors);
  if (raw.schemaVersion !== 2) errors.push('schemaVersion must be 2');

  const cfg = { schemaVersion: 2, ego: { ...DEFAULTS.ego }, artifacts: { ...DEFAULTS.artifacts }, sites: [] };
  if (raw.ego) {
    checkKeys(raw.ego, 'ego', errors);
    Object.assign(cfg.ego, raw.ego);
    if (cfg.ego.bin !== undefined && !isAbsolute(cfg.ego.bin)) errors.push('ego.bin must be an absolute path');
    if (cfg.ego.remoteHost !== undefined && (typeof cfg.ego.remoteHost !== 'string' || !/^[\w.@-]+$/.test(cfg.ego.remoteHost))) errors.push('ego.remoteHost must be an ssh host name');
    if (cfg.ego.relayEntry !== undefined && (typeof cfg.ego.relayEntry !== 'string' || /["\r\n]/.test(cfg.ego.relayEntry))) errors.push('ego.relayEntry must be a path without quotes');
    checkInt('ego.callTimeoutMs', cfg.ego.callTimeoutMs, 5000, 1800000, errors);
    checkInt('ego.settleMs', cfg.ego.settleMs, 1000, 120000, errors);
    if (typeof cfg.ego.light !== 'boolean') errors.push('ego.light must be true or false');
  }
  if (!cfg.ego.bin && !cfg.ego.remoteHost) errors.push('ego needs bin (ego lite on this machine) or remoteHost (the PC, over ssh)');
  if (raw.artifacts) {
    checkKeys(raw.artifacts, 'artifacts', errors);
    Object.assign(cfg.artifacts, raw.artifacts);
    if (cfg.artifacts.dir !== undefined && !isAbsolute(cfg.artifacts.dir)) errors.push('artifacts.dir must be absolute');
    checkInt('artifacts.retentionDays', cfg.artifacts.retentionDays, 1, 90, errors);
  }
  if (raw.sites !== undefined) {
    if (!Array.isArray(raw.sites)) errors.push('sites must be an array');
    else raw.sites.forEach((s, i) => {
      if (!s || typeof s !== 'object') { errors.push(`sites[${i}] must be an object`); return; }
      checkKeys(s, 'sites[]', errors);
      if (!s.match) errors.push(`sites[${i}].match is required`);
      const site = { ...DEFAULTS.site, ...s };
      checkEnum('sites[].login', site.login, errors);
      if (s.guardWrites !== undefined && typeof s.guardWrites !== 'boolean') errors.push(`sites[${i}].guardWrites must be true or false`);
      if (s.writeAllow !== undefined && (!Array.isArray(s.writeAllow) || s.writeAllow.some((p) => typeof p !== 'string' || !p))) errors.push(`sites[${i}].writeAllow must be an array of paths or URLs`);
      cfg.sites.push(site);
    });
  }
  return { ok: errors.length === 0, errors, config: cfg };
}

/** Load from disk with permission checks. Returns { ok, path, errors[], config, oldLayout?, raw? } and never throws. */
export function load() {
  const p = configPath();
  if (!p) return { ok: false, path: null, errors: ['no CLAUDE_PLUGIN_DATA and no BROWSER_CHECK_CONFIG'] };
  if (!existsSync(p)) return { ok: false, path: p, errors: ['config file not found'] };
  const errors = [];
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) errors.push('config is a symlink (refused)');
    // Windows has no POSIX mode bits: Node reports 0o666 whatever the ACL says, so this check could only ever fail
    // there and the plugin never ran on a PC. Owner decision (2026-09-26): skip it on Windows; POSIX keeps it.
    if (process.platform !== 'win32') {
      if ((st.mode & 0o077) !== 0) errors.push('config mode must be 0600');
      const pst = lstatSync(dirname(p));
      if ((pst.mode & 0o077) !== 0) errors.push('config parent dir mode must be 0700');
    }
  } catch (e) { errors.push('stat failed: ' + e.message); }
  let raw;
  try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return { ok: false, path: p, errors: [...errors, 'JSON parse: ' + e.message] }; }
  const v = validate(raw);
  return { ok: v.ok && errors.length === 0, path: p, errors: [...errors, ...v.errors], config: v.config, oldLayout: !!v.oldLayout, raw };
}

/** Find the site policy for a URL (origin+path only; query/hash never considered). */
export function siteFor(config, url) {
  let origin = '', path = '/';
  try { const u = new URL(url); origin = u.origin; path = u.pathname; } catch { return { ...DEFAULTS.site, match: null }; }
  for (const s of (config && config.sites) || []) {
    const m = s.match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (new RegExp('^' + m + '$').test(origin) || new RegExp('^' + m + '$').test(origin + path)) return s;
  }
  return { ...DEFAULTS.site, match: null };
}

/** Site rules from an old (schemaVersion 1) file that still mean something with ego. */
export function migrateSites(oldSites) {
  const keep = KNOWN['sites[]'];
  return (Array.isArray(oldSites) ? oldSites : []).filter((s) => s && s.match).map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => keep.includes(k))));
}
