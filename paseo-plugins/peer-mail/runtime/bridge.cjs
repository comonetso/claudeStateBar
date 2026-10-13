#!/usr/bin/env node
//
// bridge.cjs — 서버 쪽 peer_mail 연결 (PC 중계기가 SSH 로 띄운다)
//
// PC 가 연결을 연다. 서버는 PC 에 접속하지 않는다. 이 연결 하나로 양쪽이 주고받는다(한 줄 = JSON 하나).
//   서버 → PC (stdout)
//     { op:'hello', v, host, mail, home, node, platform }    처음 한 번 — 이 서버의 이름·mail.cjs 경로
//     { op:'item', name, item }                             보낸 우편함(outbox)에 있는 항목
//     { op:'pong' }
//   PC → 서버 (stdin)
//     { op:'ack', name }                                    중계기가 가져갔다 — outbox → sent 로 옮긴다
//     { op:'inbox', item }                                  이 서버로 온 알림 — inbox 에 넣는다
//     { op:'ping' }                                         연결 확인 + 우편함 다시 훑기
// 🔴 PC 에서 오는 것은 이 세 가지뿐이다. 명령·경로·셸을 받지 않는다. 파일 이름은 UUID.json 만 다룬다.
// 🔴 PC 연결이 끊기면(stdin 끝) 끝난다 — 서버에 남는 상주 프로세스가 없다.
//

'use strict';

const fs = require('fs');
const path = require('path');
const mailbox = require('./lib/mailbox.cjs');
const projects = require('./lib/projects.cjs');

const NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const announced = {};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function scan() {
  mailbox.list('outbox').forEach((name) => {
    if (announced[name]) return;
    const item = mailbox.read('outbox', name);
    if (!item) return; // 아직 쓰는 중이거나 너무 크다 — 다음 훑기에서
    announced[name] = true;
    send({ op: 'item', name: name, item: item });
  });
}

function onLine(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch (e) {
    return;
  }
  if (!m || typeof m.op !== 'string') return;
  if (m.op === 'ack' && NAME_RE.test(m.name || '')) {
    mailbox.move('outbox', 'sent', m.name);
    delete announced[m.name];
  } else if (m.op === 'inbox' && m.item && typeof m.item === 'object') {
    try {
      mailbox.put('inbox', m.item);
    } catch (e) {
      send({ op: 'error', detail: 'inbox: ' + e.message });
    }
  } else if (m.op === 'ping') {
    // 끊긴 사이 놓친 항목을 다시 알린다(중계기가 다시 붙으면 announced 는 새 프로세스라 비어 있다)
    scan();
    send({ op: 'pong' });
  }
}

function main() {
  mailbox.ensureDirs();
  const p = projects.load();
  send({ op: 'hello', v: 1, host: p.ok ? p.self : null, error: p.ok ? null : p.error, mail: path.join(__dirname, 'mail.cjs'), home: mailbox.base(), node: process.version, platform: process.platform });
  scan();
  try {
    fs.watch(mailbox.dir('outbox'), () => scan());
  } catch (e) {
    send({ op: 'error', detail: 'watch: ' + e.message });
  }
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
}

main();
