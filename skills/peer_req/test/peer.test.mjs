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
const { makeRequest, makeReply, renderMessage, extractEnvelope, checkEnvelope, HEADER_VERSION, headerHash } = require('../scripts/lib/envelope.cjs');
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

test('I2 필수 필드가 빠지면 잡는다 · 다른 머신 rc_title 은 선택이지만 적었으면 비면 안 된다(D27)', () => {
  const dir = tmp('book');
  const b = goodBook(fwd(dir));
  delete b.self.machine_id;
  b.peers.srv.session_selector.rc_title = ' ';
  const r = validateBook(JSON.stringify(b), path.join(dir, '.peer_req.json'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('self.machine_id')));
  assert.ok(r.errors.some((e) => e.includes('rc_title')));
  const b2 = goodBook(fwd(dir));
  delete b2.peers.srv.session_selector;
  assert.deepEqual(validateBook(JSON.stringify(b2), path.join(dir, '.peer_req.json')).errors, []);
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
  assert.deepEqual(a.rows[1], { name: 'Admin · ops', ref: '88b689', kind: 'Remote Control', status: 'idle', where: 'remote', section: 'Peer sessions' });
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
  assert.equal(t.remember_after_ack, true);
  // 받았다는 답이 오기 전에는 짝 세션을 기억하지 않는다(2026-09-21)
  assert.equal(fs.existsSync(path.join(state, 'declared', 'pc.b.json')), false);
  cli(['record', '--id', p.request_id, '--to', 'b', '--event', 'transport_accepted'], { cwd: A, env: envA });

  // 2) 받는 쪽 — 접수
  const msgFile = path.join(B, 'in.txt');
  fs.copyFileSync(t.message_file, msgFile);
  const r1 = cli(['receive', '--message-file', msgFile, '--from', 'uds:pipe-a'], { cwd: B, env: envB });
  assert.equal(r1.verdict, 'new');
  assert.equal(r1.body, '로그인 API 응답 형식이 어떻게 돼 있어?');

  // 3) 보내는 쪽 — ACK 기록 → received, 그때 짝 세션을 기억한다
  const ack = cli(['ingest', '--message-file', r1.reply_file, '--from', 'uds:pipe-b'], { cwd: A, env: envA });
  assert.equal(ack.state.state, 'received');
  assert.equal(ack.promoted.kind, 'declared');
  const declared = JSON.parse(fs.readFileSync(path.join(state, 'declared', 'pc.b.json'), 'utf8'));
  assert.equal(declared.session_id, 'sid-b');

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
  // C04: 한 번 다시 찾은 뒤 또 막혀도 다시 찾는다 — 전에는 두 번째가 늘 "다른 머신" 으로 끝났다
  const rr3 = cli(['reroute', '--id', p.request_id, '--agents-file', listB, '--detail', 'ENOINBOX again'], { cwd: B, env: envB });
  assert.equal(rr3.status, 'ready');
  assert.equal(rr3.send_to, 'repoa-99');
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

// ───────────── D27 다른 머신 — 고른 세션 기억 (2026-09-19 사용자 결정) ─────────────

// rc_title 없는 짝(srv) + 제목을 적어 둔 다른 짝(ops)
function remoteRepo(srvSelector) {
  const A = tmp('repoA');
  const srv = { endpoint_id: 'srv.api', machine_id: 'srv', location: { root: '/home/api' } };
  if (srvSelector) srv.session_selector = srvSelector;
  const ops = { endpoint_id: 'srv.ops', machine_id: 'ops', location: { root: '/home/ops' }, session_selector: { rc_title: 'Admin · ops' } };
  fs.writeFileSync(path.join(A, '.peer_req.json'), JSON.stringify({ schema_version: 1, self: { endpoint_id: 'pc.a', machine_id: 'm1', root: fwd(A) }, peers: { srv, ops } }));
  const bodyFile = path.join(A, 'body.txt');
  fs.writeFileSync(bodyFile, 'q');
  const list = (lines) => {
    const f = path.join(A, 'agents-' + Math.random().toString(36).slice(2) + '.txt');
    fs.writeFileSync(f, 'This session is a [1]\n  local-1 [000002]  ·  interactive  ·  idle\n' + lines.map((l) => '  ' + l + '  ·  Remote Control  ·  idle\n').join(''));
    return f;
  };
  const state = tmp('state');
  const prep = (agents, extra) => cli(['prepare', '--to', 'srv', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agents].concat(extra || []), { cwd: A, env: { PEER_REQ_STATE: state } });
  const remembered = () => {
    const f = path.join(state, 'remote_titles_v2', 'srv.api.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };
  // 받는 쪽이 "받았다" 고 답한 것처럼 ACK 를 만들어 넣는다(다른 머신이라 그쪽 저장소는 흉내만 낸다)
  const ack = (p, status) => {
    const env = extractEnvelope(fs.readFileSync(p.targets[0].message_file, 'utf8'));
    const f = path.join(A, 'ack-' + Math.random().toString(36).slice(2) + '.txt');
    fs.writeFileSync(f, renderMessage(makeReply({ type: 'ack', request: env, responder: env.recipient_endpoint, status: status || 'received' })));
    return cli(['ingest', '--message-file', f], { cwd: A, env: { PEER_REQ_STATE: state } });
  };
  // 엉뚱한 세션(주소록 없는 저장소)이 받아 WRONG_TARGET 을 돌려보낸 것
  const wrong = (p) => {
    const N = tmp('nobook');
    const msg = path.join(N, 'in.txt');
    fs.copyFileSync(p.targets[0].message_file, msg);
    const w = cli(['receive', '--message-file', msg], { cwd: N, env: { PEER_REQ_STATE: tmp('state') } });
    assert.equal(w.verdict, 'wrong_target');
    return cli(['ingest', '--message-file', w.reply_file], { cwd: A, env: { PEER_REQ_STATE: state } });
  };
  const pick = (p, agents, name) => cli(['prepare', '--request-id', p.request_id, '--to', 'srv', '--agents-file', agents, '--pick', name], { cwd: A, env: { PEER_REQ_STATE: state } });
  return { A, state, list, prep, remembered, ack, wrong, pick };
}

// "이 짝 아님" 목록에서 뺀 시각(at)을 떼고 비교한다
function notOf(t) {
  return t.remembered().not.map((n) => ({ title: n.title, ref: n.ref }));
}

test('D27 rc_title 이 없어도, 다른 짝 몫을 원격 세션이 하나뿐이면 거기로 보내고, 받았다는 답이 오면 기억한다', () => {
  const t = remoteRepo();
  const p = t.prep(t.list(['Admin · ops [0000aa]', 'host-lively-otter [0000bb]']));
  assert.equal(p.targets[0].status, 'ready');
  assert.equal(p.targets[0].via, 'only_candidate');
  assert.equal(p.targets[0].send_to, 'host-lively-otter');
  assert.equal(p.targets[0].remember_after_ack, true);
  assert.equal(t.remembered(), null); // 보내기 전에는 기억하지 않는다(2026-09-21)
  assert.equal(t.ack(p).promoted.kind, 'remote');
  assert.equal(t.remembered().title, 'host-lively-otter');
  assert.equal(t.remembered().ref, '0000bb');
});

test('D27 여럿이면 묻고, 고른 것을 받았다는 답이 온 뒤 기억해 다음 요청부터 묻지 않는다', () => {
  const t = remoteRepo();
  const agents = t.list(['Admin · ops [0000aa]', 'host-lively-otter [0000bb]', 'host-calm-river [0000cc]']);
  const p = t.prep(agents);
  assert.equal(p.targets[0].status, 'ask');
  assert.deepEqual(p.targets[0].candidates.map((c) => c.name).sort(), ['host-calm-river', 'host-lively-otter']); // 다른 짝(ops) 몫은 빠진다
  const p2 = t.pick(p, agents, 'host-calm-river');
  assert.equal(p2.targets[0].status, 'ready');
  assert.equal(p2.targets[0].remember_after_ack, true);
  t.ack(p2);
  assert.equal(t.remembered().source, 'user');
  const p3 = t.prep(agents); // 새 요청
  assert.equal(p3.targets[0].status, 'ready');
  assert.equal(p3.targets[0].via, 'remembered_ref');
  assert.equal(p3.targets[0].send_to, 'host-calm-river');
});

test('D27 이름을 붙여 제목이 바뀌어도 참조 번호로 같은 세션을 찾아가고 기억을 고친다', () => {
  const t = remoteRepo();
  t.ack(t.prep(t.list(['host-lively-otter [0000bb]'])));
  const p = t.prep(t.list(['Admin · ops [0000aa]', 'Srv · API DEV [0000bb]', 'host-calm-river [0000cc]']));
  assert.equal(p.targets[0].status, 'ready');
  assert.equal(p.targets[0].via, 'remembered_ref');
  assert.equal(p.targets[0].send_to, 'Srv · API DEV');
  t.ack(p);
  assert.equal(t.remembered().title, 'Srv · API DEV');
});

test('D27 기억한 세션이 목록에서 사라지면(새 대화) 다시 묻는다', () => {
  const t = remoteRepo();
  t.ack(t.prep(t.list(['host-lively-otter [0000bb]'])));
  const p = t.prep(t.list(['host-calm-river [0000cc]', 'host-quiet-lake [0000dd]']));
  assert.equal(p.targets[0].status, 'ask');
  assert.ok(p.targets[0].note.includes('host-lively-otter'));
});

test('R15 옛 제목을 다른 대화가 다시 써도, 기억한 참조 번호가 목록에 있으면 그쪽이 이긴다', () => {
  const t = remoteRepo();
  t.ack(t.prep(t.list(['fixed [0000bb]'])));
  const p = t.prep(t.list(['fixed [0000cc]', 'renamed [0000bb]']));
  assert.equal(p.targets[0].status, 'ready');
  assert.equal(p.targets[0].via, 'remembered_ref');
  assert.equal(p.targets[0].send_to, 'renamed');
});

test('R23 주소록 rc_title 로 보낸 짝도 참조 번호를 기억해, 제목이 바뀌어도 따라간다', () => {
  const t = remoteRepo({ rc_title: 'SRV · API' });
  const p = t.prep(t.list(['SRV · API [0000bb]', 'host-calm-river [0000cc]']));
  assert.equal(p.targets[0].via, 'rc_title');
  t.ack(p);
  assert.equal(t.remembered().ref, '0000bb');
  const p2 = t.prep(t.list(['SRV · API renamed [0000bb]', 'host-calm-river [0000cc]']));
  assert.equal(p2.targets[0].status, 'ready');
  assert.equal(p2.targets[0].via, 'remembered_ref');
  assert.equal(p2.targets[0].send_to, 'SRV · API renamed');
});

test('목록에 읽지 못한 줄·처음 보는 종류의 줄이 있으면 남은 하나로 자동 전송하지 않는다', () => {
  const t = remoteRepo();
  const f1 = path.join(t.A, 'agents-unknown.txt');
  fs.writeFileSync(f1, 'This session is a [1]\nPeer sessions (2):\n  host-lively-otter [0000bb]  ·  Remote Control  ·  idle\n  real-peer [0000ee]  ·  Remote Control (new)  ·  idle\n');
  const p1 = t.prep(f1);
  assert.equal(p1.targets[0].status, 'ask');
  assert.ok(p1.targets[0].reason.includes('처음 보는 종류'));
  const f2 = path.join(t.A, 'agents-short.txt');
  fs.writeFileSync(f2, 'This session is a [1]\nPeer sessions (2):\n  host-lively-otter [0000bb]  ·  Remote Control  ·  idle\n  this line changed format\n');
  assert.equal(t.prep(f2).targets[0].status, 'ask');
  assert.equal(t.remembered(), null);
});

test('기억한 세션이 "대상 아님" 으로 돌아오면 기억을 지운다 · 같은 제목의 새 대화(참조 번호가 다르다)는 다시 후보다', () => {
  const t = remoteRepo();
  t.ack(t.prep(t.list(['host-lively-otter [0000bb]'])));
  const p = t.prep(t.list(['host-lively-otter [0000bb]']));
  assert.equal(p.targets[0].via, 'remembered_ref');
  const ing = t.wrong(p);
  assert.equal(ing.wrong_title.forgot, true);
  assert.equal(t.remembered().title, null);
  assert.deepEqual(notOf(t), [{ title: 'host-lively-otter', ref: '0000bb' }]);
  const again = t.prep(t.list(['host-lively-otter [0000ff]'])); // 같은 제목, 다른 대화
  assert.equal(again.targets[0].status, 'ready');
  assert.equal(again.targets[0].send_to, 'host-lively-otter');
});

test('D27 주소록 rc_title 이 있는데 목록에 없으면 남은 하나로 자동 전송하지 않고 묻는다', () => {
  const t = remoteRepo({ rc_title: 'SRV · API' });
  const p = t.prep(t.list(['host-lively-otter [0000bb]']));
  assert.equal(p.targets[0].status, 'ask');
  assert.ok(p.targets[0].reason.includes('SRV · API'));
  assert.equal(t.remembered(), null);
});

test('D27 다른 짝에 기억해 둔 제목은 후보에서 뺀다', () => {
  const t = remoteRepo();
  fs.mkdirSync(path.join(t.state, 'remote_titles_v2'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'remote_titles_v2', 'srv.db.json'), JSON.stringify({ title: 'host-calm-river', ref: '0000cc', source: 'user', not: [] }));
  const p = t.prep(t.list(['host-lively-otter [0000bb]', 'host-calm-river [0000cc]']));
  assert.equal(p.targets[0].status, 'ready');
  assert.equal(p.targets[0].send_to, 'host-lively-otter');
});

test('D27 사용자가 고른 세션이 "대상 아님" 으로 돌아오면 기억하지 않고 그 세션을 {제목, 참조 번호} 로 후보에서 뺀다', () => {
  const t = remoteRepo();
  const agents = t.list(['host-lively-otter [0000bb]', 'host-calm-river [0000cc]']);
  const p = t.prep(agents);
  const picked = t.pick(p, agents, 'host-calm-river');
  const ing = t.wrong(picked);
  assert.equal(ing.wrong_title.title, 'host-calm-river');
  assert.equal(ing.wrong_title.ref, '0000cc');
  assert.equal(ing.wrong_title.forgot, false); // 받았다는 답이 오기 전이라 기억한 적이 없다
  assert.equal(t.remembered().title, null);
  assert.deepEqual(notOf(t), [{ title: 'host-calm-river', ref: '0000cc' }]);
  const again = t.prep(agents); // 남은 후보는 하나 → 그리로
  assert.equal(again.targets[0].status, 'ready');
  assert.equal(again.targets[0].send_to, 'host-lively-otter');
});

test('D27 주소록 rc_title 로 보낸 세션이 "대상 아님" 이면 rc_title 은 그대로 두고 그 세션(참조 번호)만 뺀다', () => {
  const t = remoteRepo({ rc_title: 'SRV · API' });
  const p = t.prep(t.list(['SRV · API [0000bb]']));
  assert.equal(p.targets[0].via, 'rc_title');
  const ing = t.wrong(p);
  assert.equal(ing.wrong_title.ref, '0000bb');
  assert.deepEqual(notOf(t), [{ title: 'SRV · API', ref: '0000bb' }]);
  // 같은 대화가 다시 보여도 다시 보내지 않는다 — rc_title 이 있으니 남은 것으로 자동 선택도 하지 않는다
  assert.notEqual(t.prep(t.list(['SRV · API [0000bb]'])).targets[0].status, 'ready');
  // 새 대화(참조 번호가 다르다)는 다시 rc_title 로 찾는다
  const fresh = t.prep(t.list(['SRV · API [0000ee]']));
  assert.equal(fresh.targets[0].status, 'ready');
  assert.equal(fresh.targets[0].via, 'rc_title');
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.A, '.peer_req.json'), 'utf8')).peers.srv.session_selector.rc_title, 'SRV · API'); // 주소록은 그대로
});

