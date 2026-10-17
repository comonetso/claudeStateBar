// 리규형님 전용 팀 계정 자동 전환. 공개 플러그인은 정책을 알지 않는다.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { accountEntry, accountEnv, isTeamProvider, providerForEnv, readProviders, writeAccount } from "./account.mjs";
import { sameWindow, SEAT_PCT } from "./workstate.mjs";

// 설정 폴더만으로 구독 종류를 알아낼 수 없다. 사용자가 지정한 두 팀 좌석만 허용한다.
export const TEAM_PROVIDER_IDS = ["claude-yeogiaen", "claude-hrg"];
const isTeam = (p, ids = TEAM_PROVIDER_IDS) => ids.includes(p?.id) && isTeamProvider(p);
const validPct = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
/**
 * 개인 계정 포함(10-17 리규형님 "이번 주는 개인 계정도 포함" — 23일 만료 리셋권을 쓰려고 이번 주 개인 할당량을 먼저 다 쓴다).
 * 스위치 = <Paseo 홈>/claude-rc-relay-personal.json 이 있으면 켜짐(내용은 보지 않는다). 판정마다 다시 보므로 지우면 바로 팀끼리만으로 돌아간다 —
 * 끄는 때는 리규형님이 정한다("말씀하실 때까지"). 켜져 있으면: 넘길 곳은 개인을 먼저 · 개인으로 연 대화도 대상 · 팀을 쓰는 중 쉬는 틈에
 * 개인이 90% 미만이면 개인으로 돌아간다(개인을 90% 이상·한도로 본 뒤엔 그 리셋 시각까지 다시 재지 않는다). 개인에서 넘기는 규칙은 팀과 같고
 * 기준만 90% 다(IDLE_PCT)
 */
export const PERSONAL_PROVIDER_ID = "claude";
export const isPersonal = (p) => p?.id === PERSONAL_PROVIDER_ID && !isTeamProvider(p);
/**
 * 쉬는 틈에 넘기는 5시간 사용률 — 팀 85%, 개인 90%(10-17 리규형님 "개인 계정 맥스는 팀의 2배라 90%에서 전환").
 * 개인 기준은 개인이 낀 판정 모두에 쓴다: 개인에서 떠날 때 · 개인으로 넘어가거나 돌아올 때(개인이 이 값 미만) · 개인을 다시 잴 시각.
 * 값의 정본은 workstate.mjs SEAT_PCT(문지기 양보·감독자 경고와 같은 곳)
 */
export const IDLE_PCT = SEAT_PCT.team.idle;
export const PERSONAL_IDLE_PCT = SEAT_PCT.personal.idle;
export const idlePct = (p) => isPersonal(p) ? PERSONAL_IDLE_PCT : IDLE_PCT;
export const personalSwitchOn = (file) => !!file && existsSync(file);
/**
 * 스위치 파일을 마지막으로 쓴 시각 — 리셋권 알림(10-17 리규형님 "리셋권을 쓸 타이밍은 내가 정하고 알려 줄게"). 리규형님이 리셋권을 썼다고 하면
 * Claude 가 네 대의 스위치 파일을 다시 쓴다 → 개인을 "풀리는 시각까지 기다림"으로 기억한 실행기가 그 기억을 버리고 다음 쉬는 틈에 다시 잰다
 */
export function personalSwitchStamp(file) {
  try { return file ? statSync(file).mtimeMs : null; } catch { return null; }
}
export function fiveHour(info, now = Date.now() / 1000) {
  const w = info?.unifiedWindows?.five_hour ?? (info?.rateLimitType === "five_hour" ? info : null);
  return w && validPct(w.utilization) && typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) && w.resetsAt > now
    ? { pct: w.utilization * 100, resetsAt: w.resetsAt } : null;
}
/**
 * 실제 거절(추가 사용·유예 중이 아님). 창 종류는 따지지 않는다 — 10-16 리규형님 "팀 플랜엔 전체 주간 한도가 없다"에 따라
 * 주간은 실제로 거절당할 때만 막는다(무중단 기획 §4). 5시간이든 주간이든 거절이면 넘긴다(처음엔 5시간만 보았다)
 */
export function hardLimit(info) {
  return info?.status === "rejected"
    && info.isUsingOverage !== true && info.overageInUse !== true && info.rateLimitGraceActive !== true
    && typeof info.resetsAt === "number" && info.resetsAt > Date.now() / 1000;
}
/**
 * 백그라운드 작업 목록 계약(system/background_tasks_changed — 작업이 없으면 처음엔 오지 않고, 시작·끝마다 전체 목록)을 믿는 Claude Code 판.
 * 2.1.299(설치본 코드)와 2.1.300(서버) 둘 다 실측으로 같았다 — 작업 1개 → result(작업 살아 있음) → 작업 0개(10-15 Claude, docs bg_tasks_probe.sh)
 */
export function trustedVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
  if (!m) return false;
  const [a, b, c] = m.slice(1).map(Number);
  return a > 2 || (a === 2 && (b > 1 || (b === 1 && c >= 299)));
}
/**
 * 쉬는 틈에 끝나길 기다리지 않는 작업(10-15 리규형님: 서브에이전트·워크플로우만 기다림) — 셸 명령과 감시.
 * Mesa 처럼 Codex 대기·사용량 감시·압축 깨우기 셸을 늘 띄워 두는 대화는 이걸 세면 85% 전환이 한도 거절 때까지 밀렸다.
 * Claude Code 가 "활동이 아님"으로 표시한 작업(ambient — 상주 감시·기록 안 남기는 내부 작업)도 기다리지 않는다.
 * 그 밖(서브에이전트·워크플로우·원격 에이전트·팀메이트·MCP 작업)과 처음 보는 종류는 기다린다.
 */
export const NOT_WAITED_TASK_TYPES = ["local_bash", "monitor_mcp", "monitor_ws"];
export const waitedTask = (t) => t?.ambient !== true && !NOT_WAITED_TASK_TYPES.includes(t?.task_type);

