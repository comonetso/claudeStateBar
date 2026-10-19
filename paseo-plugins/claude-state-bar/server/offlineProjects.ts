import { watchSafe } from "./watchSafe";
import { existsSync, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OFFLINE_HOST, OFFLINE_NOTICE, offlineCopySchema } from "../shared/offlineProjects";
import { listProjects, onProjectsChange, PROJECTS_FILE } from "./projects";
import { projectPins } from "./projectsPins";
import { projectOrders } from "./projectsOrder";
import { SAFE_HOST, sendRemoteFile } from "./projectLabels";
import { isTeamDaemon } from "./sound";

const NAME = "pc-offline-projects.json";
// sttHints/speech와 같은 SSH 목적지. 서버 정본(project-list/projects.json)과 별도 파일이다.
export const OFFLINE_COPY_FILE = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-state-bar", NAME);
export const usesOfflineCopy = () => process.platform !== "win32" && !isTeamDaemon();
export function assertProjectsWritable(): void {
  if (usesOfflineCopy() && existsSync(OFFLINE_COPY_FILE)) throw new Error(OFFLINE_NOTICE);
}
export async function readOfflineCopy() {
  if (!usesOfflineCopy() || !existsSync(OFFLINE_COPY_FILE)) return null;
  try {
    const copy = offlineCopySchema.parse(JSON.parse(await readFile(OFFLINE_COPY_FILE, "utf8")));
    return { copy, error: undefined };
  } catch { return { copy: null, error: "PC 프로젝트 사본을 읽지 못했습니다" }; }
}
export async function copiedProjects() {
  const value = await readOfflineCopy();
  if (!value) return null;
  return { source: OFFLINE_COPY_FILE, entries: value.copy?.entries ?? [], readOnly: true, error: value.error };
}
async function copyMtime(): Promise<number | null> {
  try { return (await stat(OFFLINE_COPY_FILE)).mtimeMs; } catch { return null; }
}
// server/projects.ts WAIT_MS와 동일: 기존 데몬 요청 한도 30초 안에서 응답한다.
const WAIT_MS = 25_000;
const waiters = new Set<() => void>();
let copyWatcher: FSWatcher | undefined;
export async function waitOfflineCopy(known?: number | null) {
  if (usesOfflineCopy() && !copyWatcher) {
    try { copyWatcher = watchSafe(dirname(OFFLINE_COPY_FILE), () => { for (const wake of [...waiters]) wake(); }, () => { copyWatcher = undefined; for (const wake of [...waiters]) wake(); }); } catch { /* 다음 요청에서 다시 */ }
  }
  if (known !== undefined && await copyMtime() === known) {
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
      const timer = setTimeout(done, WAIT_MS);
      waiters.add(done);
      // stat와 감시 등록 사이에 저장됐어도 다음 25초를 기다리지 않는다.
      void copyMtime().then(now => { if (now !== known) done(); });
    });
  }
  const value = await readOfflineCopy();
  return { eligible: !!value?.copy?.fallback && value.copy.recipient === OFFLINE_HOST, mtimeMs: await copyMtime() };
}
export function stopOfflineCopyWatch(): void {
  copyWatcher?.close(); copyWatcher = undefined;
  for (const wake of [...waiters]) wake();
}

export function startOfflineProjectsCopy(): () => void {
  // 직원 데몬은 기존 자기 정본을 그대로 쓴다. PC만 사본을 보낸다.
  if (process.platform !== "win32" || isTeamDaemon()) return () => {};
  let stopped = false, running = false, again = false;
  let orderWatcher: FSWatcher | undefined;
  let watchedFolder: string | undefined;
  const orderFolder = dirname(dirname(PROJECTS_FILE));
  const sent = new Map<string, string>();
  const round = async () => {
    const list = await listProjects();
    if (stopped || !list.source || list.error) return; // 깨진 정본으로 정상 사본을 지우지 않는다.
    const [pins, orders] = await Promise.all([projectPins(), projectOrders()]);
    if (stopped) return;
    const hosts = [...new Set(list.entries.map(e => e.host))].filter(host => host !== "PC" && SAFE_HOST.test(host));
    await Promise.all(hosts.map(async host => {
      const text = JSON.stringify({ recipient: host, fallback: host === OFFLINE_HOST, entries: list.entries, keys: pins.keys, groups: orders.groups }) + "\n";
      if (stopped || sent.get(host) === text) return;
      const result = await sendRemoteFile(host, "~/.paseo/claude-state-bar", NAME, text);
      if (result.ok) sent.set(host, text);
      else console.log("[offline-projects] " + host + " send failed");
    }));
  };
  const kick = () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    void (async () => {
      try {
        do { again = false; await round(); } while (again && !stopped);
      } catch { console.log("[offline-projects] copy failed"); }
      finally {
        running = false;
        if (!stopped) {
          // 최초 목록 이관으로 폴더가 생긴 뒤에도 감시를 붙인다.
          onProjectsChange(kick);
          if (!orderWatcher || watchedFolder !== orderFolder) {
            let folder = orderFolder;
            for (;;) {
              try {
                const target = folder;
                const watcher = watchSafe(target, (_event, file) => {
                  const name = file?.toString();
                  if (!name || target !== orderFolder || name === "project-list" || name === "project-pins.json" || name === "project-order.json") kick();
                }, () => { if (orderWatcher === watcher) { orderWatcher = undefined; watchedFolder = undefined; } });
                orderWatcher?.close(); orderWatcher = watcher; watchedFolder = target;
                break;
              } catch {
                const parent = dirname(folder);
                if (parent === folder) break;
                folder = parent; // 새 대기/재시도 시간을 만들지 않고 존재하는 상위 폴더 생성 알림을 받는다.
              }
            }
          }
        }
      }
    })();
  };
  const off = onProjectsChange(kick);
  kick(); // 데몬 시작 시 한 번, 실패한 대상은 다음 변경/시작 때만 다시(기존 이름표와 동일).
  return () => { stopped = true; off(); orderWatcher?.close(); };
}
