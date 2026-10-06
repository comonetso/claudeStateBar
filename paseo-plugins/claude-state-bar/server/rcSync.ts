import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

// 웹·폰 원격(Remote Control)과 Paseo 대화 보관 상태 맞추기(리규형님 10-06 결정).
//   30초마다(결정) — ① 원격에서 보관됐다는 알림이 온 대화는 Paseo 에서도 보관
//                    ② 원격에서 "보관 → 꺼냄"으로 바뀐 대화는 Paseo 에서도 꺼냄
//                    ③ 열린 대화인데 Claude 가 꺼져 있으면 언제든 다시 띄워 원격에 붙임(결정)
// Paseo 는 원격을 모르고(Remote Control 미지원), 보관을 풀어도 말이 들어올 때까지 Claude 를 띄우지 않는다.
// 그래서 ③은 /cost 한 줄을 보내 Claude 를 이어서 띄우고, 뜰 때 중계가 Remote Control 을 켠다(리규형님 10-06 결정).
// 말 없이 띄우면(같은 권한 모드 다시 설정) 안 된다 — Paseo 는 Claude 출력을 읽는 루프(startQueryPump)를 말을 보낼 때만
// 켜서, 그 뒤 웹·폰에서 한 대화가 Paseo 화면에 하나도 안 나온다(10-06 실측: 업데이트로 데몬이 다시 뜬 뒤 웹 대화 미표시,
// Paseo 에서 한 마디 보내자 밀린 것까지 다 올라옴. 질문 창은 다른 통로라 그때도 떴다). /cost 는 Claude 가 /usage 로
// 바꿔 직접 처리해서 모델을 안 부르고 사용량 네 줄만 남는다(모르는 명령은 모델로 넘어가 토큰이 든다 — 10-06 시험).
// Paseo 가 말 없이 뜬 대화도 읽게 고치면 다시 모드 설정으로 돌린다.
// 대화 ↔ 원격 번호와 "원격에서 보관됨"은 중계(paseo-plugins/claude-rc-relay/relay.mjs)가 남기는 상태 파일에서 읽는다.
// 원격 보관 상태만으로는 사용자가 보관한 것과 Claude 가 꺼질 때 저절로 보관된 것을 가를 수 없어서(10-06 실측)
// ①은 중계가 받은 알림(code 4090)으로만, ②는 이전에 보관으로 본 세션이 활성으로 바뀐 것을 직접 봤을 때만 한다.
// ②의 "이전에 본 원격 상태"는 플러그인 데이터 파일에 남겨 플러그인·데몬이 다시 떠도 이어 본다(10-06 Codex 지적 — 메모리에만
// 두면 꺼져 있던 사이 원격에서 꺼낸 대화가 다시 뜬 뒤 처음부터 활성으로만 보여 영영 못 꺼냈다). "활성이면 꺼냄"으로 바꾸면 안 된다 —
// Paseo 에서만 보관한 대화는 원격이 활성으로 남아 있어서 되살아난다.

const TICK_MS = 30_000;
const PASEO_HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
const STATE_DIR = join(PASEO_HOME, "claude-rc-state");
const REMOTE_FILE = join(PASEO_HOME, "plugin-data", "claude-state-bar", "rc-sync-remote.json");
const AGENTS_DIR = join(PASEO_HOME, "agents");
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const API = "https://api.anthropic.com/v1/code/sessions";

interface RelayState {
  sessionId: string;
  relayPid?: number;
  startedAt?: string;
  cse?: string;
  remoteArchivedAt?: string;
  exitedAt?: string;
}

interface PaseoAgent {
  id: string;
  sessionId: string;
  archivedAt: string | null;
  modeId: string;
  title: string;
  running: boolean;
}

async function readJsonFiles(dir: string, depth: number): Promise<unknown[]> {
  const out: unknown[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...(await readJsonFiles(p, depth - 1)));
    else if (e.isFile() && e.name.endsWith(".json")) {
      try {
        out.push(JSON.parse(await readFile(p, "utf8")));
      } catch {
        /* 쓰는 중이거나 깨진 파일은 다음 차례에 */
      }
    }
  }
  return out;
}

