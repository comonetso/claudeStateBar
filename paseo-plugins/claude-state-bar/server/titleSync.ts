import { appendFile, open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PASEO_HOME } from "./account";
import { claudeProjectsDir } from "./claudePaths";

// 탭 이름 → Claude 대화 기록(10-22 리규형님 — "세션 가져오기에서 작업 시간으로 알아보려고 리네임하는데, 처음 네이밍한 것이 뜨고 리네임한 것이 안 보여").
// Paseo 세션 가져오기 목록은 제목을 Claude 대화 기록 파일에서만 고른다 — custom-title 줄 → ai-title 줄 → 첫 말
// (Paseo 0.12.0 providers/claude/agent.js parseClaudeSessionDescriptor). 탭에서 바꾼 이름은 Paseo 기록(~/.paseo/agents)에만 들어가
// 목록에 안 보인다. 그래서 턴이 끝날 때와 보관할 때 탭 이름을 Claude `/rename` 과 같은 모양의 줄로 대화 기록 끝에 덧붙인다.
// - Claude 는 이름을 아는 대화에서 사용자 말마다 그 이름을 다시 적는다(실측 — 1982줄 대화에 63번). 옛 이름으로 덮이면 다음 턴 끝에 다시 적는다
// - Paseo 가 첫 말로 붙인 기본 이름은 적지 않는다 — 목록이 원래 보여 주는 것이고, 적으면 Claude 자동 제목(ai-title)을 가린다
// - 파일 끝·앞 일부만 읽는다(대화 기록은 수백 MB 까지 커진다)

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;
// Paseo create-agent-title.js 의 MAX_INITIAL_AGENT_TITLE_CHARS 와 같은 값
const MAX_INITIAL_TITLE_CHARS = 60;

// Paseo 하위 대화(parentAgentId)도 자기 대화 기록 파일이 따로 있고 세션 가져오기 목록에 나온다 — 똑같이 적는다
export interface TitleSyncAgent {
  id: string;
  cwd: string;
  title: string | null;
}

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
function parseLine(line: string): Json | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

/** Paseo 가 첫 말로 이름을 짓는 규칙 그대로 — 내용 있는 첫 줄, 공백 하나로, 60자 (create-agent-title.js deriveInitialAgentTitle) */
export function deriveInitialTitle(prompt: string): string | null {
  const first = prompt.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (!first) return null;
  const clamped = first.replace(/\s+/g, " ").trim().slice(0, MAX_INITIAL_TITLE_CHARS).trim();
  return clamped || null;
}

// 다른 대화가 만들거나 말을 보낸 대화는 Paseo 가 첫 말을 <paseo-system kind="agent-message" …>첫 말</paseo-system> 로 감싸 보낸다
// (10-22 실측). Paseo 는 감싸기 전 글로 이름을 지으므로 벗겨서 비교한다
function unwrapPaseoSystem(text: string): string {
  return /^\s*<paseo-system\b[^>]*>\r?\n?([\s\S]*?)\r?\n?<\/paseo-system>\s*$/.exec(text)?.[1] ?? text;
}

