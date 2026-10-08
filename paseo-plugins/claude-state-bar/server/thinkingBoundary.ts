import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { cutFromRuns } from "../shared/thinkingBoundary";
import { locateSession } from "./chime/tracker";

// 생각 상자에서 Claude 의 말을 꺼낼 자리를 Claude 원본 기록(jsonl)으로 찾는다(10-09, 까닭은 shared/thinkingBoundary.ts).
// 대화 번호 → Paseo 가 아는 Claude 세션 번호(persistence.sessionId) → 기록 파일. 기록은 처음 한 번 끝까지 읽고 그 뒤로는
// 늘어난 만큼만 이어 읽는다. 응답(message.id)마다 내용 칸 순서를 모아 이어진 생각 칸 묶음을 만든다.
// 압축 때 같은 줄(uuid)이 다시 적히므로 uuid 로 거른다. 빈 생각 칸은 Paseo 도 버리므로 뺀다.

// 서버 0.10.3 은 @getpaseo/client 를 가져오면 빌드를 거절한다 — 서버 SDK 문맥 타입에서 꺼낸다(soundEvents.ts 와 같이)
type PaseoApi = PluginHandlerContext["paseo"];

type Index = { size: number; rest: string; decoder: StringDecoder; seen: Set<string>; messages: Map<string, (string | null)[]> };
const indexes = new Map<string, Index>();
const sessions = new Map<string, string>();
const CHUNK = 4 * 1024 * 1024;

type Line = { type?: string; uuid?: string; isSidechain?: boolean; message?: { id?: string; content?: unknown } };

function addLine(ix: Index, line: string): void {
  if (!line.includes('"assistant"')) return;
  let o: Line;
  try {
    o = JSON.parse(line) as Line;
  } catch {
    return;
  }
  if (o.type !== "assistant" || o.isSidechain || !o.message?.id || !Array.isArray(o.message.content)) return;
  if (o.uuid) {
    if (ix.seen.has(o.uuid)) return;
    ix.seen.add(o.uuid);
  }
  const seq = ix.messages.get(o.message.id) ?? [];
  for (const block of o.message.content as { type?: string; thinking?: unknown }[]) {
    if (block?.type === "thinking") {
      const text = typeof block.thinking === "string" ? block.thinking.replace(/\r/g, "") : "";
      if (text) seq.push(text);
    } else seq.push(null);
  }
  ix.messages.set(o.message.id, seq);
}

// 같은 파일을 여러 요청이 동시에 이어 읽으면 읽은 자리·끊긴 줄이 꼬인다 — 파일마다 한 줄로 세운다
const loading = new Map<string, Promise<Index>>();
function load(file: string): Promise<Index> {
  const next = (loading.get(file) ?? Promise.resolve()).catch(() => undefined).then(() => loadNow(file));
  loading.set(file, next);
  void next.finally(() => { if (loading.get(file) === next) loading.delete(file); }).catch(() => undefined);
  return next;
}

async function loadNow(file: string): Promise<Index> {
  const { size } = await stat(file);
  let ix = indexes.get(file);
  if (!ix || size < ix.size) {
    ix = { size: 0, rest: "", decoder: new StringDecoder("utf8"), seen: new Set(), messages: new Map() };
    indexes.set(file, ix);
  }
  if (size === ix.size) return ix;
  const handle = await open(file, "r");
  try {
    while (ix.size < size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - ix.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, ix.size);
      if (bytesRead <= 0) break;
      ix.size += bytesRead;
      const lines = (ix.rest + ix.decoder.write(buffer.subarray(0, bytesRead))).split("\n");
      ix.rest = lines.pop() ?? "";
      for (const line of lines) addLine(ix, line);
    }
  } finally {
    await handle.close();
  }
  return ix;
}

/** 응답마다 이어진 생각 칸 묶음(오래된 것 → 새것) */
export function runsOf(messages: Iterable<(string | null)[]>): string[][] {
  const runs: string[][] = [];
  for (const seq of messages) {
    let run: string[] = [];
    for (const item of seq) {
      if (item === null) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push(item);
    }
    if (run.length) runs.push(run);
  }
  return runs;
}

