// bridge.test.mjs — 서버 쪽 연결(bridge.cjs) 시험. 중계기 대신 시험이 stdin 으로 ack·inbox·ping 을 보낸다.
//   node --test paseo-plugins/peer-mail/test/bridge.test.mjs
// 실제 ~/.paseo 를 건드리지 않는다 — 임시 폴더에 가짜 PASEO_HOME 을 만들고 bridge.cjs 를 별도 node 프로세스로 띄운다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, "..", "runtime", "bridge.cjs");
const MAX = createRequire(import.meta.url)("../runtime/lib/mailbox.cjs").MAX_ITEM_BYTES;

const A = "11111111-2222-4333-8444-555555555555.json";
const B = "33333333-2222-4333-8444-555555555555.json";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "peermail-" + prefix + "-"));
}

function setup() {
  const home = tmp("bridge-home");
  const f = path.join(home, "plugin-data", "claude-state-bar", "project-list", "projects.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "[]");
  const box = (name) => path.join(home, "peer-mail", name);
  fs.mkdirSync(box("outbox"), { recursive: true });
  const stage = tmp("bridge-stage");
  // 정규 mailbox.put 처럼 다 쓴 파일을 rename 으로 넣는다
  const put = (name, text) => {
    fs.writeFileSync(path.join(stage, name), text);
    fs.renameSync(path.join(stage, name), path.join(box("outbox"), name));
  };
  return { home, box, put };
}

function request(name, message) {
  const id = name.replace(/\.json$/, "");
  return JSON.stringify({ id, kind: "request", request_id: id, from_agent: "fixture-agent", message });
}

// 직렬화했을 때 정확히 bytes 바이트가 되는 항목
function requestOfSize(name, bytes) {
  return request(name, "x".repeat(bytes - Buffer.byteLength(request(name, ""))));
}

function startBridge(home, { preload = null, env = {} } = {}) {
  const args = preload ? ["-r", preload, BRIDGE] : [BRIDGE];
  const child = spawn(process.execPath, args, { env: { ...process.env, PASEO_HOME: home, PEER_MAIL_HOME: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const msgs = [];
  let buf = "";
  let cursor = 0;
  let waiter = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) msgs.push(JSON.parse(line));
    }
    if (waiter) waiter();
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  // 지난번 이후 메시지 중 pred 가 참인 것까지 모아 돌려준다
  const until = (pred) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null;
        reject(new Error("bridge did not answer — got " + JSON.stringify(msgs.slice(cursor).map((m) => [m.op, m.name || m.detail]))));
      }, 5000);
      const check = () => {
        for (let k = cursor; k < msgs.length; k++) {
          if (!pred(msgs[k])) continue;
          const got = msgs.slice(cursor, k + 1);
          cursor = k + 1;
          clearTimeout(timer);
          waiter = null;
          resolve(got);
          return;
        }
      };
      waiter = check;
      check();
    });
  const write = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const ping = () => {
    write({ op: "ping" });
    return until((m) => m.op === "pong");
  };
  const close = () => {
    child.stdin.end();
    return exited;
  };
  return { msgs, until, write, ping, close };
}

const isItem = (name) => (m) => m.op === "item" && m.name === name;
const count = (list, name) => list.filter(isItem(name)).length;

test("ack 없이 ping 하면 다시 올린다 · ping 없는 재스캔은 중복 없이 · ack 하면 sent 로 옮기고 그만 올린다", async () => {
  const t = setup();
  t.put(A, request(A, "a"));
  const b = startBridge(t.home);
  try {
    const first = await b.until(isItem(A));
    assert.equal(first[0].op, "hello");
    assert.equal(count(first, A), 1);

    // 중계기가 일시적 실패로 ack 를 안 했다 → 다음 ping 에서 다시 올라와야 한다
    assert.equal(count(await b.ping(), A), 1);
    assert.ok(fs.existsSync(path.join(t.box("outbox"), A)));

    // ping 이 아닌 재스캔(fs.watch): B 를 넣는다. 이름순이라 재스캔이 A 를 다시 올렸다면 B 보다 먼저 온다
    t.put(B, request(B, "b"));
    assert.equal(count(await b.until(isItem(B)), A), 0);

    const p2 = await b.ping();
    assert.equal(count(p2, A), 1);
    assert.equal(count(p2, B), 1);

    // A 만 ack → sent 로 옮겨지고 더는 안 올라온다. B 는 ack 가 없으니 계속
    b.write({ op: "ack", name: A });
    const p3 = await b.ping();
    assert.equal(count(p3, A), 0);
    assert.equal(count(p3, B), 1);
    assert.ok(fs.existsSync(path.join(t.box("sent"), A)));
    assert.ok(!fs.existsSync(path.join(t.box("outbox"), A)));
  } finally {
    await b.close();
  }
  // 늦게 온 watch 이벤트까지 합쳐도 A = 처음 1 + ping 2번, B = watch 1 + ping 2번
  assert.equal(count(b.msgs, A), 3);
  assert.equal(count(b.msgs, B), 3);
});

