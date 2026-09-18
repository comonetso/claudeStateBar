//
// peer.test.mjs — TODO P2 의 완료 기준을 그대로 옮긴 테스트
//   node --test skills/peer_req/test/peer.test.mjs   (테스트만 Node 18+ — 플러그인 자체는 버전 무관)
//
// 실제 ~/.claude 와 운영 저장소를 건드리지 않는다. 임시 폴더에 가짜 홈·가짜 저장소를 만든다.
//

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateBook, findDuplicateKeys } = require('../scripts/lib/addressbook.cjs');
const { makeRequest, renderMessage, extractEnvelope, checkEnvelope, HEADER_VERSION, headerHash } = require('../scripts/lib/envelope.cjs');
const { appendEvent, listEvents } = require('../scripts/lib/store.cjs');
const { fold } = require('../scripts/lib/state.cjs');
const { parseAgents, titleMatches } = require('../scripts/lib/sessions.cjs');
const { sha256, normPath, publishOnce } = require('../scripts/lib/util.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PEER = path.join(HERE, '..', 'scripts', 'peer.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `peerreq-${prefix}-`));
}

function fwd(p) {
  return p.replace(/\\/g, '/');
}

// ───────────── I2 주소록 ─────────────

function goodBook(root) {
  return {
    schema_version: 1,
    self: { endpoint_id: 'pc.a', machine_id: 'm1', root },
    peers: {
      b: { endpoint_id: 'pc.b', machine_id: 'm1', location: { os: 'windows', root: 'C:/work/b' } },
      srv: { endpoint_id: 'srv.api', machine_id: 'srv', location: { os: 'linux', root: '/home/api' }, session_selector: { rc_title: 'SRV · API', accept_numeric_suffix: true } },
    },
    groups: { both: ['b', 'srv'] },
  };
}

test('I2 정상 주소록은 통과한다', () => {
  const dir = tmp('book');
  const file = path.join(dir, '.peer_req.json');
  const r = validateBook(JSON.stringify(goodBook(fwd(dir))), file);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('I2 필수 필드가 빠지면 잡는다', () => {
  const dir = tmp('book');
  const b = goodBook(fwd(dir));
  delete b.self.machine_id;
  delete b.peers.srv.session_selector;
  const r = validateBook(JSON.stringify(b), path.join(dir, '.peer_req.json'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('self.machine_id')));
  assert.ok(r.errors.some((e) => e.includes('rc_title')));
});

test('I2 중복 별칭을 잡는다 (JSON.parse 가 삼키는 것)', () => {
  const dir = tmp('book');
  const text = `{"schema_version":1,"self":{"endpoint_id":"pc.a","machine_id":"m1","root":${JSON.stringify(fwd(dir))}},
    "peers":{"b":{"endpoint_id":"pc.b","machine_id":"m1","location":{"root":"C:/w/b"}},
             "b":{"endpoint_id":"pc.c","machine_id":"m1","location":{"root":"C:/w/c"}}}}`;
  assert.deepEqual(findDuplicateKeys(text), ['peers.b']);
  const r = validateBook(text, path.join(dir, '.peer_req.json'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('중복 키: peers.b')));
});

test('I2 잘못된 root 를 잡는다 (상대경로 · 주소록 위치와 다름 · 자기 자신)', () => {
  const dir = tmp('book');
  const b1 = goodBook('relative/path');
  assert.ok(validateBook(JSON.stringify(b1), path.join(dir, '.peer_req.json')).errors.some((e) => e.includes('절대경로')));
  const b2 = goodBook('C:/somewhere/else');
  assert.ok(validateBook(JSON.stringify(b2), path.join(dir, '.peer_req.json')).errors.some((e) => e.includes('다른 저장소에서 복사')));
  const b3 = goodBook(fwd(dir));
  b3.peers.b.location.root = fwd(dir);
  assert.ok(validateBook(JSON.stringify(b3), path.join(dir, '.peer_req.json')).errors.some((e) => e.includes('자기 자신')));
});

// ───────────── I3 envelope ─────────────

const SENDER = { endpoint_id: 'pc.a', root: 'C:/w/a' };
const RECIP = { endpoint_id: 'pc.b', root: 'C:/w/b' };

test('I3 같은 입력은 같은 해시, 본문 1바이트가 바뀌면 해시가 바뀐다', () => {
  const e1 = makeRequest({ sender: SENDER, recipient: RECIP, intent: 'query', body: '안녕' });
  const e2 = makeRequest({ sender: SENDER, recipient: RECIP, intent: 'query', body: '안녕' });
  const e3 = makeRequest({ sender: SENDER, recipient: RECIP, intent: 'query', body: '안녕!' });
  assert.equal(e1.body_sha256, e2.body_sha256);
  assert.notEqual(e1.body_sha256, e3.body_sha256);
  assert.equal(e1.body_sha256, sha256('안녕'));
});

test('I3 머리말 버전·해시가 envelope 에 기록된다', () => {
  const e = makeRequest({ sender: SENDER, recipient: RECIP, intent: 'notice', body: 'x' });
  assert.equal(e.header_version, HEADER_VERSION);
  assert.equal(e.header_sha256, headerHash('notice'));
  assert.notEqual(headerHash('notice'), headerHash('query'));
});

test('I3 메시지로 렌더한 뒤 다시 꺼내면 같은 envelope 이고, 본문을 고치면 검증에 걸린다', () => {
  const e = makeRequest({ sender: SENDER, recipient: RECIP, intent: 'query', body: '줄1\n```peer_req\n본문 속 가짜 블록\n```\n줄3' });
  const msg = renderMessage(e);
  assert.ok(msg.split('\n')[0].startsWith('[peer_req/1] 질문'));
  const back = extractEnvelope(msg.replace(/\n/g, '\r\n')); // CRLF 로 옮겨져도
  assert.deepEqual(back, e);
  assert.deepEqual(checkEnvelope(back), []);
  back.body += ' ';
  assert.ok(checkEnvelope(back).some((p) => p.includes('body_sha256')));
});

// ───────────── I4 동시 기록 ─────────────

test('I4 두 프로세스가 동시에 이벤트를 써도 유실·파손이 없다', async () => {
  const dir = tmp('race');
  const N = 150;
  const storePath = path.join(HERE, '..', 'scripts', 'lib', 'store.cjs');
  const code = `const { appendEvent } = require(${JSON.stringify(storePath)});
    const [dir, tag, n] = process.argv.slice(1);
    for (let i = 0; i < Number(n); i++) appendEvent(dir, { type: 'received', recipient: tag, detail: String(i) });`;
  const run = (tag) => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', code, dir, tag, String(N)], { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`exit ${c}`))));
  });
  await Promise.all([run('A'), run('B')]);
  const evs = listEvents(dir);
  assert.equal(evs.length, 2 * N);
  for (const tag of ['A', 'B']) {
    const got = evs.filter((e) => e.recipient === tag).map((e) => Number(e.detail)).sort((a, b) => a - b);
    assert.deepEqual(got, Array.from({ length: N }, (_, i) => i));
  }
});

