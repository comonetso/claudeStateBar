import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 백그라운드 탭에서 "목록에서 치운" 끝난 작업(확장 BG_CLEARED_KEY · onClearFinished 와 같은 규칙, 리규형님 09-22·10-05 결정).
// 파일은 건드리지 않고 목록에서만 뺀다. 확장은 VS Code 작업 공간 저장소에 두었고, Paseo 플러그인에는 저장 기능이 없어
// 데몬이 Paseo 홈 아래 플러그인 전용 파일에 Claude 프로젝트 칸(작업 폴더)별로 기억한다.
// 키는 "<대화 번호>|<작업 번호>". 지금 목록에 있는 대화의 키만 남겨 끝없이 늘지 않게 한다(확장과 같음).

const FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "claude-state-bar", "bg-cleared.json");

// 처음 읽기는 하나를 함께 쓴다 — 두 호출이 저마다 읽어 서로 다른 객체를 쓰면 한쪽 프로젝트가 사라졌다(Codex 검토 10-05 재현)
let loading: Promise<Record<string, string[]>> | null = null;
const load = () => (loading ??= readStore());

async function readStore(): Promise<Record<string, string[]>> {
  let text: string;
  try {
    text = await readFile(FILE, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* 아래에서 옆에 남긴다 */
  }
  // 깨진 파일은 다음 쓰기가 덮기 전에 옆에 남긴다(무엇이 있었는지 볼 수 있게)
  await rename(FILE, `${FILE}.broken`).catch(() => {});
  return {};
}

export async function clearedFor(projectDir: string): Promise<Set<string>> {
  const s = await load();
  return new Set(Array.isArray(s[projectDir]) ? s[projectDir] : []);
}

// 고치기와 쓰기는 한 줄로 — 파일 하나를 모든 작업 폴더가 같이 쓴다
let writing: Promise<void> = Promise.resolve();

/** 키들을 치운 목록에 더한다. listedSessions 에 없는 대화의 키는 이참에 버린다 */
export function addCleared(projectDir: string, keys: string[], listedSessions: Set<string>): Promise<void> {
  const run = async () => {
    const s = await load();
    const next = new Set([...(Array.isArray(s[projectDir]) ? s[projectDir] : []), ...keys]);
    s[projectDir] = [...next].filter((k) => listedSessions.has(k.slice(0, k.lastIndexOf("|"))));
    await mkdir(dirname(FILE), { recursive: true });
    // 임시 파일에 다 쓴 뒤 바꿔 끼운다 — 쓰다 끊겨도 반쯤 쓴 파일이 남지 않는다
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s), "utf8");
    await rename(tmp, FILE);
  };
  const done = writing.then(run, run);
  writing = done.catch(() => {});
  return done;
}
