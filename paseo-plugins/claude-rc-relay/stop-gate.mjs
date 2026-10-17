#!/usr/bin/env node
// 턴 끝 문지기 — Claude Code Stop 훅(10-16 리규형님 "Mesa 를 쉬지 않게" · docs/paseo-plugin-tools/NONSTOP_IMPL_SPEC.md §4).
// 09:51 사고: Mesa 가 할 일이 남았는데 "넘어간 뒤 시작"이라며 턴을 끝냈고 아무도 다시 깨우지 않아 5시간 넘게 멈췄다.
// 등록한 대화(claude-work/registry.json)에서만 판단하고, 그 밖의 대화는 아무것도 출력하지 않고 통과시킨다.
// 막을 때는 {"decision":"block","reason":…} — 같은 실행이 이어진다(2.1.301 실측). 연속으로 막는 횟수는 Claude Code 가
// 끊는다(CLAUDE_CODE_STOP_HOOK_BLOCK_CAP 기본 8, 도구를 쓰면 0 으로) — 그래서 stop_hook_active 여도 같은 판정을 한다.
// 파일 읽기만 한다. 모르면(파일이 깨졌거나 세대를 못 맞추면) 그 검사는 막지 않는 쪽으로 넘어간다 — 문지기는 보조 장치이고 감독자가 받는다.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alive, appendEvent, idlePctOf, isRegistered, missingFields, paths, PERSONAL_SEAT, personalSwitchPath, readJson, sameWindow, validId, workRoot,
  writeJson } from "./workstate.mjs";

/** 자동 전환 대상 팀 좌석 — rotation.mjs TEAM_PROVIDER_IDS 와 같아야 한다(문지기는 rotation.mjs 를 불러오지 않는다: 설정 파일 읽기 없이 빨리 끝나게) */
export const TEAM_SEATS = ["claude-yeogiaen", "claude-hrg"];
/** 셸·감시는 기다리지 않는다 — rotation.mjs waitedTask 와 같은 뜻(Stop 입력은 친근한 이름 shell·monitor 로 온다) */
const NOT_WAITED = ["local_bash", "monitor_mcp", "monitor_ws", "shell", "monitor"];
const CLI = join(dirname(fileURLToPath(import.meta.url)), "work-cli.mjs");

/**
 * 다른 좌석으로 넘어갈 희망이 있는지 — 관측이 없거나, 창이 지났거나, 그 좌석의 쉬는 틈 기준(팀 85·개인 90) 미만이면 있다(무중단 명세 §0-3).
 * personal = 개인 계정 포함 스위치(10-17) — 켜져 있으면 개인도 넘어갈 곳이다(실행기 chooseTarget 과 같은 후보)
 */
export function otherSeatHopeful(current, seats, now = Date.now() / 1000, teamSeats = TEAM_SEATS, personal = false) {
  return [...teamSeats, ...(personal ? [PERSONAL_SEAT] : [])].filter((id) => id !== current).some((id) => {
    const s = seats?.[id];
    if (!s || !(typeof s.resetsAt === "number") || s.resetsAt <= now) return true;
    if (s.status === "limit") return false;
    return !(typeof s.pct === "number" && s.pct >= (idlePctOf(id) ?? 85));
  });
}
/** 같은 좌석의 여러 관측 중 가장 새 것(실행기 자기 관측과 감독자 집계 pool.json) */
export function mergeSeats(...lists) {
  const out = {};
  for (const list of lists) for (const [id, s] of Object.entries(list ?? {})) {
    if (!s || typeof s !== "object") continue;
    if (!out[id] || String(s.observedAt ?? "") > String(out[id].observedAt ?? "")) out[id] = s;
  }
  return out;
}

/**
 * 판정 — 순수 함수(시험이 같은 것을 쓴다). 돌려주는 값: { verdict: "pass"|"block", reason, code }
 * work = 장부, observe = 실행기 관측(현재 세대일 때만), hook = Stop 입력, pool = 감독자 좌석 집계
 */
