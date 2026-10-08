import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { findCodexDirs } from "../chime/scan";
import type { CleanItemKey, CleanRefusal } from "../../shared/codexClean";
import { CLEAN_ITEMS, parseUsage } from "./usage";

// Codex 진행 탭 [정리]의 데몬 쪽(리규형님 10-08 결정: 확장과 같게). 확장 src/codexCleanNow.ts 의 거절 검사와
// src/providers/codexRescue/usageFile.ts 의 isPluginCleanScript·isThisProjectsDir·cleanScriptExists 를 옮겼다(복사본, 2026-10-08).
// 확장 쪽 규칙을 고치면 여기도.
//
// 확장과 다른 점(구현 방식):
//   · 확장은 VS Code 터미널에 명령 줄을 쳐 넣는다. 여기는 셸 없이 실행 파일과 인자 목록으로 띄운다 — 그래서 확장의
//     "터미널이 다르게 읽는 문자(큰따옴표·$·백틱·%·!) 든 경로는 거절"(unquotablePath)은 옮기지 않았다. 셸이 없으니 그 문자가
//     다르게 읽힐 곳이 없다.
//   · node 는 PATH 에서 찾지 않고 이 데몬을 돌리는 실행 파일(process.execPath)을 노드 모드로 쓴다. PC 는 Paseo.exe(Electron),
//     서버는 node 다. 서버 데몬은 PATH 가 짧을 수 있고(콜어드민은 데몬 PATH 에 paseo 도 없었다 — rcSync findCli), Electron 은
//     ELECTRON_RUN_AS_NODE=1 이면 노드로 돈다(플러그인 프로세스 자신이 그렇게 돈다. 10-08 Paseo.exe 노드 모드 실행 확인).
//   · 출력은 터미널 대신 화면에 보인다(사람이 읽는 글이라 그대로). 지우기는 몇 분 걸릴 수 있어(Codex 대화 한 건 1~6초,
//     한 건 최대 2분) 띄우고 바로 돌아오고, 화면은 codex.clean_wait 로 출력을 받아 간다.
//
// 지우는 정리는 한 폴더에 하나만 돈다(두 화면이 같이 눌러도 같은 파일을 두 번 지우지 않게). 미리보기는 읽기만 해서 막지 않는다.
// 작업은 메모리에만 둔다: 폴더마다 도는 것 + 마지막으로 끝난 것 하나. 플러그인이 다시 읽히면 잊는다(화면은 lost 를 받는다).

const WAIT_MS = 25_000; // 데몬 플러그인 요청 제한 30초 안(settingsSync·projects·headerTitles 와 같다)

type Job = {
  id: string;
  dirKey: string;
  yes: boolean;
  items: CleanItemKey[];
  output: string;
  state: "running" | "done";
  exitCode: number | null;
  error?: string;
  waiters: Set<() => void>;
};

const jobs = new Map<string, Job>();

