// 리규형님 전용 팀 계정 자동 전환. 공개 플러그인은 정책을 알지 않는다.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { accountEntry, accountEnv, isTeamProvider, providerForEnv, readProviders, writeAccount } from "./account.mjs";

// 설정 폴더만으로 구독 종류를 알아낼 수 없다. 사용자가 지정한 두 팀 좌석만 허용한다.
export const TEAM_PROVIDER_IDS = ["claude-yeogiaen", "claude-hrg"];
const isTeam = (p, ids = TEAM_PROVIDER_IDS) => ids.includes(p?.id) && isTeamProvider(p);
const validPct = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
export function fiveHour(info, now = Date.now() / 1000) {
  const w = info?.unifiedWindows?.five_hour ?? (info?.rateLimitType === "five_hour" ? info : null);
  return w && validPct(w.utilization) && typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) && w.resetsAt > now
    ? { pct: w.utilization * 100, resetsAt: w.resetsAt } : null;
}
export function hardLimit(info) {
  return info?.status === "rejected" && info.rateLimitType === "five_hour"
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
  const why = info.reason === "limit" ? "5시간 한도 거절"
    : `5시간 사용률 ${validPct(info.pct) ? Math.round(info.pct) + "% · " : ""}쉬는 틈`;
  const when = info.at ? new Date(info.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  const list = (Array.isArray(info.tasks) ? info.tasks : []).map((t) =>
    `- ${TASK_NAMES[t?.type] ?? t?.type ?? "작업"}${t?.subagent ? `(${t.subagent})` : ""} · ${String(t?.description ?? "").slice(0, 200)}`);
  return [
    `[rotation] 팀 계정 자동 전환으로 이 대화의 Claude 가 다시 떴다 — ${info.fromLabel ?? info.from} → ${info.toLabel ?? info.to}(${why}${when ? `, ${when}` : ""}). 사람 말이 아니라 실행기(claude-rc-relay)가 다음 말 앞에 한 번 붙인 안내다.`,
    list.length ? `꺼지기 직전 살아 있던 백그라운드 작업이 모두 끝났다(종류 · 설명):\n${list.join("\n")}` : "꺼지기 직전 살아 있던 백그라운드 작업은 없었다.",
    list.length
      ? "할 일: 아래 말에 답하기 전에, 대화 기록에서 위 작업을 띄운 명령을 찾아 아직 필요한 것만 다시 건다. 서브에이전트·워크플로우는 끝나지 못했으니 결과 파일·중간 저장을 확인하고 이어서 돌린다. 다시 건 것과 안 건 것을 리규형님께 한 줄씩 알린다."
      : "할 일: 아래 말에 답할 때 공급자가 바뀌었다는 것을 리규형님께 한 줄 알린다.",
  ].join("\n");
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
 * 실패·불명확한 사용률은 후보로 삼지 않는다. 경계는 엄격한 미만이다.
 * 대상은 지금 쓰는 공급자가 팀인 대화다 — 처음 연 공급자(base)는 보지 않는다(10-15 리규형님: 개인으로 열고 손으로 팀으로 옮긴 Mesa 도 대상). base 는 기록용
 */
export function chooseTarget({ providers, base, current, pct, limited, idle, usage, teamIds = TEAM_PROVIDER_IDS }) {
  const team = (id) => isTeam(providers.find((p) => p.id === id), teamIds);
  if (!team(current) || (!limited && (!idle || !validPct(pct) || pct < 85))) return null;
  return providers.filter((p) => p.id !== current && isTeam(p, teamIds) && validPct(usage[p.id]) && usage[p.id] < (limited ? 95 : 85))
    .sort((a, b) => usage[a.id] - usage[b.id] || a.id.localeCompare(b.id))[0]?.id ?? null;
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
    let child, window = null, success = false, failed = false, settled = false;
    const probeEnv = { ...env, CLAUDE_TEAM_ROTATION: "0" };
    delete probeEnv.PASEO_AGENT_ID;
    delete probeEnv.CLAUDECODE;
    const finish = (value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(value);
    };
    const abort = () => { failed = true; child?.kill(); finish(null); };
    const timer = setTimeout(abort, 25_000);
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      child = spawn(real, ["-p", "ok", "--model", "claude-haiku-5-5", "--output-format", "stream-json",
        "--verbose", "--no-session-persistence", "--max-turns", "1", "--tools", "",
        "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"],
      { env: probeEnv, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch { return finish(null); }
    const lines = jsonLines((msg) => {
      if (msg.type === "rate_limit_event") {
        const info = msg.rate_limit_info;
        window = fiveHour(info);
        if (!["allowed", "allowed_warning"].includes(info?.status)) failed = true;
      }
      if (msg.type === "assistant" && msg.error) failed = true;
      if (msg.type === "result") success = msg.subtype === "success" && msg.is_error !== true;
    });
    child.stdout.on("data", lines.write);
    child.stdout.on("end", lines.end);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 && success && !failed && window ? window : null));
  });
}