/**
 * 넘긴 뒤 알리기(10-15 리규형님): 자동 전환으로 Claude 를 끄면 백그라운드 작업이 다 사라지는데 새로 뜬 Claude 는 모른다.
 * 넘길 때 꺼지기 직전 목록을 남기고(saveHandoff), 같은 대화가 다시 뜰 때 한 번 꺼내(takeHandoff) 첫 사람 말 앞에 안내로 붙인다(withNotice).
 * 목록에는 명령 원문이 없다(Claude Code 가 종류·설명 글만 준다) — 명령은 새 Claude 가 대화 기록에서 찾는다.
 */
const handoffFile = (home, agentId) => /^[A-Za-z0-9-]{1,64}$/.test(String(agentId ?? ""))
  ? join(home, "claude-rc-relay-handoff", `${agentId}.json`) : null;
export function saveHandoff(home, agentId, info) {
  const file = handoffFile(home, agentId);
  if (!file) return false;
  mkdirSync(join(home, "claude-rc-relay-handoff"), { recursive: true });
  writeFileSync(file, JSON.stringify(info));
  return true;
}
export function takeHandoff(home, agentId) {
  const file = handoffFile(home, agentId);
  if (!file) return null;
  try {
    const info = JSON.parse(readFileSync(file, "utf8"));
    unlinkSync(file);
    return info && typeof info === "object" ? info : null;
  } catch { return null; }
}
const TASK_NAMES = { local_bash: "셸 명령", local_agent: "서브에이전트", local_workflow: "워크플로우", monitor_mcp: "감시(MCP)",
  monitor_ws: "감시(웹소켓)", remote_agent: "원격 에이전트", in_process_teammate: "팀메이트", mcp_task: "MCP 작업" };
export function handoffNotice(info) {
  const pct = validPct(info.pct) ? Math.round(info.pct) + "%" : "";
  const why = info.reason === "limit" ? (!info.limitType || info.limitType === "five_hour" ? "5시간 한도 거절"
    : /seven_day|week/i.test(info.limitType) ? "주간 한도 거절" : `한도 거절(${info.limitType})`)
    : info.reason === "force" ? `5시간 사용률 ${pct || "99%"} — 작업이 돌고 있어도 강제로`
    : info.reason === "back" ? "개인 계정이 다시 쓸 수 있어 개인 먼저 · 쉬는 틈"
    : `5시간 사용률 ${pct ? pct + " · " : ""}쉬는 틈`;
  const when = info.at ? new Date(info.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  const list = (Array.isArray(info.tasks) ? info.tasks : []).map((t) =>
    `- ${TASK_NAMES[t?.type] ?? t?.type ?? "작업"}${t?.subagent ? `(${t.subagent})` : ""} · ${String(t?.description ?? "").slice(0, 200)}`);
  return [
    `[rotation] 계정 자동 전환으로 이 대화의 Claude 가 다시 떴다 — ${info.fromLabel ?? info.from} → ${info.toLabel ?? info.to}(${why}${when ? `, ${when}` : ""}). 사람 말이 아니라 실행기(claude-rc-relay)가 다음 말 앞에 한 번 붙인 안내다.`,
    list.length ? `꺼지기 직전 살아 있던 백그라운드 작업이 모두 끝났다(종류 · 설명):\n${list.join("\n")}` : "꺼지기 직전 살아 있던 백그라운드 작업은 없었다.",
    list.length
      ? "할 일: 아래 말에 답하기 전에, 대화 기록에서 위 작업을 띄운 명령을 찾아 아직 필요한 것만 다시 건다. 서브에이전트·워크플로우는 끝나지 못했으니 결과 파일·중간 저장을 확인하고 이어서 돌린다. 다시 건 것과 안 건 것을 리규형님께 한 줄씩 알린다."
      : "할 일: 아래 말에 답할 때 공급자가 바뀌었다는 것을 리규형님께 한 줄 알린다.",
  ].join("\n");
}
/**
 * 넘긴 뒤 자동 이어 달리기(10-16 리규형님 "자동으로 이어서" — 넘기면 Claude 가 꺼진 채 다음 말을 기다려 Mesa 가 6분 넘게 멈췄다).
 * 자동 전환으로 Claude 가 꺼지면 실행기가 분리 프로세스(resume-kicker.mjs)를 하나 띄워 둔다. 그 프로세스는 실행기가 끝나 이어 둔
 * 파이프가 닫히면 — 넘김 파일이 아직 남아 있고(아무도 다시 띄우지 않음) Paseo 에서 그 대화가 실행 중이 아닐 때만 — 이 말을 넣는다.
 * 그 말에 Paseo 가 새 공급자로 실행기를 다시 띄우고, 실행기가 넘김 안내를 이 말 앞에 붙인다(withNotice)
 */
/**
 * 넘긴 뒤 "이어서 하라" 말로 깨울지(10-17 저녁 리규형님 — 개인으로 쓰던 CrewPhoneApp 대화가 일이 끝난 쉬는 틈에 넘겨지며 이 말로 깨워져 대화가 끊겼다).
 * 깨우는 때: 일하던 중 끊긴 넘김(한도 거절 limit · 99% 강제 force) · 무중단 등록 대화(Mesa — 문지기가 놓아 준 틈에 넘어가므로 할 일이 남아 있다).
 * 그 밖의 쉬는 틈 넘김(idle · back)은 일이 끝난 뒤라 깨우지 않는다 — 다음 사람 말 때 새 계정으로 뜨고 그 말 앞에 넘김 안내가 붙는다
 */
export function shouldResume({ reason, registered = false }) {
  return reason === "limit" || reason === "force" || registered === true;
}
export const RESUME_PROMPT = "[rotation] 자동 이어 달리기 — 사람 말이 아니라, 실행기(claude-rc-relay)가 공급자를 넘긴 뒤 다음 말을 기다리지 않도록 넣은 말이다. 바로 위 [rotation] 안내대로 끊긴 작업을 확인하고 하던 일을 이어서 한다. 리규형님께는 공급자가 바뀐 것과 다시 건 작업·안 건 작업을 한 줄씩 알린다.";
/** Paseo 명령 — PC 는 데스크톱 앱 안 resources\bin\paseo.cmd, 서버는 node 옆(nvm bin)의 paseo, 없으면 PATH. 시험은 CLAUDE_ROTATION_PASEO_CLI */
export function paseoCli(env = process.env) {
  if (env.CLAUDE_ROTATION_PASEO_CLI) return env.CLAUDE_ROTATION_PASEO_CLI;
  if (process.platform === "win32") {
    const app = join(env.LOCALAPPDATA ?? "", "Programs", "Paseo", "resources", "bin", "paseo.cmd");
    return existsSync(app) ? app : "paseo.cmd";
  }
  const beside = join(dirname(process.execPath), "paseo");
  return existsSync(beside) ? beside : "paseo";
}
/**
 * 분리 프로세스를 띄운다. 실행기와는 표준 입력 파이프 하나로만 잇는다 — 실행기가 끝나면 그 파이프가 닫혀 바로 안다(시간 값 없음).
 * 실행기의 이벤트 루프는 붙잡지 않는다(PC 팀 실행기는 스스로 끝나길 기다리는 구조라 붙잡으면 서로 기다린다)
 */
export function startResumeKicker({ agentId, home, logFile, tid = "", env = process.env }) {
  if (!handoffFile(home, agentId)) return null;
  const kickerEnv = { ...env };
  delete kickerEnv.PASEO_AGENT_ID;
  delete kickerEnv.CLAUDE_CODE_OAUTH_TOKEN;
  // tid = 넘김 이행 번호(10-16 무중단) — kicker 가 이행 파일(claude-work/transition)에 단계를 남긴다. 없으면 예전처럼 기록만 안 한다
  const kicker = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "resume-kicker.mjs"), agentId, home, logFile, tid],
    { detached: true, stdio: ["pipe", "ignore", "ignore"], env: kickerEnv, windowsHide: true });
  kicker.on("error", () => {});
  kicker.stdin.on("error", () => {});
  kicker.unref();
  kicker.stdin.unref?.();
  return kicker;
}
/** 사람이 보낸 user 줄이면 안내를 앞에 붙인 새 줄을, 아니면 null(도구 결과·제어 요청·JSON 아닌 줄은 그대로 둔다) */
export function withNotice(line, notice) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (o?.type !== "user" || o.parent_tool_use_id || o.message?.role !== "user") return null;
  const c = o.message.content;
  const block = { type: "text", text: notice };
  if (typeof c === "string") o.message.content = [block, { type: "text", text: c }];
  else if (Array.isArray(c) && !c.some((b) => b?.type === "tool_result")) o.message.content = [block, ...c];
  else return null;
  return JSON.stringify(o) + "\n";
}
/** 입력을 넘기며 안내를 첫 사람 말 줄에 한 번 붙인다. 안내가 없거나 붙인 뒤에는 바이트를 그대로 넘긴다(줄바꿈 바이트로 끊어 한글이 안 깨진다) */
export function noticeForwarder(notice, write, onAdded = () => {}) {
  let pending = notice || null, buf = Buffer.alloc(0);
  return {
    write(chunk) {
      if (!pending) return void write(chunk);
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let nl;
      while (pending && (nl = buf.indexOf(10)) >= 0) {
        const line = buf.subarray(0, nl + 1);
        buf = buf.subarray(nl + 1);
        const changed = withNotice(line.toString("utf8"), pending);
        if (changed) { pending = null; onAdded(); write(changed); } else write(line);
      }
      if (!pending && buf.length) { write(buf); buf = Buffer.alloc(0); }
    },
    end() { if (buf.length) write(buf); buf = Buffer.alloc(0); },
  };
}

