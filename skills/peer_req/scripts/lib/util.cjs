//
// util.cjs — peer_req 스크립트 공통 도구
//
// 🔴 Node 버전에 기대지 않는다 (2026-09-19 사용자 지시: "플러그인이 노드 버전에 종속되면 안 돼")
//    · CommonJS(require) 만 쓴다 — ESM·`node:` 접두어는 버전을 탄다
//    · 문법은 ES2017 까지 — `?.` `??` `||=` 객체 spread·rest, `catch {}`(바인딩 생략) 금지
//    · 최근에 생긴 API 금지 — randomUUID, fs.rmSync, mkdirSync({recursive}), Object.fromEntries …
//    고친 뒤에는 문법 검사기로 확인한다: npx acorn --ecma2017 --silent <파일>
//
// 모델에 맡기지 않는 결정적 처리(해시·ID·시각·경로 비교·원자적 쓰기)만 둔다.
//

'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROTOCOL = 'peer_req/1';

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// RFC 4122 v4 — crypto.randomUUID 는 최근 Node 에만 있다
function uuid() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

function nowIso() {
  return new Date().toISOString();
}

// 경로 비교용 정규화 — **이 스크립트가 도는 운영체제의 규칙**으로 한다(리뷰 P2).
//   Windows : 백슬래시 → 슬래시, MSYS 형식(/f/…)은 드라이브 경로로, 대소문자 무시(드라이브·UNC 모두)
//   그 밖   : 대소문자·백슬래시를 그대로 둔다. Linux 의 /f/repo 는 진짜 /f/repo 다
// 비교하는 경로는 전부 이 머신의 경로다(자기 root · 같은 머신 짝 root · 받은 요청의 recipient_root).
function normPath(p, platform) {
  if (!p) return '';
  const plat = platform || process.platform;
  let s = String(p).trim();
  if (plat === 'win32') {
    s = s.replace(/\\/g, '/');
    const msys = s.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (msys) s = msys[1] + ':' + (msys[2] || '/');
    s = s.toLowerCase();
  }
  if (s.length > 1 && !/^[a-z]:\/$/i.test(s)) s = s.replace(/\/+$/, '');
  return s;
}

function samePath(a, b, platform) {
  return normPath(a, platform) === normPath(b, platform);
}

// child 가 root 와 같거나 root 아래에 있는가
function isUnder(child, root, platform) {
  const c = normPath(child, platform);
  const r = normPath(root, platform);
  if (!c || !r) return false;
  return c === r || c.indexOf(r.charAt(r.length - 1) === '/' ? r : r + '/') === 0;
}

function isAbsolutePath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  return s.charAt(0) === '/' || /^[a-zA-Z]:\//.test(s);
}

// mkdirSync({recursive}) 는 Node 10.12 부터라 직접 만든다
function mkdirp(dir) {
  if (!dir || fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

function tmpName(file) {
  return file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
}

function unlinkQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    // 없으면 그만이다
  }
}

// 임시 파일에 쓰고 rename — 쓰다 만 파일을 다른 프로세스가 읽지 않게 한다(덮어쓰기용).
function writeFileAtomic(file, text) {
  mkdirp(path.dirname(file));
  const tmp = tmpName(file);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

// 처음 한 번만 게시한다 — 다 쓴 임시 파일을 link 로 붙인다. 이미 있으면 false.
// link 는 대상이 있으면 실패하므로 여러 프로세스가 동시에 해도 승자는 하나이고,
// 게시된 파일은 항상 완성본이다(1차 리뷰 P2: wx 로 열자마자 남이 반쪽을 읽던 문제).
//
// 하드링크를 못 거는 파일시스템에서는 폴더 선점(mkdir 은 원자적이다)으로 승자를 정하고,
// 승자만 완성본을 rename 으로 붙인다(2차 리뷰 P2: 폴백이 wx 로 반쪽을 드러내던 문제).
// 그래서 폴백에서는 "선점은 됐는데 파일이 아직 없는" 짧은 순간이 있다 — 읽는 쪽은 그걸
// 진행 중으로 다룬다(store.createRequestRecord). 기다리는 시간 값은 두지 않는다.
function publishOnce(file, text) {
  mkdirp(path.dirname(file));
  const tmp = tmpName(file);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    if (process.env.PEER_REQ_NO_LINK !== '1') {
      try {
        fs.linkSync(tmp, file);
        return true;
      } catch (e) {
        if (e.code === 'EEXIST') return false;
        if (['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EOPNOTSUPP'].indexOf(e.code) === -1) throw e;
      }
    }
    try {
      fs.mkdirSync(file + '.claim');
    } catch (e2) {
      if (e2.code === 'EEXIST') return false;
      throw e2;
    }
    if (fs.existsSync(file)) return false;
    fs.renameSync(tmp, file);
    return true;
  } finally {
    unlinkQuiet(tmp);
  }
}