test('0.1.x 가 제목 문자열로 적어 둔 "이 짝 아님" 도 읽는다', () => {
  const t = remoteRepo();
  fs.mkdirSync(path.join(t.state, 'remote_titles'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'remote_titles', 'srv.api.json'), JSON.stringify({ title: null, ref: null, not: ['host-calm-river'] }));
  const p = t.prep(t.list(['host-lively-otter [0000bb]', 'host-calm-river [0000cc]']));
  assert.equal(p.targets[0].status, 'ready');
  assert.equal(p.targets[0].send_to, 'host-lively-otter');
});

test('D27 forget 은 다른 머신 짝의 기억도 지운다 · doctor 가 보여 준다', () => {
  const t = remoteRepo();
  t.ack(t.prep(t.list(['host-lively-otter [0000bb]'])));
  const d = cli(['doctor'], { cwd: t.A, env: { PEER_REQ_STATE: t.state } });
  assert.equal(d.peers.filter((x) => x.alias === 'srv')[0].remembered.title, 'host-lively-otter');
  assert.equal(d.peers.filter((x) => x.alias === 'srv')[0].rc_title, null);
  const f = cli(['forget', '--to', 'srv'], { cwd: t.A, env: { PEER_REQ_STATE: t.state } });
  assert.equal(f.removed, true);
  assert.equal(t.remembered().title, null);
  assert.ok(t.remembered().invalidated_at); // 지운 때를 남긴다 — 그 전에 보낸 요청의 늦은 ACK 가 되살리지 않게
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

// ───────────── 2026-09-21 짝 식별 개선 (확인 뒤 기억 · 기기 이름 · 한글 별칭 · doctor 대조 · discover · 훅) ─────────────

test('같은 머신: 기록해 둔 세션으로 보냈는데 "대상 아님" 이 오면 그 기록을 지운다', () => {
  const { A, B, agentsFile, bodyFile, envA, envB } = sameMachinePair();
  const p1 = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  const m1 = path.join(B, 'in1.txt');
  fs.copyFileSync(p1.targets[0].message_file, m1);
  const r1 = cli(['receive', '--message-file', m1], { cwd: B, env: envB });
  cli(['ingest', '--message-file', r1.reply_file], { cwd: A, env: envA });
  const p2 = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  assert.equal(p2.targets[0].via, 'declared');
  const m2 = path.join(B, 'in2.txt');
  fs.copyFileSync(p2.targets[0].message_file, m2);
  const w = cli(['receive', '--message-file', m2], { cwd: B, env: { ...envB, CLAUDE_CODE_SESSION_ID: 'sid-other' } });
  assert.equal(w.verdict, 'wrong_target');
  const ing = cli(['ingest', '--message-file', w.reply_file], { cwd: A, env: envA });
  assert.equal(ing.forgot_local, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(envA.PEER_REQ_STATE, 'declared', 'pc.b.json'), 'utf8')).session_id, null); // 지운 기록만 남는다
});

