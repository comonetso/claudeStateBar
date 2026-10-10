import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectHosts } from "./projectsEdit";
import { SAFE_HOST, sshExe } from "./projectLabels";

// 팀원 관리 시험판(10-11) — 직원에게 줄 스킬·명령어 목록.
// 리규형님 10-11: "command 도 나와야 돼" · "Paseo 및 Claude 전용 스킬은 로드할 필요 없잖아" · "서버 특화 스킬은 내가 추가하고 서버에서
// 직접 복사해 주면 되는 거지?" · "서버 특화 커맨드가 있어" → 고를 목록은 고른 서버의 ~/.claude 에서 SSH 로 읽는다(복사도 그 서버에서).
// PC 목록은 "이 서버에만 있음" 표시를 위한 비교용.
// 빼는 것(PC·서버 같은 기준): Paseo 가 깐 스킬(.paseo-managed-files.json 표식) · Anthropic 공식 스킬(LICENSE 에 Anthropic) ·
// SKILL.md 없는 폴더(Claude 앱 동기화 칸 synced 등 — 스킬이 아니다). 명령어는 commands/<이름>.md, 하위 폴더 한 단계는 "폴더:이름".

type Item = { kind: "skill" | "command"; name: string; description: string };

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

function descriptionOf(text: string): string {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!head) return "";
  const line = /^description:\s*(.*)$/m.exec(head[1]);
  if (!line) return "";
  return line[1].replace(/^["']|["']$/g, "").replace(/\t/g, " ").trim();
}

const exists = (p: string) => stat(p).then(() => true, () => false);

async function isVendorSkill(dir: string): Promise<boolean> {
  if (await exists(join(dir, ".paseo-managed-files.json"))) return true;
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files.filter((n) => /^license/i.test(n))) {
    if (/anthropic/i.test(await readFile(join(dir, f), "utf8").catch(() => ""))) return true;
  }
  return false;
}

async function localSkills(): Promise<Item[]> {
  const root = join(CLAUDE_DIR, "skills");
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: Item[] = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const dir = join(root, d.name);
    const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => null);
    if (text === null || (await isVendorSkill(dir))) continue;
    out.push({ kind: "skill", name: d.name, description: descriptionOf(text) });
  }
  return out;
}

async function localCommands(dir = join(CLAUDE_DIR, "commands"), prefix = ""): Promise<Item[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: Item[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory() && !prefix) out.push(...(await localCommands(join(dir, e.name), `${e.name}:`)));
    else if (e.isFile() && e.name.endsWith(".md"))
      out.push({ kind: "command", name: prefix + e.name.slice(0, -3), description: descriptionOf(await readFile(join(dir, e.name), "utf8").catch(() => "")) });
  }
  return out;
}

const byName = (a: Item, b: Item) => a.name.localeCompare(b.name);

/** 이 기기(PC) 글로벌 스킬·명령어 */
export async function listGlobalSkills(): Promise<{ skills: Item[] }> {
  const [skills, commands] = await Promise.all([localSkills(), localCommands()]);
  return { skills: [...skills, ...commands].sort(byName) };
}

// 서버에서 도는 같은 기준의 목록 뽑기 — 줄마다 "종류<탭>이름<탭>설명". node 가 PATH 에 없는 서버(nvm)가 있어 bash·awk 로.
export const REMOTE_LIST = [
  "cd ~/.claude 2>/dev/null || exit 0",
  "desc() { tr -d '\\r' < \"$1\" 2>/dev/null | awk 'NR==1{if($0!=\"---\")exit;next} $0==\"---\"{exit} /^description:/{sub(/^description:[ \\t]*/,\"\");gsub(/\\t/,\" \");print;exit}' | sed -E \"s/^[\\\"']//; s/[\\\"']$//\"; }",
  "for d in skills/*/; do",
  "  d=${d%/}; n=${d#skills/}",
  "  [ -f \"$d/SKILL.md\" ] || continue",
  "  [ -e \"$d/.paseo-managed-files.json\" ] && continue",
  "  grep -qis anthropic \"$d\"/[Ll][Ii][Cc][Ee][Nn][Ss][Ee]* 2>/dev/null && continue",
  "  printf 'skill\\t%s\\t%s\\n' \"$n\" \"$(desc \"$d/SKILL.md\")\"",
  "done",
  "for f in commands/*.md commands/*/*.md; do",
  "  [ -f \"$f\" ] || continue",
  "  n=${f#commands/}; n=${n%.md}; n=${n//\\//:}",
  "  printf 'command\\t%s\\t%s\\n' \"$n\" \"$(desc \"$f\")\"",
  "done",
].join("\n");

export function parseRemoteList(stdout: string): Item[] {
  const out: Item[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [kind, name, ...rest] = line.split("\t");
    if ((kind !== "skill" && kind !== "command") || !name) continue;
    out.push({ kind, name, description: rest.join(" ").trim() });
  }
  return out.sort(byName);
}

/** 서버 한 대의 글로벌 스킬·명령어(SSH). 목록의 SSH 별칭만 받는다 — 입력 글자가 ssh 옵션으로 읽히지 않게 */
export async function listServerSkills(host: string): Promise<{ skills: Item[]; error: string | null }> {
  if (!SAFE_HOST.test(host) || !(await projectHosts()).hosts.includes(host)) return { skills: [], error: "SSH 설정에 없는 서버입니다" };
  const b64 = Buffer.from(REMOTE_LIST, "utf8").toString("base64");
  // 스크립트는 base64 로 명령 인자에 싣는다 — 이 PC 의 ssh 는 파이프 입력의 끝을 못 알린다(09-14). -n 으로 입력도 닫는다
  return new Promise((resolve) => {
    execFile(
      sshExe(),
      ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, `printf %s '${b64}' | base64 -d | bash`],
      { timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const why = `${stderr}`.replace(/\*\*[^\n]*\n?/g, "").trim().replace(/\s+/g, " ").slice(0, 160);
          return resolve({ skills: [], error: `서버에서 읽지 못했습니다${why ? ` — ${why}` : ""}` });
        }
        resolve({ skills: parseRemoteList(`${stdout}`), error: null });
      },
    );
  });
}