// ───────────── I5 상태 ─────────────

test('I5 상태 접기: 늦게 온 전송 성공이 진행을 되돌리지 않고, 완료 뒤 중복은 무시한다', () => {
  const t = (s) => `2026-09-19T00:00:0${s}.000Z`;
  const st = fold([
    { at: t(0), type: 'prepared', recipient: 'b', attempt_id: 'a1' },
    { at: t(1), type: 'received', recipient: 'b' },
    { at: t(2), type: 'transport_accepted', recipient: 'b' },
    { at: t(3), type: 'completed', recipient: 'b' },
    { at: t(4), type: 'duplicate', recipient: 'b' },
  ]).b;
  assert.equal(st.state, 'completed');
  assert.equal(st.unreported, true);
  const st2 = fold([
    { at: t(0), type: 'awaiting_user', recipient: 'self' },
    { at: t(1), type: 'reported', recipient: 'self' },
  ]).self;
  assert.equal(st2.unreported, false);
});

// ───────────── ListAgents 파싱 · 제목 규칙 ─────────────

const AGENTS = `This session is app-7c [99faf4] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).

Peer sessions (4):
  app-c0 [379a0b]  ·  interactive  ·  idle  ·  started 18m ago
  Admin · ops [88b689]  ·  Remote Control  ·  idle
  SRV · API · 2 [aa11bb]  ·  Remote Control  ·  idle
  SRV · API old [cc22dd]  ·  Remote Control  ·  offline`;

test('ListAgents 출력을 읽는다 — 이름에 · 가 있어도', () => {
  const a = parseAgents(AGENTS);
  assert.equal(a.self.name, 'app-7c');
  assert.equal(a.rows.length, 4);
  assert.deepEqual(a.rows[1], { name: 'Admin · ops', ref: '88b689', kind: 'Remote Control', status: 'idle', where: 'remote' });
  assert.equal(a.rows[0].where, 'local');
});

test('C1 제목은 정확히 같거나 " · 숫자" 만 허용한다 (부분 일치 금지)', () => {
  assert.ok(titleMatches('SRV · API', 'SRV · API'));
  assert.ok(titleMatches('SRV · API · 2', 'SRV · API'));
  assert.ok(!titleMatches('SRV · API old', 'SRV · API'));
  assert.ok(!titleMatches('SRV · API · 2', 'SRV · API', false));
});

// ───────────── 전체 왕복 (두 저장소) ─────────────

