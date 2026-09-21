#!/usr/bin/env node
//
// peer.cjs — peer_req 의 결정적 처리 진입점
//
// ListAgents·SendMessage 는 Claude 의 도구라 스크립트가 부를 수 없다. 그래서 역할을 나눈다.
//   · Claude(SKILL.md) : 목록을 보고, 메시지를 보내고, 사용자에게 묻는다
//   · 이 스크립트       : 주소록·envelope·해시·ID·기록·상태 계산 — 모델에 맡기지 않는 부분
//
// 모든 출력은 JSON 이다(Claude 가 읽는다). 사람에게 보일 문장은 Claude 가 만든다.
// 모든 서브커맨드는 --state-dir <머신 상태 폴더> 를 받는다 — 셸마다 다른 환경변수 문법을 피하려는 것이다
// (PowerShell 은 `VAR=값 node …` 를 못 쓴다, 리뷰 P2).
//
// 서브커맨드
//   doctor                                   주소록·선언·짝 후보·RC 설정 점검 + 같은 머신 짝 주소록과 교차 대조. 아무것도 쓰거나 보내지 않는다
//   discover                                 이 머신에 떠 있는 세션과 각자의 폴더·주소록(self) 목록. 아무것도 쓰지 않는다
//   prepare  --to <짝|그룹> --intent <i> --body-file <f> --agents-file <f> [--request-id <id>] [--pick "<이름>"]
//   record   --id <id> --to <짝> --event <type> [--detail <text>]   (받는 쪽은 --event reported 만)
//   bind     --to <짝> --session-id <sid>    사용자가 알려 준 같은 머신 세션을 기록한다
//   forget   --to <짝>                        기록한 세션을 지운다
//   here                                     받는 대화에서 "여기가 짝" 선언 (주소록 self 필요)
//   receive  --message-file <f> [--from <주소>]
//   reply    --id <id> --status <completed|awaiting_user|failed> --body-file <f>
//   reroute  --id <id> --agents-file <f> [--detail <오류>] [--pick "<send_to>"]   회신이 막혔을 때 같은 머신의 보낸 쪽 세션을 다시 찾는다
//   ingest   --message-file <f> [--from <주소>]
//   sync                                     같은 머신 짝 기록에서 못 받은 응답을 따라잡는다(status·inbox·시작 훅이 자동으로 부른다)
//   unattended --id <id> --to <짝> --confirmed   짝 세션이 없을 때 무인 전송 — 사용자 승인 뒤에만
//   status   [--id <id>]
//   inbox    [--mark-reported]
//
// Node 버전에 기대지 않는다 — lib/util.cjs 머리말 참고.
//

'use strict';

const fs = require('fs');
const path = require('path');
const util = require('./lib/util.cjs');
const ab = require('./lib/addressbook.cjs');
const envl = require('./lib/envelope.cjs');
const store = require('./lib/store.cjs');
const state = require('./lib/state.cjs');
const sessions = require('./lib/sessions.cjs');
const ingest = require('./lib/ingest.cjs');
const unattended = require('./lib/unattended.cjs');

function UsageError(message) {
  this.message = message;
  this.usage = true;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') === 0) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.indexOf('--') === 0) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function opt(args, key) {
  const v = args[key];
  return v === undefined || v === true || v === '' ? null : String(v);
}

function need(args, key) {
  const v = opt(args, key);
  if (v === null) throw new UsageError('--' + key + ' 가 필요하다');
  return v;
}

