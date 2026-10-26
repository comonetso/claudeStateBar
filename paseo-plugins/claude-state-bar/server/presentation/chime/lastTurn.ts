import { open } from "node:fs/promises";
import { locateSession } from "./tracker";

// 방금 끝난 차례가 "슬래시 명령만으로 끝난 차례"(모델 답 없음)인지 — 이런 차례엔 끝남 소리를 내지 않는다(리규형님 10-06 결정).
// 계기: rcSync 가 Claude 를 다시 띄우며 보내는 /cost 한 줄이 차례 하나로 잡혀, 업데이트 때마다 열린 대화 수만큼 끝남 소리가 났다.
// 결정은 그 /cost 만이 아니라 직접 친 /cost·/context 처럼 모델을 안 부르고 끝난 명령 차례 모두다.
//
// 판정: 기록 끝에서 거꾸로 읽어 본 대화 줄만 본다.
//   - 모델 답(assistant)을 먼저 만나면 → 모델이 답한 차례
//   - 로컬 명령 결과 줄(system local_command)을 먼저 만나면 → 명령만으로 끝난 차례
//   - 사용자 줄(도구 결과·isMeta 제외)을 먼저 만나면 그게 차례의 시작이다. 그 줄이 슬래시 명령(<command-name>)이면 → 명령만으로 끝난 차례
//   - 그 밖(일반 말에 답 없이 끝남 = 중단 등)이거나 못 가리면 → 아니라고 본다(지금처럼 울린다)
// 로컬 명령이 남기는 줄은 명령마다 다르다(10-06 실측): /cost 는 사용자 줄 둘(설명 · <command-name>/usage) + local_command,
// /remote-control(이 환경에서 못 씀)은 사용자 줄 없이 local_command 둘. 차례 끝의 stop_hook_summary 등 다른 system 줄은 건너뛴다.

// 마지막 차례만 보면 되므로 끝부분만 읽는다. 마지막 모델 답 한 줄이 이보다 길면 줄이 잘려 못 읽고, 그때는 아니라고 본다(울림).
const TAIL_BYTES = 256 * 1024;

async function readTail(file: string, bytes = TAIL_BYTES): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // 중간부터 읽었으면 첫 줄은 잘렸을 수 있다
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function isToolResultOnly(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0 && content.every((b) => (b as { type?: string })?.type === "tool_result");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b as { text?: string })?.text ?? "").join("");
  return "";
}

// 방금 끝난 차례가 압축 전 체크포인트(start_compact) 보고로 끝났는지 — 그러면 끝남 대신 "압축 준비" 소리(리규형님 10-15: 60% 에서 자동으로
// 체크포인트를 만들고, 다른 일을 하다가도 소리로 알아차려 명령어를 복사하러 온다). 표식 = start_compact SKILL.md 보고의 복사용 명령어 줄
// "/compact 세션로그 <경로> 가 이 세션의 정본이다…" 가 줄 맨 앞에 있는 답(본문에 인용만 한 답은 안 친다). 보고 첫 줄은 Claude 가
// 풀어 쓰기도 해서("✅ 체크포인트를 저장했습니다." — 10-15 실제 기록) 표식으로 쓰지 않는다. 명령어 줄은 복사용이라 그대로 나온다
const CHECKPOINT_COMMAND = /^\/compact 세션로그 \S+ 가 이 세션의 정본이다/m;
export function isCheckpointReport(text: string): boolean {
  return CHECKPOINT_COMMAND.test(text);
}
/** 체크포인트 보고 안의 복사용 압축 명령어 줄 전체(같은 표식으로 시작하는 줄을 줄 끝까지) — 압축 명령 자동 넣기(autoCompact.ts)가 그대로 보낸다. 없으면 null */
const CHECKPOINT_LINE = new RegExp(`${CHECKPOINT_COMMAND.source}[^\\r\\n]*`, "m");
export function checkpointCommandLine(text: string): string | null {
  const m = CHECKPOINT_LINE.exec(text);
  return m ? m[0].trim() : null;
}
export async function lastTurnCheckpointReady(sessionId: string): Promise<boolean> {
  const file = await locateSession(sessionId);
  if (!file) return false;
  const text = await readTail(file);
  return !!text && turnEndsWithCheckpoint(text);
}
type Line = { type?: string; subtype?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } };
function parseLine(raw: string): Line | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    return JSON.parse(line) as Line;
  } catch {
    return null;
  }
}
const isCompactBoundary = (o: Line) => o.type === "system" && o.subtype === "compact_boundary";
/** 차례를 여는 줄 — 사람 말·백그라운드 끝 알림·다른 대화가 보낸 말(도구 결과·isMeta 는 차례 안) */
const isTurnStart = (o: Line) => o.type === "user" && !o.isMeta && !isToolResultOnly(o.message?.content);

/** from 줄에서 끝난 차례가 체크포인트 보고로 끝났는지 — 거꾸로 읽어 글이 든 마지막 답 하나만 본다 */
function checkpointEndAt(lines: string[], from: number): boolean {
  for (let i = from; i >= 0; i--) {
    const o = parseLine(lines[i]);
    if (!o || o.isSidechain) continue;
    if (isCompactBoundary(o)) return false;
    if (o.type === "assistant") {
      // 답은 블록마다 줄이 따로다 — 글이 든 마지막 줄 하나만 본다(그 뒤에 도구를 불렀으면 보고로 끝난 차례가 아니다)
      const content = o.message?.content;
      if (Array.isArray(content) && content.some((b) => (b as { type?: string })?.type === "tool_use")) return false;
      const said = textOf(content);
      if (said.trim()) return isCheckpointReport(said);
      continue;
    }
    if (isTurnStart(o)) return false;
  }
  return false;
}

/** 대화 기록 끝(jsonl 글)을 거꾸로 읽어 마지막 차례가 체크포인트 보고로 끝났는지 */
export function turnEndsWithCheckpoint(text: string): boolean {
  const lines = text.split("\n");
  return checkpointEndAt(lines, lines.length - 1);
}

export async function lastTurnCommandOnly(sessionId: string): Promise<boolean> {
  const file = await locateSession(sessionId);
  if (!file) return false;
  const text = await readTail(file);
  if (!text) return false;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o: { type?: string; subtype?: string; isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain) continue;
    if (o.type === "assistant") return false;
    if (o.type === "system" && o.subtype === "local_command") return true;
    if (o.type !== "user" || o.isMeta) continue;
    const content = o.message?.content;
    if (isToolResultOnly(content)) continue;
    // /compact 차례는 끝에 명령 출력(<local-command-stdout>Compacted …)과 압축 요약 줄이 사용자 줄로 붙는다 — 건너뛰고 그 앞 명령 줄을 본다.
    // 못 건너뛰면 압축 차례 끝마다 끝남 소리가 났다(10-24 — 체크포인트 보고의 압축 준비 소리 1분 뒤 자동 넣기 압축이 끝나며 또 울림)
    if (o.isCompactSummary || textOf(content).trimStart().startsWith("<local-command-stdout>")) continue;
    return textOf(content).includes("<command-name>");
  }
  return false;
}