test('늦게 온 ACK 는 그사이 새로 고른 기억을 덮지 않는다', () => {
  const t = remoteRepo();
  const agents = t.list(['host-lively-otter [0000bb]', 'host-calm-river [0000cc]']);
  const first = t.pick(t.prep(agents), agents, 'host-lively-otter');
  const second = t.pick(t.prep(agents), agents, 'host-calm-river');
  t.ack(second);
  assert.equal(t.remembered().title, 'host-calm-river');
  const late = t.ack(first); // 먼저 보낸 것의 ACK 가 나중에 왔다
  assert.equal(late.promoted.skipped, 'newer');
  assert.equal(t.remembered().title, 'host-calm-river');
});

test('기기 이름은 대소문자를 무시한다 — 같은 PC 를 달리 적어도 같은 머신 짝이다', () => {
  const { A, agentsFile, bodyFile, envA } = sameMachinePair();
  const book = JSON.parse(fs.readFileSync(path.join(A, '.peer_req.json'), 'utf8'));
  book.self.machine_id = 'M1';
  fs.writeFileSync(path.join(A, '.peer_req.json'), JSON.stringify(book));
  const v = validateBook(JSON.stringify(book), path.join(A, '.peer_req.json'));
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => w.includes('대소문자')));
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  assert.equal(p.targets[0].same_machine, true);
  assert.equal(p.targets[0].via, 'auto');
});

