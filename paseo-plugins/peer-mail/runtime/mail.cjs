#!/usr/bin/env node
//
// mail.cjs — peer_mail: Paseo 대화끼리 묻고 알리기 (대화 쪽 명령)
//
// 리모트 컨트롤을 쓰지 않는다. 우편은 이 기기의 우편함 폴더(outbox)에 넣고, PC 의 peer-mail 중계기가
// 가져가 상대 대화에 넣는다(일하는 중이면 끊지 않고 끼워 넣기). 봉투·접수 확인·기록·세 종류 규칙은
// peer_req 0.2.3 과 같다. 짝 = 프로젝트 매니저의 "보임" 프로젝트(lib/projects.cjs).
//
//   targets                                            보낼 수 있는 프로젝트(보임) 목록
//   whoami                                             이 대화가 어느 기기·프로젝트로 보이는가
//   send    --to <이름|host:path> --intent <query|notice|change_request> --body-file <f> [--agent <id>]
//   send    --request-id <id> [--agent <id>] [--to …]  같은 요청을 다시(새 시도) — 전달 안 됨·대화 고르기 뒤
//   receive --message-file <f>                         받은 요청 기록 + 접수 확인을 우편함에 넣기
//   reply   --id <id> --status <completed|awaiting_user|failed> --body-file <f>
//   ingest  --message-file <f>                         받은 결과(또는 접수 확인)를 보낸 쪽 기록에 넣기
//   inbox   [--mark-reported]                          중계기가 넣어 둔 알림을 기록에 반영하고, 알리지 않은 것을 보여 준다
//   status  [--id <id>]
//
// 출력은 모두 JSON. Node 버전에 기대지 않는다(CommonJS · ES2017 · 오래된 API 만).
//

'use strict';

const fs = require('fs');
const path = require('path');
const util = require('./lib/util.cjs');
const envl = require('./lib/envelope.cjs');
const store = require('./lib/store.cjs');
const state = require('./lib/state.cjs');
const mailbox = require('./lib/mailbox.cjs');
const projects = require('./lib/projects.cjs');

const PEER = 'peer'; // 보낸 요청의 받는 쪽은 늘 하나 — 기록의 받는 쪽 열쇠

