//
// paseo.cjs — Paseo 통로 (2026-10-13)
//
// Remote Control 목록에 짝 세션이 안 보일 때 쓰는 두 번째 통로다. Remote Control 통로는 그대로 둔다.
//   · Paseo 에서 연 대화는 Remote Control 이 꺼져 있다(사용자 결정 2026-10-10 — 화면이 겹쳐 보이는 문제).
//     그래서 ListAgents 로 다른 머신 세션을 못 보고, 쉬는 Paseo 대화는 프로세스가 없어 같은 머신 목록에도 없다.
//     계정이 다른 대화(회사 Team ↔ 개인)도 Remote Control 목록에서 서로 안 보인다.
//   · Paseo 데몬은 계정과 상관없이 그 기기의 대화를 다 안다. `paseo ls` 로 짝 폴더의 대화를 찾고
//     `paseo send` 로 그 대화에 요청을 넣는다. 쉬는 대화는 Paseo 가 깨워서 받게 한다.
//     다른 기기는 `--host ssh://<host_alias>` — 이 기기의 SSH 설정으로 그 기기 데몬에 붙는다
//     (2026-10-13 실측: PC → CallAdmin 서버, 비밀번호 없이 목록을 읽었다).
//
// 🔴 Paseo 의 send 는 상대가 일하는 중이면 **끊고(interrupt) 새 말로 시작**하고, 권한 확인을 기다리던 것도
//    치운다(데몬 기본값 activeTurnBehavior "interrupt" · clearPendingPermissions — CLI 로는 바꿀 수 없다,
//    Paseo 0.11.1 코드 확인). 그래서 상대가 쉬고 있을 때만 넣는다. 일하는 중이면 `paseo wait` 로 끝나길
//    기다리고, 권한 확인을 기다리는 중이면 보내지 않고 멈춘다. 확인과 보내기 사이의 짧은 틈은 남는다
//    (그 사이 사용자가 말을 걸면 그 턴이 끊긴다).
// 🔴 답은 보낸 쪽이 가져온다. 서버에서 PC 로는 SSH 가 닿지 않아 받는 쪽이 답을 넣어 줄 길이 없다.
//    받는 쪽은 평소처럼 receive·reply 로 자기 저장소 기록에 남기기만 하고(머리말이 "보내지 마라" 로 바뀐다),
//    보낸 쪽이 그 기록을 읽어 온다 — 같은 머신은 sync 와 같은 방식, 다른 머신은 SSH 로 읽기만(collect).
// 🔴 SSH 는 닿는 방향만 된다(PC→서버). 서버에서 PC·다른 서버로는 이 통로가 없다 — unreachable 로 알린다.
//
// 대상 고르기 — 짝 기준은 "기기 + 프로젝트 경로"다(2026-09-21 사용자 결정). 그 기기 Paseo 대화 중 작업 폴더가
// 짝 root 와 같거나 그 아래인 것이 후보다.
//   ① 기억한 대화(받았다는 답이 온 뒤 기억한 Paseo 대화 번호)가 후보에 있으면 그것
//   ② 후보가 하나면 그것 — 받았다는 답이 오면 기억한다
//   ③ 없으면 unreachable, 여럿이면 사용자에게 묻는다(짐작하지 않는다)
//

'use strict';

const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const util = require('./util.cjs');
const ab = require('./addressbook.cjs');

const PREFIX = 'paseo:';

// ───────────────────────── 실행 ─────────────────────────

// Paseo CLI 위치. Paseo 대화 안에서는 PASEO_CLI 가 들어 있다(2026-10-13 실측). VS Code·터미널 세션은
// PATH 의 paseo(서버는 npm 전역 설치), 그것도 없으면 Windows 데스크톱 앱의 기본 설치 위치.
// PEER_REQ_PASEO_CLI 는 시험용 덮어쓰기다(.js·.cjs 면 node 로 돈다).
function findCli() {
  const forced = process.env.PEER_REQ_PASEO_CLI;
  if (forced) return path.isAbsolute(forced) && util.isFile(forced) ? forced : null;
  const env = process.env.PASEO_CLI;
  if (env && path.isAbsolute(env) && util.isFile(env)) return env;
  const onPath = util.findOnPath('paseo');
  if (onPath) return onPath;
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const f = path.join(base, 'Programs', 'Paseo', 'resources', 'bin', 'paseo.cmd');
    if (util.isFile(f)) return f;
  }
  return null;
}