test('한글 별칭을 받는다 — 기록 파일 이름은 해시 키로 쓴다', () => {
  const { A, B, agentsFile, bodyFile, envA, envB } = sameMachinePair();
  const book = JSON.parse(fs.readFileSync(path.join(A, '.peer_req.json'), 'utf8'));
  book.peers = { '볼트': book.peers.b };
  book.groups = { '위키형제': ['볼트'] };
  fs.writeFileSync(path.join(A, '.peer_req.json'), JSON.stringify(book));
  assert.equal(validateBook(JSON.stringify(book), path.join(A, '.peer_req.json')).ok, true);
  const spaced = { schema_version: 1, self: book.self, peers: { '볼 트': book.peers['볼트'] } };
  assert.equal(validateBook(JSON.stringify(spaced), path.join(A, '.peer_req.json')).ok, false); // 공백은 안 된다
  const p = cli(['prepare', '--to', '위키형제', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  assert.equal(p.targets[0].alias, '볼트');
  assert.match(path.basename(p.targets[0].message_file), /^p-[0-9a-f]{12}\.txt$/);
  const m = path.join(B, 'in.txt');
  fs.copyFileSync(p.targets[0].message_file, m);
  cli(['receive', '--message-file', m], { cwd: B, env: envB });
  const ans = path.join(B, 'ans.txt');
  fs.writeFileSync(ans, '답');
  const rep = cli(['reply', '--id', p.request_id, '--status', 'completed', '--body-file', ans], { cwd: B, env: envB });
  const res = cli(['ingest', '--message-file', rep.reply_file], { cwd: A, env: envA });
  assert.equal(res.alias, '볼트');
  assert.match(path.basename(res.result_file), /^p-[0-9a-f]{12}\.md$/);
});

test('받은 요청에는 reported 만 기록한다 — 보낸 쪽 기록(transport_accepted 등)은 거부', () => {
  const { A, B, agentsFile, bodyFile, envA, envB } = sameMachinePair();
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  const m = path.join(B, 'in.txt');
  fs.copyFileSync(p.targets[0].message_file, m);
  cli(['receive', '--message-file', m], { cwd: B, env: envB });
  const bad = cliFail(['record', '--id', p.request_id, '--event', 'transport_accepted'], { cwd: B, env: envB });
  assert.equal(bad.code, 2);
  assert.equal(cli(['record', '--id', p.request_id, '--event', 'reported'], { cwd: B, env: envB }).ok, true);
});

test('doctor 가 같은 머신 짝 주소록과 대조해 어긋남을 잡는다', () => {
  const { A, B, envA } = sameMachinePair();
  assert.equal(cli(['doctor'], { cwd: A, env: envA }).problem_count, 0);
  const bookB = JSON.parse(fs.readFileSync(path.join(B, '.peer_req.json'), 'utf8'));
  bookB.self.endpoint_id = 'pc.renamed'; // 다른 세션이 남의 self 를 고쳐 놓은 상황
  fs.writeFileSync(path.join(B, '.peer_req.json'), JSON.stringify(bookB));
  const d = cli(['doctor'], { cwd: A, env: envA });
  assert.equal(d.problem_count, 1);
  assert.equal(d.peers[0].cross_check.problems[0].code, 'endpoint_mismatch');
  fs.unlinkSync(path.join(B, '.peer_req.json'));
  assert.equal(cli(['doctor'], { cwd: A, env: envA }).peers[0].cross_check.problems[0].code, 'peer_book_missing');
});

test('discover 는 주소록이 없어도 이 머신의 세션과 폴더·주소록 self 를 보여 준다', () => {
  const { B, envA } = sameMachinePair();
  const N = tmp('nobook');
  const d = cli(['discover'], { cwd: N, env: { ...envA, ClaudeDeviceName: 'DEV-PC' } });
  assert.equal(d.device_name, 'DEV-PC');
  assert.equal(d.count, 1);
  assert.equal(d.sessions[0].name, 'repob-7f');
  assert.equal(fwd(d.sessions[0].cwd), fwd(B));
  assert.equal(d.sessions[0].addressbook.self.endpoint_id, 'pc.b');
});

test('훅: 다른 저장소의 주소록 Write·Edit 는 거부하고, 이 저장소 주소록·다른 파일은 통과시킨다', () => {
  const { A, B } = sameMachinePair();
  const hook = path.join(HERE, '..', 'scripts', 'guard-addressbook.cjs');
  const run = (toolName, file) => execFileSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, cwd: A, tool_input: { file_path: file } }), encoding: 'utf8' });
  const denied = JSON.parse(run('Write', path.join(B, '.peer_req.json')));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(denied.hookSpecificOutput.permissionDecisionReason.includes('doctor'));
  assert.equal(JSON.parse(run('Edit', path.join(B, '.PEER_REQ.JSON'))).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('Edit', path.join(A, '.peer_req.json')), '');
  assert.equal(run('Edit', path.join(B, 'src', 'main.js')), '');
  assert.equal(execFileSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' }), ''); // 판정 못 하면 통과
});