/** Paseo 의 Claude 대화(제목·브랜치 이름 짓는 내부 실행은 뺀다) — 첫 말을 보내기 전이라 대화 번호가 없는 것도 뺀다 */
async function readAgents(): Promise<PaseoAgent[]> {
  const raw = (await readJsonFiles(AGENTS_DIR, 1)) as Record<string, any>[];
  const out: PaseoAgent[] = [];
  for (const a of raw) {
    if (!a || a.provider !== "claude" || a.internal === true || typeof a.id !== "string") continue;
    const sessionId = a.persistence?.sessionId ?? a.runtimeInfo?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) continue;
    out.push({
      id: a.id,
      sessionId,
      archivedAt: typeof a.archivedAt === "string" ? a.archivedAt : null,
      modeId: a.lastModeId || a.config?.modeId || "default",
      title: typeof a.title === "string" ? a.title : "",
      running: a.lastStatus === "running",
    });
  }
  return out;
}

async function readStates(): Promise<Map<string, RelayState>> {
  const map = new Map<string, RelayState>();
  for (const s of (await readJsonFiles(STATE_DIR, 0)) as RelayState[]) if (s && typeof s.sessionId === "string") map.set(s.sessionId, s);
  return map;
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 원격 목록(최근 100개) — 원격 번호 → 상태. 로그인 파일이 없거나 실패하면 null(이번 차례는 꺼내기 판정을 건너뛴다) */
async function readRemote(): Promise<Map<string, string> | null> {
  try {
    const cred = JSON.parse(await readFile(join(CLAUDE_DIR, ".credentials.json"), "utf8"));
    const token = cred?.claudeAiOauth?.accessToken;
    if (!token) return null;
    // 20초는 응답이 멈췄을 때 다음 차례를 막지 않게 하는 안전장치
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20_000);
    const r = await fetch(`${API}?limit=100`, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
      signal: ac.signal,
    }).finally(() => clearTimeout(t));
    if (r.status !== 200) return null;
    const j = (await r.json()) as { data?: { id: string; status: string }[]; sessions?: { id: string; status: string }[] };
    const map = new Map<string, string>();
    for (const s of j.data ?? j.sessions ?? []) if (s?.id) map.set(s.id, s.status);
    return map;
  } catch {
    return null;
  }
}

/** 지난 차례까지 본 원격 상태(원격 번호 → 상태). 파일이 없거나 깨졌으면 빈 것에서 시작한다 */
async function loadLastRemote(): Promise<Map<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(REMOTE_FILE, "utf8")) as Record<string, unknown>;
    return new Map(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return new Map();
  }
}

