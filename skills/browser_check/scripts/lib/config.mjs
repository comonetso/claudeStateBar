/*
 * Private config loader + validator. The public plugin ships only config/schema.json and config/example.json;
 * the real values live in ${CLAUDE_PLUGIN_DATA}/config.json (0600, parent 0700) or $BROWSER_CHECK_CONFIG.
 * Unknown keys are rejected (a typo must not silently disable a policy). No network, no browser contact.
 */
import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';

const ENUMS = {
  mode: ['auto', 'local', 'remote'],
  'cdp.remote.transport': ['unix', 'tcp'],
  'cdp.policyProfile': ['safe-v1'],
  'sites[].login': ['none', 'rotating-refresh', 'session-cookie'],
  'sites[].diag': ['none', 'vite-v2.1', 'cdp-inject'],
  'sites[].darkReader': ['must-be-off-warn', 'tolerate', 'lock-silently'],
  'sites[].deepL': ['hide-and-report', 'tolerate'],
};

const KNOWN = {
  '': ['schemaVersion', 'mode', 'aside', 'cdp', 'artifacts', 'sites'],
  aside: ['enabled', 'bin', 'remoteHost', 'maxConcurrent', 'evaluateTimeoutMs', 'callTimeoutMs'],
  cdp: ['enabled', 'remote', 'local', 'policyProfile', 'connectTimeoutMs', 'commandTimeoutMs'],
  'cdp.remote': ['transport', 'socketPath', 'tcpEndpoint'],
  'cdp.local': ['endpoint', 'daemonEndpoint'],
  artifacts: ['dir', 'retentionDays', 'storeRawProtocol', 'storeScreenshots'],
  'sites[]': ['match', 'login', 'diag', 'darkReader', 'deepL', 'allowDataMutation', 'authPathPrefixes'],
};

const DEFAULTS = {
  aside: { enabled: true, maxConcurrent: 1, evaluateTimeoutMs: 25000, callTimeoutMs: 50000 },
  cdp: { enabled: true, policyProfile: 'safe-v1', connectTimeoutMs: 1000, commandTimeoutMs: 10000, remote: { transport: 'unix' } },
  artifacts: { retentionDays: 7, storeRawProtocol: false, storeScreenshots: true },
  site: { login: 'none', diag: 'none', darkReader: 'must-be-off-warn', deepL: 'hide-and-report', allowDataMutation: false, authPathPrefixes: [] },
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

/** Validate a parsed object. Returns { ok, errors[], config (with defaults applied) }. */
export function validate(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['config must be a JSON object'] };
  checkKeys(raw, '', errors);
  if (raw.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  checkEnum('mode', raw.mode, errors);
  if (raw.mode === undefined) errors.push('mode is required');

  const cfg = { schemaVersion: 1, mode: raw.mode, aside: { ...DEFAULTS.aside }, cdp: { ...DEFAULTS.cdp, remote: { ...DEFAULTS.cdp.remote }, local: {} }, artifacts: { ...DEFAULTS.artifacts }, sites: [] };

  if (raw.aside) {
    checkKeys(raw.aside, 'aside', errors);
    Object.assign(cfg.aside, raw.aside);
    if (cfg.aside.bin !== undefined && !isAbsolute(cfg.aside.bin)) errors.push('aside.bin must be an absolute path');
    checkInt('aside.maxConcurrent', cfg.aside.maxConcurrent, 1, 4, errors);
    checkInt('aside.evaluateTimeoutMs', cfg.aside.evaluateTimeoutMs, 1000, 30000, errors);
    checkInt('aside.callTimeoutMs', cfg.aside.callTimeoutMs, 5000, 55000, errors);
  }
  if (raw.cdp) {
    checkKeys(raw.cdp, 'cdp', errors);
    const { remote, local, ...rest } = raw.cdp;
    Object.assign(cfg.cdp, rest);
    if (remote) { checkKeys(remote, 'cdp.remote', errors); Object.assign(cfg.cdp.remote, remote); checkEnum('cdp.remote.transport', cfg.cdp.remote.transport, errors); if (cfg.cdp.remote.socketPath && !isAbsolute(cfg.cdp.remote.socketPath)) errors.push('cdp.remote.socketPath must be absolute'); }
    if (local) { checkKeys(local, 'cdp.local', errors); Object.assign(cfg.cdp.local, local); }
    checkEnum('cdp.policyProfile', cfg.cdp.policyProfile, errors);
    checkInt('cdp.connectTimeoutMs', cfg.cdp.connectTimeoutMs, 200, 10000, errors);
    checkInt('cdp.commandTimeoutMs', cfg.cdp.commandTimeoutMs, 1000, 60000, errors);
  }
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
      for (const k of ['login', 'diag', 'darkReader', 'deepL']) checkEnum('sites[].' + k, site[k], errors);
      cfg.sites.push(site);
    });
  }
  return { ok: errors.length === 0, errors, config: cfg };
}

/** Load from disk with permission checks. Returns { ok, path, errors[], config } and never throws. */
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
  return { ok: v.ok && errors.length === 0, path: p, errors: [...errors, ...v.errors], config: v.config };
}

/** Find the site policy for a URL (origin+path only; query/hash never considered). */
export function siteFor(config, url) {
  let origin = '', path = '/';
  try { const u = new URL(url); origin = u.origin; path = u.pathname; } catch { return { ...DEFAULTS.site, match: null }; }
  for (const s of config.sites || []) {
    const m = s.match.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (new RegExp('^' + m + '$').test(origin) || new RegExp('^' + m + '$').test(origin + path)) return s;
  }
  return { ...DEFAULTS.site, match: null };
}
