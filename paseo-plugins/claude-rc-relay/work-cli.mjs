#!/usr/bin/env node
// 무중단 작업 장부 명령(10-16 리규형님 "Mesa 를 쉬지 않게" — docs/paseo-plugin-tools/NONSTOP_IMPL_SPEC.md §2).
// 대화 안 Claude 가 지금 일의 상태를 적는다. 턴 끝 문지기(stop-gate.mjs)와 감독자가 이 장부를 읽는다.
//   node work-cli.mjs show                         — 이 대화의 장부·관측 요약
//   node work-cli.mjs set --state <상태> [칸…]      — 장부 갱신(상태별 필수 칸이 빠지면 쓰지 않는다)
//     ready             --next "다음 조각"            (할 일이 있다 — 턴을 끝내지 않고 이어서 한다)
//     waiting_external  --ref "기다리는 작업" --recheck-at <ISO 또는 +30m/+2h>
//     waiting_human     --question "리규형님께 물을 것"
//     waiting_provider  (좌석 한도 — 실행기 기록으로 다시 본다)
//     completed         --criteria "완료 기준 위치" --evidence "증거"
//     paused            --note "멈추는 이유"
//     공통: --task "큰 작업 한 줄" --progress "이번 조각에서 낸 결과(산출물·체크포인트)"
//           --question "리규형님께 물을 것" — 어느 상태에서나 남는다(질문 버튼 대신 · 감독자가 폰으로 알린다) · --question "" 로 지운다
//   사람 지시로만(Claude 가 스스로 부르지 않는다):
//     register [--agent <id>] [--label <이름>] · unregister [--agent <id>] · resume [--agent <id>](감독자 보류 풀기) · auto-send on|off · status
// 대화 번호는 PASEO_AGENT_ID. 🔴 이 값은 보안 경계가 아니다 — 같은 기기의 누구나 쓸 수 있다. 정상 사용 경로 제한일 뿐이다.
import { statSync, rmSync } from "node:fs";
import { appendEvent, isRegistered, missingFields, paths, readJson, readRegistry, STATES, updateRegistry, validId, workRoot, writeJson } from "./workstate.mjs";

const root = workRoot();
const p = paths(root);
const [cmd, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = rest[i + 1];
  if (next === undefined || next.startsWith("--")) opts[key] = true;
  else { opts[key] = next; i++; }
}
const out = (obj, code = 0) => { process.stdout.write(JSON.stringify(obj, null, 1) + "\n"); process.exit(code); };
const fail = (message, extra = {}) => out({ ok: false, error: message, ...extra }, 2);
const agentArg = () => (typeof opts.agent === "string" ? opts.agent : process.env.PASEO_AGENT_ID) ?? "";

