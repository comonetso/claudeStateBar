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

async function readTail(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
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

export async function lastTurnCommandOnly(sessionId: string): Promise<boolean> {
  const file = await locateSession(sessionId);
  if (!file) return false;
  const text = await readTail(file);
  if (!text) return false;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o: { type?: string; subtype?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } };
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
    return textOf(content).includes("<command-name>");
  }
  return false;
}