export function createRotation({ real, env, initialEnv, agentId, log = () => {}, enabled = true,
  providers: getProviders = readProviders, entry: getEntry = accountEntry, write = writeAccount, probe = probeUsage, handoff = () => {} }) {
  const providers = getProviders(), original = getEntry(agentId);
  const base = original?.base ?? providerForEnv(initialEnv, providers);
  const current = original?.to ?? providerForEnv(env, providers);
  const active = enabled && !!agentId && env.CLAUDE_TEAM_ROTATION !== "0" && !env.TEAM_UID
    && isTeam(providers.find((p) => p.id === current))
    && providerForEnv(env, providers) === current;
  let stopped = false, switched = false, busy = false, queued = false, epoch = 0;
  let mainDone = false, background = null, window = null, limited = false, limitReset = 0;
  let controller = null, tasks = [];
  const sameEntry = () => JSON.stringify(getEntry(agentId)) === JSON.stringify(original);
  const idle = () => mainDone && background === 0;
  const reason = () => limited ? "limit" : idle() && window?.pct >= 85 ? "idle" : null;
  const valid = (generation, why) => !stopped && !switched && epoch === generation && sameEntry()
    && reason() === why && (why === "limit" ? limitReset : window?.resetsAt) > Date.now() / 1000;
  const check = async () => {
    queued = false;
    if (!active || stopped || switched || busy) return;
    const why = reason();
    if (!why) return;
    const generation = epoch;
    busy = true; controller = new AbortController();
    log(`rotation decision provider=${current} reason=${why} pct=${window?.pct ?? "unknown"}`);
    try {
      const nowProviders = getProviders();
      const usage = {};
      const windows = {};
      for (const candidate of nowProviders.filter((p) => p.id !== current && isTeam(p))) {
        if (!valid(generation, why)) return;
        log(`rotation probe provider=${candidate.id}`);
        const result = await probe(real, accountEnv(env, candidate), controller.signal);
        log(`rotation probe provider=${candidate.id} pct=${result?.pct ?? "failed"}`);
        if (!result || !validPct(result.pct) || result.resetsAt <= Date.now() / 1000) return;
        usage[candidate.id] = result.pct;
        windows[candidate.id] = result;
      }
      const to = chooseTarget({ providers: nowProviders, base, current, pct: window?.pct, limited: why === "limit", idle: idle(), usage });
      if (!to || !valid(generation, why)) { log(`rotation stay provider=${current}`); return; }
      // 설정까지 바뀌었으면 다음 이벤트에서 다시 탐침한다. 값은 비교만 하고 기록하지 않는다.
      const config = JSON.stringify(nowProviders);
      const committed = await write(agentId, to, base, () => valid(generation, why)
        && windows[to].resetsAt > Date.now() / 1000 && JSON.stringify(getProviders()) === config);
      if (committed) {
        switched = true; log(`rotation switch provider=${current} to=${to} pct=${usage[to]}`);
        // 기록이 바뀌면 실행기가 곧 Claude 를 끈다 — 그 전에 꺼질 작업 목록을 남긴다(상주 감시·내부 작업은 빼고)
        const label = (id) => nowProviders.find((p) => p.id === id)?.label;
        try {
          handoff({ at: new Date().toISOString(), from: current, to, fromLabel: label(current), toLabel: label(to), reason: why,
            pct: window?.pct, tasks: tasks.filter((t) => t?.ambient !== true)
              .map((t) => ({ type: t.task_type, subagent: t.subagent_type, description: t.description })) });
        } catch { log(`rotation handoff save failed provider=${current}`); }
      }
    } catch { log(`rotation failed provider=${current}`); }
    finally {
      busy = false; controller = null;
      if (epoch !== generation) schedule();
    }
  };
  const schedule = () => {
    if (!active || queued || stopped || switched) return;
    queued = true;
    setImmediate(() => void check());
  };
  return {
    input(msg) {
      if (!active) return;
      if (msg?.type === "user" || msg?.type === "control_request" && msg.request?.subtype === "interrupt") {
        epoch++; mainDone = false; limited = false; controller?.abort();
      }
    },
    observe(msg) {
      if (!active || !msg) return;
      // 설치본 계약은 새 프로세스의 초기 집합을 빈 목록으로 시작하라고 명시한다.
      // 확인한 버전 이상만 초기값을 신뢰하며, 더 낮은 버전은 실제 전체 목록을 받을 때까지 보류한다.
      if (msg.type === "system" && msg.subtype === "init" && trustedVersion(msg.claude_code_version) && background === null) {
        background = 0; epoch++;
      }
      if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
        // 기다리는 작업(waitedTask — 셸·감시·상주 작업 뺌)만 센다. 목록이 불명확하면 쉬는 틈으로 보지 않는다.
        const ok = Array.isArray(msg.tasks) && msg.tasks.every((t) => typeof t?.task_id === "string");
        background = ok ? msg.tasks.filter(waitedTask).length : null;
        tasks = ok ? msg.tasks : [];
        epoch++;
      }
      if (msg.type === "assistant" && !msg.parent_tool_use_id || msg.type === "stream_event" && !msg.parent_tool_use_id) {
        mainDone = false; epoch++;
      }
      if (msg.type === "result" && !msg.parent_tool_use_id) { mainDone = true; epoch++; }
      if (msg.type === "rate_limit_event") {
        window = fiveHour(msg.rate_limit_info);
        limited = hardLimit(msg.rate_limit_info);
        limitReset = msg.rate_limit_info?.resetsAt ?? 0;
        epoch++;
      }
      schedule();
    },
    stop() { stopped = true; controller?.abort(); },
    // 테스트도 같은 판정을 사용한다.
    state: () => ({ base, current, active, idle: idle(), switched }),
  };
}