// 반환: { ok, json, error } — 출력은 늘 --json 으로 받는다
function run(args) {
  const cli = findCli();
  if (!cli) return { ok: false, error: 'the paseo command was not found on this machine (PASEO_CLI · PATH · the desktop app folder)' };
  // 작업 폴더는 CLI 가 있는 폴더 — Paseo 가 --host ssh:// 로 ssh 를 부를 때 저장소 안의 ssh.exe 를 찾지 않게 한다
  const opts = { cwd: path.dirname(cli), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 };
  const p = /\.(c?js|mjs)$/i.test(cli) ? childProcess.spawnSync(process.execPath, [cli].concat(args), Object.assign({}, opts, { env: Object.assign({}, process.env, { NoDefaultCurrentDirectoryInExePath: '1' }) })) : util.runAt(cli, args, opts);
  if (p.error) return { ok: false, error: 'could not run paseo: ' + (p.error.message || p.error.code) };
  const out = String(p.stdout || '').trim();
  let json = null;
  try {
    json = out ? JSON.parse(out) : null;
  } catch (e) {
    json = null;
  }
  if (p.status !== 0 || json === null) {
    const err = String(p.stderr || '').trim() || out;
    return { ok: false, error: 'paseo ' + args[0] + ' failed (exit ' + p.status + '): ' + err.slice(0, 400) };
  }
  return { ok: true, json: json };
}

function withHost(args, host) {
  return host ? args.concat(['--host', host]) : args;
}

// 같은 머신이면 null(이 기기 데몬), 다른 머신이면 ssh://<host_alias>
function hostFor(book, peer) {
  if (util.sameMachine(peer.machine_id, book.self.machine_id)) return { host: null };
  const alias = peer.location && peer.location.host_alias;
  if (!alias) return { error: 'the peer is on another machine but has no location.host_alias (the Host name in ~/.ssh/config) — Paseo on that machine cannot be reached' };
  if (!ab.HOST_RE.test(alias)) return { error: 'bad host_alias format: ' + alias };
  return { host: 'ssh://' + alias };
}

function list(host) {
  const r = run(withHost(['ls', '-g', '--json'], host));
  if (!r.ok) return r;
  if (!Array.isArray(r.json)) return { ok: false, error: 'paseo ls did not return a list' };
  return { ok: true, agents: r.json };
}

function inspect(host, id) {
  return run(withHost(['inspect', id, '--json'], host));
}

function wait(host, id, timeoutSec) {
  const args = ['wait', id, '--json'];
  if (timeoutSec) args.push('--timeout', String(timeoutSec));
  return run(withHost(args, host));
}

function send(host, id, file) {
  return run(withHost(['send', id, '--no-wait', '--prompt-file', file, '--json'], host));
}

// ───────────────────────── 대상 고르기 ─────────────────────────

// 짝 경로를 비교할 규칙 — 그 기기의 운영체제를 따른다(Linux 는 대소문자를 가린다)
function platformOf(peer) {
  const o = peer.location && peer.location.os;
  if (o === 'windows') return 'win32';
  if (o === 'macos') return 'darwin';
  if (o === 'linux') return 'linux';
  return /^[a-zA-Z]:[\\/]/.test(String(peer.location && peer.location.root)) ? 'win32' : 'linux';
}

const CLOSED = ['closed'];

function candidatesOf(agents, peer, selfAgentId) {
  const plat = platformOf(peer);
  return agents.filter((a) => a && typeof a.id === 'string' && a.id !== selfAgentId && CLOSED.indexOf(a.status) === -1 && util.isUnder(a.cwd, peer.location.root, plat));
}

function asCandidate(a) {
  return { send_to: PREFIX + a.id, agent_id: a.id, short_id: a.shortId || a.id.slice(0, 7), name: a.name || a.title || null, status: a.status || null, cwd: a.cwd || null, provider: a.provider || null };
}

// ── 기억(머신 상태) — 짝마다 파일 하나: paseo_agents/<endpoint_id>.json
//    { agent_id, host, name, source, picked_at, selected_at, invalidated_at }
function memoryFile(endpointId) {
  if (!ab.ID_RE.test(endpointId || '')) throw new Error('bad endpoint_id format: ' + endpointId);
  return path.join(util.stateDir(), 'paseo_agents', endpointId + '.json');
}

function readMemory(endpointId) {
  return util.readJson(memoryFile(endpointId), null);
}

function remember(endpointId, o) {
  const prev = readMemory(endpointId);
  const now = util.nowIso();
  const rec = { agent_id: o.agent_id, host: o.host || null, name: o.name || null, source: o.source || 'auto', picked_at: now, selected_at: o.selectedAt || now, invalidated_at: prev ? prev.invalidated_at || null : null };
  util.writeJsonAtomic(memoryFile(endpointId), rec);
  return rec;
}