function cli(args, { cwd, env }) {
  const out = execFileSync(process.execPath, [PEER, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  return JSON.parse(out);
}

function cliFail(args, { cwd, env }) {
  try {
    execFileSync(process.execPath, [PEER, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { code: e.status, out: JSON.parse(e.stdout) };
  }
  throw new Error('실패해야 하는데 성공했다');
}

test('왕복: 같은 머신 A → B 질문, 자동 선택·ACK·결과·중복·충돌·inbox', () => {
  const home = tmp('home');
  const state = tmp('state');
  const A = tmp('repoA');
  const B = tmp('repoB');
  // 가짜 세션 등록 파일 — pid 는 살아 있어야 하므로 테스트 프로세스 자신을 쓴다
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sid-b', cwd: B, name: 'repob-7f', status: 'idle', kind: 'interactive' }));
  const bookA = { schema_version: 1, self: { endpoint_id: 'pc.a', machine_id: 'm1', root: fwd(A) }, peers: { b: { endpoint_id: 'pc.b', machine_id: 'm1', location: { root: fwd(B) } } } };
  const bookB = { schema_version: 1, self: { endpoint_id: 'pc.b', machine_id: 'm1', root: fwd(B) }, peers: { a: { endpoint_id: 'pc.a', machine_id: 'm1', location: { root: fwd(A) } } } };
  fs.writeFileSync(path.join(A, '.peer_req.json'), JSON.stringify(bookA));
  fs.writeFileSync(path.join(B, '.peer_req.json'), JSON.stringify(bookB));
  const agentsFile = path.join(A, 'agents.txt');
  fs.writeFileSync(agentsFile, `This session is repoa-11 [000001] — x\n\nPeer sessions (1):\n  repob-7f [000002]  ·  interactive  ·  idle  ·  started 1m ago\n`);
  const bodyFile = path.join(A, 'body.txt');
  fs.writeFileSync(bodyFile, '로그인 API 응답 형식이 어떻게 돼 있어?');
  const envA = { CLAUDE_CONFIG_DIR: home, PEER_REQ_STATE: state, CLAUDE_CODE_SESSION_ID: 'sid-a' };
  const envB = { CLAUDE_CONFIG_DIR: home, PEER_REQ_STATE: state, CLAUDE_CODE_SESSION_ID: 'sid-b' };

  // 1) 보내기 준비 — 후보가 하나라 자동 선택되고 기록된다
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  const t = p.targets[0];
  assert.equal(t.status, 'ready');
  assert.equal(t.via, 'auto');
  assert.equal(t.send_to, 'repob-7f');
  const declared = JSON.parse(fs.readFileSync(path.join(state, 'declared', 'pc.b.json'), 'utf8'));
  assert.equal(declared.session_id, 'sid-b');
  cli(['record', '--id', p.request_id, '--to', 'b', '--event', 'transport_accepted'], { cwd: A, env: envA });

  // 2) 받는 쪽 — 접수
  const msgFile = path.join(B, 'in.txt');
  fs.copyFileSync(t.message_file, msgFile);
  const r1 = cli(['receive', '--message-file', msgFile, '--from', 'uds:pipe-a'], { cwd: B, env: envB });
  assert.equal(r1.verdict, 'new');
  assert.equal(r1.body, '로그인 API 응답 형식이 어떻게 돼 있어?');

  // 3) 보내는 쪽 — ACK 기록 → received
  const ack = cli(['ingest', '--message-file', r1.reply_file, '--from', 'uds:pipe-b'], { cwd: A, env: envA });
  assert.equal(ack.state.state, 'received');

  // 4) ACK 를 받는 쪽 receive 에 넣으면 회신하지 않는다(ACK 에 ACK 안 함)
  assert.equal(cli(['receive', '--message-file', r1.reply_file], { cwd: B, env: envB }).verdict, 'not_a_request');

  // 5) 같은 메시지 재수신 → 다시 실행하지 않고 기존 상태
  const r2 = cli(['receive', '--message-file', msgFile], { cwd: B, env: envB });
  assert.equal(r2.verdict, 'duplicate');

  // 6) 같은 ID 에 다른 본문 → 충돌
  const env = extractEnvelope(fs.readFileSync(msgFile, 'utf8'));
  env.body = '바뀐 본문';
  env.body_sha256 = sha256(env.body);
  const forged = path.join(B, 'forged.txt');
  fs.writeFileSync(forged, renderMessage(env));
  assert.equal(cli(['receive', '--message-file', forged], { cwd: B, env: envB }).verdict, 'conflict');

  // 7) 결과 → 보내는 쪽 completed · inbox 에 1건 → 알린 뒤 0건
  const ansFile = path.join(B, 'ans.txt');
  fs.writeFileSync(ansFile, '{ token, user } 입니다. 근거 src/auth.js:42');
  const rep = cli(['reply', '--id', p.request_id, '--status', 'completed', '--body-file', ansFile], { cwd: B, env: envB });
  const res = cli(['ingest', '--message-file', rep.reply_file], { cwd: A, env: envA });
  assert.equal(res.state.state, 'completed');
  assert.ok(fs.readFileSync(res.result_file, 'utf8').includes('src/auth.js:42'));
  assert.equal(cli(['inbox'], { cwd: A, env: envA }).count, 1);
  cli(['inbox', '--mark-reported'], { cwd: A, env: envA });
  assert.equal(cli(['inbox'], { cwd: A, env: envA }).count, 0);

  // 8) 다른 세션이 받으면 WRONG_TARGET — 기록을 남기지 않는다
  const wrong = cli(['receive', '--message-file', msgFile], { cwd: B, env: { ...envB, CLAUDE_CODE_SESSION_ID: 'sid-other' } });
  assert.equal(wrong.verdict, 'wrong_target');

  // 9) 회신 주소가 막혔다 — 보낸 쪽 세션이 없으면 unreachable, 새로 떠 있으면 그 이름으로 다시 찾는다
  const listB = path.join(B, 'agents.txt');
  fs.writeFileSync(listB, `This session is repob-7f [000002]\n  repoa-99 [000009]  ·  interactive  ·  idle\n`);
  const rr1 = cli(['reroute', '--id', p.request_id, '--agents-file', listB, '--detail', 'ENOINBOX'], { cwd: B, env: envB });
  assert.equal(rr1.status, 'unreachable');
  fs.writeFileSync(path.join(home, 'sessions', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: 'sid-a2', cwd: A, name: 'repoa-99' }));
  const rr2 = cli(['reroute', '--id', p.request_id, '--agents-file', listB], { cwd: B, env: envB });
  assert.equal(rr2.status, 'ready');
  assert.equal(rr2.send_to, 'repoa-99');
  const rep2 = cli(['reply', '--id', p.request_id, '--status', 'completed', '--body-file', ansFile], { cwd: B, env: envB });
  assert.equal(rep2.reply_to, 'repoa-99');
});

function sameMachinePair() {
  const home = tmp('home');
  const state = tmp('state');
  const A = tmp('repoA');
  const B = tmp('repoB');
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sid-b', cwd: B, name: 'repob-7f' }));
  fs.writeFileSync(path.join(A, '.peer_req.json'), JSON.stringify({ schema_version: 1, self: { endpoint_id: 'pc.a', machine_id: 'm1', root: fwd(A) }, peers: { b: { endpoint_id: 'pc.b', machine_id: 'm1', location: { root: fwd(B) } } } }));
  fs.writeFileSync(path.join(B, '.peer_req.json'), JSON.stringify({ schema_version: 1, self: { endpoint_id: 'pc.b', machine_id: 'm1', root: fwd(B) }, peers: { a: { endpoint_id: 'pc.a', machine_id: 'm1', location: { root: fwd(A) } } } }));
  const agentsFile = path.join(A, 'agents.txt');
  fs.writeFileSync(agentsFile, `This session is repoa-11 [000001]\n  repob-7f [000002]  ·  interactive  ·  idle\n`);
  const bodyFile = path.join(A, 'body.txt');
  fs.writeFileSync(bodyFile, '질문');
  return { A, B, agentsFile, bodyFile, envA: { CLAUDE_CONFIG_DIR: home, PEER_REQ_STATE: state, CLAUDE_CODE_SESSION_ID: 'sid-a' }, envB: { CLAUDE_CONFIG_DIR: home, PEER_REQ_STATE: state, CLAUDE_CODE_SESSION_ID: 'sid-b' } };
}

test('I13 응답 메시지를 못 받아도 같은 머신 짝 기록에서 결과를 따라잡는다', () => {
  const { A, B, agentsFile, bodyFile, envA, envB } = sameMachinePair();
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  cli(['record', '--id', p.request_id, '--to', 'b', '--event', 'transport_accepted'], { cwd: A, env: envA });
  const msg = path.join(B, 'in.txt');
  fs.copyFileSync(p.targets[0].message_file, msg);
  cli(['receive', '--message-file', msg], { cwd: B, env: envB });
  const ans = path.join(B, 'ans.txt');
  fs.writeFileSync(ans, '답');
  cli(['reply', '--id', p.request_id, '--status', 'completed', '--body-file', ans], { cwd: B, env: envB });
  // 보낸 쪽은 ACK·결과를 하나도 ingest 하지 않았다 — status 가 짝 기록에서 따라잡아야 한다
  const s = cli(['status', '--id', p.request_id], { cwd: A, env: envA });
  assert.equal(s.states.b.state, 'completed');
  assert.ok(s.events.some((e) => e.detail === 'from=peer-record'));
});

test('I8 무인 전송은 승인 표시 없이 돌지 않고, 보류된 요청은 무인으로 돌리지 않는다(C2)', () => {
  const { A, agentsFile, bodyFile, envA } = sameMachinePair();
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  const noConfirm = cliFail(['unattended', '--id', p.request_id, '--to', 'b'], { cwd: A, env: envA });
  assert.equal(noConfirm.code, 2);
  cli(['record', '--id', p.request_id, '--to', 'b', '--event', 'held'], { cwd: A, env: envA });
  const held = cliFail(['unattended', '--id', p.request_id, '--to', 'b', '--confirmed'], { cwd: A, env: envA });
  assert.equal(held.out.ok, false);
  assert.ok(held.out.error.includes('held'));
});

test('주소록: unattended.permission·host_alias 형식을 검사한다', () => {
  const dir = tmp('book');
  const b = goodBook(fwd(dir));
  b.unattended = { permission: 'yolo' };
  b.peers.srv.location.host_alias = 'has space';
  const r = validateBook(JSON.stringify(b), path.join(dir, '.peer_req.json'));
  assert.ok(r.errors.some((e) => e.includes('unattended')));
  assert.ok(r.errors.some((e) => e.includes('host_alias')));
});

test('후보가 둘이면 고르지 않고 묻는다, 사용자가 고르면 기록한다(bind)', () => {
  const home = tmp('home');
  const state = tmp('state');
  const A = tmp('repoA');
  const B = tmp('repoB');
  fs.mkdirSync(path.join(home, 'sessions'));
  // 같은 pid 를 두 파일로 — 둘 다 살아 있는 것으로 보인다
  fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sid-b1', cwd: B, name: 'repob-11' }));
  fs.writeFileSync(path.join(home, 'sessions', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: 'sid-b2', cwd: path.join(B, 'sub'), name: 'repob-22' }));
  fs.writeFileSync(path.join(A, '.peer_req.json'), JSON.stringify({ schema_version: 1, self: { endpoint_id: 'pc.a', machine_id: 'm1', root: fwd(A) }, peers: { b: { endpoint_id: 'pc.b', machine_id: 'm1', location: { root: fwd(B) } } } }));
  const agentsFile = path.join(A, 'agents.txt');
  fs.writeFileSync(agentsFile, `This session is a [1]\n  repob-11 [000002]  ·  interactive  ·  idle\n  repob-22 [000003]  ·  interactive  ·  idle\n`);
  const bodyFile = path.join(A, 'body.txt');
  fs.writeFileSync(bodyFile, 'q');
  const env = { CLAUDE_CONFIG_DIR: home, PEER_REQ_STATE: state, CLAUDE_CODE_SESSION_ID: 'sid-a' };
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env });
  assert.equal(p.targets[0].status, 'ask');
  assert.equal(p.targets[0].candidates.length, 2);
  cli(['bind', '--to', 'b', '--session-id', 'sid-b2'], { cwd: A, env });
  const p2 = cli(['prepare', '--request-id', p.request_id, '--to', 'b', '--agents-file', agentsFile], { cwd: A, env });
  assert.equal(p2.targets[0].status, 'ready');
  assert.equal(p2.targets[0].via, 'declared');
  assert.equal(p2.targets[0].send_to, 'repob-22');
});