// 0.2.2 — 세션 제목은 붙이지 않는다(2026-09-22 사용자 결정). 이름은 사용자 쪽 도구의 몫이고, 두 곳이 붙이면 어긋난다.
test('시작 훅은 세션 제목을 붙이지 않는다 — 제목이 없어도, 있어도', () => {
  const B = receiverRepo();
  fs.mkdirSync(path.join(B, '.vscode'));
  fs.writeFileSync(path.join(B, '.vscode', 'settings.json'), '{ "window.title": "Claude State Bar" }');
  const hook = path.join(HERE, '..', 'scripts', 'session-start.cjs');
  const home = tmp('home');
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sid-t', cwd: B, version: '2.1.300' }));
  const run = (input) =>
    JSON.parse(execFileSync(process.execPath, [hook], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', PEER_REQ_UNATTENDED: '', ClaudeDeviceName: 'DEV-PC', CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_EXECPATH: '' }, encoding: 'utf8' })).hookSpecificOutput;
  for (const input of [
    { source: 'startup', cwd: B, session_id: 'sid-t', session_title: '' },
    { source: 'startup', cwd: B, session_id: 'sid-t' },
    { source: 'resume', cwd: B, session_id: 'sid-t', session_title: '내가 지은 제목' },
  ]) {
    const out = run(input);
    assert.equal(out.sessionTitle, undefined, JSON.stringify(input));
    assert.ok(out.additionalContext.includes('peer_req'));
  }
});

// ───────────── Codex 리뷰(2026-09-21, 0.2.0) 9건 재현 ─────────────

test('리뷰1 그룹으로 보낼 때 한 원격 세션을 두 짝에 배정하지 않는다', () => {
  const A = tmp('repoA');
  const srv = (id, root) => ({ endpoint_id: id, machine_id: 'srv', location: { root } });
  fs.writeFileSync(path.join(A, '.peer_req.json'), JSON.stringify({ schema_version: 1, self: { endpoint_id: 'pc.a', machine_id: 'm1', root: fwd(A) }, peers: { one: srv('srv.one', '/one'), two: srv('srv.two', '/two') }, groups: { both: ['one', 'two'] } }));
  const agents = path.join(A, 'agents.txt');
  fs.writeFileSync(agents, 'This session is a [1]\n  host-lively-otter [0000bb]  ·  Remote Control  ·  idle\n');
  const body = path.join(A, 'body.txt');
  fs.writeFileSync(body, 'q');
  const p = cli(['prepare', '--to', 'both', '--intent', 'notice', '--body-file', body, '--agents-file', agents], { cwd: A, env: { PEER_REQ_STATE: tmp('state') } });
  assert.equal(p.targets[0].status, 'ready');
  assert.notEqual(p.targets[1].status, 'ready');
});

test('리뷰2 먼저 고른 세션의 ACK 가 먼저 와도, 나중에 고른 세션의 ACK 가 이긴다(고른 순서로 비교)', () => {
  const t = remoteRepo();
  const agents = t.list(['host-lively-otter [0000bb]', 'host-calm-river [0000cc]']);
  const first = t.pick(t.prep(agents), agents, 'host-lively-otter');
  const second = t.pick(t.prep(agents), agents, 'host-calm-river');
  t.ack(first);
  assert.equal(t.remembered().title, 'host-lively-otter');
  const later = t.ack(second);
  assert.equal(later.promoted.kind, 'remote');
  assert.equal(t.remembered().title, 'host-calm-river');
});

test('리뷰4 서브에이전트·팀메이트 섹션과 cloud session 은 목록 불완전으로 보지 않는다 · 잘린 목록은 불완전', () => {
  const t = remoteRepo();
  const f = path.join(t.A, 'agents-sections.txt');
  fs.writeFileSync(
    f,
    'This session is a [1] — x\n\nPeer sessions (3):\n  local-1 [000002]  ·  interactive  ·  idle\n  host-lively-otter [0000bb]  ·  Remote Control  ·  idle\n  nightly [0000cc]  ·  cloud session  ·  idle\n\nSubagents:\n  helper [aaaa11]  ·  general-purpose  ·  running  ·  started 1m ago\n\nTeammates (1):\n  mate  ·  worker\n'
  );
  const p = t.prep(f);
  assert.equal(p.targets[0].status, 'ready');
  assert.equal(p.targets[0].via, 'only_candidate');
  const cut = path.join(t.A, 'agents-cut.txt');
  fs.writeFileSync(cut, 'This session is a [1]\n\nPeer sessions (4):\n  host-lively-otter [0000bb]  ·  Remote Control  ·  idle\n  (… 3 more not shown)\n');
  assert.equal(t.prep(cut).targets[0].status, 'ask');
});

test('리뷰5 다른 짝이 새 대화로 바뀌면(같은 제목·새 참조 번호) 그 세션을 이 짝 몫으로 가져가지 않는다', () => {
  const t = remoteRepo();
  fs.mkdirSync(path.join(t.state, 'remote_titles_v2'), { recursive: true });
  fs.writeFileSync(path.join(t.state, 'remote_titles_v2', 'srv.other.json'), JSON.stringify({ title: 'Other · API', ref: '0000aa', source: 'user', not: [] }));
  const p = t.prep(t.list(['Other · API [0000ee]']));
  assert.notEqual(p.targets[0].status, 'ready');
});

test('리뷰6 "대상 아님"·forget 으로 지운 뒤에는 그 전에 보낸 요청의 늦은 ACK 가 기억을 되살리지 않는다', () => {
  const t = remoteRepo();
  const agents = t.list(['host-lively-otter [0000bb]', 'host-calm-river [0000cc]']);
  const p1 = t.pick(t.prep(agents), agents, 'host-calm-river');
  const p2 = t.pick(t.prep(agents), agents, 'host-calm-river');
  t.wrong(p2);
  const late = t.ack(p1);
  assert.equal(late.promoted.skipped, 'excluded');
  assert.equal(t.remembered().title, null);
  assert.deepEqual(notOf(t), [{ title: 'host-calm-river', ref: '0000cc' }]);
  const t2 = remoteRepo();
  const q = t2.prep(t2.list(['host-lively-otter [0000bb]']));
  cli(['forget', '--to', 'srv'], { cwd: t2.A, env: { PEER_REQ_STATE: t2.state } });
  assert.equal(t2.ack(q).promoted.skipped, 'invalidated');
  assert.equal(t2.remembered().title, null);
});

test('리뷰7 같은 PC 짝에게 다시 보냈으면 따라잡기가 그 시도의 duplicate ACK 도 읽어 새 세션을 기억한다', () => {
  const { A, B, agentsFile, bodyFile, envA, envB } = sameMachinePair();
  const home = envA.CLAUDE_CONFIG_DIR;
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env: envA });
  const m1 = path.join(B, 'in1.txt');
  fs.copyFileSync(p.targets[0].message_file, m1);
  cli(['receive', '--message-file', m1], { cwd: B, env: envB }); // 보낸 쪽은 이 ACK 를 못 받았다
  // 받는 쪽 대화가 바뀌었다 — 같은 요청을 새 세션으로 다시 보낸다
  fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sid-b2', cwd: B, name: 'repob-8x' }));
  const agents2 = path.join(A, 'agents2.txt');
  fs.writeFileSync(agents2, 'This session is repoa-11 [000001]\n  repob-8x [000003]  ·  interactive  ·  idle\n');
  const p2 = cli(['prepare', '--request-id', p.request_id, '--to', 'b', '--agents-file', agents2], { cwd: A, env: envA });
  assert.equal(p2.targets[0].send_to, 'repob-8x');
  const m2 = path.join(B, 'in2.txt');
  fs.copyFileSync(p2.targets[0].message_file, m2);
  assert.equal(cli(['receive', '--message-file', m2], { cwd: B, env: { ...envB, CLAUDE_CODE_SESSION_ID: 'sid-b2' } }).verdict, 'duplicate');
  cli(['status'], { cwd: A, env: envA }); // 따라잡기
  assert.equal(JSON.parse(fs.readFileSync(path.join(envA.PEER_REQ_STATE, 'declared', 'pc.b.json'), 'utf8')).session_id, 'sid-b2');
});

