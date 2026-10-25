//
// projects.cjs — 짝 목록 = 프로젝트 매니저(claude-state-bar)의 "보임" 프로젝트 (리규형님 결정 2026-10-13)
//
//   PC     : <PASEO_HOME>/plugin-data/claude-state-bar/project-list/projects.json  ← 정본. 읽기만 한다
//   서버   : <PASEO_HOME>/claude-state-bar/pc-offline-projects.json               ← PC 가 보내 주는 사본. recipient = 이 서버의 별칭
// 항목의 기기(host)는 PC 또는 PC 의 ~/.ssh/config 별칭이다. 경로 비교는 그 기기의 운영체제 규칙을 따른다.
// 🔴 이름은 열쇠로 쓰지 않는다 — 같은 이름이 목록에 여러 번 나온다(실제로 있다). 열쇠 = host + path.
// 🔴 cwd 가 여러 항목 아래에 들면 가장 구체적인(경로가 긴) 항목이 그 대화의 프로젝트다. 그 항목이 숨김이면 짝이 아니다
//    (숨긴 하위 프로젝트를 보임인 상위 경로로 우회하지 못하게).
//

'use strict';

const fs = require('fs');
const path = require('path');
const util = require('./util.cjs');
const mailbox = require('./mailbox.cjs');

function canonicalFile() {
  return path.join(mailbox.paseoHome(), 'plugin-data', 'claude-state-bar', 'project-list', 'projects.json');
}

function copyFile() {
  return path.join(mailbox.paseoHome(), 'claude-state-bar', 'pc-offline-projects.json');
}

function hostOf(rootPath) {
  if (rootPath.indexOf('vscode-remote://') !== 0) return 'PC';
  const authority = rootPath.slice('vscode-remote://'.length).split('/')[0].replace(/^ssh-remote\+/, '');
  try {
    const decoded = JSON.parse(Buffer.from(authority, 'hex').toString('utf8'));
    if (decoded && typeof decoded.hostName === 'string') return decoded.hostName;
  } catch (e) {
    // 16진이 아닌 옛 형식은 별칭 그대로
  }
  return decodeURIComponent(authority);
}

