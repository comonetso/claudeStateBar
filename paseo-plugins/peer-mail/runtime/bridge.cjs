#!/usr/bin/env node
//
// bridge.cjs — 서버 쪽 peer_mail 연결 (PC 중계기가 SSH 로 띄운다)
//
// PC 가 연결을 연다. 서버는 PC 에 접속하지 않는다. 이 연결 하나로 양쪽이 주고받는다(한 줄 = JSON 하나).
//   서버 → PC (stdout)
//     { op:'hello', v, host, mail, home, node, platform }    처음 한 번 — 이 서버의 이름·mail.cjs 경로
//     { op:'item', name, item }                             보낸 우편함(outbox)에 있는 항목
//     { op:'pong' }
//     { op:'error', detail }                                이 서버에서 생긴 문제 — 중계기가 로그에 남긴다
//   PC → 서버 (stdin)
//     { op:'ack', name }                                    중계기가 가져갔다 — outbox → sent 로 옮긴다
//     { op:'inbox', item }                                  이 서버로 온 알림 — inbox 에 넣는다
//     { op:'ping' }                                         연결 확인 + 아직 ack 안 된 outbox 항목을 전부 다시 올린다
// 🔴 PC 에서 오는 것은 이 세 가지뿐이다. 명령·경로·셸을 받지 않는다. 파일 이름은 UUID.json 만 다룬다.
// 🔴 PC 연결이 끊기면(stdin 끝) 끝난다 — 서버에 남는 상주 프로세스가 없다.
// 🔴 다시 올리기는 ping 때만 한다. 중계기는 일시적 실패로 처리 못 한 항목에 ack 를 안 보내므로, ack 가 없으면
//    다음 ping 에서 다시 올라가야 그 우편이 멈추지 않는다. fs.watch 같은 재스캔에서는 이미 올린 것을 다시 올리지 않는다.
//

'use strict';

const fs = require('fs');
const path = require('path');
const mailbox = require('./lib/mailbox.cjs');
const projects = require('./lib/projects.cjs');

const NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const MAX = mailbox.MAX_ITEM_BYTES;
const announced = {}; // 올렸고 아직 ack 가 안 온 이름 — ack 가 오면 지운다
const readBuf = Buffer.alloc(MAX + 1); // 상한보다 1바이트 더 — 상한을 넘었는지 알 만큼만 읽는다

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// outbox 항목 하나를 읽는다. mailbox.read 와 같은 stat 상한 검사 뒤, 실제로 읽은 길이로 상한을 한 번 더 본다 —
// stat 과 읽기 사이에 파일이 커질 수 있다(완성본을 rename 으로 넣지 않고 그 자리에서 쓰는 경우).
function readOutbox(name) {
  const file = path.join(mailbox.dir('outbox'), name);
  let fd = null;
  let got = 0;
  try {
    if (fs.statSync(file).size > MAX) return null; // 처음부터 크다 — 지금처럼 조용히 건너뛴다
    fd = fs.openSync(file, 'r');
    let n;
    while (got < readBuf.length && (n = fs.readSync(fd, readBuf, got, readBuf.length - got, null)) > 0) got += n;
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        // 닫기 실패는 무시
      }
    }
  }
  if (got > MAX) {
    send({ op: 'error', detail: 'outbox ' + name + ' grew past ' + MAX + ' bytes while being read — not sent' });
    return null;
  }
  try {
    return JSON.parse(readBuf.toString('utf8', 0, got));
  } catch (e) {
    return null; // 아직 쓰는 중이다 — 다음 훑기에서
  }
}

// resend=true(ping 때만): 이미 올렸어도 ack 가 안 온 항목을 다시 올린다. ack 된 항목은 sent 로 옮겨져 outbox 에 없다.
function scan(resend) {
  mailbox.list('outbox').forEach((name) => {
    if (announced[name] && !resend) return;
    const item = readOutbox(name);
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
    // 아직 ack 안 된 항목을 이미 올렸던 것까지 전부 다시 올린다 — 중계기가 일시적 실패로 ack 를 안 한 항목이
    // 여기서 다시 간다. 처리 중인 같은 항목이 다시 가는 것은 중계기가 처리 중 집합으로 막는다.
    scan(true);
    send({ op: 'pong' });
  }
}

function main() {
  mailbox.ensureDirs();
  const p = projects.load();
  send({ op: 'hello', v: 1, host: p.ok ? p.self : null, error: p.ok ? null : p.error, mail: path.join(__dirname, 'mail.cjs'), home: mailbox.base(), node: process.version, platform: process.platform });
  scan(false);
  try {
    fs.watch(mailbox.dir('outbox'), () => scan(false));
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