test('다른 머신 짝: 목록에 원격 세션이 없으면 unreachable + RC 꺼짐 의심', () => {
  const A = tmp('repoA');
  fs.writeFileSync(path.join(A, '.peer_req.json'), JSON.stringify({ schema_version: 1, self: { endpoint_id: 'pc.a', machine_id: 'm1', root: fwd(A) }, peers: { srv: { endpoint_id: 'srv.api', machine_id: 'srv', location: { root: '/home/api' }, session_selector: { rc_title: 'SRV · API' } } } }));
  const agentsFile = path.join(A, 'agents.txt');
  fs.writeFileSync(agentsFile, `This session is a [1]\n  local-1 [000002]  ·  interactive  ·  idle\n`);
  const bodyFile = path.join(A, 'body.txt');
  fs.writeFileSync(bodyFile, 'q');
  const p = cli(['prepare', '--to', 'srv', '--intent', 'notice', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: { PEER_REQ_STATE: tmp('state') } });
  assert.equal(p.targets[0].status, 'unreachable');
  assert.equal(p.rc_visible, false);
  assert.ok(p.targets[0].reason.includes('Remote Control'));
});

test('다른 머신 짝: 제목 후보가 둘이면 묻고, --pick 으로 고른 대상에게 보낸다', () => {
  const A = tmp('repoA');
  fs.writeFileSync(path.join(A, '.peer_req.json'), JSON.stringify({ schema_version: 1, self: { endpoint_id: 'pc.a', machine_id: 'm1', root: fwd(A) }, peers: { srv: { endpoint_id: 'srv.api', machine_id: 'srv', location: { root: '/home/api' }, session_selector: { rc_title: 'SRV · API' } } } }));
  const agentsFile = path.join(A, 'agents.txt');
  fs.writeFileSync(agentsFile, `This session is a [1]\n  SRV · API [0000aa]  ·  Remote Control  ·  idle\n  SRV · API · 2 [0000bb]  ·  Remote Control  ·  idle\n`);
  const bodyFile = path.join(A, 'body.txt');
  fs.writeFileSync(bodyFile, 'q');
  const env = { PEER_REQ_STATE: tmp('state') };
  const p = cli(['prepare', '--to', 'srv', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env });
  assert.equal(p.targets[0].status, 'ask');
  assert.equal(p.targets[0].candidates.length, 2);
  const p2 = cli(['prepare', '--request-id', p.request_id, '--to', 'srv', '--agents-file', agentsFile, '--pick', 'SRV · API · 2'], { cwd: A, env });
  assert.equal(p2.targets[0].status, 'ready');
  assert.equal(p2.targets[0].send_to, 'SRV · API · 2');
  assert.equal(p2.request_id, p.request_id);
});