/** 대화 기록 앞부분에서 사용자가 처음 보낸 말. 슬래시 명령은 `/이름 인자` 로 되돌린다. 못 찾으면 null */
export function firstPromptText(head: string): string | null {
  for (const line of head.split(/\r?\n/)) {
    if (!line.includes('"user"')) continue;
    const entry = parseLine(line);
    if (!entry || entry.type !== "user" || entry.isMeta || entry.isSidechain) continue;
    const content = asRecord(entry.message)?.content;
    if (typeof content === "string") {
      const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(content)?.[1]?.trim();
      if (name) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(content)?.[1]?.trim();
        return args ? `${name} ${args}` : name;
      }
      if (content.trim()) return unwrapPaseoSystem(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    // 도구 결과만 든 줄은 사용자가 쓴 말이 아니다 — 글 조각이 있는 첫 줄을 쓴다
    const text = content.map(asRecord).find((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim());
    if (text) return unwrapPaseoSystem(text.text as string);
  }
  return null;
}

/** Paseo 가 붙인 기본 이름인가 — 슬래시 명령 이름이거나, 첫 말에서 Paseo 규칙으로 지은 이름과 같으면 */
export function isDefaultTitle(title: string, firstPrompt: string | null): boolean {
  if (title.startsWith("/")) return true;
  return firstPrompt !== null && deriveInitialTitle(firstPrompt) === title;
}

/** 대화 기록 끝부분에서 마지막 이름 줄(custom-title). 없으면 null */
export function lastCustomTitle(tail: string): string | null {
  const needle = '"custom-title"';
  let at = tail.lastIndexOf(needle);
  while (at >= 0) {
    const start = tail.lastIndexOf("\n", at) + 1;
    const end = tail.indexOf("\n", at);
    const entry = parseLine((end === -1 ? tail.slice(start) : tail.slice(start, end)).trim());
    if (entry && entry.type === "custom-title" && !entry.isSidechain && typeof entry.customTitle === "string" && entry.customTitle.trim()) {
      return entry.customTitle.trim();
    }
    at = at <= 0 ? -1 : tail.lastIndexOf(needle, at - 1);
  }
  return null;
}

/** Paseo 기록에서 Claude 대화 번호와 이름. 없으면 null */
async function readAgentRecord(agentId: string): Promise<{ sessionId: string; title: string | null } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  let dirs: string[];
  try {
    dirs = await readdir(join(PASEO_HOME, "agents"));
  } catch {
    return null;
  }
  for (const dir of dirs) {
    let doc: Json | null;
    try {
      doc = asRecord(JSON.parse(await readFile(join(PASEO_HOME, "agents", dir, `${agentId}.json`), "utf8")));
    } catch {
      continue;
    }
    const persistence = asRecord(doc?.persistence);
    const sessionId = persistence?.sessionId ?? persistence?.nativeHandle;
    if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
    return { sessionId, title: typeof doc?.title === "string" ? doc.title : null };
  }
  return null;
}

const pathCache = new Map<string, string>();
/** Claude 대화 기록 파일 — 작업 폴더 이름 규칙으로 먼저, 안 맞으면 projects 아래 폴더를 뒤진다(긴 경로는 Claude 가 이름을 줄인다) */
async function transcriptPath(cwd: string, sessionId: string): Promise<string | null> {
  const cached = pathCache.get(sessionId);
  if (cached) return cached;
  const root = claudeProjectsDir();
  const file = `${sessionId}.jsonl`;
  const candidates = [join(root, cwd.replace(/[^a-zA-Z0-9]/g, "-"), file)];
  try {
    for (const dir of await readdir(root)) candidates.push(join(root, dir, file));
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        pathCache.set(sessionId, candidate);
        return candidate;
      }
    } catch { /* 이 폴더엔 없다 */ }
  }
  return null;
}

async function readSlice(path: string, fromEnd: boolean, bytes: number): Promise<{ text: string; endsWithNewline: boolean }> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, fromEnd ? size - length : 0);
    const last = Buffer.alloc(1);
    if (size > 0) await handle.read(last, 0, 1, size - 1);
    return { text: buffer.toString("utf8"), endsWithNewline: size === 0 || last[0] === 0x0a };
  } finally {
    await handle.close();
  }
}

/** 탭 이름을 대화 기록에 옮겨 적는다. 적었으면 그 이름, 안 적었으면 null */
export async function syncTitle(agent: TitleSyncAgent): Promise<string | null> {
  const record = await readAgentRecord(agent.id);
  if (!record) return null;
  const title = (agent.title ?? record.title)?.trim();
  if (!title) return null;
  const path = await transcriptPath(agent.cwd, record.sessionId);
  if (!path) return null;
  const tail = await readSlice(path, true, TAIL_BYTES);
  if (lastCustomTitle(tail.text) === title) return null;
  if (isDefaultTitle(title, firstPromptText((await readSlice(path, false, HEAD_BYTES)).text))) return null;
  const line = JSON.stringify({ type: "custom-title", customTitle: title, sessionId: record.sessionId });
  await appendFile(path, `${tail.endsWithNewline ? "" : "\n"}${line}\n`, "utf8");
  return title;
}

// 턴 끝과 보관이 거의 같이 오면 같은 줄을 두 번 적을 수 있다 — 대화마다 차례로 처리한다
const queues = new Map<string, Promise<void>>();
export function scheduleTitleSync(agent: TitleSyncAgent): void {
  const previous = queues.get(agent.id) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      const written = await syncTitle(agent);
      if (written) console.log(`[title-sync] ${agent.id.slice(0, 8)}: 탭 이름을 대화 기록에 적음 — "${written}"`);
    } catch (error) {
      console.log(`[title-sync] ${agent.id.slice(0, 8)}: 탭 이름을 대화 기록에 못 적음 — ${String(error)}`);
    }
  });
  queues.set(agent.id, next);
  void next.finally(() => {
    if (queues.get(agent.id) === next) queues.delete(agent.id);
  });
}