export function judge({ work, workError, observe, hook = {}, pool = null, now = Date.now(), personal = false }) {
  if (workError) return { verdict: "pass", code: "work_unreadable" }; // 깨진 장부를 이유로 막으면 고칠 수 없는 반복이 된다 — 감독자가 받는다
  if (!work) return { verdict: "block", code: "no_work", reason: "장부가 없다. 지금 일의 상태를 먼저 적는다." };
  // 이번 입력 뒤 갱신했나 — 실행기 관측이 현재 세대일 때만 본다(모르면 건너뛴다)
  if (observe?.input && observe.runGen) {
    const mark = work.turnMark;
    if (!mark || mark.runGen !== observe.runGen || mark.seq !== observe.input.seq) {
      return { verdict: "block", code: "stale_work", reason: "이번 입력 뒤로 장부를 갱신하지 않았다. 이 턴에서 한 일과 지금 상태를 장부에 적는다." };
    }
  }
  const miss = missingFields(work, now);
  if (miss.length) return { verdict: "block", code: "missing_fields", reason: `장부 상태 ${work.state} 에 필요한 칸이 비었다: ${miss.join(", ")}.` };
  if (work.state !== "ready") return { verdict: "pass", code: `state_${work.state}` };
  // ready — 기다리는 백그라운드 작업이 있으면 그 작업이 끝날 때 Claude Code 가 스스로 깨운다
  const waited = observe?.background && typeof observe.background.waited === "number" ? observe.background.waited
    : Array.isArray(hook.background_tasks) ? hook.background_tasks.filter((t) => !NOT_WAITED.includes(t?.type)).length : 0;
  if (waited > 0) return { verdict: "pass", code: "background_wait", waited };
  // 전환 양보 — 지금 좌석이 쉬는 틈 기준(팀 85·개인 90) 이상, 이번 창에 넘길 곳 없음 판정이 없고, 다른 좌석에 희망이 있으면 끝내게 둔다(실행기가 넘김을 판정한다).
  // 개인 좌석은 개인 계정 포함 스위치가 켜져 있을 때만 — 10-17 개인 포함 때 이 양보가 빠져 개인을 쓰는 동안엔 쉬는 틈이 오지 않았다(99% 강제까지 밀림)
  const current = observe?.provider;
  const seat = observe?.seats?.[current];
  // 실행기가 이 대화를 자동 넘김 대상으로 안 보면(active false — 개인 포함 전에 뜬 옛 실행기는 개인을 모른다) 놓아 주지 않는다.
  // 놓아 주면 실행기는 안 넘기고 턴만 끝나 멈춘다(10-17 저녁 — 문지기는 턴마다 새로 떠 바로 새 판, 실행기는 다시 뜰 때까지 옛 판)
  const inPool = current && observe.active !== false && (TEAM_SEATS.includes(current) || (personal && current === PERSONAL_SEAT));
  if (inPool && typeof seat?.pct === "number" && seat.pct >= (idlePctOf(current) ?? 85) && seat.resetsAt > now / 1000) {
    const d = observe.decision;
    const settled = d && sameWindow(d.window, seat.resetsAt) && (d.reason === "no_target" || d.reason === "error");
    const seats = mergeSeats(pool?.seats, observe.seats);
    if (!settled && otherSeatHopeful(current, seats, now / 1000, TEAM_SEATS, personal)) return { verdict: "pass", code: "yield_rotation", pct: seat.pct };
  }
  return { verdict: "block", code: "ready", reason: `할 일이 남아 있다(다음: ${String(work.next).slice(0, 300)}). 턴을 끝내지 말고 다음 조각을 바로 이어서 한다.` };
}

const HOW = [
  "기다릴 이유가 있으면 장부 상태를 바꾼 뒤 끝낸다:",
  `  사람 답이 필요 → node ${CLI} set --state waiting_human --question "…"`,
  `  외부 작업 결과 대기 → node ${CLI} set --state waiting_external --ref "…" --recheck-at +30m`,
  `  다 끝났다 → node ${CLI} set --state completed --criteria "…" --evidence "…"`,
  `  멈춰야 한다 → node ${CLI} set --state paused --note "…"`,
  `  계속할 일 → node ${CLI} set --state ready --next "…" --progress "이번 조각 결과"`,
].join("\n");

function main(raw) {
  let hook = {};
  try { hook = JSON.parse(raw || "{}"); } catch { /* 입력을 못 읽어도 판단은 파일로 한다 */ }
  const agentId = process.env.PASEO_AGENT_ID;
  if (!validId(agentId)) return;
  const root = workRoot();
  if (!isRegistered(root, agentId)) return;
  const p = paths(root);
  const w = readJson(p.work(agentId));
  const o = readJson(p.observe(agentId)).value;
  // 관측이 이 Claude 를 띄운 실행기의 것인지 — 그 실행기가 살아 있어야 한다(옛 세대의 입력 번호로 판단하지 않게)
  const observe = o && alive(Number(o.pid)) ? o : null;
  const pool = readJson(p.pool).value ?? null;
  const result = judge({ work: w.value ?? null, workError: w.error ?? null, observe, hook, pool, personal: existsSync(personalSwitchPath(root)) });
  // 같은 입력에서 몇 번째로 막는지 — Claude 와 사람이 반복을 알아볼 수 있게
  const mark = observe ? `${observe.runGen}:${observe.input?.seq}` : null;
  const prevGate = readJson(p.gate(agentId)).value;
  const blocks = result.verdict === "block" ? (prevGate?.mark === mark && mark ? (Number(prevGate.blocks) || 0) : 0) + 1 : 0;
  try {
    writeJson(p.gate(agentId), { v: 1, agentId, at: new Date().toISOString(), mark, verdict: result.verdict, code: result.code,
      reason: result.reason ?? null, blocks: result.verdict === "block" ? blocks : (prevGate?.mark === mark ? prevGate.blocks ?? 0 : 0),
      stopHookActive: hook.stop_hook_active === true, observed: !!observe });
  } catch { /* 기록 실패는 판정에 영향 없음 */ }
  appendEvent(root, { kind: "gate", agentId, verdict: result.verdict, code: result.code, mark, blocks });
  if (result.verdict !== "block") return;
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: `[work-gate] ${result.reason}\n${HOW}\n(이번 입력에서 ${blocks}번째로 막음 · 사람 말이 아니라 턴 끝 문지기가 넣은 안내)`,
  }));
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { /* 입력 없음 */ }
  try { main(raw); } catch { /* 문지기가 실패해도 턴은 끝난다 — 감독자가 받는다 */ }
}