function pathOf(rootPath) {
  if (rootPath.indexOf('vscode-remote://') !== 0) return rootPath;
  const rest = rootPath.slice('vscode-remote://'.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? '/' : decodeURIComponent(rest.slice(slash));
}

// 그 기기 경로의 비교 규칙 — PC 는 Windows(대소문자 무시), 서버는 Linux
function platformOfHost(host) {
  return host === 'PC' ? 'win32' : 'linux';
}

function keyOf(host, p) {
  return host + '|' + util.normPath(p, platformOfHost(host));
}

// 반환: { ok, self, entries:[{name, host, path, enabled, key}], source, error }
//   self = 이 기기의 이름(PC 또는 별칭)
// 카테고리 — 이름이 겹칠 때 사용자가 후보를 구분하는 데만 쓴다. 없으면 null
function categoryOf(o) {
  return typeof o.category === 'string' && o.category.trim() ? o.category.trim() : null;
}

// PC 원본 한 줄 → 항목(PC 와 서버가 같은 모양으로 읽는다)
function entryOf(o) {
  return o && typeof o.rootPath === 'string' && typeof o.name === 'string' ? { name: o.name.trim(), category: categoryOf(o), host: hostOf(o.rootPath), path: pathOf(o.rootPath), enabled: o.enabled !== false } : null;
}

// 서버는 PC 원본을 ssh 로 바로 읽는다(10-25 리규형님 — 저장한 사본은 PC 가 바꿀 때만 보내고 실패하면 다시 안 보낸다). 못 읽으면 null(사본으로).
// 서버 셋 모두 `ssh BluemingPC` 로 PC(cmd)에 닿는다(browser-check 중계와 같은 길 · 실측 0.4초). PEER_MAIL_PC_READ=0 이면 안 읽는다(시험은 끈다)
function readPcCanonical() {
  if (process.env.PEER_MAIL_PC_READ === '0') return null;
  const host = process.env.PEER_MAIL_PC_HOST || 'BluemingPC';
  try {
    const out = require('child_process').execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', host,
      'type "%USERPROFILE%\\.paseo\\plugin-data\\claude-state-bar\\project-list\\projects.json"'],
    { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    return null;
  }
}

function load() {
  let raw = null;
  let source = null;
  let self = null;
  if (fs.existsSync(canonicalFile())) {
    source = canonicalFile();
    self = 'PC';
    try {
      const arr = JSON.parse(fs.readFileSync(source, 'utf8'));
      if (!Array.isArray(arr)) return { ok: false, error: 'the project list is not an array: ' + source };
      raw = arr.map(entryOf);
    } catch (e) {
      return { ok: false, error: 'could not read the project list: ' + e.message };
    }
  } else if (fs.existsSync(copyFile())) {
    source = copyFile();
    try {
      const j = JSON.parse(fs.readFileSync(source, 'utf8'));
      self = typeof j.recipient === 'string' && j.recipient ? j.recipient : null;
      raw = (Array.isArray(j.entries) ? j.entries : []).map((o) => (o && typeof o.name === 'string' && typeof o.host === 'string' && typeof o.path === 'string' ? { name: o.name.trim(), category: categoryOf(o), host: o.host, path: o.path, enabled: o.enabled !== false } : null));
    } catch (e) {
      return { ok: false, error: 'could not read the project list copy: ' + e.message };
    }
    // 이 기기 이름(recipient)은 사본에서, 목록은 PC 원본이 읽히면 그것으로
    const live = readPcCanonical();
    if (live) {
      raw = live.map(entryOf);
      source = 'PC live: %USERPROFILE%\\.paseo\\plugin-data\\claude-state-bar\\project-list\\projects.json (fallback ' + copyFile() + ')';
    }
  } else {
    return { ok: false, error: 'no project list on this machine (the claude-state-bar project manager is needed)' };
  }
  if (process.env.PEER_MAIL_SELF_HOST) self = process.env.PEER_MAIL_SELF_HOST; // 시험용
  if (!self) return { ok: false, error: 'this machine does not know its own name in the project list (' + source + ')' };
  const entries = raw.filter(Boolean).map((e) => Object.assign(e, { key: keyOf(e.host, e.path) }));
  return { ok: true, self: self, entries: entries, source: source };
}

// 이 기기에서 cwd 가 속한 프로젝트 — 가장 구체적인 항목. 숨김이면 visible:false 로 돌려준다
function projectOf(entries, host, cwd) {
  const plat = platformOfHost(host);
  const hits = entries.filter((e) => e.host === host && util.isUnder(cwd, e.path, plat));
  if (!hits.length) return null;
  hits.sort((a, b) => util.normPath(b.path, plat).length - util.normPath(a.path, plat).length);
  return hits[0];
}

// --to 해석: "host:path" 또는 이름(보임 중에 하나뿐일 때만). 반환 { ok, entry } | { ok:false, error, candidates }
function resolveTo(entries, to) {
  const visible = entries.filter((e) => e.enabled);
  const t = String(to || '').trim();
  if (!t) return { ok: false, error: '--to is empty', candidates: [] };
  // 관리 화면 우클릭 "경로 포함 이름 복사"의 한 줄 "이름 (기기:경로)"(10-25 리규형님) — 기기·경로로 찾는다(이름은 사람이 알아보는 표시).
  // 이름·경로에 괄호가 있어도 되게 목록에 있는 기기 이름으로 " (기기:" 를 뒤에서 찾는다
  if (t.endsWith(')')) {
    for (const h of [...new Set(entries.map((e) => e.host))]) {
      const mark = '(' + h + ':';
      const at = t.startsWith(mark) ? 0 : t.lastIndexOf(' ' + mark) + 1;
      if (at <= 0 && !t.startsWith(mark)) continue;
      const key = keyOf(h, t.slice(at + mark.length, -1).trim());
      const hit = visible.filter((e) => e.key === key);
      if (hit.length === 1) return { ok: true, entry: hit[0] };
      if (entries.some((e) => !e.enabled && e.key === key)) return { ok: false, error: '"' + t + '" is hidden in the project manager — only visible projects can be reached', candidates: [] };
      const name = t.slice(0, at).trim();
      return { ok: false, error: 'no visible project at ' + h + ':' + t.slice(at + mark.length, -1).trim() + ' — the copied line may be old; copy it again from the project menu', candidates: visible.filter((e) => name && e.name === name) };
    }
  }
  const colon = t.indexOf(':');
  if (colon > 0 && !/^[a-zA-Z]:[\\/]/.test(t)) {
    const host = t.slice(0, colon);
    const p = t.slice(colon + 1);
    const hit = visible.filter((e) => e.key === keyOf(host, p));
    if (hit.length === 1) return { ok: true, entry: hit[0] };
    const hidden = entries.filter((e) => !e.enabled && e.key === keyOf(host, p));
    if (hidden.length) return { ok: false, error: '"' + t + '" is hidden in the project manager — only visible projects can be reached', candidates: [] };
  }
  const byName = visible.filter((e) => e.name === t);
  if (byName.length === 1) return { ok: true, entry: byName[0] };
  if (byName.length > 1) return { ok: false, error: byName.length + ' visible projects are named "' + t + '" — use host:path', candidates: byName };
  const loose = visible.filter((e) => e.name.toLowerCase().indexOf(t.toLowerCase()) !== -1);
  return { ok: false, error: 'no visible project "' + t + '"', candidates: loose.slice(0, 10) };
}

module.exports = { canonicalFile, copyFile, hostOf, pathOf, platformOfHost, keyOf, load, projectOf, resolveTo };