/**
 * 서브·워크플로우가 돌고 있어도 강제로 넘기는 5시간 사용률(10-16 리규형님 "최소한 99%에는 강제로 돌려야" — Mesa 가 워크플로우를
 * 1시간 넘게 쉬지 않고 돌려 85% 쉬는 틈이 한 번도 안 와 hrg 100% 한도 거절까지 갔다). 넘기면 Claude 를 끄므로 돌던 작업은 끊긴다
 */
export const FORCE_PCT = 99;
/**
 * 시험 덮어쓰기(10-16 — 실제로 99% 까지 쓰지 않고 강제 넘김·이어 달리기를 실기로 보려고, 리규형님 지시로 Mesa 와 시험).
 * 파일(실행기는 <Paseo 홈>/claude-rc-relay-test.json) = { "agentId": "<대화 번호>", "forcePct": <강제 문턱>, "usage": { "<공급자>": <사용률> } }.
 * 그 대화에서 파일이 있는 동안만 쓰고, 그 값으로 한 번 넘기면 지운다. 파일이 없으면 아무 일도 안 한다
 */
export function readRotationTest(file, agentId) {
  if (!file || !agentId) return null;
  try {
    const t = JSON.parse(readFileSync(file, "utf8"));
    return t && typeof t === "object" && t.agentId === agentId ? t : null;
  } catch { return null; }
}
/**
 * 실패·불명확한 사용률은 후보로 삼지 않는다. 경계는 엄격한 미만이다.
 * 대상은 지금 쓰는 공급자가 팀인 대화다 — 처음 연 공급자(base)는 보지 않는다(10-15 리규형님: 개인으로 열고 손으로 팀으로 옮긴 Mesa 도 대상). base 는 기록용.
 * 99% 강제 넘김(forced)은 한도 넘김과 같이 쉬는 틈을 보지 않고, 넘어갈 곳도 같은 기준(95% 미만)이다
 */