/** +30m · +2h · +1d · ISO 시각 → ISO. 못 읽으면 null */
function when(v) {
  if (typeof v !== "string") return null;
  const m = /^\+(\d+(?:\.\d+)?)\s*(m|min|h|d)$/i.exec(v.trim());
  if (m) {
    const n = Number(m[1]) * ({ m: 60, min: 60, h: 3600, d: 86400 }[m[2].toLowerCase()]) * 1000;
    return new Date(Date.now() + n).toISOString();
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const str = (v) => (typeof v === "string" ? v.trim() : undefined);

function summary(agentId) {
  const w = readJson(p.work(agentId)), o = readJson(p.observe(agentId)), g = readJson(p.gate(agentId)), s = readJson(p.supervisor(agentId));
  const ob = o.value;
  return {
    agentId, registered: isRegistered(root, agentId),
    work: w.value ?? (w.missing ? null : { error: w.error }),
    observe: ob ? { runGen: ob.runGen, provider: ob.provider, input: ob.input, background: ob.background, seat: ob.seats?.[ob.provider] ?? null,
      decision: ob.decision && { reason: ob.decision.reason, at: ob.decision.at, nextAt: ob.decision.nextAt ?? null },
      switched: ob.switched ?? false, transition: ob.transition ?? null } : (o.missing ? null : { error: o.error }),
    gate: g.value ? { at: g.value.at, verdict: g.value.verdict, code: g.value.code ?? null, reason: g.value.reason, blocks: g.value.blocks } : null,
    toolGateSeen: (() => { try { return statSync(`${p.gate(agentId).replace(/\.json$/, "")}.tool-seen`).mtime.toISOString(); } catch { return null; } })(),
    supervisor: s.value ? { status: s.value.status, reason: s.value.reason, hold: s.value.hold ?? null, at: s.value.updatedAt } : null,
  };
}

if (cmd === "show") {
  const agentId = agentArg();
  if (!validId(agentId)) fail("대화 번호가 없다(PASEO_AGENT_ID)");
  out({ ok: true, ...summary(agentId) });
}

if (cmd === "set") {
  const agentId = process.env.PASEO_AGENT_ID ?? "";
  if (!validId(agentId)) fail("대화 번호가 없다(PASEO_AGENT_ID) — Paseo 대화 안에서만 쓴다");
  if (!isRegistered(root, agentId)) fail("등록되지 않은 대화다 — 장부는 등록한 대화(무중단 작업 대상)만 쓴다");
  const state = str(opts.state);
  if (!STATES.includes(state)) fail(`--state 는 ${STATES.join(" · ")} 중 하나`);
  const cur = readJson(p.work(agentId));
  if (cur.error) fail(`장부 파일을 읽을 수 없다(${cur.error}) — 덮어쓰지 않는다. 사람에게 알린다`);
  const prev = cur.value ?? {};
  const next = { ...prev, v: 1, agentId, state };
  // 상태 전용 칸은 새 상태에 맞는 것만 남긴다(지난 상태의 칸이 남아 헷갈리지 않게)
  if (state !== "waiting_external") delete next.external;
  // 질문 칸은 사람 대기가 아니어도 남긴다 — 질문 버튼 대신 장부에 적고 다른 일을 계속한다(리규형님 10-16 19:2x).
  // 지우는 때: --question "" · 완료·멈춤 · 사람 대기에서 나가며 질문을 다시 주지 않음(답을 받았다는 뜻)
  if (["completed", "paused"].includes(state) || (prev.state === "waiting_human" && state !== "waiting_human")) delete next.human;
  if (state !== "completed") delete next.completed;
  if (state !== "paused" && opts.note === undefined) delete next.note;
  for (const key of ["task", "next", "progress", "note"]) if (str(opts[key]) !== undefined) next[key] = str(opts[key]).slice(0, 2000);
  if (state === "waiting_external") {
    const recheck = opts["recheck-at"] !== undefined ? when(opts["recheck-at"]) : prev.external?.recheckAt;
    if (opts["recheck-at"] !== undefined && !recheck) fail("--recheck-at 을 읽을 수 없다 — ISO 시각 또는 +30m·+2h·+1d");
    next.external = { ref: str(opts.ref) ?? prev.external?.ref, recheckAt: recheck };
  }
  const question = str(opts.question);
  if (question === "") delete next.human;
  else if (question !== undefined) {
    const same = question.slice(0, 2000) === prev.human?.question;
    next.human = { question: question.slice(0, 2000), askedAt: same && prev.human?.askedAt ? prev.human.askedAt : new Date().toISOString() };
  }
  if (state === "completed") next.completed = { criteria: str(opts.criteria) ?? prev.completed?.criteria, evidence: str(opts.evidence) ?? prev.completed?.evidence };
  const miss = missingFields(next);
  if (miss.length) fail(`상태 ${state} 에 필요한 칸이 비었다: ${miss.join(", ")}`, { missing: miss });
  // 이번 입력 표식 — 실행기가 Claude 에 넘긴 마지막 주 입력(문지기가 "이번 입력 뒤에 갱신했나"를 본다)
  const ob = readJson(p.observe(agentId)).value;
  next.turnMark = ob?.input && ob.runGen ? { runGen: ob.runGen, seq: ob.input.seq } : null;
  if (str(opts.progress) !== undefined && str(opts.progress) !== prev.progress) next.progressAt = new Date().toISOString();
  next.rev = (Number(prev.rev) || 0) + 1;
  next.updatedAt = new Date().toISOString();
  writeJson(p.work(agentId), next);
  appendEvent(root, { kind: "work", agentId, state, rev: next.rev, turnMark: next.turnMark });
  out({ ok: true, state, rev: next.rev, turnMark: next.turnMark,
    note: state === "ready" ? "할 일이 있다 — 턴을 끝내지 말고 다음 조각을 이어서 한다" : "이 상태로 턴을 끝낼 수 있다" });
}

if (cmd === "register" || cmd === "unregister") {
  const agentId = agentArg();
  if (!validId(agentId)) fail("대화 번호가 없다(--agent 또는 PASEO_AGENT_ID)");
  const doc = updateRegistry(root, (d) => {
    if (cmd === "register") d.agents[agentId] = { at: new Date().toISOString(), ...(typeof opts.label === "string" ? { label: opts.label } : {}) };
    else delete d.agents[agentId];
  });
  if (cmd === "unregister") rmSync(`${p.gate(agentId).replace(/\.json$/, "")}.tool-seen`, { force: true }); // 도구 문지기 흔적(등록 대화에만 생긴다)
  appendEvent(root, { kind: cmd, agentId });
  out({ ok: true, registered: Object.keys(doc.agents), autoSend: doc.autoSend === true });
}

// 감독자 보류 풀기 — 감독자 파일은 감독자만 쓴다. 요청 파일만 남기고 감독자가 보고 지운다
if (cmd === "resume") {
  const agentId = agentArg();
  if (!validId(agentId)) fail("대화 번호가 없다(--agent 또는 PASEO_AGENT_ID)");
  writeJson(`${p.supervisor(agentId)}.resume`, { at: new Date().toISOString() });
  appendEvent(root, { kind: "resume-request", agentId });
  out({ ok: true, note: "감독자에게 보류 풀기를 요청했다" });
}

if (cmd === "auto-send") {
  const on = rest[0] === "on" ? true : rest[0] === "off" ? false : null;
  if (on === null) fail("auto-send on 또는 off");
  const doc = updateRegistry(root, (d) => { d.autoSend = on; });
  appendEvent(root, { kind: "auto-send", on });
  out({ ok: true, autoSend: doc.autoSend === true });
}

if (cmd === "status") {
  const reg = readRegistry(root);
  if (reg.error) fail(`등록 파일을 읽을 수 없다(${reg.error})`);
  out({ ok: true, autoSend: reg.autoSend, agents: Object.keys(reg.agents).map((id) => ({ label: reg.agents[id]?.label ?? null, ...summary(id) })),
    pool: readJson(p.pool).value ?? null });
}

fail(`모르는 명령: ${cmd ?? "(없음)"} — show · set · register · unregister · resume · auto-send · status`);