function readFileArg(args, key) {
  const f = need(args, key);
  if (f === '-') return fs.readFileSync(0, 'utf8');
  if (!fs.existsSync(f)) throw new UsageError('--' + key + ' 파일이 없다: ' + f);
  return fs.readFileSync(f, 'utf8');
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// git 도 PATH 의 절대경로로만 실행한다 — 저장소 안의 git.exe 가 대신 돌지 않게(2차 리뷰 P1)
function gitRoot(cwd) {
  const r = util.runExe('git', ['rev-parse', '--show-toplevel'], { cwd: cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

// 기록을 둘 저장소 루트: 주소록이 있으면 그 폴더, 없으면 git 루트, 그것도 없으면 cwd
function repoContext(cwd) {
  const b = ab.loadBook(cwd);
  const root = b.found ? b.root : gitRoot(cwd) || cwd;
  return { b: b, root: root };
}

// 받는 쪽은 주소록이 없으면 어차피 거부한다 — 대상 확인 전에 그 저장소에서 아무것도 실행하지 않는다
function receiveContext(cwd) {
  const b = ab.loadBook(cwd);
  return { b: b, root: b.found ? b.root : cwd };
}

function requireBook(b) {
  if (!b.found) {
    const e = new Error('이 저장소에 주소록(.peer_req.json)이 없다');
    e.exitCode = 3;
    throw e;
  }
  if (!b.ok) {
    const e = new Error('주소록 오류:\n- ' + b.errors.join('\n- '));
    e.exitCode = 3;
    throw e;
  }
  return b.book;
}

// ───────────────────────── doctor ─────────────────────────

function cmdDoctor(args, cwd) {
  const ctx = repoContext(cwd);
  const b = ctx.b;
  const settings = util.readJson(path.join(util.claudeHome(), 'settings.json'), {});
  const reg = sessions.readRegistry();
  const declared = sessions.readDeclared().endpoints;
  const titles = sessions.readTitles().endpoints;
  const report = {
    repo_root: ctx.root,
    addressbook: b.found ? { file: b.file, ok: b.ok, errors: b.errors, warnings: b.warnings } : null,
    remote_control_at_startup: settings.remoteControlAtStartup === undefined ? null : settings.remoteControlAtStartup,
    session_id: process.env.CLAUDE_CODE_SESSION_ID || null,
    state_dir: util.stateDir(),
    node: process.version,
    registry: { readable: reg.readable, reason: reg.reason || null, live_sessions: reg.sessions.length },
    peers: [],
  };
  if (b.found && b.ok) {
    report.self = b.book.self;
    report.device_name = util.deviceName();
    report.records_commit = ab.recordsCommitted(b.book);
    const peers = ab.peersOf(b.book);
    let problems = 0;
    Object.keys(peers).forEach((alias) => {
      const p = peers[alias];
      const same = util.sameMachine(p.machine_id, b.book.self.machine_id);
      const row = { alias: alias, endpoint_id: p.endpoint_id, same_machine: same, root: p.location.root };
      if (same) {
        const dec = declared[p.endpoint_id] || null;
        row.declared = dec;
        row.declared_alive = !!(dec && reg.sessions.some((s) => s.sessionId === dec.session_id));
        row.sessions_in_root = reg.sessions.filter((s) => util.isUnder(s.cwd, p.location.root)).map((s) => ({ name: s.name, session_id: s.sessionId, status: s.status }));
        row.cross_check = crossCheck(b.book, p);
        problems += row.cross_check.problems.length;
      } else {
        row.rc_title = (p.session_selector && p.session_selector.rc_title) || null;
        row.remembered = titles[p.endpoint_id] || null;
        row.host_alias = p.location.host_alias || null;
      }
      report.peers.push(row);
    });
    report.problem_count = problems;
    if (report.peers.length === 0) report.note = '짝이 없다 — 받기만 하는 저장소다';
    if (b.book.groups) report.groups = b.book.groups;
  }
  print(report);
}

// 같은 머신 짝의 주소록과 내 주소록을 대조한다 — 파일 하나만 보면 둘 다 "정상" 인데 서로 어긋나 있을 수 있다
// (2026-09-21 사고: 두 저장소 doctor 가 모두 ok 였는데 상대 self 이름이 달라 곧바로 WRONG_TARGET 이 났다).
// 대조만 한다. 상대 주소록은 고치지 않는다 — 고치는 것은 그 저장소 세션의 몫이다.
function crossCheck(myBook, peer) {
  const out = { peer_book: null, problems: [], notes: [] };
  const theirs = ab.loadBookAt(peer.location.root);
  out.peer_book = theirs.found ? theirs.file : null;
  if (!theirs.found) {
    out.problems.push({ code: 'peer_book_missing', message: '짝 폴더에 주소록이 없다 — 보내면 받는 쪽이 대상을 확인하지 못해 WRONG_TARGET 으로 돌려보낸다' });
    return out;
  }
  if (!theirs.ok) {
    out.problems.push({ code: 'peer_book_invalid', message: '짝 주소록이 깨져 있다: ' + theirs.errors[0] });
    return out;
  }
  const s = theirs.book.self;
  if (s.endpoint_id !== peer.endpoint_id) {
    out.problems.push({ code: 'endpoint_mismatch', message: '짝 주소록의 self 는 "' + s.endpoint_id + '" 인데 내 주소록엔 "' + peer.endpoint_id + '" 로 적혀 있다 — 보내면 WRONG_TARGET' });
  }
  if (!util.sameMachine(s.machine_id, peer.machine_id)) {
    out.problems.push({ code: 'machine_mismatch', message: '짝 주소록의 기기 이름은 "' + s.machine_id + '" 인데 내 주소록엔 "' + peer.machine_id + '"' });
  }
  const back = Object.keys(ab.peersOf(theirs.book)).map((a) => ({ alias: a, p: theirs.book.peers[a] })).filter((x) => x.p.endpoint_id === myBook.self.endpoint_id);
  if (back.length === 0) {
    out.notes.push('짝은 나를 짝으로 적어 두지 않았다 — 짝이 나에게 먼저 보낼 수는 없다(받기·답장은 된다)');
  } else if (!util.samePath(back[0].p.location.root, myBook.self.root)) {
    out.problems.push({ code: 'reverse_root_mismatch', message: '짝 주소록이 나를 다른 폴더(' + back[0].p.location.root + ')로 적어 두었다' });
  }
  return out;
}

// ───────────────────────── discover ─────────────────────────
// 주소록이 없어도 쓸 수 있다 — "이 머신에 떠 있는 세션이 각각 어느 폴더인가" 를 보여 준다.
// 2026-09-21: 이게 없어서 세션이 내부 함수를 node -e 로 직접 불러 폴더를 알아냈다.
function cmdDiscover(args, cwd) {
  const reg = sessions.readRegistry();
  const me = process.env.CLAUDE_CODE_SESSION_ID || null;
  const rows = reg.sessions.map((s) => {
    const b = ab.loadBook(s.cwd);
    return {
      name: s.name,
      session_id: s.sessionId,
      cwd: s.cwd,
      status: s.status,
      kind: s.kind,
      this_session: s.sessionId === me,
      addressbook: b.found ? { root: b.root, ok: b.ok, self: b.ok ? b.book.self : null, error: b.ok ? null : b.errors[0] } : null,
    };
  });
  print({ device_name: util.deviceName(), registry: { readable: reg.readable, reason: reg.reason || null }, count: rows.length, sessions: rows });
}

// ───────────────────────── prepare ─────────────────────────

// 사용자가 목록에서 직접 고른 대상(--pick "<이름>" 또는 "<이름> [ref]").
// 고른 세션은 상대가 받았다고 답한 뒤 기억한다 — 다음부터는 묻지 않는다.
function resolvePicked(o) {
  const peer = ab.peersOf(o.book)[o.alias];
  const same = util.sameMachine(peer.machine_id, o.book.self.machine_id);
  const m = o.pick.match(/^(.*?)(?: \[([0-9a-z]+)\])?$/);
  const rows = o.agents.rows.filter((r) => r.name === m[1] && (!m[2] || r.ref === m[2]));
  const base = { alias: o.alias, endpoint_id: peer.endpoint_id, same_machine: same };
  if (rows.length !== 1) return Object.assign(base, { status: 'ask', reason: '--pick "' + o.pick + '" 가 목록에서 하나로 특정되지 않는다(' + rows.length + '개)', candidates: [] });
  const row = rows[0];
  const sendTo = sessions.addressFor(o.agents.rows, row);
  // 다른 머신은 고른 세션(제목·참조 번호)을 적어 둔다 — 다음부터 묻지 않는다(D27)
  if (!same) {
    if (row.where !== 'remote') return Object.assign(base, { status: 'ask', reason: '"' + row.name + '" 는 다른 머신(Remote Control) 세션이 아니다', candidates: [] });
    return Object.assign(base, { status: 'ready', via: 'user_pick', send_to: sendTo, row: row, remember: true });
  }
  // 같은 머신은 세션 번호가 있어야 받는 쪽이 "내 앞으로 온 게 맞나" 를 확인할 수 있다 — 모르면 보내지 않는다(2차 리뷰 P2 · 사용자 결정)
  if (row.where !== 'local' && sessions.localRowsOf(o.agents, o.registry).indexOf(row) === -1) {
    return Object.assign(base, { status: 'ask', reason: '"' + row.name + '" 는 이 머신의 세션이 아니다(' + row.kind + ')', candidates: [] });
  }
  const hits = o.registry.readable ? o.registry.sessions.filter((s) => s.name === row.name) : [];
  if (hits.length === 1) return Object.assign(base, { status: 'ready', via: 'user_pick', send_to: sendTo, row: row, session_id: hits[0].sessionId, bind: true });
  return Object.assign(base, {
    status: 'ask',
    reason: o.registry.readable ? '"' + row.name + '" 의 세션 번호를 찾지 못했다(' + hits.length + '개) — 받는 쪽에서 here 로 선언해 달라고 한다' : '세션 등록 파일을 읽을 수 없어 세션 번호를 확인할 수 없다 — 같은 머신 전송을 하지 않는다',
    candidates: [],
  });
}

// prepared 이벤트에 남길 "고른 세션" — 확인(ACK) 뒤 기억하거나, WRONG_TARGET 이면 지울 근거
function routeOf(r) {
  const source = r.via === 'user_pick' ? 'user' : r.via === 'remembered_ref' ? 'ref' : r.via === 'rc_title' ? 'rc_title' : r.via === 'remembered' ? 'title' : 'auto';
  if (r.same_machine) return { same_machine: true, via: r.via, send_to: r.send_to, session_id: r.session_id || null, name: r.row ? r.row.name : r.send_to, bind: !!r.bind, source: source };
  return { same_machine: false, via: r.via, send_to: r.send_to, title: r.row ? r.row.name : null, ref: r.row ? r.row.ref : null, remember: !!r.remember, source: source };
}

function cmdPrepare(args, cwd) {
  const ctx = repoContext(cwd);
  const book = requireBook(ctx.b);
  const root = ctx.root;
  const peers = ab.peersOf(book);
  if (Object.keys(peers).length === 0) throw new UsageError('주소록에 짝(peers)이 없다 — 받기만 하는 저장소에서는 보낼 수 없다');
  const target = need(args, 'to');
  const aliases = ab.expandTarget(book, target);
  if (!aliases) throw new UsageError('주소록에 "' + target + '" 라는 짝·그룹이 없다. 있는 것: ' + Object.keys(peers).concat(Object.keys(book.groups || {})).join(', '));
  const agents = sessions.parseAgents(readFileArg(args, 'agents-file'));
  const selfSessionId = process.env.CLAUDE_CODE_SESSION_ID || null;
  // 지난 요청의 ACK 를 같은 머신 짝 기록에서 먼저 따라잡는다 — 그래야 확인된 짝 세션이 기억에 올라와 있다
  syncIfPossible(ctx.b, root);

  let requestId = opt(args, 'request-id');
  let intent;
  let body;
  let conversationId = opt(args, 'conversation');
  store.applyCommitPolicy(root, ab.recordsCommitted(book));

  if (requestId) {
    // 재시도: 같은 request_id·본문으로 새 attempt 만 만든다(C6)
    const rec = store.readRequestRecord(store.requestDir(root, requestId));
    if (!rec || rec.direction !== 'outbound') throw new UsageError('보낸 기록에 ' + requestId + ' 가 없다');
    // 처음 기록한 대상과 같을 때만 — 그사이 주소록이 바뀌었으면 같은 요청을 다른 곳에 보내지 않는다(2차 리뷰 P1)
    aliases.forEach((a) => {
      const snap = rec.targets[a];
      if (!snap) throw new UsageError(a + ' 는 이 요청의 처음 받는 쪽이 아니다 — 새 요청으로 보내야 한다');
      if (snap.endpoint_id !== peers[a].endpoint_id || snap.root !== peers[a].location.root) {
        throw new UsageError('주소록의 ' + a + ' 가 처음 보낸 대상(' + snap.endpoint_id + ' · ' + snap.root + ')과 달라졌다 — 새 요청으로 보내야 한다');
      }
    });
    intent = rec.intent;
    body = rec.body;
    conversationId = rec.conversation_id;
  } else {
    intent = need(args, 'intent');
    if (!envl.INTENTS[intent]) throw new UsageError('--intent 는 ' + Object.keys(envl.INTENTS).join('·') + ' 중 하나');
    body = readFileArg(args, 'body-file').replace(/\s+$/, '');
    if (!body) throw new UsageError('본문이 비어 있다');
    requestId = util.uuid();
    conversationId = conversationId || util.uuid();
  }
  const dir = store.requestDir(root, requestId);
  const targets = {};
  aliases.forEach((a) => {
    targets[a] = { endpoint_id: peers[a].endpoint_id, root: peers[a].location.root };
  });
  store.createRequestRecord(dir, {
    direction: 'outbound',
    request_id: requestId,
    conversation_id: conversationId,
    intent: intent,
    body: body,
    sender: { endpoint_id: book.self.endpoint_id, root: book.self.root },
    targets: targets,
    created_at: util.nowIso(),
  });

  const registry = sessions.readRegistry();
  const pick = opt(args, 'pick');
  if (pick && aliases.length !== 1) throw new UsageError('--pick 은 짝 하나에게 보낼 때만 쓴다');
  // 그룹으로 보낼 때 앞 짝에게 배정한 세션 — 기억은 ACK 뒤라 기록에 아직 없으니 여기서 넘겨 준다
  const claimed = { refs: {}, sessions: {} };
  const results = aliases.map((alias) => {
    const r = pick
      ? resolvePicked({ book: book, alias: alias, agents: agents, registry: registry, pick: pick })
      : sessions.resolvePeer({ book: book, alias: alias, agents: agents, selfSessionId: selfSessionId, registry: registry, claimed: claimed });
    if (r.status === 'ready') {
      if (r.row && r.row.ref && !r.same_machine) claimed.refs[r.row.ref] = alias;
      if (r.session_id) claimed.sessions[r.session_id] = alias;
      const peer = peers[alias];
      const env = envl.makeRequest({
        requestId: requestId,
        conversationId: conversationId,
        sender: { endpoint_id: book.self.endpoint_id, root: book.self.root },
        recipient: { endpoint_id: peer.endpoint_id, root: peer.location.root, session_id: r.session_id || null },
        intent: intent,
        body: body,
      });
      const file = store.writeText(dir, 'outbox', util.fileKey(alias) + '.txt', envl.renderMessage(env));
      // 고른 세션은 여기서 기억하지 않는다 — route 로 적어 두고, 상대가 받았다고 답하면 ingest 가 기억한다.
      // WRONG_TARGET 이 오면 같은 route 로 그 세션을 후보에서 빼거나(다른 머신) 기록을 지운다(같은 머신).
      const route = routeOf(r);
      // remote_title: 0.1.x 가 읽던 필드 — 적어 둔 세션으로 보낸 다른 머신 시도에만
      const learned = !r.same_machine && r.via !== 'rc_title' && r.row ? r.row.name : null;
      store.appendEvent(dir, { type: 'prepared', recipient: alias, attempt_id: env.attempt_id, detail: 'via=' + r.via + ' to=' + r.send_to, remote_title: learned, route: route });
      const willRemember = !!(route.same_machine ? route.bind : route.remember);
      return { alias: alias, status: 'ready', send_to: r.send_to, via: r.via, message_file: file, attempt_id: env.attempt_id, same_machine: r.same_machine, remember_after_ack: willRemember, note: r.note || null };
    }
    if (r.status === 'unreachable') store.appendEvent(dir, { type: 'unreachable', recipient: alias, detail: r.reason });
    return { alias: alias, status: r.status, reason: r.reason, note: r.note || null, candidates: r.candidates || [], same_machine: r.same_machine };
  });
  print({
    request_id: requestId,
    short_id: util.shortId(requestId),
    conversation_id: conversationId,
    intent: intent,
    intent_label: envl.INTENTS[intent].label,
    rc_visible: agents.rows.some((r) => r.where === 'remote'),
    record_dir: dir,
    targets: results,
  });
}

// ───────────────────────── record · bind · forget · here ─────────────────────────

// 보낸 쪽이 전송 도구 결과로 적는 것 / 받은 쪽이 적는 것 — 받은 쪽은 "알렸다" 하나뿐이다
// (2026-09-21: 받은 쪽이 transport_accepted 를 적은 일이 있었다. 무해했지만 절차가 섞였다는 신호다)
const RECORDABLE = ['transport_accepted', 'unreachable', 'held', 'refused', 'expired', 'failed', 'unknown', 'reported'];
const RECORDABLE_INBOUND = ['reported'];

function cmdRecord(args, cwd) {
  const root = repoContext(cwd).root;
  const id = need(args, 'id');
  const type = need(args, 'event');
  if (RECORDABLE.indexOf(type) === -1) throw new UsageError('--event 는 ' + RECORDABLE.join('·') + ' 중 하나');
  const dir = store.requestDir(root, id);
  const rec = store.readRequestRecord(dir);
  if (!rec) throw new UsageError('기록에 ' + id + ' 가 없다');
  if (rec.direction === 'inbound' && RECORDABLE_INBOUND.indexOf(type) === -1) {
    throw new UsageError('받은 요청에는 ' + RECORDABLE_INBOUND.join('·') + ' 만 기록한다 — ' + type + ' 는 보낸 쪽이 적는 것이다');
  }
  const who = rec.direction === 'inbound' ? 'self' : need(args, 'to');
  if (rec.direction === 'outbound' && !rec.targets[who]) throw new UsageError(id + ' 의 받는 쪽에 ' + who + ' 가 없다');
  store.appendEvent(dir, { type: type, recipient: who, detail: opt(args, 'detail') });
  print({ ok: true, request_id: id, recipient: who, state: state.fold(store.listEvents(dir))[who] });
}

function sameMachinePeer(book, alias) {
  const peer = ab.peersOf(book)[alias];
  if (!peer) throw new UsageError('주소록에 짝 "' + alias + '" 가 없다');
  if (!util.sameMachine(peer.machine_id, book.self.machine_id)) throw new UsageError(alias + ' 는 다른 머신 짝이다 — 세션 기록은 같은 머신 짝에만 쓴다');
  return peer;
}

function cmdBind(args, cwd) {
  const book = requireBook(repoContext(cwd).b);
  const alias = need(args, 'to');
  const peer = sameMachinePeer(book, alias);
  const sid = need(args, 'session-id');
  const s = sessions.readRegistry().sessions.filter((x) => x.sessionId === sid)[0];
  print({ ok: true, alias: alias, declared: sessions.declare(peer.endpoint_id, { sessionId: sid, root: peer.location.root, name: s ? s.name : null, source: 'user' }), alive: !!s });
}

// 같은 머신은 기록한 세션 번호, 다른 머신은 적어 둔 세션(제목·참조 번호·"이 짝 아님" 목록)을 지운다
function cmdForget(args, cwd) {
  const book = requireBook(repoContext(cwd).b);
  const alias = need(args, 'to');
  const peer = ab.peersOf(book)[alias];
  if (!peer) throw new UsageError('주소록에 짝 "' + alias + '" 가 없다');
  const same = util.sameMachine(peer.machine_id, book.self.machine_id);
  print({ ok: true, alias: alias, same_machine: same, removed: same ? sessions.forget(peer.endpoint_id) : sessions.forgetTitle(peer.endpoint_id) });
}

function cmdHere(args, cwd) {
  const ctx = repoContext(cwd);
  const book = requireBook(ctx.b);
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) throw new UsageError('CLAUDE_CODE_SESSION_ID 가 없다 — Claude Code 세션 안에서 실행해야 한다');
  const s = sessions.readRegistry().sessions.filter((x) => x.sessionId === sid)[0];
  print({ ok: true, endpoint_id: book.self.endpoint_id, declared: sessions.declare(book.self.endpoint_id, { sessionId: sid, root: ctx.root, name: s ? s.name : null, source: 'here' }) });
}

// ───────────────────────── receive (받는 쪽) ─────────────────────────

// 대상 확인 — **확인할 수 없는 값이 하나라도 있으면 거부한다**(리뷰 P1 · fail-closed).
//   · 이 저장소에 유효한 주소록(self)이 있어야 한다 — 없거나 깨졌으면 확인 불가
//   · recipient_endpoint = self.endpoint_id
//   · recipient_root = 이 저장소 루트 (정확히 같아야 한다 — 상위 폴더 허용 안 함)
//   · recipient_session_id 가 있으면 이 세션이어야 한다 — 이 세션 번호를 모르면 확인 불가
function targetMismatch(b, root, env) {
  const out = [];
  if (!b.found) return ['이 저장소에 주소록(.peer_req.json)이 없어 대상을 확인할 수 없다'];
  if (!b.ok) return ['이 저장소의 주소록이 깨져 있어 대상을 확인할 수 없다: ' + b.errors[0]];
  const me = b.book.self;
  if (env.recipient_endpoint !== me.endpoint_id) out.push('recipient_endpoint(' + env.recipient_endpoint + ') ≠ 이 저장소(' + me.endpoint_id + ')');
  if (!util.samePath(env.recipient_root, root)) out.push('recipient_root(' + env.recipient_root + ') ≠ 이 저장소(' + root + ')');
  if (env.recipient_session_id) {
    const selfSid = process.env.CLAUDE_CODE_SESSION_ID || '';
    if (!selfSid) out.push('recipient_session_id 가 지정됐는데 이 세션 번호를 알 수 없다');
    else if (env.recipient_session_id !== selfSid) out.push('recipient_session_id 가 이 세션이 아니다');
  }
  return out;
}

function cmdReceive(args, cwd) {
  const ctx = receiveContext(cwd);
  const b = ctx.b;
  const root = ctx.root;
  const from = opt(args, 'from');
  let env;
  try {
    env = envl.extractEnvelope(readFileArg(args, 'message-file'));
  } catch (e) {
    if (e.usage) throw e;
    return print({ verdict: 'invalid', problems: [e.message], hint: '메시지 끝의 ```peer_req 블록을 그대로 파일에 옮겼는지 확인하라' });
  }
  const problems = envl.checkEnvelope(env);
  if (problems.length) return print({ verdict: 'invalid', problems: problems, request_id: env && env.request_id });
  if (env.type !== 'request') return print({ verdict: 'not_a_request', type: env.type, hint: '응답(ack·result)은 ingest 로 기록한다. 회신하지 않는다' });

  const mismatch = targetMismatch(b, root, env);
  if (mismatch.length) {
    // 대상이 아니면 이 저장소에 기록을 남기지 않는다. 회신 파일만 머신 상태 쪽에 둔다.
    const responder = b.found && b.ok ? b.book.self.endpoint_id : 'unknown';
    const ack = envl.makeReply({ type: 'ack', request: env, responder: responder, status: 'wrong_target', body: 'WRONG_TARGET — ' + mismatch.join(' / ') });
    const f = path.join(util.stateDir(), 'wrong_target', env.request_id + '-' + env.attempt_id + '.txt');
    util.writeFileAtomic(f, envl.renderMessage(ack));
    return print({ verdict: 'wrong_target', request_id: env.request_id, mismatch: mismatch, reply_file: f, reply_to: from, instruction: '이 파일 내용을 from 주소로 SendMessage 하고 조사하지 않는다' });
  }

  const responder = b.book.self.endpoint_id;
  store.applyCommitPolicy(root, ab.recordsCommitted(b.book));
  const dir = store.requestDir(root, env.request_id);
  const made = store.createRequestRecord(dir, { direction: 'inbound', request_id: env.request_id, envelope: env, from: from, received_at: util.nowIso() });
  const base = { request_id: env.request_id, short_id: util.shortId(env.request_id), intent: env.intent, intent_label: envl.INTENTS[env.intent].label, sender_endpoint: env.sender_endpoint, from: from, body: env.body, record_dir: dir };

  if (!made.created && !made.existing) {
    // 다른 처리가 막 같은 요청을 게시하는 중이다(하드링크를 못 쓰는 파일시스템) — 처리하지 않고 알린다
    return print(Object.assign({}, base, { verdict: 'in_progress', instruction: '같은 요청을 이미 처리하기 시작했다. 다시 실행하지 않는다. 보낸 쪽에는 회신하지 않는다' }));
  }
  if (!made.created) {
    const prev = made.existing.envelope || {};
    if (prev.body_sha256 !== env.body_sha256) {
      const ack = envl.makeReply({ type: 'ack', request: env, responder: responder, status: 'conflict', body: 'CONFLICT — 같은 request_id 로 다른 본문이 왔다. 처리하지 않는다.' });
      store.appendEvent(dir, { type: 'conflict', recipient: 'self', attempt_id: env.attempt_id, detail: 'new body ' + env.body_sha256.slice(0, 12) + ' ≠ ' + String(prev.body_sha256).slice(0, 12) });
      const f = store.writeText(dir, 'outbox', 'ack-conflict-' + env.attempt_id + '.txt', envl.renderMessage(ack));
      return print(Object.assign({}, base, { verdict: 'conflict', reply_file: f, instruction: '이 파일 내용을 from 으로 보내고 처리하지 않는다' }));
    }
    store.appendEvent(dir, { type: 'duplicate', recipient: 'self', attempt_id: env.attempt_id, detail: from ? 'from=' + from : null });
    const st = state.fold(store.listEvents(dir)).self;
    const ack = envl.makeReply({ type: 'ack', request: env, responder: responder, status: 'duplicate', body: '이미 받은 요청이다. 현재 상태: ' + (st ? st.state : '알 수 없음') + '. 다시 실행하지 않는다.' });
    const f = store.writeText(dir, 'outbox', 'ack-duplicate-' + env.attempt_id + '.txt', envl.renderMessage(ack));
    return print(Object.assign({}, base, { verdict: 'duplicate', state: st, reply_file: f, result_file: store.resultMessageFile(dir), instruction: '다시 실행하지 않는다. reply_file 을 보내고, result_file 이 있으면 그것도 보낸다' }));
  }

  store.appendEvent(dir, { type: 'received', recipient: 'self', attempt_id: env.attempt_id, detail: from ? 'from=' + from : null });
  const ack = envl.makeReply({ type: 'ack', request: env, responder: responder, status: 'received', body: '접수했다 (' + envl.INTENTS[env.intent].label + ').' });
  const f = store.writeText(dir, 'outbox', 'ack.txt', envl.renderMessage(ack));
  const next = {
    query: '물어본 것만 조사해 답을 쓴 뒤 reply --status completed 로 결과를 만든다',
    notice: '이 저장소에 미치는 영향 범위만 확인해 reply --status completed 로 보고한다. 고치지 않는다',
    change_request: '조사·수정에 착수하지 않는다. 바로 reply --status awaiting_user 로 "접수, 사용자 지시 대기" 결과를 만들고 사용자에게 알린다',
  }[env.intent];
  print(Object.assign({}, base, { verdict: 'new', reply_file: f, instruction: '먼저 reply_file 을 from 으로 보낸다(ACK). 그다음: ' + next }));
}

// ───────────────────────── reply (받는 쪽 결과) ─────────────────────────

// 회신 주소: 처음 받은 from, reroute 로 바꿨으면 마지막 것
function currentReplyTo(dir, rec) {
  const moved = store.listEvents(dir).filter((e) => e.type === 'rerouted' && e.reply_to);
  return moved.length ? moved[moved.length - 1].reply_to : rec.from;
}

function replyInstruction(replyTo) {
  if (String(replyTo || '').indexOf('unattended:') === 0) {
    return '무인 경로로 온 요청이다 — SendMessage 할 곳이 없다. 결과는 이 기록에 남고, 보낸 쪽이 무인 "다시 확인" 으로 가져간다';
  }
  return 'reply_file 내용을 reply_to 로 SendMessage 한다. 실패하면 reroute';
}

// completed·failed 는 한 번만 쓴다. 확정 결과는 publishOnce 로 게시해 **동시에 두 번 불러도 승자는 하나**다
// (2차 리뷰 P2: 검사와 쓰기가 따로라 둘 다 성공하던 문제). 같은 내용이면 그대로 성공, 다르면 거부.
// awaiting_user 는 임시 결과라 나중에 completed·failed 로 바꿀 수 있다.
function cmdReply(args, cwd) {
  const ctx = repoContext(cwd);
  const root = ctx.root;
  const id = need(args, 'id');
  const status = need(args, 'status');
  if (['completed', 'awaiting_user', 'failed'].indexOf(status) === -1) throw new UsageError('--status 는 completed·awaiting_user·failed 중 하나');
  const dir = store.requestDir(root, id);
  const rec = store.readRequestRecord(dir);
  if (!rec || rec.direction !== 'inbound') throw new UsageError('받은 기록에 ' + id + ' 가 없다');
  const body = readFileArg(args, 'body-file').replace(/\s+$/, '');
  const finFile = path.join(dir, 'outbox', store.RESULT_FINAL);
  const replyTo = currentReplyTo(dir, rec);

  const idempotentOrRefuse = () => {
    if (util.publishPending(finFile)) throw new UsageError('이 요청의 결과를 다른 처리가 지금 확정하는 중이다 — 덮어쓰지 않는다');
    const prev = ingest.readReply(finFile);
    const cur = state.fold(store.listEvents(dir)).self;
    if (prev && prev.status === status && prev.body_sha256 === util.sha256(body)) {
      return print({ ok: true, idempotent: true, request_id: id, status: status, reply_file: finFile, reply_to: replyTo, instruction: '같은 결과다. 아직 못 보냈으면 ' + replyInstruction(replyTo) });
    }
    throw new UsageError('이 요청의 결과는 이미 "' + (prev ? prev.status : cur ? cur.state : '?') + '" 로 확정됐다 — 덮어쓰지 않는다');
  };
  if (fs.existsSync(finFile) || util.publishPending(finFile)) return idempotentOrRefuse();

  const responder = ctx.b.found && ctx.b.ok ? ctx.b.book.self.endpoint_id : rec.envelope.recipient_endpoint;
  const text = envl.renderMessage(envl.makeReply({ type: 'result', request: rec.envelope, responder: responder, status: status, body: body }));
  let f;
  if (state.FINAL.indexOf(status) !== -1) {
    if (!util.publishOnce(finFile, text)) return idempotentOrRefuse();
    f = finFile;
  } else {
    f = store.writeText(dir, 'outbox', store.RESULT_TEMP, text);
  }
  store.writeText(dir, 'result', 'result.md', body + '\n');
  store.appendEvent(dir, { type: status, recipient: 'self', attempt_id: rec.envelope.attempt_id });
  print({ ok: true, request_id: id, status: status, reply_file: f, reply_to: replyTo, instruction: replyInstruction(replyTo) });
}

// ───────────────────────── reroute (받는 쪽 회신 주소가 막혔을 때) ─────────────────────────

function cmdReroute(args, cwd) {
  const root = repoContext(cwd).root;
  const id = need(args, 'id');
  const dir = store.requestDir(root, id);
  const rec = store.readRequestRecord(dir);
  if (!rec || rec.direction !== 'inbound') throw new UsageError('받은 기록에 ' + id + ' 가 없다');
  store.appendEvent(dir, { type: 'reply_undelivered', recipient: 'self', detail: opt(args, 'detail') });
  // 같은 머신에서 온 요청인가는 **처음 받은 주소**로 가른다. 한 번 다시 찾은 뒤의 답장 주소는 세션 이름이라
  // 'uds:' 로 시작하지 않는다 — 그걸로 가르면 두 번째 reroute 가 늘 "다른 머신" 으로 끝났다(C04).
  const first = String(rec.from || '');
  if (first.indexOf('uds:') !== 0) {
    return print({ status: 'unreachable', reason: '다른 머신에서 온 요청이다. Remote Control 주소는 다시 찾지 않는다 — 결과는 이 저장소 기록에 남아 있다', reply_to: currentReplyTo(dir, rec) || first, record_dir: dir });
  }
  const agents = sessions.parseAgents(readFileArg(args, 'agents-file'));
  let r = sessions.findReplyTarget({ senderRoot: rec.envelope.sender_root, agents: agents, selfSessionId: process.env.CLAUDE_CODE_SESSION_ID || null });
  // 후보가 여럿이라 사용자가 골랐다 — 그 후보가 목록에 있고 보낸 쪽 저장소의 세션일 때만 받아들인다(2차 리뷰 P2)
  const pick = opt(args, 'pick');
  if (pick && r.status === 'ask') {
    const c = (r.candidates || []).filter((x) => x.send_to && (x.send_to === pick || x.name === pick || x.session_id === pick));
    r = c.length === 1 ? { status: 'ready', send_to: c[0].send_to, session_id: c[0].session_id } : Object.assign({}, r, { reason: '--pick "' + pick + '" 가 후보에서 하나로 특정되지 않는다. ' + r.reason });
  }
  if (r.status === 'ready') store.appendEvent(dir, { type: 'rerouted', recipient: 'self', reply_to: r.send_to, detail: 'session=' + r.session_id });
  const pending = [path.join(dir, 'outbox', 'ack.txt'), store.resultMessageFile(dir)].filter((f) => f && fs.existsSync(f));
  print(Object.assign({}, r, { request_id: id, record_dir: dir, files: pending, instruction: r.status === 'ready' ? 'files 중 아직 못 보낸 것을 send_to 로 다시 보낸다' : r.status === 'ask' ? '후보를 사용자에게 보여 주고 고르게 한 뒤 reroute --pick "<send_to>" 로 다시 부른다' : '보내지 않는다. 결과는 이 저장소 기록에 남아 있다고 사용자에게 알린다' }));
}

// ───────────────────────── ingest · sync (보낸 쪽이 응답을 받음) ─────────────────────────

function cmdIngest(args, cwd) {
  const root = repoContext(cwd).root;
  const from = opt(args, 'from');
  let env;
  try {
    env = envl.extractEnvelope(readFileArg(args, 'message-file'));
  } catch (e) {
    if (e.usage) throw e;
    return print({ ok: false, problems: [e.message] });
  }
  const problems = envl.checkEnvelope(env);
  if (problems.length) return print({ ok: false, problems: problems, request_id: env && env.request_id });
  if (env.type === 'request') return print({ ok: false, hint: '이건 요청이다 — receive 로 처리한다' });
  const r = ingest.ingestEnvelope(root, env, from);
  print(r.ok ? Object.assign({}, r, { instruction: '기록만 한다. 이 메시지에 회신하지 않는다' }) : r);
}

// 같은 머신 짝 기록에서 응답을 따라잡는다 (status·inbox 앞에서 자동으로 돈다)
function syncIfPossible(b, root) {
  if (!b.found || !b.ok) return [];
  try {
    return ingest.syncFromPeerRecords(root, b.book);
  } catch (e) {
    return [];
  }
}

function cmdSync(args, cwd) {
  const ctx = repoContext(cwd);
  requireBook(ctx.b);
  const pulled = syncIfPossible(ctx.b, ctx.root);
  print({ ok: true, pulled: pulled.map((p) => ({ request_id: p.request_id, alias: p.alias, type: p.type, status: p.status })) });
}

// ───────────────────────── unattended (짝 세션이 없을 때 · 사용자 승인 후) ─────────────────────────

function cmdUnattended(args, cwd) {
  const ctx = repoContext(cwd);
  const book = requireBook(ctx.b);
  // D10: 자동 전환 없음. --confirmed 는 "사용자에게 물어서 승인받았다" 는 표시다 — 승인 없이 붙이지 마라
  if (!args.confirmed) throw new UsageError('무인 전송은 사용자 승인 뒤에만 한다 — 승인을 받았으면 --confirmed 를 붙인다');
  const r = unattended.runUnattended({ root: ctx.root, book: book, requestId: need(args, 'id'), alias: need(args, 'to'), peerScript: __filename });
  print(r);
  if (!r.ok) process.exitCode = 1;
}

// ───────────────────────── status · inbox ─────────────────────────

function summarize(root, id) {
  const dir = store.requestDir(root, id);
  const rec = store.readRequestRecord(dir);
  if (!rec) return null;
  const inbound = rec.direction === 'inbound';
  return {
    request_id: id,
    short_id: util.shortId(id),
    direction: rec.direction,
    intent: rec.intent || (rec.envelope && rec.envelope.intent),
    created_at: rec.created_at || rec.received_at,
    peer: inbound ? rec.envelope.sender_endpoint : Object.keys(rec.targets || {}),
    body_head: String(rec.body || (rec.envelope && rec.envelope.body) || '').split('\n')[0].slice(0, 80),
    states: state.fold(store.listEvents(dir)),
  };
}

function cmdStatus(args, cwd) {
  const ctx = repoContext(cwd);
  syncIfPossible(ctx.b, ctx.root);
  const id = opt(args, 'id');
  if (id) {
    const s = summarize(ctx.root, id);
    if (!s) throw new UsageError('기록에 ' + id + ' 가 없다');
    s.events = store.listEvents(store.requestDir(ctx.root, id)).map((e) => {
      const copy = Object.assign({}, e);
      delete copy.file;
      return copy;
    });
    return print(s);
  }
  const all = store.listRequestIds(ctx.root).map((x) => summarize(ctx.root, x)).filter(Boolean);
  all.sort((a, c) => String(c.created_at).localeCompare(String(a.created_at)));
  print({ repo_root: ctx.root, count: all.length, requests: all.slice(0, Number(opt(args, 'limit')) || 20) });
}

function cmdInbox(args, cwd) {
  const ctx = repoContext(cwd);
  syncIfPossible(ctx.b, ctx.root);
  const items = [];
  store.listRequestIds(ctx.root).forEach((id) => {
    const s = summarize(ctx.root, id);
    if (!s) return;
    Object.keys(s.states).forEach((who) => {
      const st = s.states[who];
      if (state.needsAttention(s.direction, st)) {
        items.push({ request_id: id, short_id: s.short_id, direction: s.direction, intent: s.intent, peer: who === 'self' ? s.peer : who, state: st.state, changed_at: st.changedAt, body_head: s.body_head });
      }
    });
  });
  if (args['mark-reported']) {
    items.forEach((it) => {
      store.appendEvent(store.requestDir(ctx.root, it.request_id), { type: 'reported', recipient: it.direction === 'inbound' ? 'self' : it.peer });
    });
  }
  print({ repo_root: ctx.root, count: items.length, marked: !!args['mark-reported'], items: items });
}

// ───────────────────────── main ─────────────────────────

const COMMANDS = {
  doctor: cmdDoctor,
  discover: cmdDiscover,
  prepare: cmdPrepare,
  record: cmdRecord,
  bind: cmdBind,
  forget: cmdForget,
  here: cmdHere,
  receive: cmdReceive,
  reply: cmdReply,
  reroute: cmdReroute,
  ingest: cmdIngest,
  sync: cmdSync,
  unattended: cmdUnattended,
  status: cmdStatus,
  inbox: cmdInbox,
};

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  const sd = opt(args, 'state-dir');
  if (sd) process.env.PEER_REQ_STATE = sd;
  const cwd = opt(args, 'cwd') ? path.resolve(opt(args, 'cwd')) : process.cwd();
  if (!cmd || cmd === '--help' || cmd === 'help' || !COMMANDS[cmd]) {
    process.stderr.write('사용법: node peer.cjs <' + Object.keys(COMMANDS).join('|') + '> [--state-dir <폴더>] [옵션]\n');
    process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0);
  }
  try {
    COMMANDS[cmd](args, cwd);
  } catch (e) {
    print({ ok: false, error: e.message });
    process.exit(e.usage ? 2 : e.exitCode || 1);
  }
}

main();