/** 경로 비교 열쇠 — 구분자를 / 로, 끝 슬래시 제거, Windows 는 대소문자 무시(확장 pathKey · codex-sessions normPath 와 같다) */
function pathKey(p: string): string {
  const s = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/** 이 기기 홈의 ~/.claude — 확장 getClaudeBaseUri 의 로컬 창과 같다(Claude Code 가 플러그인을 까는 곳, 리규형님 10-02 결정 16③) */
function claudeBase(): string {
  return join(homedir(), ".claude");
}

/**
 * 기록된 스크립트가 플러그인 자신의 정리 스크립트인가: ~/.claude 아래 어딘가의 cleanup-logs.mjs. 용량 파일은 프로젝트 안의
 * 보통 파일이라 복사되거나 심어진 것이 [정리]로 아무 프로그램이나 돌리게 하면 안 된다(확장 isPluginCleanScript, 10-02 결정).
 * '.'·'..' 조각은 정규화 전에 막는다(정규화하면 사라져 ~/.claude 밖을 가리켜도 통과한다).
 */
export function isPluginCleanScript(script: string, base = claudeBase()): boolean {
  const s = script.replace(/\\/g, "/");
  if (s.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  if (s.slice(s.lastIndexOf("/") + 1) !== "cleanup-logs.mjs") return false;
  return pathKey(s).startsWith(pathKey(base) + "/");
}

/** 기록의 폴더가 이 작업 공간이 읽는 docs/codex_rescue 인가(복사해 온 프로젝트는 옛 폴더를 적고 있다 — 확장 isThisProjectsDir) */
export function isThisProjectsDir(dir: string, docsDir: string): boolean {
  return pathKey(dir) === pathKey(docsDir);
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

type Ready = {
  ok: true;
  project: string;
  root: string;
  docsDir: string;
  computedAt: number;
  items: { key: CleanItemKey; bytes: number; count: number }[];
  clean: { script: string; dir: string };
};
type Refused = { ok: false; reason: CleanRefusal; path?: string };

/** 용량 기록을 새로 읽고 확장과 같은 순서로 거절 검사를 한다. 거절은 모두 고르기 전에(고른 뒤에 안 된다고 하지 않게 — 확장 주석) */
async function prepare(cwd: string): Promise<Ready | Refused> {
  const dirs = await findCodexDirs(cwd);
  if (!dirs) return { ok: false, reason: "noUsage" };
  let text: string;
  try {
    text = await readFile(join(dirs.logDir, "_usage.json"), "utf8");
  } catch {
    return { ok: false, reason: "noUsage" };
  }
  const read = parseUsage(text);
  if (read.state !== "ok") return { ok: false, reason: "noUsage" };
  const { script, dir } = read.clean;
  if (!isPluginCleanScript(script)) {
    console.log(`[codex-clean] refused (not under ~/.claude): ${script}`);
    return { ok: false, reason: "notPluginScript", path: script };
  }
  if (!isThisProjectsDir(dir, dirs.docsDir)) {
    console.log(`[codex-clean] refused: usage file names ${dir}, workspace reads ${dirs.docsDir}`);
    return { ok: false, reason: "dirMismatch", path: dir };
  }
  if (!(await isFile(script))) {
    console.log(`[codex-clean] script missing: ${script}`);
    return { ok: false, reason: "noScript", path: script };
  }
  const root = dirname(dirname(dirs.docsDir));
  return { ok: true, project: basename(root), root, docsDir: dirs.docsDir, computedAt: read.computedAt, items: read.items, clean: read.clean };
}

function runningDelete(dirKey: string): Job | undefined {
  for (const j of jobs.values()) if (j.dirKey === dirKey && j.yes && j.state === "running") return j;
  return undefined;
}

export async function cleanCheck(cwd: string) {
  const r = await prepare(cwd);
  if (!r.ok) return r;
  const busy = runningDelete(pathKey(r.docsDir));
  return {
    ok: true as const,
    project: r.project,
    computedAt: r.computedAt,
    items: r.items,
    ...(busy ? { running: { jobId: busy.id, items: busy.items } } : {}),
  };
}

function wake(job: Job): void {
  for (const w of [...job.waiters]) w();
}

export async function cleanStart(cwd: string, picked: CleanItemKey[], yes: boolean) {
  // 누를 때 화면에 있던 값이 아니라 지금 파일로 다시 검사한다(미리보기와 지우기 사이에 플러그인이 바뀌었을 수 있다)
  const r = await prepare(cwd);
  if (!r.ok) return r;
  const dirKey = pathKey(r.docsDir);
  if (yes) {
    const busy = runningDelete(dirKey);
    if (busy) return { ok: false as const, reason: "busy" as const, jobId: busy.id, items: busy.items };
  }
  // 고른 항목은 정해진 순서로(확장 buildCleanCommand 와 같다). 화면이 보낸 값은 zod 가 네 이름으로 이미 거른다
  const items = CLEAN_ITEMS.filter((k) => picked.includes(k));
  // 이 폴더의 끝난 작업은 버린다 — 폴더마다 도는 것 + 이번 것만 남겨 메모리가 늘지 않게
  for (const [id, j] of jobs) if (j.dirKey === dirKey && j.state === "done") jobs.delete(id);

  const job: Job = { id: randomUUID(), dirKey, yes, items, output: "", state: "running", exitCode: null, waiters: new Set() };
  jobs.set(job.id, job);
  // consult.md "Run logs": node <script> --dir <dir> --now "<항목>" [--yes] [--lang en|ko]. 화면이 한국어라 ko
  const args = [r.clean.script, "--dir", r.clean.dir, "--now", items.join(","), ...(yes ? ["--yes"] : []), "--lang", "ko"];
  console.log(`[codex-clean] ${yes ? "clean" : "preview"} ${items.join(",")} in ${r.docsDir}`);
  const finish = (exitCode: number | null, error?: string) => {
    if (job.state === "done") return;
    job.state = "done";
    job.exitCode = exitCode;
    if (error) job.error = error;
    console.log(`[codex-clean] ${yes ? "clean" : "preview"} ended: ${error ? `error ${error}` : `exit ${exitCode}`}`);
    wake(job);
  };
  try {
    const child = spawn(process.execPath, args, {
      cwd: r.root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const take = (chunk: string) => {
      job.output += chunk;
      wake(job);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => finish(null, (e as NodeJS.ErrnoException).code ?? e.message));
    child.on("close", (code) => finish(code));
  } catch (e) {
    finish(null, String(e));
  }
  return { ok: true as const, jobId: job.id };
}

function view(job: Job) {
  return {
    state: job.state,
    output: job.output,
    ...(job.state === "done" ? { exitCode: job.exitCode } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

export async function cleanWait(jobId: string, seen: number) {
  const job = jobs.get(jobId);
  if (!job) return { state: "lost" as const, output: "" };
  if (job.state === "running" && job.output.length <= seen) {
    await new Promise<void>((resolveWait) => {
      const done = () => {
        clearTimeout(timer);
        job.waiters.delete(done);
        resolveWait();
      };
      const timer = setTimeout(done, WAIT_MS);
      job.waiters.add(done);
    });
  }
  return view(job);
}