// 게시 선점은 됐는데 완성본이 아직 없는가(폴백 경로의 진행 중)
function publishPending(file) {
  return !fs.existsSync(file) && fs.existsSync(file + '.claim');
}

// 이 사용자만 읽을 수 있는 임시 폴더(2차 리뷰 P1: 여러 계정이 쓰는 머신의 /tmp 에 본문이 드러나던 문제).
// mkdtemp 는 0700 으로 만든다. 쓰는 파일은 0600. 다 쓰면 rmTree 로 지운다.
function privateTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'peer_req-'));
}

function writePrivate(file, text) {
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 384 }); // 0o600
}

function rmTree(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    return;
  }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach((n) => rmTree(path.join(p, n)));
    try {
      fs.rmdirSync(p);
    } catch (e) {
      // 못 지우면 그만이다
    }
  } else {
    unlinkQuiet(p);
  }
}

// ───────────────────────── 외부 프로그램 실행 ─────────────────────────
// 🔴 Windows 는 디렉터리 없이 준 실행 파일 이름을 **현재 폴더에서 먼저** 찾는다(CreateProcess·cmd.exe).
//    짝 저장소나 보내는 저장소 안의 ssh.exe·scp.exe·git.exe·claude.cmd 가 대신 실행될 수 있다(리뷰 P1, 재현함).
//    그래서 PATH 의 절대 경로 항목에서만 찾아 **절대경로로** 실행하고, 자식 환경에
//    NoDefaultCurrentDirectoryInExePath=1 을 넣어 그 자식(예: claude.cmd 가 부르는 node)도 현재 폴더를 안 보게 한다.

function findOnPath(name) {
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  const exts = process.platform === 'win32' ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (let i = 0; i < dirs.length; i++) {
    for (let j = 0; j < exts.length; j++) {
      const f = path.join(dirs[i], name + exts[j]);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch (e) {
        // 없다
      }
    }
  }
  return null;
}

function safeEnv(env) {
  return Object.assign({}, env || process.env, { NoDefaultCurrentDirectoryInExePath: '1' });
}

// spawnSync 와 같은 모양의 결과를 돌려준다. 못 찾으면 { error:{code:'ENOENT'} }.
function runExe(name, args, opts) {
  const exe = findOnPath(name);
  if (!exe) return { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'PATH 에서 ' + name + ' 를 찾지 못했다' } };
  const o = Object.assign({}, opts || {});
  o.env = safeEnv(o.env);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
    // .cmd·.bat 은 cmd.exe 를 거쳐야 한다. 인자는 호출하는 쪽이 공백·따옴표 없는 고정값만 넘긴다.
    const line = '"' + ['"' + exe + '"'].concat(args.map((a) => '"' + a + '"')).join(' ') + '"';
    o.windowsVerbatimArguments = true;
    return childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], o);
  }
  return childProcess.spawnSync(exe, args, o);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

// 사용자 홈의 Claude 설정 디렉토리. CLAUDE_CONFIG_DIR 를 따른다.
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// 머신 전용 상태(선언·락·캐시). Git 에 올리지 않는다.
// 우선순위: --state-dir(= PEER_REQ_STATE) → CLAUDE_PLUGIN_DATA(훅) → OS 기본 위치
function stateDir() {
  const fromEnv = process.env.PEER_REQ_STATE || process.env.CLAUDE_PLUGIN_DATA;
  if (fromEnv && fromEnv.indexOf('${') === -1) return fromEnv;
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'peer_req');
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'peer_req');
}

function shortId(id) {
  return String(id || '').slice(0, 8);
}

module.exports = {
  PROTOCOL,
  sha256,
  uuid,
  nowIso,
  normPath,
  samePath,
  isUnder,
  isAbsolutePath,
  mkdirp,
  unlinkQuiet,
  writeFileAtomic,
  writeJsonAtomic,
  publishOnce,
  publishPending,
  privateTmpDir,
  writePrivate,
  rmTree,
  findOnPath,
  runExe,
  readJson,
  claudeHome,
  stateDir,
  shortId,
};