test('리뷰8 0.1.x 폴더(remote_titles)는 읽기만 한다 — "이 짝 아님" 은 가져오고, 확인 안 된 옛 기억은 쓰지 않는다', () => {
  const t = remoteRepo();
  const legacy = path.join(t.state, 'remote_titles', 'srv.api.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const old = JSON.stringify({ title: 'host-old', ref: '0000dd', source: 'auto', picked_at: '2026-09-19T00:00:00.000Z', not: ['host-calm-river'] });
  fs.writeFileSync(legacy, old);
  const p = t.prep(t.list(['host-old [0000dd]', 'host-calm-river [0000cc]']));
  assert.equal(p.targets[0].status, 'ready');
  assert.equal(p.targets[0].via, 'only_candidate'); // 옛 기억(remembered_ref)이 아니라 남은 하나
  t.ack(p);
  assert.equal(fs.readFileSync(legacy, 'utf8'), old); // 0.1.x 가 쓰는 파일은 그대로
  assert.equal(t.remembered().title, 'host-old');
});

test('리뷰9 같은 PC 에서 사용자가 목록에서 고른 세션도 받았다는 답이 온 뒤에 기억한다(--pick)', () => {
  const home = tmp('home');
  const state = tmp('state');
  const A = tmp('repoA');
  const B = tmp('repoB');
  fs.mkdirSync(path.join(home, 'sessions'));
  fs.writeFileSync(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sid-b1', cwd: B, name: 'repob-11' }));
  fs.writeFileSync(path.join(home, 'sessions', `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: 'sid-b2', cwd: path.join(B, 'sub'), name: 'repob-22' }));
  fs.writeFileSync(path.join(A, '.peer_req.json'), JSON.stringify({ schema_version: 1, self: { endpoint_id: 'pc.a', machine_id: 'm1', root: fwd(A) }, peers: { b: { endpoint_id: 'pc.b', machine_id: 'm1', location: { root: fwd(B) } } } }));
  const agentsFile = path.join(A, 'agents.txt');
  fs.writeFileSync(agentsFile, 'This session is a [1]\n  repob-11 [000002]  ·  interactive  ·  idle\n  repob-22 [000003]  ·  interactive  ·  idle\n');
  const bodyFile = path.join(A, 'body.txt');
  fs.writeFileSync(bodyFile, 'q');
  const env = { CLAUDE_CONFIG_DIR: home, PEER_REQ_STATE: state, CLAUDE_CODE_SESSION_ID: 'sid-a' };
  const p = cli(['prepare', '--to', 'b', '--intent', 'query', '--body-file', bodyFile, '--agents-file', agentsFile], { cwd: A, env });
  assert.equal(p.targets[0].status, 'ask');
  const p2 = cli(['prepare', '--request-id', p.request_id, '--to', 'b', '--agents-file', agentsFile, '--pick', 'repob-22'], { cwd: A, env });
  assert.equal(p2.targets[0].status, 'ready');
  assert.equal(p2.targets[0].remember_after_ack, true);
  const declaredFile = path.join(state, 'declared', 'pc.b.json');
  assert.equal(fs.existsSync(declaredFile), false); // 보내기 전에는 기억하지 않는다
  const req = extractEnvelope(fs.readFileSync(p2.targets[0].message_file, 'utf8'));
  const ackFile = path.join(A, 'ack.txt');
  fs.writeFileSync(ackFile, renderMessage(makeReply({ type: 'ack', request: req, responder: 'pc.b', status: 'received' })));
  cli(['ingest', '--message-file', ackFile], { cwd: A, env });
  assert.equal(JSON.parse(fs.readFileSync(declaredFile, 'utf8')).session_id, 'sid-b2');
});