async function sessionFile(paseo: PaseoApi, agentId: string, fresh = false): Promise<string | null> {
  const known = fresh ? undefined : sessions.get(agentId);
  if (known) {
    const file = await locateSession(known);
    if (file) return file;
    sessions.delete(agentId);
  }
  const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
  if (!agent || agent.provider !== "claude") return null;
  const sessionId = agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId;
  if (!sessionId) return null;
  sessions.set(agentId, sessionId);
  return locateSession(sessionId);
}

/** 데몬 플러그인 요청 제한(30초) 안 — 설정 맞추기 기다림(25초)과 같은 값 */
const WAIT_MS = 25_000;

/** 파일이 size 보다 커지면 true, 시간이 다 되면 false. 지켜보기를 못 걸면 바로 false */
function waitForGrowth(file: string, size: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let watcher: FSWatcher | undefined;
    const finish = (grown: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      watcher?.close();
      resolve(grown);
    };
    const timer = setTimeout(() => finish(false), ms);
    const check = () => {
      stat(file).then((s) => { if (s.size > size) finish(true); }, () => finish(false));
    };
    try {
      watcher = watch(file, check);
    } catch {
      finish(false);
      return;
    }
    check(); // 지켜보기를 걸기 직전에 이미 늘었을 수도 있다
  });
}

/**
 * 상자 글에서 꺼낼 자리. wait 이면(지금 도는 턴의 상자) 기록에서 못 찾았을 때 기록 파일이 늘어날 때마다 다시 찾는다 — 생각이 다
 * 들어온 순간엔 Claude Code 가 아직 그 칸을 적지 않았을 수 있다(10-09 실측: 두 칸이 툴 호출 직전에 함께 적힘)
 */
export async function thinkingCut(paseo: PaseoApi, agentId: string, text: string, wait = false, waitMs = WAIT_MS): Promise<number | null> {
  let file = await sessionFile(paseo, agentId);
  if (!file) return null;
  const clean = text.replace(/\r/g, "");
  const started = Date.now();
  const deadline = started + waitMs;
  let rechecked = false;
  let waited = false;
  for (;;) {
    const ix = await load(file);
    const found = cutFromRuns(runsOf(ix.messages.values()), clean);
    if (found.matched) {
      // 기다렸다 찾은 경우 — 생각이 다 들어온 뒤 기록에 늦게 적히는 일이 얼마나 잦은지 본다(10-09)
      if (waited) console.log(`[thinking] boundary found after ${Date.now() - started}ms wait agent=${agentId.slice(0, 8)} cut=${found.cut ?? "none"}`);
      return found.cut;
    }
    // 못 찾으면 대화 정보를 한 번 다시 묻는다 — /clear 등으로 세션이 바뀌었는데 예전 기록 파일을 보고 있을 수 있다(10-09)
    if (!rechecked) {
      rechecked = true;
      const latest = await sessionFile(paseo, agentId, true);
      if (latest && latest !== file) {
        file = latest;
        continue;
      }
    }
    if (!wait) return found.cut;
    const left = deadline - Date.now();
    if (left <= 0 || !(await waitForGrowth(file, ix.size, left))) {
      // 실패 신호 — 기록에서 끝내 못 찾았다(상자에 말이 남는다). 글 내용은 남기지 않고, 화면 글이 기록의 어느 묶음과 앞에서부터
      // 몇 글자까지 같았는지만 — 늦게 적힘(0에 가까움)인지 글이 달라서(중간까지 같음)인지 가른다
      let best = 0;
      for (const run of runsOf(ix.messages.values())) {
        const joined = run.join("");
        let k = 0;
        while (k < joined.length && k < clean.length && joined.charCodeAt(k) === clean.charCodeAt(k)) k++;
        if (k > best) best = k;
      }
      console.log(`[thinking] boundary not found after wait agent=${agentId.slice(0, 8)} len=${clean.length} samePrefix=${best}`);
      return null;
    }
    waited = true;
  }
}
