import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectEntry } from "../shared/projects";
import { listProjects, onProjectsChange } from "./projects";

// 폰·웹 세션 제목의 프로젝트 이름표(리규형님 10-07 결정 — 이름은 .vscode 대신 이 목록에서, 번호는 떼고, 서버에는 이름만 담은
// 작은 파일을 자동으로 보낸다). 제목은 /start 의 ~/.claude/scripts/rc_title.js 가 짓고, 그 스크립트가 이 파일을 읽는다.
// 목록이 있는 PC 데몬에서만 돈다(서버 데몬에는 목록 파일이 없다). 목록을 기기별 { 경로, 이름 } 으로 나눠 PC 는
// ~/.claude/project-labels.json 에 바로 쓰고, 서버는 목록 원격 경로의 SSH 별칭으로 보낸다. 데몬이 뜰 때 모두 보내고,
// 목록 파일이 바뀌면 내용이 달라진 기기에만 보낸다. 못 보낸 기기(꺼진 서버 등)는 다음 변경이나 데몬이 다시 뜰 때 다시 보낸다.
// 꺼 둔(enabled:false) 프로젝트도 넣는다 — 목록에서 숨긴 것일 뿐 그 폴더의 이름은 맞다.
// 10-08: Paseo 위쪽 제목(작업 공간 머리줄) "카테고리 - 이름"도 같은 파일에 싣는다 — 기기마다 그 기기 플러그인이 읽어 맞춘다(server/headerTitles).

const LABELS_NAME = "project-labels.json";
/** 이 기기의 이름표 파일 — rc_title.js 와 위쪽 제목(server/headerTitles)이 읽는다 */
export const LABELS_FILE = join(homedir(), ".claude", LABELS_NAME);
const PC = "PC";
const SENT_FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "claude-state-bar", "project-labels-sent.json");

export interface ProjectLabel {
  path: string;
  /** 폰·웹 세션 제목에 쓰는 이름 */
  name: string;
  /** Paseo 위쪽 제목 "카테고리 - 이름"(카테고리가 없으면 이름만) */
  title: string;
}

const dropNumber = (s: string) => s.trim().replace(/^\d+\.\s*/, "").trim();

/** 목록 → 기기별 이름표. 이름·카테고리 앞 정렬용 번호("1. ")는 뗀다 */
export function labelsByHost(entries: ProjectEntry[]): Map<string, ProjectLabel[]> {
  const out = new Map<string, ProjectLabel[]>();
  for (const e of entries) {
    const name = dropNumber(e.name);
    if (!name || !e.path) continue;
    const category = dropNumber(e.category);
    const list = out.get(e.host) ?? [];
    list.push({ path: e.path, name, title: category ? `${category} - ${name}` : name });
    out.set(e.host, list);
  }
  return out;
}