function forgetMemory(endpointId) {
  const prev = readMemory(endpointId);
  util.writeJsonAtomic(memoryFile(endpointId), { agent_id: null, invalidated_at: util.nowIso() });
  return !!(prev && prev.agent_id);
}

// 받았다는 답이 왔다 — 그때 고른 대화를 기억한다(sessions.promoteRoute 와 같은 규칙: 고른 때로 최신을 정한다)
function promote(endpointId, route, sentAt) {
  if (!route || !route.agent_id || !route.remember) return null;
  const after = (t) => !!(t && sentAt && t > sentAt);
  const cur = readMemory(endpointId);
  if (cur && after(cur.invalidated_at)) return { kind: 'paseo', skipped: 'invalidated' };
  if (cur && cur.agent_id === route.agent_id) return { kind: 'paseo', unchanged: true };
  if (cur && cur.agent_id && after(cur.selected_at || cur.picked_at)) return { kind: 'paseo', skipped: 'newer' };
  return { kind: 'paseo', rec: remember(endpointId, { agent_id: route.agent_id, host: route.host, name: route.name, source: route.source, selectedAt: sentAt }) };
}

// "대상 아님" 이 왔다 — 그 대화를 기억해 두었으면 지운다
function forgetIfRemembered(endpointId, agentId) {
  const cur = readMemory(endpointId);
  if (!cur || !cur.agent_id || cur.agent_id !== agentId) return false;
  return forgetMemory(endpointId);
}

// 한 짝의 Paseo 대상. 반환 모양은 sessions.resolvePeer 와 같다(+ transport·paseo).
//   o: { book, alias, pick?, claimed? }
function resolve(o) {
  const peer = ab.peersOf(o.book)[o.alias];
  const same = util.sameMachine(peer.machine_id, o.book.self.machine_id);
  const base = { alias: o.alias, endpoint_id: peer.endpoint_id, same_machine: same, transport: 'paseo' };
  const make = (extra) => Object.assign({}, base, extra);
  const h = hostFor(o.book, peer);
  if (h.error) return make({ status: 'unreachable', reason: h.error });
  const l = list(h.host);
  if (!l.ok) return make({ status: 'unreachable', reason: 'could not list Paseo conversations' + (h.host ? ' on ' + h.host : ' on this machine') + ' — ' + l.error });
  const claimed = (o.claimed && o.claimed.paseo) || {};
  const cands = candidatesOf(l.agents, peer, same ? process.env.PASEO_AGENT_ID || null : null).filter((a) => !claimed[a.id]);
  const where = (h.host || 'this machine') + ' · ' + peer.location.root;
  const ready = (a, via, extra) => make(Object.assign({ status: 'ready', via: via, send_to: PREFIX + a.id, paseo: { host: h.host, agent_id: a.id, name: a.name || a.title || null, status: a.status || null }, remember: true }, extra || {}));

  if (o.pick) {
    const key = String(o.pick).indexOf(PREFIX) === 0 ? o.pick.slice(PREFIX.length) : o.pick;
    const hits = cands.filter((a) => a.id === key || (key.length >= 6 && a.id.indexOf(key) === 0));
    if (hits.length === 1) return ready(hits[0], 'user_pick', { source: 'user' });
    return make({ status: 'ask', reason: '--pick "' + o.pick + '" does not match exactly one Paseo conversation in ' + where + ' (' + hits.length + ')', candidates: cands.map(asCandidate) });
  }
  const mem = readMemory(peer.endpoint_id);
  if (mem && mem.agent_id) {
    const hit = cands.filter((a) => a.id === mem.agent_id);
    if (hit.length === 1) return ready(hit[0], 'remembered_paseo', { source: 'remembered' });
  }
  const note = mem && mem.agent_id ? 'the Paseo conversation chosen earlier (' + mem.agent_id.slice(0, 8) + ') is gone — archived or deleted' : null;
  if (cands.length === 1) return ready(cands[0], 'paseo_only_candidate', { source: 'auto', note: note });
  if (cands.length === 0) return make({ status: 'unreachable', reason: 'no Paseo conversation is open in ' + where, note: note });
  return make({ status: 'ask', reason: cands.length + ' Paseo conversations are open in ' + where + ' — choose one (it is remembered after the peer acknowledges)', note: note, candidates: cands.map(asCandidate) });
}

module.exports = { PREFIX, findCli, run, hostFor, list, inspect, wait, send, platformOf, candidatesOf, readMemory, remember, forgetMemory, forgetIfRemembered, promote, resolve };
