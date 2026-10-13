#!/usr/bin/env node
//
// fake-paseo.cjs — 시험용 가짜 paseo CLI (PEER_REQ_PASEO_CLI 로 지정한다)
//
// 상태는 FAKE_PASEO_STATE 의 JSON 파일에 둔다.
//   agents:   { "<host 또는 local>": [ { id, shortId, cwd, status, name, pending:[], archived, statusSeq:[…] } ] }
//   waitStatus: wait 이 돌려줄 상태(기본 idle)
//   onSend:   { "<agent id>": { peer, cwd, env, status, answer } } — 받는 대화를 흉내 낸다(receive → reply)
//   calls·sent: 부른 기록
//

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const stateFile = process.env.FAKE_PASEO_STATE;
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
st.calls = st.calls || [];
st.sent = st.sent || [];

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const pos = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.indexOf('--') === 0) {
    const n = argv[i + 1];
    if (n === undefined || n.indexOf('-') === 0) flags[a.slice(2)] = true;
    else {
      flags[a.slice(2)] = n;
      i++;
    }
  } else if (a === '-g') flags.g = true;
  else pos.push(a);
}
const hostKey = flags.host || 'local';
st.calls.push({ cmd: cmd, id: pos[0] || null, host: hostKey });
const agents = (st.agents && st.agents[hostKey]) || [];
const find = (id) => agents.filter((a) => a.id === id)[0];

function save() {
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
}

function fail(msg) {
  save();
  process.stderr.write(msg + '\n');
  process.exit(1);
}

if (st.unreachable && st.unreachable[hostKey]) fail('ssh: connect to host failed');

if (cmd === 'ls') {
  save();
  process.stdout.write(JSON.stringify(agents.map((a) => ({ id: a.id, shortId: a.shortId || a.id.slice(0, 7), cwd: a.cwd, status: a.status, name: a.name || '', provider: 'claude' }))));
} else if (cmd === 'inspect') {
  const a = find(pos[0]);
  if (!a) fail('Agent not found: ' + pos[0]);
  if (Array.isArray(a.statusSeq) && a.statusSeq.length) a.status = a.statusSeq.shift();
  save();
  process.stdout.write(JSON.stringify({ Id: a.id, Status: a.status, Cwd: a.cwd, PendingPermissions: a.pending || [], Archived: !!a.archived }));
} else if (cmd === 'wait') {
  const a = find(pos[0]);
  if (!a) fail('Agent not found: ' + pos[0]);
  const s = st.waitStatus || 'idle';
  if (s === 'idle') a.status = 'idle';
  save();
  process.stdout.write(JSON.stringify({ agentId: a.id, status: s, message: 'fake' }));
} else if (cmd === 'send') {
  const a = find(pos[0]);
  if (!a) fail('Agent not found: ' + pos[0]);
  const text = fs.readFileSync(flags['prompt-file'], 'utf8');
  st.sent.push({ id: a.id, host: hostKey, text: text, no_wait: !!flags['no-wait'] });
  const h = st.onSend && st.onSend[a.id];
  if (h) {
    // 받는 대화가 할 일 — peer_req 의 receive·reply 를 그대로 부른다
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-paseo-'));
    const msg = path.join(work, 'in.txt');
    fs.writeFileSync(msg, text);
    const env = Object.assign({}, process.env, h.env || {});
    delete env.PEER_REQ_PASEO_CLI;
    const r = JSON.parse(childProcess.execFileSync(process.execPath, [h.peer, 'receive', '--message-file', msg], { cwd: h.cwd, env: env, encoding: 'utf8' }));
    st.received = st.received || [];
    st.received.push(r);
    if (r.verdict === 'new' && h.status) {
      const ans = path.join(work, 'ans.txt');
      fs.writeFileSync(ans, h.answer || 'answer');
      st.replied = JSON.parse(childProcess.execFileSync(process.execPath, [h.peer, 'reply', '--id', r.request_id, '--status', h.status, '--body-file', ans], { cwd: h.cwd, env: env, encoding: 'utf8' }));
    }
  }
  save();
  process.stdout.write(JSON.stringify({ agentId: a.id, status: 'sent' }));
} else {
  fail('fake paseo: unknown command ' + cmd);
}