export function labelsText(labels: ProjectLabel[]): string {
  const doc = {
    note: "Claude State Bar 가 PC 의 프로젝트 목록(Paseo 플러그인 데이터 project-list/projects.json)에서 만든 이름표다(name = 폰·웹 세션 제목, title = Paseo 위쪽 제목). 여기를 고쳐도 다음에 덮어쓴다 — 이름은 목록에서 고친다.",
    projects: labels,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** SSH 별칭으로 쓸 수 있는 이름만 — 목록 글자가 ssh 옵션으로 읽히지 않게 */
export const SAFE_HOST = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function sshExe(): string {
  if (process.platform === "win32") {
    const builtIn = join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    if (existsSync(builtIn)) return builtIn;
  }
  return "ssh";
}

async function writeLocal(text: string): Promise<{ ok: boolean; out: string }> {
  try {
    await mkdir(dirname(LABELS_FILE), { recursive: true });
    const tmp = `${LABELS_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, LABELS_FILE);
    return { ok: true, out: LABELS_FILE };
  } catch (error) {
    return { ok: false, out: String(error) };
  }
}

// 내용은 base64 로 명령 인자에 싣는다 — 이 PC 의 ssh 는 파이프로 넣은 입력의 끝을 서버에 못 알려 멈춘다(09-14 실측). -n 으로 입력도 닫는다
function sendRemote(host: string, text: string): Promise<{ ok: boolean; out: string }> {
  return sendRemoteFile(host, "~/.claude", LABELS_NAME, text);
}

/** 서버 한 대의 dir/name 에 글을 통째로 쓴다. dir·name 은 코드 상수만 넘긴다(명령 글에 그대로 들어간다) — 받아쓰기 이름 힌트도 쓴다(10-10) */
export function sendRemoteFile(host: string, dir: string, name: string, text: string): Promise<{ ok: boolean; out: string }> {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const target = `${dir}/${name}`;
  const command = `mkdir -p ${dir} && printf %s '${b64}' | base64 -d > ${target}.tmp && mv -f ${target}.tmp ${target}`;
  return new Promise((resolve) => {
    // 접속 10초·전체 30초는 서버가 꺼져 있을 때 다음 차례를 막지 않게 하는 안전장치
    execFile(sshExe(), ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command], { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.replace(/\*\*[^\n]*\n?/g, "").trim().replace(/\s+/g, " ").slice(0, 200) }),
    );
  });
}

async function readSentHosts(): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(SENT_FILE, "utf8"));
    return Array.isArray(raw?.hosts) ? raw.hosts.filter((h: unknown): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

async function writeSentHosts(hosts: string[]): Promise<void> {
  try {
    await mkdir(dirname(SENT_FILE), { recursive: true });
    await writeFile(SENT_FILE, `${JSON.stringify({ hosts: [...hosts].sort() }, null, 2)}\n`, "utf8");
  } catch {
    /* 다음에 다시 */
  }
}

export function startProjectLabels(): () => void {
  let stopped = false;
  let running = false;
  let again = false;
  const sent = new Map<string, string>(); // 기기 → 마지막으로 보낸 내용(이번 데몬 동안)
  let known: Set<string> | null = null; // 이름표를 보낸 적 있는 기기 — 목록에서 기기가 통째로 빠지면 빈 이름표를 보낸다
  const quiet = new Set<string>(); // 같은 실패를 되풀이해 남기지 않게

  const round = async () => {
    const list = await listProjects();
    if (!list.source || list.error) return; // 목록이 없거나(서버 데몬) 고치는 중이라 깨진 순간 — 다음 변경 때
    const byHost = labelsByHost(list.entries);
    known ??= new Set(await readSentHosts());
    for (const host of known) if (!byHost.has(host)) byHost.set(host, []);
    let changed = false;
    for (const [host, labels] of byHost) {
      if (stopped) return;
      const text = labelsText(labels);
      if (sent.get(host) === text) continue;
      if (host !== PC && !SAFE_HOST.test(host)) {
        if (!quiet.has(`bad:${host}`)) console.log(`[project-labels] skip host "${host}" (not an ssh alias)`);
        quiet.add(`bad:${host}`);
        continue;
      }
      const r = host === PC ? await writeLocal(text) : await sendRemote(host, text);
      const key = `${host}:${r.ok}:${r.out}`;
      if (r.ok || !quiet.has(key)) console.log(`[project-labels] ${host} ${labels.length} name(s) ok=${r.ok}${r.ok ? "" : ` ${r.out}`}`);
      if (!r.ok) {
        quiet.add(key);
        continue;
      }
      sent.set(host, text);
      if (labels.length && !known.has(host)) {
        known.add(host);
        changed = true;
      } else if (!labels.length && known.delete(host)) changed = true;
    }
    if (changed) await writeSentHosts([...known]);
  };

  // 저장 한 번에 감시 알림이 여러 번 오고, 서버에 보내는 데 몇 초 걸린다 — 한 차례씩만 돌리고 그사이 온 알림은 한 번으로 모은다
  const kick = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          again = false;
          await round();
        } while (again && !stopped);
      } catch (error) {
        console.log(`[project-labels] error ${String(error)}`);
      } finally {
        running = false;
      }
    })();
  };

  const off = onProjectsChange(kick);
  kick();
  return () => {
    stopped = true;
    off();
  };
}