export function chooseTarget({ providers, base, current, pct, limited, forced = false, forcePct = FORCE_PCT, idle, usage, teamIds = TEAM_PROVIDER_IDS, personal = false }) {
  // personal = 개인 계정 포함 스위치(10-17) — 개인도 대상·후보이고, 후보 중 개인을 먼저 고른다
  const inPool = (p) => isTeam(p, teamIds) || (personal && isPersonal(p));
  const urgent = limited || (forced && validPct(pct) && pct >= forcePct);
  const now = providers.find((p) => p.id === current);
  // 쉬는 틈 기준은 계정마다(팀 85·개인 90) — 지금 계정은 그 기준을 넘었을 때, 후보는 자기 기준 미만일 때
  if (!inPool(now) || (!urgent && (!idle || !validPct(pct) || pct < idlePct(now)))) return null;
  return providers.filter((p) => p.id !== current && inPool(p) && validPct(usage[p.id]) && usage[p.id] < (urgent ? 95 : idlePct(p)))
    .sort((a, b) => (personal ? Number(isPersonal(b)) - Number(isPersonal(a)) : 0) || usage[a.id] - usage[b.id] || a.id.localeCompare(b.id))[0]?.id ?? null;
}

/** 파이프 원본은 호출자가 그대로 전달한다. 여기서는 UTF-8 줄의 복사본만 읽는다. */
export function jsonLines(onMessage) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const consume = (text, end = false) => {
    pending += text;
    let nl;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
      try { onMessage(JSON.parse(line)); } catch { /* JSON 이 아닌 출력은 넘기기만 한다 */ }
    }
    if (end && pending) { try { onMessage(JSON.parse(pending)); } catch { /* 마지막 조각 */ } pending = ""; }
  };
  return { write: (chunk) => consume(decoder.write(chunk)), end: () => consume(decoder.end(), true) };
}

/**
 * 실제 후보 계정으로 최소 Haiku 요청. 출력·stderr·계정 값은 기록하지 않는다.
 * --bare 는 쓰지 않는다 — 로그인 정보(로그인 파일·CLAUDE_CODE_OAUTH_TOKEN)까지 건너뛰어 늘 "Not logged in" 으로 실패했다(10-15 실측).
 * 설정 파일을 안 읽어 훅·플러그인이 안 돌고, MCP·스킬도 끈다 — 3초 안팎, 옵션 없을 때보다 읽는 양이 4~17분의 1
 */