function UsageError(message) {
  this.message = message;
  this.usage = true;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') === 0) {
      const next = argv[i + 1];
      if (next === undefined || next.indexOf('--') === 0) out[a.slice(2)] = true;
      else {
        out[a.slice(2)] = next;
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
  if (v === null) throw new UsageError('--' + key + ' is required');
  return v;
}

function readFileArg(args, key) {
  const f = need(args, key);
  if (!fs.existsSync(f)) throw new UsageError('--' + key + ' file not found: ' + f);
  return fs.readFileSync(f, 'utf8');
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function context(cwd) {
  const p = projects.load();
  if (!p.ok) throw new UsageError(p.error);
  const proj = projects.projectOf(p.entries, p.self, cwd);
  return { p: p, host: p.self, proj: proj };
}

function requireAgent() {
  const id = process.env.PASEO_AGENT_ID;
  if (!id) throw new UsageError('peer_mail works only inside a Paseo conversation (PASEO_AGENT_ID is not set)');
  return id;
}

function requireVisibleProject(ctx, cwd) {
  if (!ctx.proj) throw new UsageError('this folder (' + cwd + ') is not a project in the project manager on ' + ctx.host + ' — add it there first');
  if (!ctx.proj.enabled) throw new UsageError('this project ("' + ctx.proj.name + '") is hidden in the project manager — only visible projects can send or receive');
  return ctx.proj;
}

const NEXT = {
  query: 'investigate only what was asked, write the answer to a file, then run reply --status completed',
  notice: 'check only the impact on this repository and report it with reply --status completed. Do not fix anything',
  change_request: 'do not start investigating or fixing. Immediately run reply --status awaiting_user ("Received; waiting for the user on this side") and tell the user what was requested',
};

// ───────── targets · whoami ─────────

function cmdTargets(args, cwd) {
  const ctx = context(cwd);
  const mine = ctx.proj ? ctx.proj.key : null;
  const rows = ctx.p.entries.filter((e) => e.enabled && e.key !== mine).map((e) => ({ name: e.name, host: e.host, path: e.path, to: e.host + ':' + e.path }));
  print({ self: ctx.host, this_project: ctx.proj ? { name: ctx.proj.name, visible: ctx.proj.enabled } : null, count: rows.length, targets: rows, source: ctx.p.source });
}

function cmdWhoami(args, cwd) {
  const ctx = context(cwd);
  print({ host: ctx.host, cwd: cwd, project: ctx.proj ? { name: ctx.proj.name, path: ctx.proj.path, visible: ctx.proj.enabled } : null, paseo_agent_id: process.env.PASEO_AGENT_ID || null, mailbox: mailbox.base() });
}

// ───────── send ─────────

function cmdSend(args, cwd) {
  const agent = requireAgent();
  const ctx = context(cwd);
  const proj = requireVisibleProject(ctx, cwd);
  const root = proj.path;
  let requestId = opt(args, 'request-id');
  let intent;
  let body;
  let conversationId;
  let target;
  if (requestId) {
    const rec = store.readRequestRecord(store.requestDir(root, requestId));
    if (!rec || rec.direction !== 'outbound') throw new UsageError('no sent record for ' + requestId + ' in ' + root);
    intent = rec.intent;
    body = rec.body;
    conversationId = rec.conversation_id;
    const t = rec.targets[PEER];
    const toArg = opt(args, 'to');
    if (toArg) {
      const r = projects.resolveTo(ctx.p.entries, toArg);
      if (!r.ok) return print({ ok: false, error: r.error, candidates: (r.candidates || []).map((e) => ({ name: e.name, to: e.host + ':' + e.path })) });
      if (r.entry.key !== projects.keyOf(t.host, t.root)) throw new UsageError('a resend goes only to the first target (' + t.host + ':' + t.root + ') — send it as a new request');
      target = r.entry;
    } else {
      target = ctx.p.entries.filter((e) => e.key === projects.keyOf(t.host, t.root))[0];
      if (!target) throw new UsageError('the first target (' + t.host + ':' + t.root + ') is no longer in the project list');
    }
    if (!target.enabled) throw new UsageError('the first target is hidden now in the project manager');
  } else {
    intent = need(args, 'intent');
    if (!envl.INTENTS[intent]) throw new UsageError('--intent must be one of ' + Object.keys(envl.INTENTS).join('·'));
    body = readFileArg(args, 'body-file').replace(/\s+$/, '');
    if (!body) throw new UsageError('the body is empty');
    const r = projects.resolveTo(ctx.p.entries, need(args, 'to'));
    if (!r.ok) return print({ ok: false, error: r.error, candidates: (r.candidates || []).map((e) => ({ name: e.name, to: e.host + ':' + e.path })) });
    target = r.entry;
    if (target.key === proj.key) throw new UsageError('that is this project itself');
    requestId = util.uuid();
    conversationId = util.uuid();
  }
  const pickAgent = opt(args, 'agent');
  if (pickAgent && !/^[0-9a-f-]{8,36}$/i.test(pickAgent)) throw new UsageError('--agent must be a Paseo conversation id');
  const dir = store.requestDir(root, requestId);
  store.applyCommitPolicy(root, true);
  if (!opt(args, 'request-id')) {
    store.createRequestRecord(dir, {
      direction: 'outbound',
      request_id: requestId,
      conversation_id: conversationId,
      intent: intent,
      body: body,
      sender: { host: ctx.host, root: root, project: proj.name },
      targets: { peer: { host: target.host, root: target.path, project: target.name } },
      created_at: util.nowIso(),
    });
  }
  const env = envl.makeRequest({
    requestId: requestId,
    conversationId: conversationId,
    sender: { host: ctx.host, root: root, project: proj.name },
    recipient: { host: target.host, root: target.path, project: target.name },
    intent: intent,
    body: body,
  });
  const item = {
    v: 1,
    id: env.attempt_id,
    kind: 'request',
    request_id: requestId,
    created_at: util.nowIso(),
    from_agent: agent,
    from_cwd: cwd,
    from_host: ctx.host,
    to: { host: target.host, path: target.path, agent: pickAgent || null },
    message: envl.renderMessage(env),
  };
  const put = mailbox.put('outbox', item);
  store.writeText(dir, 'outbox', 'request-' + env.attempt_id + '.txt', item.message);
  store.appendEvent(dir, { type: 'prepared', recipient: PEER, attempt_id: env.attempt_id, detail: 'peer_mail to=' + target.host + ':' + target.path + (pickAgent ? ' agent=' + pickAgent : ''), route: { transport: 'peer_mail', host: target.host, path: target.path, agent: pickAgent || null } });
  print({
    ok: true,
    request_id: requestId,
    short_id: util.shortId(requestId),
    attempt_id: env.attempt_id,
    to: { name: target.name, host: target.host, path: target.path },
    outbox_file: put.file,
    record_dir: dir,
    instruction: 'queued for the peer_mail relay. Do not wait: the answer arrives in this conversation as a "[peer_mail/1] 결과" message, and delivery problems as "[peer_mail/1] 전달" messages',
  });
}

// ───────── receive · reply (받는 쪽) ─────────

function putReply(kind, requestId, env) {
  const item = { v: 1, id: util.uuid(), kind: kind, request_id: requestId, created_at: util.nowIso(), from_agent: process.env.PASEO_AGENT_ID || null, message: envl.renderMessage(env) };
  return mailbox.put('outbox', item).file;
}

function cmdReceive(args, cwd) {
  let env;
  try {
    env = envl.extractEnvelope(readFileArg(args, 'message-file'));
  } catch (e) {
    if (e.usage) throw e;
    return print({ verdict: 'invalid', problems: [e.message], hint: 'copy the whole message, including the ```peer_mail block at the end, to the file unchanged' });
  }
  const problems = envl.checkEnvelope(env);
  if (problems.length) return print({ verdict: 'invalid', problems: problems, request_id: env && env.request_id });
  if (env.type !== 'request') return print({ verdict: 'not_a_request', type: env.type, hint: 'replies are recorded with ingest. Do not reply to them' });
  const ctx = context(cwd);
  const plat = projects.platformOfHost(ctx.host);
  const mismatch = [];
  if (env.recipient_host !== ctx.host) mismatch.push('recipient_host(' + env.recipient_host + ') ≠ this machine (' + ctx.host + ')');
  if (!ctx.proj) mismatch.push('this folder is not a project in the project manager');
  else {
    if (!util.samePath(env.recipient_root, ctx.proj.path, plat)) mismatch.push('recipient_root(' + env.recipient_root + ') ≠ this project (' + ctx.proj.path + ')');
    if (!ctx.proj.enabled) mismatch.push('this project is hidden in the project manager');
  }
  if (mismatch.length) {
    const ack = envl.makeReply({ type: 'ack', request: env, status: 'wrong_target', body: 'WRONG_TARGET — ' + mismatch.join(' / ') });
    putReply('ack', env.request_id, ack);
    return print({ verdict: 'wrong_target', request_id: env.request_id, mismatch: mismatch, instruction: 'do not investigate. The relay tells the sender. Tell the user a peer_mail request meant for another target arrived' });
  }
  const root = ctx.proj.path;
  store.applyCommitPolicy(root, true);
  const dir = store.requestDir(root, env.request_id);
  const from = 'peer_mail:' + env.sender_host + ':' + env.sender_root;
  const made = store.createRequestRecord(dir, { direction: 'inbound', request_id: env.request_id, envelope: env, from: from, received_at: util.nowIso() });
  const base = { request_id: env.request_id, short_id: util.shortId(env.request_id), intent: env.intent, intent_label: envl.INTENTS[env.intent].label, sender: { host: env.sender_host, root: env.sender_root, project: env.sender_project }, body: env.body, record_dir: dir };
  if (!made.created && !made.existing) return print(Object.assign({}, base, { verdict: 'in_progress', instruction: 'this request is already being handled. Do not run it again' }));
  if (!made.created) {
    const prev = made.existing.envelope || {};
    if (prev.body_sha256 !== env.body_sha256) {
      store.appendEvent(dir, { type: 'conflict', recipient: 'self', attempt_id: env.attempt_id, detail: 'new body ' + env.body_sha256.slice(0, 12) });
      putReply('ack', env.request_id, envl.makeReply({ type: 'ack', request: env, status: 'conflict', body: 'CONFLICT — a different body arrived with the same request_id. Not handling it.' }));
      return print(Object.assign({}, base, { verdict: 'conflict', instruction: 'do not handle the request. The relay tells the sender' }));
    }
    store.appendEvent(dir, { type: 'duplicate', recipient: 'self', attempt_id: env.attempt_id });
    const st = state.fold(store.listEvents(dir)).self;
    putReply('ack', env.request_id, envl.makeReply({ type: 'ack', request: env, status: 'duplicate', body: 'Already received. Current state: ' + (st ? st.state : 'unknown') + '. Not running it again.' }));
    const fin = store.resultMessageFile(dir);
    if (fin) {
      const prevRes = envl.extractEnvelope(fs.readFileSync(fin, 'utf8'));
      putReply('result', env.request_id, prevRes);
    }
    return print(Object.assign({}, base, { verdict: 'duplicate', state: st, instruction: 'do not run it again. The existing state' + (fin ? ' and result were' : ' was') + ' sent back' }));
  }
  store.appendEvent(dir, { type: 'received', recipient: 'self', attempt_id: env.attempt_id, detail: 'from=' + from });
  putReply('ack', env.request_id, envl.makeReply({ type: 'ack', request: env, status: 'received', body: 'Received (' + env.intent + ').' }));
  print(Object.assign({}, base, { verdict: 'new', instruction: 'the acknowledgement is queued for you — send nothing yourself. Then: ' + NEXT[env.intent] }));
}

function cmdReply(args, cwd) {
  const ctx = context(cwd);
  const proj = requireVisibleProject(ctx, cwd);
  const id = need(args, 'id');
  const status = need(args, 'status');
  if (['completed', 'awaiting_user', 'failed'].indexOf(status) === -1) throw new UsageError('--status must be one of completed·awaiting_user·failed');
  const dir = store.requestDir(proj.path, id);
  const rec = store.readRequestRecord(dir);
  if (!rec || rec.direction !== 'inbound') throw new UsageError('no received record for ' + id + ' in ' + proj.path);
  const body = readFileArg(args, 'body-file').replace(/\s+$/, '');
  const finFile = path.join(dir, 'outbox', store.RESULT_FINAL);
  if (fs.existsSync(finFile)) {
    const prev = envl.extractEnvelope(fs.readFileSync(finFile, 'utf8'));
    if (prev.status === status && prev.body_sha256 === util.sha256(body)) return print({ ok: true, idempotent: true, request_id: id, status: status, instruction: 'same result already final — nothing more to send' });
    throw new UsageError('the result of this request is already final as "' + prev.status + '" — not overwriting it');
  }
  const env = envl.makeReply({ type: 'result', request: rec.envelope, status: status, body: body });
  const text = envl.renderMessage(env);
  if (state.FINAL.indexOf(status) !== -1) {
    if (!util.publishOnce(finFile, text)) throw new UsageError('another process finalized the result of this request just now');
  } else {
    store.writeText(dir, 'outbox', store.RESULT_TEMP, text);
  }
  store.writeText(dir, 'result', 'result.md', body + '\n');
  store.appendEvent(dir, { type: status, recipient: 'self', attempt_id: rec.envelope.attempt_id });
  putReply('result', id, env);
  print({ ok: true, request_id: id, status: status, instruction: 'the relay delivers the result to the sending conversation — send nothing yourself' });
}

// ───────── ingest · inbox · status (보낸 쪽) ─────────

function recordReply(root, env, from) {
  const dir = store.requestDir(root, env.request_id);
  const rec = store.readRequestRecord(dir);
  if (!rec || rec.direction !== 'outbound') return { ok: false, unknown_request: true, request_id: env.request_id, hint: 'not a request sent from this project — not recorded' };
  const before = state.fold(store.listEvents(dir))[PEER];
  if (env.type === 'result' && before && before.state === env.status) {
    const prevFile = path.join(dir, 'result', 'peer.md');
    if (fs.existsSync(prevFile) && fs.readFileSync(prevFile, 'utf8') === env.body + '\n') return { ok: true, request_id: env.request_id, type: env.type, status: env.status, accepted: false, unchanged: true, body: env.body };
  }
  const added = store.appendEvent(dir, { type: env.status, recipient: PEER, attempt_id: env.attempt_id, detail: from || null });
  const after = state.fold(store.listEvents(dir))[PEER];
  const accepted = !!after && after.state === env.status && after.changedAt === added.event.at;
  let resultFile = null;
  if (env.type === 'result' && accepted) resultFile = store.writeText(dir, 'result', 'peer.md', env.body + '\n');
  return { ok: true, request_id: env.request_id, short_id: util.shortId(env.request_id), type: env.type, status: env.status, accepted: accepted, body: env.body, result_file: resultFile, state: after };
}

function ownRoot(cwd) {
  const ctx = context(cwd);
  if (!ctx.proj) throw new UsageError('this folder (' + cwd + ') is not a project in the project manager');
  return ctx.proj.path;
}

function cmdIngest(args, cwd) {
  const root = ownRoot(cwd);
  let env;
  try {
    env = envl.extractEnvelope(readFileArg(args, 'message-file'));
  } catch (e) {
    if (e.usage) throw e;
    return print({ ok: false, problems: [e.message] });
  }
  const problems = envl.checkEnvelope(env);
  if (problems.length) return print({ ok: false, problems: problems });
  if (env.type === 'request') return print({ ok: false, hint: 'this is a request — handle it with receive' });
  const r = recordReply(root, env, 'peer_mail:' + env.responder_host);
  print(r.ok ? Object.assign({}, r, { instruction: 'recorded. Tell the user (quote a result verbatim). Never reply to this message' }) : r);
}

// 중계기가 이 기기 우편함(inbox)에 넣어 둔 알림을 기록에 반영한다
//   { kind:'ack', request_id, message }                     받는 쪽의 접수 확인(봉투)
//   { kind:'relay', request_id, attempt_id, status, detail, candidates? }  중계기의 전달 상태
const RELAY_EVENT = { delivered: 'transport_accepted', held: 'held', unreachable: 'unreachable' };

function pullInbox(root) {
  const pulled = [];
  mailbox.list('inbox').forEach((name) => {
    const item = mailbox.read('inbox', name);
    if (!item || !envl.UUID_RE.test(item.request_id || '')) {
      mailbox.move('inbox', 'inbox-done', name);
      return;
    }
    const dir = store.requestDir(root, item.request_id);
    const rec = store.readRequestRecord(dir);
    if (!rec || rec.direction !== 'outbound') return; // 다른 프로젝트 몫 — 그 프로젝트에서 inbox 를 부를 때 반영한다
    if (item.kind === 'ack') {
      try {
        const env = envl.extractEnvelope(item.message);
        if (!envl.checkEnvelope(env).length) pulled.push(recordReply(root, env, 'peer_mail-ack'));
      } catch (e) {
        // 깨진 알림은 건너뛴다
      }
    } else if (item.kind === 'relay') {
      const type = RELAY_EVENT[item.status] || 'relay_' + String(item.status || 'note').replace(/[^a-z_]/gi, '');
      store.appendEvent(dir, { type: type, recipient: PEER, attempt_id: item.attempt_id || null, detail: 'relay: ' + String(item.detail || item.status).slice(0, 500) });
      pulled.push({ request_id: item.request_id, relay: item.status, detail: item.detail || null, candidates: item.candidates || null });
    }
    mailbox.move('inbox', 'inbox-done', name);
  });
  return pulled;
}

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
    peer: inbound ? rec.envelope.sender_project || rec.envelope.sender_host : rec.targets[PEER] && (rec.targets[PEER].project || rec.targets[PEER].host),
    body_head: String(rec.body || (rec.envelope && rec.envelope.body) || '').split('\n')[0].slice(0, 80),
    states: state.fold(store.listEvents(dir)),
  };
}