test('주소록이 깨져 있으면 prepare 가 멈춘다(exit 3)', () => {
  const A = tmp('repoA');
  fs.writeFileSync(path.join(A, '.peer_req.json'), '{"schema_version":1,"self":{}}');
  fs.writeFileSync(path.join(A, 'a.txt'), '');
  const r = cliFail(['prepare', '--to', 'x', '--intent', 'query', '--body-file', path.join(A, 'a.txt'), '--agents-file', path.join(A, 'a.txt')], { cwd: A, env: {} });
  assert.equal(r.code, 3);
});

// ───────────── Codex 리뷰(2026-09-19) 지적 재현 — 고친 뒤 막히는지 ─────────────

function receiverRepo(extraBook) {
  const B = tmp('recv');
  const book = Object.assign({ schema_version: 1, self: { endpoint_id: 'pc.b', machine_id: 'm1', root: fwd(B) } }, extraBook || {});
  fs.writeFileSync(path.join(B, '.peer_req.json'), JSON.stringify(book));
  return B;
}

function requestFile(dir, recipient) {
  const env = makeRequest({ sender: { endpoint_id: 'pc.a', root: 'C:/w/a' }, recipient, intent: 'query', body: 'q' });
  const f = path.join(dir, 'msg-' + env.attempt_id + '.txt');
  fs.writeFileSync(f, renderMessage(env));
  return f;
}

test('리뷰 P2 받기 전용 주소록(peers 없음)은 유효하고, 보내기만 막힌다', () => {
  const B = receiverRepo();
  const env = { PEER_REQ_STATE: tmp('state') };
  const d = cli(['doctor'], { cwd: B, env });
  assert.equal(d.addressbook.ok, true);
  fs.writeFileSync(path.join(B, 'x.txt'), 'x');
  assert.equal(cliFail(['prepare', '--to', 'a', '--intent', 'query', '--body-file', path.join(B, 'x.txt'), '--agents-file', path.join(B, 'x.txt')], { cwd: B, env }).code, 2);
});

test('리뷰 P1 대상 확인 fail-closed — 상위 root · 주소록 없음 · 깨진 주소록 · 세션 번호 모름', () => {
  const env = { PEER_REQ_STATE: tmp('state'), CLAUDE_CODE_SESSION_ID: '' };
  const B = receiverRepo();
  const parent = path.dirname(B);
  assert.equal(cli(['receive', '--message-file', requestFile(B, { endpoint_id: 'pc.b', root: fwd(parent) })], { cwd: B, env }).verdict, 'wrong_target');
  const N = tmp('nobook');
  assert.equal(cli(['receive', '--message-file', requestFile(N, { endpoint_id: 'pc.b', root: fwd(N) })], { cwd: N, env }).verdict, 'wrong_target');
  const X = tmp('broken');
  fs.writeFileSync(path.join(X, '.peer_req.json'), JSON.stringify({ schema_version: 1, self: { endpoint_id: 'pc.b', machine_id: 'm1', root: fwd(X) }, peers: 'oops' }));
  assert.equal(cli(['receive', '--message-file', requestFile(X, { endpoint_id: 'pc.b', root: fwd(X) })], { cwd: X, env }).verdict, 'wrong_target');
  assert.equal(cli(['receive', '--message-file', requestFile(B, { endpoint_id: 'pc.b', root: fwd(B), session_id: 'sid-intended' })], { cwd: B, env }).verdict, 'wrong_target');
  assert.equal(cli(['receive', '--message-file', requestFile(B, { endpoint_id: 'pc.b', root: fwd(B) })], { cwd: B, env }).verdict, 'new');
});

test('리뷰 P1 SSH 별칭이 옵션으로 읽힐 수 있으면 거부한다', () => {
  const dir = tmp('book');
  const b = goodBook(fwd(dir));
  for (const bad of ['-oProxyCommand=calc', '-Fevil', '']) {
    b.peers.srv.location.host_alias = bad;
    assert.ok(validateBook(JSON.stringify(b), path.join(dir, '.peer_req.json')).errors.some((e) => e.includes('host_alias')), bad);
  }
  b.peers.srv.location.host_alias = 'Api_Server-01';
  assert.deepEqual(validateBook(JSON.stringify(b), path.join(dir, '.peer_req.json')).errors, []);
});

test('리뷰 P2 확정된 결과는 덮어쓰지 않는다 — 같은 내용은 그대로 성공, 다르면 거부', () => {
  const B = receiverRepo();
  const env = { PEER_REQ_STATE: tmp('state') };
  const r = cli(['receive', '--message-file', requestFile(B, { endpoint_id: 'pc.b', root: fwd(B) })], { cwd: B, env });
  const a1 = path.join(B, 'a1.txt');
  const a2 = path.join(B, 'a2.txt');
  fs.writeFileSync(a1, '답 A');
  fs.writeFileSync(a2, '답 B');
  cli(['reply', '--id', r.request_id, '--status', 'completed', '--body-file', a1], { cwd: B, env });
  assert.equal(cli(['reply', '--id', r.request_id, '--status', 'completed', '--body-file', a1], { cwd: B, env }).idempotent, true);
  assert.equal(cliFail(['reply', '--id', r.request_id, '--status', 'completed', '--body-file', a2], { cwd: B, env }).code, 2);
  const kept = extractEnvelope(fs.readFileSync(path.join(r.record_dir, 'outbox', 'result-final.txt'), 'utf8'));
  assert.equal(kept.body, '답 A');
});