export function probeUsage(real, env, signal) {
  return new Promise((resolve) => {
    let child, window = null, limit = null, error = null, success = false, resultText = "", settled = false;
    const probeEnv = { ...env, CLAUDE_TEAM_ROTATION: "0" };
    delete probeEnv.PASEO_AGENT_ID;
    delete probeEnv.CLAUDECODE;
    const finish = (value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(value);
    };
    const abort = () => { child?.kill(); finish({ status: "unknown", error: "aborted" }); };
    const timer = setTimeout(() => { child?.kill(); finish({ status: "transport", error: "timeout" }); }, 25_000);
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      child = spawn(real, ["-p", "ok", "--model", "claude-haiku-5-5", "--output-format", "stream-json",
        "--verbose", "--no-session-persistence", "--max-turns", "1", "--tools", "",
        "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"],
      { env: probeEnv, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch { return finish({ status: "transport", error: "spawn" }); }
    const lines = jsonLines((msg) => {
      if (msg.type === "rate_limit_event") {
        const info = msg.rate_limit_info;
        window = fiveHour(info) ?? window;
        // 거절이면 초기화 시각을 버리지 않는다(10-16 04:50 — 거절이 다음 볼 시각까지 지워 아무도 다시 보지 않았다)
        if (info?.status === "rejected") limit = { resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : window?.resetsAt ?? null, type: info.rateLimitType ?? null };
        else if (!["allowed", "allowed_warning"].includes(info?.status)) error ??= `rate ${String(info?.status).slice(0, 40)}`;
      }
      if (msg.type === "assistant" && msg.error) error = String(msg.error).slice(0, 80);
      if (msg.type === "result") {
        success = msg.subtype === "success" && msg.is_error !== true;
        resultText = typeof msg.result === "string" ? msg.result.slice(0, 300) : "";
      }
    });
    child.stdout.on("data", lines.write);
    child.stdout.on("end", lines.end);
    child.on("error", () => finish({ status: "transport", error: "spawn" }));
    child.on("close", (code) => finish(classifyProbe({ code, success, window, limit, error, resultText })));
  });
}
/**
 * 탐침 결과를 종류로 나눈다(10-16 무중단 기획 §3-5): ok · limit(거절 — 초기화 시각 보존) · auth(로그인·인증 — 사람이 필요) ·
 * transport(실행 실패·시간 초과·과부하 — 다시 보면 될 수 있다) · unknown. 오류 글(resultText)은 판정에만 쓰고 남기지 않는다
 */
export function classifyProbe({ code, success, window, limit, error, resultText = "" }) {
  if (limit) return { status: "limit", pct: window?.pct ?? 100, resetsAt: limit.resetsAt, limitType: limit.type };
  if (error === "rate_limit") return { status: "limit", pct: window?.pct ?? 100, resetsAt: window?.resetsAt ?? null };
  if (/auth|login|oauth|billing|account_on_hold|org_not_allowed/i.test(error ?? "")
    || /not logged in|invalid api key|\/login|authenticat|unauthori[sz]ed|forbidden/i.test(resultText)) return { status: "auth", error: error ?? "result" };
  if (code === 0 && success && !error && window) return { status: "ok", pct: window.pct, resetsAt: window.resetsAt };
  if (code !== 0 || /overload|server_error|timeout|unavailable|network|ECONN/i.test(`${error ?? ""} ${resultText}`)) return { status: "transport", error: error ?? `exit ${code}` };
  return { status: "unknown", error: error ?? (window ? "result" : "no-window") };
}
/** 탐침 결과 모양 맞추기 — 시험의 가짜 탐침이 주는 옛 모양({pct, resetsAt} | null)도 받는다 */
export function probeResult(r) {
  if (r && typeof r.status === "string") return r;
  if (r && validPct(r.pct) && typeof r.resetsAt === "number" && r.resetsAt > Date.now() / 1000) return { status: "ok", pct: r.pct, resetsAt: r.resetsAt };
  return { status: "unknown", error: "no-result" };
}

/**
 * 넘길 곳이 없을 때 다시 볼 간격(초) — 탐침이 일시 오류(실행 실패·시간 초과·모름)로 끝난 경우.
 * 무중단 기획 §4 "5·10·15분 세 번"(Claude 선택 값 — Paseo 사용량 캐시 주기와 같은 값일 뿐 복구 최적값을 잰 것이 아니다. 실측 뒤 조정)
 */
export const RETRY_SEC = 300;
export const RETRY_MAX = 3;
/** 판정 기록을 몇 개까지 남길지 — 관측 파일이 끝없이 커지지 않게 */
export const DECISIONS_KEEP = 20;
const nowSec = () => Date.now() / 1000;
const iso = () => new Date().toISOString();
const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n") : "";
/**
 * Paseo 가 Claude 에 넘긴 주 입력의 종류 — 사람 말·자동 이어 달리기·감독자 말·감독자 사용량 알림·peer_mail. 도구 결과·제어 요청이면 null.
 * 사용량 알림(경고·풀림, 10-17 저녁)은 감독자 깨우기 말과 따로 센다 — 감독자는 supervisor 종류로 끝난 턴을 "깨우기 결과"로 센다
 */
export function mainInputKind(msg) {
  if (msg?.type !== "user" || msg.parent_tool_use_id || msg.message?.role !== "user") return null;
  const c = msg.message.content;
  if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) return null;
  const head = textOf(c).trimStart();
  return head.startsWith("[rotation]") ? "rotation" : head.startsWith("[supervisor:usage]") ? "usage" : head.startsWith("[supervisor]") ? "supervisor"
    : head.startsWith("[peer_mail/") ? "peer_mail" : "human";
}
function sevenDay(info) {
  const w = info?.unifiedWindows?.seven_day;
  return w && validPct(w.utilization) && typeof w.resetsAt === "number" ? { pct: w.utilization * 100, resetsAt: w.resetsAt } : null;
}

/**
 * runGen = 이 실행기 세대("<pid>-<시작 ms>"). record(snapshot) = 관측이 바뀔 때마다(무중단 기획 observe 파일 — 호출자가 디스크에 쓴다).
 * onTransition(t) = 넘김 이행 단계(prepared → committed / aborted). 둘 다 실패해도 판정·입출력 전달에 영향이 없다
 */
export function createRotation({ real, env, initialEnv, agentId, log = () => {}, enabled = true,
  providers: getProviders = readProviders, entry: getEntry = accountEntry, write = writeAccount, probe = probeUsage, handoff = () => {}, testFile = null,
  runGen = `${process.pid}-${Date.now()}`, record = null, onTransition = null, teamIds = TEAM_PROVIDER_IDS, personalFile = null }) {
  const providers = getProviders(), original = getEntry(agentId);
  const base = original?.base ?? providerForEnv(initialEnv, providers);
  const current = original?.to ?? providerForEnv(env, providers);
  const currentProvider = providers.find((p) => p.id === current);
  const eligible = enabled && !!agentId && env.CLAUDE_TEAM_ROTATION !== "0" && !env.TEAM_UID
    && providerForEnv(env, providers) === current;
  // 개인 포함 스위치는 판정마다 다시 본다 — 떠 있는 실행기도 켜고 끄는 즉시 따른다(10-17)
  const personal = () => personalSwitchOn(personalFile);
  const isActive = () => eligible && (isTeam(currentProvider, teamIds) || (isPersonal(currentProvider) && personal()));
  // 개인으로 돌아가기(10-17) — 개인을 다시 재 볼 시각(초). 0 = 아직 안 재 봄(첫 쉬는 틈에 잰다). 90% 이상·한도면 그 리셋 시각,
  // 일시 오류면 RETRY_SEC 뒤. 이 실행기 안에서만 기억한다(새로 뜬 실행기는 첫 쉬는 틈에 한 번 다시 잰다)
  let personalNext = 0;
  // personalNext 를 정할 때의 스위치 파일 시각 — 파일이 다시 쓰이면(리셋권 알림) 기다림을 버린다
  let personalSeen = null;
  const personalWaiting = () => nowSec() < personalNext && personalSwitchStamp(personalFile) === personalSeen;
  let stopped = false, switched = false, busy = false, queued = false, epoch = 0;
  let mainDone = false, background = null, window = null, limited = false, limitReset = 0, limitType = null;
  let controller = null, tasks = [], limitTasks = null, loggedStep = 0, loggedWindow = null;
  // holdUntil(초): 넘길 곳이 없다고 판정했으면 그때까지 쉬는 틈·99% 판정의 탐침(Haiku 요청)을 쉰다 — 보존한 초기화 시각 중 가장 이른 것,
  // 일시 오류면 RETRY_SEC 뒤(창마다 RETRY_MAX 번까지), 인증 실패·재시도 소진·시각 모름이면 이번 창 끝까지(감독자가 사람에게 알린다).
  // 한도 거절은 쉬지 않고 판정한다. 창이 바뀌면 처음부터. 10-16 의 forceHoldUntil(99% 만)을 쉬는 틈까지 넓힌 것
  let holdUntil = 0, holdWindow = null, retries = 0;
  // 시험 덮어쓰기(readRotationTest) — 판정할 때마다 다시 읽는다. 없으면 강제 문턱은 FORCE_PCT
  let test = null, forcePct = FORCE_PCT;
  // 관측 — 입력 순번(문지기가 "이번 입력 뒤 장부를 갱신했나"를 본다)·결과·백그라운드·좌석·판정 기록
  let inputSeq = 0, inputAt = null, inputKind = null, mainAt = null, bgTotal = 0, bgAt = null, attempts = 0;
  // 사람이 턴을 중단한 시각과 그때의 입력 순번 — 감독자가 "사람 손에 있는 멈춤"을 알아보게(10-16 22:4x 리규형님 "다음 말까지 알림 안 함").
  // 순번으로 가른다 — 중단과 새 말이 같은 밀리초에 올 수 있다
  let interrupt = null;
  // 압축 중 — Claude Code 가 압축하는 동안 30초마다 되풀이하는 status "compacting" 의 처음·마지막 시각. compact_boundary·result 로 끝(10-17 저녁 —
  // 감독자가 압축 중엔 사용량 경고를 끼워 넣지 않는다: Paseo 는 압축 중에 들어온 말로 압축을 취소한다). 끝 신호를 놓치면 감독자가 마지막 시각으로 가린다
  let compacting = null;
  let decision = null, decisions = [], transition = null;
  const seats = {};
  const startedAtMs = Number(String(runGen).split("-")[1]) || Date.now();
  const win = () => (window && window.resetsAt > nowSec() ? window : null);
  const snapshot = () => ({ v: 1, agentId, runGen, pid: process.pid, startedAtMs, updatedAt: iso(), provider: current, base, active: isActive(),
    input: { seq: inputSeq, at: inputAt, kind: inputKind }, main: { done: mainDone, at: mainAt },
    background: { waited: background, total: bgTotal, at: bgAt }, interrupt, compacting,
    limited, limitReset: limited ? limitReset : null, limitType: limited ? limitType : null,
    seats, decision, decisions, holdUntil: holdUntil || null, switched,
    transition: transition && { tid: transition.tid, state: transition.state } });
  const emit = () => { if (record) { try { record(snapshot()); } catch { /* 관측 실패는 판정·전달에 영향 없음 */ } } };
  const decide = (d) => {
    const same = decision && !d.attemptId && !decision.attemptId && decision.reason === d.reason && sameWindow(decision.window, d.window);
    decision = { ...d, at: iso() };
    if (!same) {
      decisions = [...decisions.slice(-(DECISIONS_KEEP - 1)), decision];
      if (d.reason !== "below_threshold" && d.reason !== "tasks_running") {
        log(`rotation record reason=${d.reason}${d.to ? ` to=${d.to}` : ""}${d.nextAt ? ` next=${new Date(d.nextAt * 1000).toISOString()}` : ""}${d.needsHuman ? ` needs=${d.needsHuman}` : ""}`);
      }
    }
    emit();
  };
  const setTransition = (t) => {
    transition = t;
    if (onTransition) { try { onTransition(t); } catch { log(`rotation transition record failed state=${t.state}`); } }
    emit();
  };
  const seat = (id, r, source) => {
    seats[id] = { pct: validPct(r.pct) ? r.pct : null, resetsAt: typeof r.resetsAt === "number" ? r.resetsAt : null,
      observedAt: iso(), source, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.limitType ? { limitType: r.limitType } : {}), ...(r.limitReset ? { limitReset: r.limitReset } : {}),
      ...(r.week ? { week: r.week } : {}) };
  };
  const sameEntry = () => JSON.stringify(getEntry(agentId)) === JSON.stringify(original);
  const idle = () => mainDone && background === 0;
  // back = 개인 포함 스위치가 켜져 있고 팀을 쓰는 중, 쉬는 틈에 개인을 다시 잴 시각이 됐다(10-17 "개인 먼저")
  // anyTime = 다시 잴 시각은 보지 않는다 — 판정 도중 그 시각을 고친 뒤에도 같은 판정이 유효한지 볼 때(valid)
  const reason = (anyTime = false) => limited ? "limit" : win()?.pct >= forcePct ? "force" : idle() && win()?.pct >= idlePct(currentProvider) ? "idle"
    : idle() && personal() && isTeam(currentProvider, teamIds) && (anyTime || !personalWaiting()) ? "back" : null;
  // 쉬는 틈 넘김만 탐침 동안 새 신호가 오면 다시 판정한다(쉬는 틈이 깨졌을 수 있다). 한도·99% 강제는 이유가 그대로면 유효 —
  // 10-16 Mesa: 한도 거절 직후 워크플로우 실패 신호가 이어져 첫 판정이 "stay" 로 버려지고 탐침을 한 번 더 했다(5초)
  const valid = (generation, why) => !stopped && !switched && (why !== "idle" && why !== "back" || epoch === generation) && sameEntry()
    && reason(true) === why && (why === "back" || (why === "limit" ? limitReset : window?.resetsAt) > nowSec());
  /** 결과(result) 직후 넘길 이유가 없으면 남긴다 — 09:51 처럼 85% 바로 아래에서 끝난 턴을 실행기 기록으로 볼 수 있게 */
  const noteResult = () => {
    const w = win();
    if (!isActive() || switched || limited || !w || reason()) return;
    if (w.pct >= idlePct(currentProvider)) decide({ reason: "tasks_running", window: w.resetsAt, pct: w.pct, waited: background });
    else decide({ reason: "below_threshold", window: w.resetsAt, pct: w.pct });
  };
  const check = async () => {
    queued = false;
    if (!isActive() || stopped || switched || busy) return;
    test = readRotationTest(testFile, agentId);
    forcePct = validPct(test?.forcePct) ? test.forcePct : FORCE_PCT;
    const why = reason();
    if (!why) return;
    if (!sameWindow(window?.resetsAt, holdWindow)) { holdWindow = window?.resetsAt ?? null; holdUntil = 0; retries = 0; }
    // 개인으로 돌아가기(back)는 holdUntil(팀 넘길 곳이 없을 때 쉬는 시각)이 아니라 personalNext 로 쉰다
    if (why !== "limit" && why !== "back" && !test && nowSec() < holdUntil) return;
    const generation = epoch;
    busy = true; controller = new AbortController();
    const att = { attemptId: `${runGen}-${++attempts}`, why, window: window?.resetsAt ?? (limitReset || null), pct: win()?.pct ?? null, candidates: [] };
    log(`rotation decision provider=${current} reason=${why} pct=${win()?.pct ?? "unknown"}${test ? ` (test force=${forcePct})` : ""}`);
    let prepared = null;
    try {
      const nowProviders = getProviders();
      const usage = {}, windows = {}, resets = [];
      let temporary = false, auth = false;
      const personalOn = personal();
      // 돌아가기는 개인만 잰다. 그 밖엔 팀과 (스위치가 켜져 있으면) 개인을 잰다
      const pool = (p) => why === "back" ? isPersonal(p) : isTeam(p, teamIds) || (personalOn && isPersonal(p));
      for (const candidate of nowProviders.filter((p) => p.id !== current && pool(p))) {
        if (!valid(generation, why)) return decide({ ...att, reason: "invalidated" });
        const fake = test?.usage && validPct(test.usage[candidate.id]) ? { pct: test.usage[candidate.id], resetsAt: window?.resetsAt } : null;
        log(`rotation probe provider=${candidate.id}${fake ? " (test)" : ""}`);
        const result = probeResult(fake ?? await probe(real, accountEnv(env, candidate), controller.signal));
        log(`rotation probe provider=${candidate.id} pct=${result.status === "ok" ? result.pct : `failed(${result.status})`}${fake ? " (test)" : ""}`);
        seat(candidate.id, result, fake ? "test" : "probe");
        att.candidates.push({ id: candidate.id, status: result.status, pct: validPct(result.pct) ? result.pct : null, resetsAt: result.resetsAt ?? null });
        if (typeof result.resetsAt === "number" && result.resetsAt > nowSec()) resets.push(result.resetsAt);
        if (result.status === "transport" || result.status === "unknown") temporary = true;
        if (result.status === "auth") auth = true;
        // 후보 하나가 실패해도 다음 후보를 본다(10-16 무중단 — 예전엔 첫 실패에서 판정 전체를 버렸다)
        if (result.status === "ok" && validPct(result.pct) && result.resetsAt > nowSec()) { usage[candidate.id] = result.pct; windows[candidate.id] = result; }
        // 개인을 쟀으면 다음에 다시 잴 시각을 남긴다 — 개인 기준(90%) 미만이면 바로(0), 이상·한도면 그 리셋 시각, 그 밖엔 RETRY_SEC 뒤
        if (isPersonal(candidate)) {
          personalNext = usage[candidate.id] !== undefined ? (usage[candidate.id] < PERSONAL_IDLE_PCT ? 0 : result.resetsAt)
            : result.status === "limit" && result.resetsAt > nowSec() ? result.resetsAt : nowSec() + RETRY_SEC;
          personalSeen = personalSwitchStamp(personalFile);
        }
      }
      if (!valid(generation, why)) return decide({ ...att, reason: "invalidated" });
      const to = why === "back"
        ? (nowProviders.find((p) => isPersonal(p) && validPct(usage[p.id]) && usage[p.id] < PERSONAL_IDLE_PCT)?.id ?? null)
        : chooseTarget({ providers: nowProviders, base, current, pct: win()?.pct, limited: why === "limit", forced: why === "force", forcePct, idle: idle(), usage, teamIds, personal: personalOn });
      if (!to && why === "back") {
        decide({ ...att, reason: "personal_wait", nextAt: personalNext || null });
        log(`rotation stay provider=${current} — personal not ready${personalNext ? ` until ${new Date(personalNext * 1000).toISOString()}` : ""}`);
        return;
      }
      if (!to) {
        // 넘길 곳이 없다 — 다시 볼 시각을 남긴다(아무도 다시 안 보는 일이 없게)
        const known = resets.length ? Math.min(...resets) : 0;
        let next = known, needsHuman = auth ? "auth" : null;
        if (temporary && retries < RETRY_MAX) { retries++; next = Math.min(known || Infinity, nowSec() + RETRY_SEC); }
        else if (!known) { next = window?.resetsAt ?? 0; if (temporary) needsHuman ??= "retries"; }
        if (!test && why !== "limit") holdUntil = next;
        decide({ ...att, reason: "no_target", nextAt: next || null, retries, ...(needsHuman ? { needsHuman } : {}) });
        log(`rotation stay provider=${current}${why === "force" ? " — no team under 95%, force waits for its reset" : ""}`);
        return;
      }
      // 설정까지 바뀌었으면 다음 이벤트에서 다시 탐침한다. 값은 비교만 하고 기록하지 않는다.
      const config = JSON.stringify(nowProviders);
      // 준비 단계부터 주인을 적는다 — 없으면 감독자가 살아 있는 실행기의 준비를 "주인 없음"으로 취소할 수 있었다(Codex 리뷰 261016_182309)
      prepared = { tid: att.attemptId, agentId, state: "prepared", owner: "relay", from: current, to, reason: why, runGen, createdAt: iso() };
      setTransition(prepared);
      const committed = await write(agentId, to, base, () => valid(generation, why)
        && windows[to].resetsAt > nowSec() && JSON.stringify(getProviders()) === config);
      if (!committed) {
        setTransition({ ...prepared, state: "aborted", closedAt: iso(), why: "guard" });
        return decide({ ...att, reason: "invalidated", to });
      }
      switched = true;
      setTransition({ ...prepared, state: "committed", committedAt: iso(), owner: "relay" });
      decide({ ...att, reason: "switched", to });
      log(`rotation switch provider=${current} to=${to} pct=${usage[to]}${test ? " (test)" : ""}`);
      // 시험 덮어쓰기는 한 번만 — 넘어간 쪽 실행기가 같은 값으로 되넘기지 않게 바로 지운다
      if (test) { try { unlinkSync(testFile); log("rotation test override used — file removed"); } catch { log("rotation test override remove failed"); } }
      // 기록이 바뀌면 실행기가 곧 Claude 를 끈다 — 그 전에 꺼질 작업 목록을 남긴다(상주 감시·내부 작업은 빼고).
      // 한도 거절이면 거절 순간의 목록 — 그 뒤엔 거절당한 작업이 실패로 목록에서 빠진다(10-16 Mesa: 워크플로우가 빠져 tasks=0 으로 "작업 없었다" 안내)
      const label = (id) => nowProviders.find((p) => p.id === id)?.label;
      try {
        handoff({ at: iso(), from: current, to, fromLabel: label(current), toLabel: label(to), reason: why, tid: prepared.tid,
          ...(why === "limit" && limitType ? { limitType } : {}),
          pct: window?.pct, tasks: (why === "limit" && limitTasks ? limitTasks : tasks).filter((t) => t?.ambient !== true)
            .map((t) => ({ type: t.task_type, subagent: t.subagent_type, description: t.description })) });
      } catch { log(`rotation handoff save failed provider=${current}`); }
    } catch {
      log(`rotation failed provider=${current}`);
      if (prepared && !switched) setTransition({ ...prepared, state: "aborted", closedAt: iso(), why: "error" });
      decide({ ...att, reason: "error" });
    } finally {
      busy = false; controller = null;
      if (epoch !== generation) schedule();
    }
  };
  const schedule = () => {
    if (queued || stopped || switched || !isActive()) return;
    queued = true;
    setImmediate(() => void check());
  };
  return {
    input(msg) {
      if (msg?.type === "user" || msg?.type === "control_request" && msg.request?.subtype === "interrupt") {
        epoch++; mainDone = false; limited = false; limitTasks = null; controller?.abort();
      }
      if (msg?.type === "control_request" && msg.request?.subtype === "interrupt") { interrupt = { at: iso(), seq: inputSeq }; emit(); }
      const kind = mainInputKind(msg);
      if (kind) { inputSeq++; inputAt = iso(); inputKind = kind; emit(); }
    },
    observe(msg) {
      if (!msg) return;
      let changed = false;
      // 설치본 계약은 새 프로세스의 초기 집합을 빈 목록으로 시작하라고 명시한다.
      // 확인한 버전 이상만 초기값을 신뢰하며, 더 낮은 버전은 실제 전체 목록을 받을 때까지 보류한다.
      if (msg.type === "system" && msg.subtype === "init" && trustedVersion(msg.claude_code_version) && background === null) {
        background = 0; epoch++; changed = true;
      }
      if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
        // 기다리는 작업(waitedTask — 셸·감시·상주 작업 뺌)만 센다. 목록이 불명확하면 쉬는 틈으로 보지 않는다.
        const ok = Array.isArray(msg.tasks) && msg.tasks.every((t) => typeof t?.task_id === "string");
        background = ok ? msg.tasks.filter(waitedTask).length : null;
        tasks = ok ? msg.tasks : [];
        bgTotal = ok ? msg.tasks.length : 0; bgAt = iso();
        epoch++; changed = true;
      }
      if (msg.type === "assistant" && !msg.parent_tool_use_id || msg.type === "stream_event" && !msg.parent_tool_use_id) {
        if (mainDone) changed = true; // 실시간 조각마다 쓰지 않는다 — 끝난 상태가 풀릴 때만
        mainDone = false; epoch++;
      }
      // 압축 — status 는 모드 바뀜 알림에도 쓰이므로 compacting 일 때만 보고, 끝은 compact_boundary·result 로만 판단한다
      if (msg.type === "system" && msg.subtype === "status" && msg.status === "compacting") { compacting = { since: compacting?.since ?? iso(), at: iso() }; changed = true; }
      if (compacting && (msg.type === "system" && msg.subtype === "compact_boundary" || msg.type === "result" && !msg.parent_tool_use_id)) { compacting = null; changed = true; }
      if (msg.type === "result" && !msg.parent_tool_use_id) { mainDone = true; mainAt = iso(); epoch++; changed = true; noteResult(); }
      if (msg.type === "rate_limit_event") {
        const info = msg.rate_limit_info;
        // 5시간 정보가 없는 신호(주간만 담긴 것)는 앞의 5시간 관측을 지우지 않는다. 지난 창은 win() 이 버린다
        window = fiveHour(info) ?? window;
        const wasLimited = limited;
        limited = hardLimit(info);
        limitReset = info?.resetsAt ?? 0;
        limitType = limited ? info.rateLimitType ?? null : null;
        if (limited && !wasLimited) limitTasks = tasks;
        if (!limited) limitTasks = null;
        const w = win(), week = sevenDay(info);
        if (w || limited) seat(current, { status: limited ? "limit" : "ok", pct: w?.pct ?? (limited ? 100 : null), resetsAt: limited && !w ? limitReset : w?.resetsAt,
          ...(limited ? { limitType, limitReset } : {}), ...(week ? { week } : {}) }, "stream");
        // 사용률이 85·90·95·99% 를 처음 넘는 때를 남긴다(창마다) — 10-16 Mesa 조사 때 언제 85% 를 넘었는지 실행기 기록으로 알 수 없었다
        if (w && !sameWindow(w.resetsAt, loggedWindow)) { loggedWindow = w.resetsAt; loggedStep = 0; }
        const step = [FORCE_PCT, 95, 90, 85].find((s) => w?.pct >= s) ?? 0;
        if (step > loggedStep) { loggedStep = step; log(`rotation usage provider=${current} pct=${Math.round(w.pct)} (≥${step})`); }
        epoch++; changed = true;
      }
      if (changed) emit();
      schedule();
    },
    stop() { stopped = true; controller?.abort(); },
    // 테스트도 같은 판정을 사용한다.
    state: () => ({ base, current, active: isActive(), idle: idle(), switched, transition, personalNext }),
    snapshot,
    /** 실행기가 이행 파일에 덧붙일 때(kicker pid 등) — 같은 이행의 다음 단계만 */
    updateTransition(patch) { if (transition) setTransition({ ...transition, ...patch }); },
  };
}
