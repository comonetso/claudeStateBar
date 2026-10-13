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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIL = path.join(HERE, "..", "runtime", "mail.cjs");

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
  return { home, A, B, run, take, toFile, putInbox, items };
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

test("이름이 같은 프로젝트가 둘이면 이름으로 고르지 않는다 — host:path 로", () => {
  const t = setup();
  const f = path.join(t.home, "plugin-data", "claude-state-bar", "project-list", "projects.json");
  const C = tmp("projC");
  const list = JSON.parse(fs.readFileSync(f, "utf8"));
  list.push({ name: "Proj B", rootPath: C, category: "t", enabled: true });
  fs.writeFileSync(f, JSON.stringify(list));
  const body = path.join(t.A, "b.txt");
  fs.writeFileSync(body, "q");
  const s = t.run(t.A, "agent-a", ["send", "--to", "Proj B", "--intent", "query", "--body-file", body]);
  assert.equal(s.ok, false);
  assert.equal(s.candidates.length, 2);
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