test("읽는 사이 상한을 넘은 파일은 올리지 않고 error 로 알린다 · 처음부터 큰 파일은 조용히 건너뛴다 · 정확히 상한은 올린다", async () => {
  const t = setup();
  const exact = "44444444-2222-4333-8444-555555555555.json";
  const grew = "66666666-2222-4333-8444-555555555555.json";
  const big = "77777777-2222-4333-8444-555555555555.json";
  t.put(exact, requestOfSize(exact, MAX));
  t.put(grew, requestOfSize(grew, MAX + 1));
  t.put(big, requestOfSize(big, MAX + 1));
  // stat 과 읽기 사이에 파일이 커진 상황: grew 의 stat 크기만 0 으로 보이게 한다(읽기는 실제 내용)
  const preload = path.join(tmp("bridge-preload"), "small-stat.cjs");
  fs.writeFileSync(
    preload,
    [
      "const fs = require('fs');",
      "const target = process.env.PEER_MAIL_TEST_SMALL_STAT;",
      "const orig = fs.statSync;",
      "fs.statSync = function (p, ...rest) {",
      "  const st = orig.call(this, p, ...rest);",
      "  if (target && String(p).endsWith(target)) st.size = 0;",
      "  return st;",
      "};",
      "",
    ].join("\n"),
  );
  const b = startBridge(t.home, { preload, env: { PEER_MAIL_TEST_SMALL_STAT: grew } });
  try {
    await b.until(isItem(exact));
    await b.ping();
  } finally {
    await b.close();
  }
  const sentExact = b.msgs.find(isItem(exact));
  assert.equal(Buffer.byteLength(JSON.stringify(sentExact.item)), MAX);
  assert.equal(count(b.msgs, grew), 0);
  assert.equal(count(b.msgs, big), 0);
  const errors = b.msgs.filter((m) => m.op === "error").map((m) => m.detail);
  assert.ok(errors.some((d) => d.includes(grew) && d.includes(String(MAX))), "grew 는 error 로 알려야 한다: " + JSON.stringify(errors));
  assert.ok(!errors.some((d) => d.includes(big)), "처음부터 큰 파일은 지금처럼 조용히 건너뛴다");
  // 둘 다 outbox 에 그대로 남는다(지우지 않는다)
  assert.ok(fs.existsSync(path.join(t.box("outbox"), grew)));
  assert.ok(fs.existsSync(path.join(t.box("outbox"), big)));
});

test("기존 경로: 경로를 벗어나는 ack 는 무시 · UUID 아닌 inbox 는 거부 · 정상 inbox 는 기록", async () => {
  const t = setup();
  const outside = path.join(t.home, "outside.txt");
  fs.writeFileSync(outside, "fixture keep");
  const inboxId = "55555555-2222-4333-8444-555555555555";
  const b = startBridge(t.home);
  let got;
  try {
    await b.until((m) => m.op === "hello");
    b.write({ op: "ack", name: "../../outside.txt" });
    b.write({ op: "inbox", item: { id: "../../escaped", body: "fixture" } });
    b.write({ op: "inbox", item: { id: inboxId, kind: "relay", request_id: inboxId, status: "delivered" } });
    got = await b.ping();
  } finally {
    await b.close();
  }
  assert.equal(fs.readFileSync(outside, "utf8"), "fixture keep");
  assert.ok(got.some((m) => m.op === "error" && /^inbox: /.test(m.detail)));
  assert.ok(!fs.existsSync(path.join(t.home, "escaped.json")));
  const written = JSON.parse(fs.readFileSync(path.join(t.box("inbox"), inboxId + ".json"), "utf8"));
  assert.equal(written.status, "delivered");
});
