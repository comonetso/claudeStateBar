import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { LABELS_FILE } from "./projectLabels";
import { findCli } from "./paseoCli";

// 위쪽 제목 "카테고리 - 이름"(shared/headerTitles) — 기기마다 돈다. 이 기기 이름표(~/.claude/project-labels.json, PC 가 보낸 것)의
// 경로별 제목을 화면에 주고, 화면이 바꾸자고 하면 원래 이름을 기록한 뒤 프로젝트 이름을 이 기기의 paseo 명령으로 바꾼다
// (화면 쪽 Paseo 기능에는 작업 공간 제목 바꾸기만 있고 프로젝트 이름 바꾸기는 명령에만 있다).
// 원래 이름 기록: 플러그인 데이터 header-titles-history.jsonl — 한 줄에 { at, kind, id, before, after }. 되돌릴 때 이걸 본다

const PASEO_HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
const HISTORY_FILE = join(PASEO_HOME, "plugin-data", "claude-state-bar", "header-titles-history.jsonl");
/** 데몬은 플러그인 요청을 30초에 끊는다(projects.ts WAIT_MS 와 같은 사정) — 그 안에서 답한다 */
const WAIT_MS = 25_000;

type Title = { path: string; title: string; name: string };

async function readTitles(): Promise<{ sig: string | null; titles: Title[] }> {
  let doc: { projects?: unknown };
  try {
    doc = JSON.parse(await readFile(LABELS_FILE, "utf8"));
  } catch {
    return { sig: null, titles: [] }; // 아직 안 받았거나(이 기기가 목록에 없음) 읽지 못함 — 화면은 아무것도 안 바꾼다
  }
  const titles: Title[] = [];
  for (const p of Array.isArray(doc?.projects) ? doc.projects : []) {
    if (p && typeof p.path === "string" && typeof p.title === "string" && p.title.trim()) {
      titles.push({ path: p.path, title: p.title.trim(), name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.title.trim() });
    }
  }
  return { sig: createHash("sha1").update(JSON.stringify(titles)).digest("hex"), titles };
}

const waiters = new Set<() => void>();
let watching = false;
function watchLabels(): void {
  if (watching) return;
  try {
    // ~/.claude 폴더에는 다른 파일도 자주 바뀐다 — 이름표 파일 알림만 깨운다(파일 이름을 안 주는 기기면 다 깨운다)
    watch(dirname(LABELS_FILE), (_event, filename) => {
      if (filename && String(filename) !== basename(LABELS_FILE)) return;
      for (const wake of [...waiters]) wake();
    });
    watching = true;
  } catch {
    /* 폴더가 아직 없으면 다음 요청 때 다시 */
  }
}

export async function waitHeaderTitles(known: string | null): Promise<{ sig: string | null; titles: Title[] }> {
  watchLabels();
  const now = await readTitles();
  if (now.sig !== known) return now;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, WAIT_MS);
    waiters.add(done);
  });
  return readTitles();
}

/** paseo 명령 실행. .cmd(윈도우)는 cmd 를 거치므로 칸마다 큰따옴표로 싼다 — cmd 는 따옴표 안의 %…% 도 풀어서 " % 가 든 글은 받지 않는다 */
function runPaseo(cli: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // Paseo 데몬이 켜 둔 값 — 남기면 명령어가 Electron 앱으로 뜨지 않는다(rcSync 와 같다)
  const shell = cli.toLowerCase().endsWith(".cmd");
  if (shell && args.some((a) => /["%\r\n]/.test(a))) return Promise.resolve({ ok: false, out: '이름에 " 나 % 가 있어 윈도우 명령으로 넘길 수 없습니다' });
  const argv = shell ? args.map((a) => `"${a}"`) : args;
  return new Promise((resolve) => {
    // 60초는 명령어가 멈췄을 때 다음 요청을 막지 않게 하는 안전장치(rcSync 와 같다)
    execFile(shell ? `"${cli}"` : cli, argv, { env, shell, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim().replace(/\s+/g, " ").slice(0, 200) }),
    );
  });
}

async function record(entry: { kind: string; id: string; before: string; after: string }): Promise<void> {
  try {
    await mkdir(dirname(HISTORY_FILE), { recursive: true });
    await appendFile(HISTORY_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    /* 기록을 못 해도 바꾸기는 막지 않는다 */
  }
}

// 화면이 여럿(PC 앱·웹·폰)이면 같은 요청이 한꺼번에 올 수 있다 — 같은 것이 도는 중이면 그 결과를 같이 받는다
const inflight = new Map<string, Promise<{ ok: boolean; out: string }>>();

export function applyHeaderTitle(input: { kind: "workspace" | "project"; id: string; before: string; after: string }): Promise<{ ok: boolean; out: string }> {
  const key = `${input.kind}:${input.id}:${input.after}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.id) || !input.after.trim() || input.after.startsWith("-")) return { ok: false, out: "바꿀 수 없는 번호나 이름" };
    await record(input);
    if (input.kind === "workspace") {
      console.log(`[header-titles] workspace ${input.id} "${input.before}" → "${input.after}"`);
      return { ok: true, out: "" };
    }
    const cli = findCli();
    const r = cli ? await runPaseo(cli, ["project", "rename", input.id, input.after]) : { ok: false, out: "paseo 명령을 찾지 못했습니다" };
    console.log(`[header-titles] project ${input.id} "${input.before}" → "${input.after}" ok=${r.ok}${r.ok ? "" : ` ${r.out}`}`);
    return r;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