test('리뷰 P2 awaiting_user 는 나중에 completed 로 바꿀 수 있다', () => {
  const B = receiverRepo();
  const env = { PEER_REQ_STATE: tmp('state') };
  const r = cli(['receive', '--message-file', requestFile(B, { endpoint_id: 'pc.b', root: fwd(B) })], { cwd: B, env });
  const f = path.join(B, 'a.txt');
  fs.writeFileSync(f, '접수');
  cli(['reply', '--id', r.request_id, '--status', 'awaiting_user', '--body-file', f], { cwd: B, env });
  fs.writeFileSync(f, '작업 끝');
  assert.equal(cli(['reply', '--id', r.request_id, '--status', 'completed', '--body-file', f], { cwd: B, env }).status, 'completed');
});

test('리뷰 P2 경로 비교는 실행 운영체제의 규칙을 따른다', () => {
  assert.notEqual(normPath('/f/repo', 'linux'), normPath('F:/repo', 'linux'));
  assert.equal(normPath('/f/repo', 'win32'), normPath('F:/repo', 'win32'));
  assert.equal(normPath('\\\\SERVER\\Share\\Repo', 'win32'), normPath('\\\\server\\share\\repo', 'win32'));
  assert.notEqual(normPath('/Home/A', 'linux'), normPath('/home/a', 'linux'));
  assert.equal(normPath('C:\\', 'win32'), 'c:/');
});

test('리뷰 P2 두 프로세스가 동시에 서로 다른 짝을 기록해도 둘 다 남는다', async () => {
  const state = tmp('state');
  const sessPath = path.join(HERE, '..', 'scripts', 'lib', 'sessions.cjs');
  const code = 'const s = require(' + JSON.stringify(sessPath) + '); const ep = process.argv[1]; const n = Number(process.argv[2]);' +
    ' for (let i = 0; i < n; i++) s.declare(ep, { sessionId: ep + "-" + i, root: "/r", source: "test" });';
  const run = (ep) => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', code, ep, '60'], { stdio: 'inherit', env: { ...process.env, PEER_REQ_STATE: state } });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error('exit ' + c))));
  });
  await Promise.all([run('pc.one'), run('pc.two')]);
  const names = fs.readdirSync(path.join(state, 'declared')).filter((n) => n.endsWith('.json')).sort();
  assert.deepEqual(names, ['pc.one.json', 'pc.two.json']);
});

test('리뷰 P2 request 기록은 처음 한 번만, 완성본으로 게시된다', () => {
  const d = tmp('pub');
  const f = path.join(d, 'request.json');
  assert.equal(publishOnce(f, '{"a":1}\n'), true);
  assert.equal(publishOnce(f, '{"a":2}\n'), false);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).a, 1);
  assert.deepEqual(fs.readdirSync(d), ['request.json']);
});

test('리뷰 P2 처리까지 끝냈는데 알리기 전에 닫힌 받은 요청도 inbox 에 남는다', () => {
  const B = receiverRepo();
  const env = { PEER_REQ_STATE: tmp('state') };
  const r = cli(['receive', '--message-file', requestFile(B, { endpoint_id: 'pc.b', root: fwd(B) })], { cwd: B, env });
  const f = path.join(B, 'a.txt');
  fs.writeFileSync(f, '답');
  cli(['reply', '--id', r.request_id, '--status', 'completed', '--body-file', f], { cwd: B, env });
  const ib = cli(['inbox'], { cwd: B, env });
  assert.equal(ib.count, 1);
  assert.equal(ib.items[0].state, 'completed');
});

test('리뷰 P2 --state-dir 인자로 상태 폴더를 받는다(PowerShell 에서도 한 줄로)', () => {
  const B = receiverRepo();
  const st = tmp('state');
  const d = cli(['doctor', '--state-dir', st], { cwd: B, env: { PEER_REQ_STATE: '', CLAUDE_PLUGIN_DATA: '' } });
  assert.equal(fwd(d.state_dir), fwd(st));
});

// ───────────── 배포 후 실측에서 나온 것 ─────────────

test('원격 claude -p 가 JSON 뒤에 줄을 덧붙여도 결과를 읽는다(2026-09-19 서버 실측)', () => {
  const { parseJsonOut } = require('../scripts/lib/unattended.cjs');
  const j = '{"result":"4455","is_error":false}';
  assert.equal(parseJsonOut(j + '\n').result, '4455');
  assert.equal(parseJsonOut(j + '\nlogout\n').result, '4455');
  assert.equal(parseJsonOut('motd 안내\n' + j + '\n').result, '4455');
  assert.equal(parseJsonOut(JSON.stringify({ ok: true, a: 1 }, null, 2) + '\n덧붙은 줄').ok, true); // 여러 줄 JSON + 잡음
  assert.equal(parseJsonOut('JSON 이 아니다'), null);
});

test('비대화형(claude -p) 세션에서는 시작 훅이 아무것도 내지 않는다 — 스크립트 답에 섞이지 않게', () => {
  const B = receiverRepo();
  const hook = path.join(HERE, '..', 'scripts', 'session-start.cjs');
  const run = (ep) => execFileSync(process.execPath, [hook], { input: JSON.stringify({ source: 'startup', cwd: B }), env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: ep, PEER_REQ_UNATTENDED: '' }, encoding: 'utf8' });
  assert.equal(run('sdk-cli'), '');
  assert.ok(run('cli').includes('systemMessage'));
  assert.ok(run('claude-vscode').includes('systemMessage'));
});

// ───────────── 배포 규칙 ─────────────