async function saveLastRemote(map: Map<string, string>): Promise<void> {
  await mkdir(dirname(REMOTE_FILE), { recursive: true });
  // 임시 파일에 다 쓴 뒤 바꿔 끼운다 — 쓰다 끊겨도 반쯤 쓴 파일이 남지 않는다
  const tmp = `${REMOTE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(Object.fromEntries(map)), "utf8");
  await rename(tmp, REMOTE_FILE);
}

const sameEntries = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** 이 기기의 Paseo 명령어 — 데몬과 같은 곳에 있다(콜어드민 서버는 데몬 PATH 에 없어서 실행 파일 위치로 찾는다) */
function findCli(): string | null {
  const dir = dirname(process.execPath);
  const win = process.platform === "win32";
  const near = win ? [join(dir, "resources", "bin", "paseo.cmd"), join(dir, "paseo.cmd")] : [join(dir, "paseo")];
  for (const c of near) if (existsSync(c)) return c;
  const names = win ? ["paseo.cmd", "paseo.exe"] : ["paseo"];
  for (const p of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    for (const n of names) if (p && existsSync(join(p, n))) return join(p, n);
  }
  return null;
}

function runCli(cli: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // Paseo 데몬이 켜 둔 값 — 남기면 명령어가 Electron 앱으로 뜨지 않는다
  const shell = cli.toLowerCase().endsWith(".cmd");
  return new Promise((resolve) => {
    // 60초는 명령어가 멈췄을 때 다음 차례를 막지 않게 하는 안전장치
    execFile(shell ? `"${cli}"` : cli, args, { env, shell, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim().replace(/\s+/g, " ").slice(0, 200) }),
    );
  });
}

export function startRcSync(): () => void {
  const cli = findCli();
  console.log(`[rc-sync] start cli=${cli ?? "없음"} home=${PASEO_HOME}`);
  if (!cli) return () => {};

  const handledArchive = new Set<string>(); // 대화 번호 + 원격 보관 시각
  let lastRemote: Map<string, string> | null = null; // 원격 번호 → 지난 차례에 본 상태(첫 차례에 파일에서 읽는다)
  const launched = new Map<string, string | null>(); // Paseo 대화 → 띄울 때 상태 파일의 시작 시각
  const quiet = new Set<string>(); // 같은 사정으로 같은 줄을 되풀이해 남기지 않게
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const [agents, states] = await Promise.all([readAgents(), readStates()]);

      // ① 원격에서 보관됨 → Paseo 도 보관
      for (const a of agents) {
        const s = states.get(a.sessionId);
        if (a.archivedAt || !s?.remoteArchivedAt) continue;
        const key = `${a.sessionId}@${s.remoteArchivedAt}`;
        if (handledArchive.has(key)) continue;
        const r = await runCli(cli, ["agent", "archive", a.id]);
        console.log(`[rc-sync] remote archived → paseo archive ${a.id} "${a.title}" ok=${r.ok}${r.ok ? "" : ` ${r.out}`}`);
        if (r.ok) {
          handledArchive.add(key);
          a.archivedAt = new Date().toISOString();
        }
      }

      // ② 원격에서 꺼냄(보관으로 봤던 세션이 활성이 됨) → Paseo 도 꺼냄(reload 가 보관 표시를 푼다, 10-05 실측)
      const archivedWithCse = agents.filter((a) => a.archivedAt && states.get(a.sessionId)?.cse);
      lastRemote ??= await loadLastRemote();
      // 보관된 대화가 없으면 원격을 묻지 않고 남은 기록만 비운다. 원격을 못 읽은 차례는 기록을 건드리지 않는다
      const remote = archivedWithCse.length > 0 ? await readRemote() : null;
      if (archivedWithCse.length === 0 || remote) {
        // Paseo 에서 보관 중인 대화 것만 남긴다 — 꺼냈다가 다시 보관한 대화가 오래된 "보관" 기록으로 꺼내지지 않게
        const seen = new Map<string, string>();
        for (const a of archivedWithCse) {
          const cse = states.get(a.sessionId)!.cse!;
          const now = remote!.get(cse);
          const before = lastRemote.get(cse);
          if (now ?? before) seen.set(cse, (now ?? before)!);
          if (before !== "archived" || now !== "active") continue;
          const r = await runCli(cli, ["agent", "reload", a.id]);
          console.log(`[rc-sync] remote unarchived → paseo unarchive ${a.id} "${a.title}" ok=${r.ok}${r.ok ? "" : ` ${r.out}`}`);
          if (r.ok) a.archivedAt = null;
        }
        if (!sameEntries(seen, lastRemote)) {
          lastRemote = seen;
          await saveLastRemote(seen).catch((e) => console.log(`[rc-sync] remote state save failed: ${(e as Error).message}`));
        }
      }

      // ③ 열린 대화인데 Claude 가 꺼져 있음 → /cost 한 줄을 보내 띄운다(머리 설명 — 말 없이 띄우면 웹 대화가 Paseo 에 안 보인다)
      for (const a of agents) {
        // 턴이 돌고 있으면 Claude 는 떠 있다 — 상태 파일이 없는 옛 중계로 떠 있어도 돌고 있는 중에 말을 넣지 않는다
        if (a.archivedAt || a.running) continue;
        const s = states.get(a.sessionId);
        if (s && !s.exitedAt && pidAlive(s.relayPid)) {
          launched.delete(a.id);
          continue;
        }
        const mark = s?.startedAt ?? null;
        if (launched.has(a.id) && launched.get(a.id) === mark) {
          // 띄웠는데 새 실행 기록이 안 생겼다 — 옛 중계로 떠 있는 대화 등. 기록이 바뀔 때까지 건드리지 않는다
          const q = `stuck:${a.id}:${mark}`;
          if (!quiet.has(q)) {
            quiet.add(q);
            console.log(`[rc-sync] ${a.id} "${a.title}" — 띄운 뒤 중계 기록이 없음, 기록이 바뀔 때까지 대기`);
          }
          continue;
        }
        const r = await runCli(cli, ["agent", "send", a.id, "/cost", "--no-wait"]);
        console.log(`[rc-sync] claude not running → start ${a.id} "${a.title}" via /cost ok=${r.ok}${r.ok ? "" : ` ${r.out}`}`);
        if (r.ok) launched.set(a.id, mark);
      }
    } catch (e) {
      console.log(`[rc-sync] tick failed: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(timer);
}
