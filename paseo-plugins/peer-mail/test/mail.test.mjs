// mail.test.mjs — peer_mail 대화 쪽 명령(mail.cjs) 시험. 중계기가 할 일(우편 옮기기)은 시험이 대신한다.
//   node --test paseo-plugins/peer-mail/test/mail.test.mjs
// 실제 ~/.paseo 를 건드리지 않는다 — 임시 폴더에 가짜 PASEO_HOME·프로젝트를 만든다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIL = path.join(HERE, "..", "runtime", "mail.cjs");
const require = createRequire(import.meta.url);
const LIB = path.join(HERE, "..", "runtime", "lib");
const store = require(path.join(LIB, "store.cjs"));
const util = require(path.join(LIB, "util.cjs"));
const envl = require(path.join(LIB, "envelope.cjs"));
const mailbox = require(path.join(LIB, "mailbox.cjs"));

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "peermail-" + prefix + "-"));
}

function setup({ hideB = false } = {}) {
  const home = tmp("home");
  const A = tmp("projA");
  const B = tmp("projB");
  const list = [
    { name: "Proj A", rootPath: A, category: "t", enabled: true },
    { name: "Proj B", rootPath: B, category: "t", enabled: !hideB },
  ];
  const f = path.join(home, "plugin-data", "claude-state-bar", "project-list", "projects.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(list));
  const env = (agent) => ({ ...process.env, PASEO_HOME: home, PASEO_AGENT_ID: agent, PEER_MAIL_HOME: "" });
  const run = (cwd, agent, args) => JSON.parse(execFileSync(process.execPath, [MAIL, ...args], { cwd, env: env(agent), encoding: "utf8" }));
  // 실패해야 하는 명령 — 종료 코드와 출력(JSON)을 돌려준다
  const runFail = (cwd, agent, args) => {
    try {
      execFileSync(process.execPath, [MAIL, ...args], { cwd, env: env(agent), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return { status: e.status, out: JSON.parse(e.stdout) };
    }
    throw new Error("expected the command to fail: " + args.join(" "));
  };
  const box = (name) => path.join(home, "peer-mail", name);
  const items = (name) => (fs.existsSync(box(name)) ? fs.readdirSync(box(name)).filter((n) => n.endsWith(".json")).map((n) => ({ n, j: JSON.parse(fs.readFileSync(path.join(box(name), n), "utf8")) })) : []);
  const take = (name) => {
    const all = items(name);
    for (const it of all) fs.renameSync(path.join(box(name), it.n), path.join(tmp("sent"), it.n));
    return all.map((x) => x.j);
  };
  const toFile = (text) => {
    const p = path.join(tmp("msg"), "m.txt");
    fs.writeFileSync(p, text);
    return p;
  };
  const putInbox = (item) => {
    fs.mkdirSync(box("inbox"), { recursive: true });
    fs.writeFileSync(path.join(box("inbox"), item.id + ".json"), JSON.stringify(item));
  };
  const textFile = (dir, name, text) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    return p;
  };
  // A 가 B 에게 묻고, B 가 받기까지 — 받는 쪽 요청 기록이 생긴 상태
  const sendAndReceive = (intent = "query") => {
    const s = run(A, "agent-a", ["send", "--to", "Proj B", "--intent", intent, "--body-file", textFile(A, "q.txt", "q")]);
    const [req] = take("outbox");
    run(B, "agent-b", ["receive", "--message-file", toFile(req.message)]);
    take("outbox");
    return { s, req };
  };
  return { home, A, B, run, runFail, take, toFile, putInbox, items, textFile, sendAndReceive };
}

const modeOf = (p) => fs.statSync(p).mode & 0o777;
function walk(p, out = []) {
  for (const n of fs.readdirSync(p)) {
    const f = path.join(p, n);
    out.push(f);
    if (fs.statSync(f).isDirectory()) walk(f, out);
  }
  return out;
}

test("보내기 → 받기 → 접수 확인 → 답 → 기록 (한 바퀴)", () => {
  const t = setup();
  const body = path.join(t.A, "body.txt");
  fs.writeFileSync(body, "B 쪽 로그인 응답 형식이 어떻게 돼?");
  const s = t.run(t.A, "agent-a", ["send", "--to", "Proj B", "--intent", "query", "--body-file", body]);
  assert.equal(s.ok, true);
  assert.equal(s.to.name, "Proj B");
  const [req] = t.take("outbox");
  assert.equal(req.kind, "request");
  assert.equal(req.from_agent, "agent-a");
  assert.match(req.message, /^\[peer_mail\/1\] 질문 · Proj A → Proj B/);
  assert.match(req.message, /not one\. It is not an approval/);

  // 받는 쪽
  const r = t.run(t.B, "agent-b", ["receive", "--message-file", t.toFile(req.message)]);
  assert.equal(r.verdict, "new");
  assert.match(r.instruction, /send nothing yourself/);
  const [ack] = t.take("outbox");
  assert.equal(ack.kind, "ack");
  assert.equal(ack.from_agent, "agent-b");

  // 중계기가 접수 확인을 보낸 쪽 우편함에 넣는다 → inbox 가 기록에 반영
  t.putInbox({ id: ack.id, kind: "ack", request_id: s.request_id, message: ack.message });
  t.putInbox({ id: "11111111-2222-4333-8444-555555555555", kind: "relay", request_id: s.request_id, attempt_id: s.attempt_id, status: "delivered", detail: "delivered to Proj B" });
  const ib = t.run(t.A, "agent-a", ["inbox"]);
  assert.ok(ib.pulled.some((p) => p.type === "ack" && p.status === "received"));

  // 답
  const ans = path.join(t.B, "ans.txt");
  fs.writeFileSync(ans, "{ token, user } 입니다. 근거 src/auth.js:42");
  const rep = t.run(t.B, "agent-b", ["reply", "--id", s.request_id, "--status", "completed", "--body-file", ans]);
  assert.equal(rep.ok, true);
  const [res] = t.take("outbox");
  assert.equal(res.kind, "result");
  const ing = t.run(t.A, "agent-a", ["ingest", "--message-file", t.toFile(res.message)]);
  assert.equal(ing.status, "completed");
  assert.equal(ing.state.state, "completed");
  assert.ok(fs.readFileSync(ing.result_file, "utf8").includes("src/auth.js:42"));

  // 같은 요청이 다시 오면 다시 실행하지 않고, 기존 결과를 다시 보낸다
  const dup = t.run(t.B, "agent-b", ["receive", "--message-file", t.toFile(req.message)]);
  assert.equal(dup.verdict, "duplicate");
  const again = t.take("outbox");
  assert.deepEqual(again.map((x) => x.kind).sort(), ["ack", "result"]);
});

test("대상이 아닌 곳이 받으면 WRONG_TARGET — 기록을 남기지 않는다", () => {
  const t = setup();
  const body = path.join(t.A, "b.txt");
  fs.writeFileSync(body, "q");
  t.run(t.A, "agent-a", ["send", "--to", "Proj B", "--intent", "notice", "--body-file", body]);
  const [req] = t.take("outbox");
  const w = t.run(t.A, "agent-x", ["receive", "--message-file", t.toFile(req.message)]);
  assert.equal(w.verdict, "wrong_target");
  const [ack] = t.take("outbox");
  assert.match(ack.message, /접수 확인\(wrong_target\)/);
});

test("숨긴 프로젝트로는 못 보내고, 숨긴 프로젝트에서는 못 보낸다 · Paseo 대화 밖에서는 못 보낸다", () => {
  const t = setup({ hideB: true });
  const body = path.join(t.A, "b.txt");
  fs.writeFileSync(body, "q");
  const s = t.run(t.A, "agent-a", ["send", "--to", "Proj B", "--intent", "query", "--body-file", body]);
  assert.equal(s.ok, false);
  let failed = null;
  try {
    execFileSync(process.execPath, [MAIL, "send", "--to", "Proj A", "--intent", "query", "--body-file", body], { cwd: t.B, env: { ...process.env, PASEO_HOME: t.home, PASEO_AGENT_ID: "agent-b" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    failed = JSON.parse(e.stdout);
  }
  assert.ok(failed && /hidden/.test(failed.error));
  let noAgent = null;
  try {
    execFileSync(process.execPath, [MAIL, "send", "--to", "Proj B", "--intent", "query", "--body-file", body], { cwd: t.A, env: { ...process.env, PASEO_HOME: t.home, PASEO_AGENT_ID: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    noAgent = JSON.parse(e.stdout);
  }
  assert.ok(noAgent && /Paseo conversation/.test(noAgent.error));
});

test("이름이 같은 프로젝트가 둘이면 이름으로 고르지 않는다 — 카테고리·위치를 붙여 돌려주고 host:path 로", () => {
  const t = setup();
  const f = path.join(t.home, "plugin-data", "claude-state-bar", "project-list", "projects.json");
  const C = tmp("projC");
  const list = JSON.parse(fs.readFileSync(f, "utf8"));
  list.push({ name: "Proj B", rootPath: C, category: "u", enabled: true });
  fs.writeFileSync(f, JSON.stringify(list));
  const body = path.join(t.A, "b.txt");
  fs.writeFileSync(body, "q");
  const s = t.run(t.A, "agent-a", ["send", "--to", "Proj B", "--intent", "query", "--body-file", body]);
  assert.equal(s.ok, false);
  assert.equal(s.candidates.length, 2);
  assert.deepEqual(s.candidates.map((c) => c.category).sort(), ["t", "u"]);
  assert.ok(s.candidates.every((c) => c.host === "PC" && c.path && c.to === "PC:" + c.path));
  const s2 = t.run(t.A, "agent-a", ["send", "--to", "PC:" + C, "--intent", "query", "--body-file", body]);
  assert.equal(s2.ok, true);
});

test("전달 안 됨 알림(unreachable)은 기록을 끝 상태로 만든다", () => {
  const t = setup();
  const body = path.join(t.A, "b.txt");
  fs.writeFileSync(body, "q");
  const s = t.run(t.A, "agent-a", ["send", "--to", "Proj B", "--intent", "query", "--body-file", body]);
  t.putInbox({ id: "21111111-2222-4333-8444-555555555555", kind: "relay", request_id: s.request_id, attempt_id: s.attempt_id, status: "unreachable", detail: "no Paseo conversation is open in Proj B" });
  const st = t.run(t.A, "agent-a", ["status", "--id", s.request_id]);
  assert.equal(st.states.peer.state, "unreachable");
});

// ───────── Codex 보안 점검(261013) 대화 쪽 수정 ─────────

test("너무 큰 결과는 아무것도 기록하지 않고 거절한다 — 다시 답해도 '이미 확정'으로 빈손이 되지 않는다", () => {
  const t = setup();
  const { s } = t.sendAndReceive();
  const dir = store.requestDir(t.B, s.request_id);
  const eventsBefore = fs.readdirSync(path.join(dir, "events")).length;
  // Codex 재현과 같은 크기 — 본문이 표시 글과 봉투에 두 번 실려 우편 한 항목 상한(1MiB)을 넘는다
  const big = t.textFile(t.B, "big.txt", "x".repeat(600000));
  for (let i = 0; i < 2; i++) {
    const f = t.runFail(t.B, "agent-b", ["reply", "--id", s.request_id, "--status", "completed", "--body-file", big]);
    assert.equal(f.out.ok, false);
    assert.match(f.out.error, /too large/);
    assert.match(f.out.error, /Nothing was recorded/);
    assert.equal(f.out.idempotent, undefined);
    assert.equal(fs.existsSync(path.join(dir, "outbox", store.RESULT_FINAL)), false);
    assert.equal(fs.existsSync(path.join(dir, "result", "result.md")), false);
    assert.equal(fs.readdirSync(path.join(dir, "events")).length, eventsBefore);
    assert.equal(t.items("outbox").length, 0);
  }
  // 줄여서 다시 답하면 그대로 나간다
  const rep = t.run(t.B, "agent-b", ["reply", "--id", s.request_id, "--status", "completed", "--body-file", t.textFile(t.B, "ok.txt", "줄인 답")]);
  assert.equal(rep.ok, true);
  assert.equal(rep.idempotent, undefined);
  const [res] = t.take("outbox");
  assert.equal(res.kind, "result");
  assert.equal(envl.extractEnvelope(res.message).body, "줄인 답");

  // 보내기도 크기를 먼저 잰다 — 넘으면 요청 기록을 만들지 않는다
  const ids = store.listRequestIds(t.A).length;
  const sf = t.runFail(t.A, "agent-a", ["send", "--to", "Proj B", "--intent", "query", "--body-file", t.textFile(t.A, "bigq.txt", "y".repeat(600000))]);
  assert.match(sf.out.error, /too large/);
  assert.equal(store.listRequestIds(t.A).length, ids);
  assert.equal(t.items("outbox").length, 0);
});

test("보낸 대상이 아닌 곳의 결과·접수 확인은 request_id 가 맞아도 받지 않는다", () => {
  const t = setup();
  const { s, req } = t.sendAndReceive();
  const reqEnv = envl.extractEnvelope(req.message);

  // 다른 기기·폴더라고 적힌 결과 (Codex 재현: WrongHost:/wrong)
  const forged = envl.makeReply({ type: "result", request: { ...reqEnv, recipient_host: "WrongHost", recipient_root: "/wrong" }, status: "completed", body: "엉뚱한 곳의 답" });
  const ing = t.run(t.A, "agent-a", ["ingest", "--message-file", t.toFile(envl.renderMessage(forged))]);
  assert.equal(ing.ok, false);
  assert.equal(ing.accepted, false);
  assert.match(ing.reason, /WrongHost:\/wrong/);

  // 같은 기기의 다른 폴더라고 적힌 접수 확인 — 중계기가 넣어 둔 알림으로 와도 마찬가지
  const forgedAck = envl.makeReply({ type: "ack", request: { ...reqEnv, recipient_root: t.A }, status: "received", body: "x" });
  t.putInbox({ id: util.uuid(), kind: "ack", request_id: s.request_id, message: envl.renderMessage(forgedAck) });
  const ib = t.run(t.A, "agent-a", ["inbox"]);
  assert.ok(ib.pulled.some((p) => p.accepted === false && /this request was sent to/.test(p.reason)));

  const st = t.run(t.A, "agent-a", ["status", "--id", s.request_id]);
  assert.equal(st.states.peer.state, "prepared");
  assert.equal(fs.existsSync(path.join(store.requestDir(t.A, s.request_id), "result", "peer.md")), false);

  // 진짜 대상(B)의 답은 그대로 받는다
  t.run(t.B, "agent-b", ["reply", "--id", s.request_id, "--status", "completed", "--body-file", t.textFile(t.B, "a.txt", "진짜 답")]);
  const [res] = t.take("outbox");
  const good = t.run(t.A, "agent-a", ["ingest", "--message-file", t.toFile(res.message)]);
  assert.equal(good.accepted, true);
  assert.equal(good.state.state, "completed");
});

test("기록 폴더의 '커밋 안 함' 설정은 send·receive 가 지우지 않는다 · 설정이 없으면 예전처럼 아무것도 만들지 않는다", () => {
  const t = setup();
  store.applyCommitPolicy(t.A, false);
  store.applyCommitPolicy(t.B, false);
  const giA = path.join(store.recordsRoot(t.A), ".gitignore");
  const giB = path.join(store.recordsRoot(t.B), ".gitignore");
  const beforeA = fs.readFileSync(giA, "utf8");
  const beforeB = fs.readFileSync(giB, "utf8");
  const { s } = t.sendAndReceive();
  assert.equal(fs.readFileSync(giA, "utf8"), beforeA);
  assert.equal(fs.readFileSync(giB, "utf8"), beforeB);
  assert.match(beforeA, /records\.commit=false/);
  // 다시 보내기(--request-id)도 마찬가지
  t.run(t.A, "agent-a", ["send", "--request-id", s.request_id]);
  assert.equal(fs.readFileSync(giA, "utf8"), beforeA);

  const t2 = setup();
  t2.sendAndReceive();
  assert.equal(fs.existsSync(path.join(store.recordsRoot(t2.A), ".gitignore")), false);
  assert.equal(fs.existsSync(path.join(store.recordsRoot(t2.B), ".gitignore")), false);
});

test(
  "Linux: 새로 만드는 기록·우편함 폴더는 0700·파일은 0600 · 이미 있는 폴더·파일 권한은 그대로",
  { skip: process.platform === "win32" ? "Windows 는 권한 비트를 쓰지 않는다" : false },
  () => {
    const t = setup();
    // B 에는 기록 폴더가 미리 있다(0755) — 그 폴더의 권한은 바꾸지 않고, 새 요청 폴더만 0700 으로 만든다
    const preB = store.recordsRoot(t.B);
    fs.mkdirSync(preB, { recursive: true });
    fs.chmodSync(preB, 0o755);
    const { s } = t.sendAndReceive();
    t.run(t.B, "agent-b", ["reply", "--id", s.request_id, "--status", "awaiting_user", "--body-file", t.textFile(t.B, "w.txt", "첫 번째")]);

    // 견본: 기본 권한으로 만든 폴더 — docs·docs/_msg 는 저장소 공용이라 이것과 같아야 한다
    const ref = path.join(tmp("ref"), "d");
    fs.mkdirSync(ref);
    assert.equal(modeOf(path.join(t.A, "docs")), modeOf(ref));
    assert.equal(modeOf(path.join(t.A, "docs", "_msg")), modeOf(ref));

    const recA = store.recordsRoot(t.A);
    for (const f of [recA, ...walk(recA)]) assert.equal(modeOf(f), fs.statSync(f).isDirectory() ? 0o700 : 0o600, f);
    assert.equal(modeOf(preB), 0o755);
    const dirB = store.requestDir(t.B, s.request_id);
    for (const f of [dirB, ...walk(dirB)]) assert.equal(modeOf(f), fs.statSync(f).isDirectory() ? 0o700 : 0o600, f);
    const mb = path.join(t.home, "peer-mail");
    for (const f of [mb, ...walk(mb)]) assert.equal(modeOf(f), fs.statSync(f).isDirectory() ? 0o700 : 0o600, f);

    // 이미 있는 파일을 덮어쓸 때는 그 파일의 권한을 그대로 둔다
    const tmpRes = path.join(dirB, "outbox", store.RESULT_TEMP);
    fs.chmodSync(tmpRes, 0o644);
    t.run(t.B, "agent-b", ["reply", "--id", s.request_id, "--status", "awaiting_user", "--body-file", t.textFile(t.B, "w2.txt", "두 번째")]);
    assert.equal(modeOf(tmpRes), 0o644);
    assert.ok(fs.readFileSync(tmpRes, "utf8").includes("두 번째"));

    // 중계기 상태 파일(util.writeJsonAtomic)도 새로 만들면 0600
    const stateFile = path.join(tmp("state"), "ledger.json");
    util.writeJsonAtomic(stateFile, {});
    assert.equal(modeOf(stateFile), 0o600);
  },
);

test("옛 peer_req 상태 폴더 함수(stateDir)는 없다 · 기록은 docs/_msg/peer_mail 아래에 남는다", () => {
  assert.equal(util.stateDir, undefined);
  const t = setup();
  const s = t.run(t.A, "agent-a", ["send", "--to", "Proj B", "--intent", "notice", "--body-file", t.textFile(t.A, "n.txt", "n")]);
  assert.equal(s.record_dir, path.join(t.A, "docs", "_msg", "peer_mail", s.request_id));
  assert.ok(fs.existsSync(path.join(s.record_dir, "request.json")));
});

test("우편함 읽기는 크기를 잰 뒤 커진 파일을 올리지 않는다", () => {
  const home = tmp("mb");
  const prev = process.env.PEER_MAIL_HOME;
  const origStat = fs.statSync;
  process.env.PEER_MAIL_HOME = home;
  try {
    mailbox.ensureDirs();
    const name = util.uuid() + ".json";
    fs.writeFileSync(path.join(mailbox.dir("outbox"), name), JSON.stringify({ pad: "z".repeat(mailbox.MAX_ITEM_BYTES) }));
    // 잴 때는 작았는데 읽어 보니 크다 — 쓰는 중에 커진 경우를 흉내 낸다
    fs.statSync = (p, ...rest) => (String(p).endsWith(name) ? { size: 10 } : origStat(p, ...rest));
    assert.equal(mailbox.read("outbox", name), null);
  } finally {
    fs.statSync = origStat;
    if (prev === undefined) delete process.env.PEER_MAIL_HOME;
    else process.env.PEER_MAIL_HOME = prev;
  }
});