// 플러그인은 plugin.json 의 version 이 바뀔 때만 사용자에게 업데이트된다(공식 문서: 버전을 적어 두면
// 새 커밋을 올려도 같은 버전으로 보고 캐시를 그대로 쓴다). 고치고 번호를 안 올리면 아무도 못 받는다.
test('배포 규칙: skills/peer_req 를 고쳤으면 plugin.json version 을 마지막 커밋보다 올렸다', () => {
  const repo = path.join(HERE, '..', '..', '..');
  let changed;
  let headVersion;
  try {
    changed = execFileSync('git', ['status', '--porcelain', '--', 'skills/peer_req'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    headVersion = JSON.parse(execFileSync('git', ['show', 'HEAD:skills/peer_req/.claude-plugin/plugin.json'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).version;
  } catch (e) {
    return; // 레포 밖(설치본)이거나 아직 커밋된 적 없다(첫 배포)
  }
  if (!changed) return;
  const now = JSON.parse(fs.readFileSync(path.join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.notEqual(now, headVersion, 'skills/peer_req 가 바뀌었는데 plugin.json version 이 ' + now + ' 그대로다 — 올려야 사용자에게 업데이트가 간다');
});

// ───────────── Codex 재리뷰(2026-09-19) 17건 재현 ─────────────

const { applyCommitPolicy, requestDir } = require('../scripts/lib/store.cjs');
const { findOnPath } = require('../scripts/lib/util.cjs');

test('재리뷰 P1 승인 창이 만료된 요청은 무인으로 돌리지 않는다', () => {
  const { A, agentsFile, bodyFile, envA } = sameMachinePair();
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  cli(['record', '--id', p.request_id, '--to', 'b', '--event', 'expired'], { cwd: A, env: envA });
  const r = cliFail(['unattended', '--id', p.request_id, '--to', 'b', '--confirmed'], { cwd: A, env: envA });
  assert.ok(r.out.error.includes('expired'));
});

test('재리뷰 P2 기존 .gitignore 가 있어도 기록 제외 블록을 덧붙이고, 다시 켜면 그 블록만 뺀다', () => {
  const R = tmp('gi');
  const gi = path.join(R, 'docs', '_msg', 'peer_req', '.gitignore');
  fs.mkdirSync(path.dirname(gi), { recursive: true });
  fs.writeFileSync(gi, 'mine.log\n');
  applyCommitPolicy(R, false);
  assert.ok(fs.readFileSync(gi, 'utf8').includes('mine.log'));
  assert.ok(fs.readFileSync(gi, 'utf8').includes('\n*\n'));
  applyCommitPolicy(R, false); // 두 번 불러도 블록은 하나
  assert.equal(fs.readFileSync(gi, 'utf8').split('peer_req: records.commit=false').length, 2);
  applyCommitPolicy(R, true);
  assert.equal(fs.readFileSync(gi, 'utf8'), 'mine.log\n');
});

test('재리뷰 P2 서로 다른 답으로 동시에 확정해도 승자는 하나다', async () => {
  const B = receiverRepo();
  const state = tmp('state');
  const r = cli(['receive', '--message-file', requestFile(B, { endpoint_id: 'pc.b', root: fwd(B) })], { cwd: B, env: { PEER_REQ_STATE: state } });
  const files = [0, 1].map((i) => {
    const f = path.join(B, 'ans' + i + '.txt');
    fs.writeFileSync(f, ('답' + i + '\n').repeat(200000));
    return f;
  });
  const run = (f) => new Promise((res) => {
    const p = spawn(process.execPath, [PEER, 'reply', '--id', r.request_id, '--status', 'completed', '--body-file', f], { cwd: B, env: { ...process.env, PEER_REQ_STATE: state } });
    p.on('exit', (c) => res(c));
  });
  const codes = await Promise.all(files.map(run));
  assert.deepEqual(codes.slice().sort(), [0, 2]);
  const done = listEvents(r.record_dir).filter((e) => e.type === 'completed');
  assert.equal(done.length, 1);
});

test('재리뷰 P2 완료 뒤 늦게 온 임시 결과는 저장된 완료 답을 덮지 않는다', () => {
  const { A, B, agentsFile, bodyFile, envA, envB } = sameMachinePair();
  const p = cli(['prepare', '--to', 'b', '--intent', 'change_request', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  const msg = path.join(B, 'in.txt');
  fs.copyFileSync(p.targets[0].message_file, msg);
  cli(['receive', '--message-file', msg], { cwd: B, env: envB });
  const f = path.join(B, 'a.txt');
  fs.writeFileSync(f, 'waiting');
  const wait = cli(['reply', '--id', p.request_id, '--status', 'awaiting_user', '--body-file', f], { cwd: B, env: envB });
  const waitCopy = path.join(A, 'wait.txt');
  fs.copyFileSync(wait.reply_file, waitCopy);
  fs.writeFileSync(f, 'done');
  const fin = cli(['reply', '--id', p.request_id, '--status', 'completed', '--body-file', f], { cwd: B, env: envB });
  cli(['ingest', '--message-file', fin.reply_file], { cwd: A, env: envA });
  const late = cli(['ingest', '--message-file', waitCopy], { cwd: A, env: envA });
  assert.equal(late.accepted, false);
  assert.equal(late.state.state, 'completed');
  assert.equal(fs.readFileSync(path.join(requestDir(A, p.request_id), 'result', 'b.md'), 'utf8'), 'done\n');
});

test('재리뷰 P1 재시도는 처음 기록한 대상과 같을 때만 한다', () => {
  const { A, agentsFile, bodyFile, envA } = sameMachinePair();
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  const book = JSON.parse(fs.readFileSync(path.join(A, '.peer_req.json'), 'utf8'));
  book.peers.b.location.root = fwd(tmp('elsewhere'));
  fs.writeFileSync(path.join(A, '.peer_req.json'), JSON.stringify(book));
  assert.equal(cliFail(['prepare', '--request-id', p.request_id, '--to', 'b', '--agents-file', agentsFile], { cwd: A, env: envA }).code, 2);
  assert.equal(cliFail(['unattended', '--id', p.request_id, '--to', 'b', '--confirmed'], { cwd: A, env: envA }).out.ok, false);
});

test('재리뷰 P2 같은 머신 --pick 은 세션 번호를 모르면 보내지 않는다', () => {
  const { A, bodyFile, envA } = sameMachinePair();
  const list = path.join(A, 'agents2.txt');
  fs.writeFileSync(list, 'This session is a [1]\n  someone-else [000009]  ·  interactive  ·  idle\n');
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', list, '--pick', 'someone-else'], { cwd: A, env: envA });
  assert.equal(p.targets[0].status, 'ask');
});

test('재리뷰 P2 엉뚱한 곳이 보낸 WRONG_TARGET 도 보낸 쪽이 기록한다', () => {
  const { A, agentsFile, bodyFile, envA } = sameMachinePair();
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  const N = tmp('nobook'); // 주소록 없는 저장소가 받았다
  const msg = path.join(N, 'in.txt');
  fs.copyFileSync(p.targets[0].message_file, msg);
  const w = cli(['receive', '--message-file', msg], { cwd: N, env: { PEER_REQ_STATE: envA.PEER_REQ_STATE } });
  assert.equal(w.verdict, 'wrong_target');
  const ing = cli(['ingest', '--message-file', w.reply_file], { cwd: A, env: envA });
  assert.equal(ing.ok, true);
  assert.equal(ing.state.state, 'wrong_target');
});

test('재리뷰 P2 reroute 후보가 여럿이면 --pick 으로 골라 기록한다', () => {
  const { A, B, agentsFile, bodyFile, envA, envB } = sameMachinePair();
  const home = envA.CLAUDE_CONFIG_DIR;
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  const msg = path.join(B, 'in.txt');
  fs.copyFileSync(p.targets[0].message_file, msg);
  cli(['receive', '--message-file', msg, '--from', 'uds:gone'], { cwd: B, env: envB });
  // 보낸 쪽 저장소(A)에서 도는 세션 둘 — 살아 있는 pid 가 필요해 잠깐 떠 있는 프로세스를 둘 띄운다
  const sleepers = [0, 1].map(() => spawn(process.execPath, ['-e', 'setTimeout(function(){}, 60000)'], { stdio: 'ignore' }));
  try {
    sleepers.forEach((s, i) => {
      fs.writeFileSync(path.join(home, 'sessions', s.pid + '.json'), JSON.stringify({ pid: s.pid, sessionId: 'sid-a' + i, cwd: A, name: 'repoa-' + i }));
    });
    const list = path.join(B, 'agents.txt');
    fs.writeFileSync(list, 'This session is repob-7f [2]\n  repoa-0 [000010]  ·  interactive  ·  idle\n  repoa-1 [000011]  ·  interactive  ·  idle\n');
    const r1 = cli(['reroute', '--id', p.request_id, '--agents-file', list], { cwd: B, env: envB });
    assert.equal(r1.status, 'ask');
    const r2 = cli(['reroute', '--id', p.request_id, '--agents-file', list, '--pick', 'repoa-1'], { cwd: B, env: envB });
    assert.equal(r2.status, 'ready');
    assert.equal(r2.send_to, 'repoa-1');
    const f = path.join(B, 'a.txt');
    fs.writeFileSync(f, '답');
    assert.equal(cli(['reply', '--id', p.request_id, '--status', 'completed', '--body-file', f], { cwd: B, env: envB }).reply_to, 'repoa-1');
  } finally {
    sleepers.forEach((s) => s.kill());
  }
});

test('재리뷰 P2 awaiting_user 뒤 completed 도 짝 기록에서 따라잡는다', () => {
  const { A, B, agentsFile, bodyFile, envA, envB } = sameMachinePair();
  const p = cli(['prepare', '--to', 'b', '--intent', 'change_request', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  const msg = path.join(B, 'in.txt');
  fs.copyFileSync(p.targets[0].message_file, msg);
  cli(['receive', '--message-file', msg], { cwd: B, env: envB });
  const f = path.join(B, 'a.txt');
  fs.writeFileSync(f, '접수');
  const wait = cli(['reply', '--id', p.request_id, '--status', 'awaiting_user', '--body-file', f], { cwd: B, env: envB });
  cli(['ingest', '--message-file', wait.reply_file], { cwd: A, env: envA });
  fs.writeFileSync(f, '작업 끝');
  cli(['reply', '--id', p.request_id, '--status', 'completed', '--body-file', f], { cwd: B, env: envB });
  const s = cli(['status', '--id', p.request_id], { cwd: A, env: envA });
  assert.equal(s.states.b.state, 'completed');
});

test('재리뷰 P2 하드링크를 못 쓰는 폴백에서도 처음 한 번만, 완성본으로 게시된다', () => {
  const prev = process.env.PEER_REQ_NO_LINK;
  process.env.PEER_REQ_NO_LINK = '1';
  try {
    const d = tmp('pub2');
    const f = path.join(d, 'request.json');
    assert.equal(publishOnce(f, '{"a":1}\n'), true);
    assert.equal(publishOnce(f, '{"a":2}\n'), false);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).a, 1);
  } finally {
    if (prev === undefined) delete process.env.PEER_REQ_NO_LINK;
    else process.env.PEER_REQ_NO_LINK = prev;
  }
});

test('재리뷰 P1 실행 파일은 PATH 의 절대 경로에서만 찾는다(현재 폴더의 가짜 git 을 실행하지 않는다)', { skip: process.platform !== 'win32' }, () => {
  const R = tmp('fakegit');
  fs.writeFileSync(path.join(R, 'git.cmd'), '@echo off\r\necho x > "%~dp0PWNED.txt"\r\n');
  const found = findOnPath('git');
  assert.ok(found && !found.startsWith(R));
  // 주소록 없는 저장소에서 status 를 부르면 git 으로 루트를 찾는다 — 그때도 가짜가 돌면 안 된다
  const env = { ...process.env, PEER_REQ_STATE: tmp('state'), PATH: '.' + path.delimiter + process.env.PATH };
  delete env.NoDefaultCurrentDirectoryInExePath;
  execFileSync(process.execPath, [PEER, 'status'], { cwd: R, env, encoding: 'utf8' });
  assert.equal(fs.existsSync(path.join(R, 'PWNED.txt')), false);
});