function cmdInbox(args, cwd) {
  const root = ownRoot(cwd);
  const pulled = pullInbox(root);
  const items = [];
  store.listRequestIds(root).forEach((id) => {
    const s = summarize(root, id);
    if (!s) return;
    Object.keys(s.states).forEach((who) => {
      const st = s.states[who];
      if (state.needsAttention(s.direction, st)) items.push({ request_id: id, short_id: s.short_id, direction: s.direction, intent: s.intent, peer: s.peer, state: st.state, detail: st.detail, body_head: s.body_head, who: who });
    });
  });
  if (args['mark-reported']) items.forEach((it) => store.appendEvent(store.requestDir(root, it.request_id), { type: 'reported', recipient: it.who }));
  print({ root: root, pulled: pulled, count: items.length, marked: !!args['mark-reported'], items: items });
}

function cmdStatus(args, cwd) {
  const root = ownRoot(cwd);
  const pulled = pullInbox(root);
  const id = opt(args, 'id');
  if (id) {
    const s = summarize(root, id);
    if (!s) throw new UsageError('no record for ' + id);
    s.events = store.listEvents(store.requestDir(root, id)).map((e) => {
      const c = Object.assign({}, e);
      delete c.file;
      return c;
    });
    return print(Object.assign({ pulled: pulled }, s));
  }
  const all = store.listRequestIds(root).map((x) => summarize(root, x)).filter(Boolean);
  all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  print({ root: root, pulled: pulled, count: all.length, requests: all.slice(0, Number(opt(args, 'limit')) || 20) });
}

const COMMANDS = { targets: cmdTargets, whoami: cmdWhoami, send: cmdSend, receive: cmdReceive, reply: cmdReply, ingest: cmdIngest, inbox: cmdInbox, status: cmdStatus };

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  const cwd = opt(args, 'cwd') ? path.resolve(opt(args, 'cwd')) : process.cwd();
  if (!cmd || !COMMANDS[cmd]) {
    process.stderr.write('usage: node mail.cjs <' + Object.keys(COMMANDS).join('|') + '> [options]\n');
    process.exit(cmd ? 2 : 0);
  }
  try {
    COMMANDS[cmd](args, cwd);
  } catch (e) {
    print({ ok: false, error: e.message });
    process.exit(e.usage ? 2 : 1);
  }
}

main();
