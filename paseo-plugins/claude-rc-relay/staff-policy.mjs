// 직원(팀원) Claude 인자 고치기 — relay.mjs 가 직원 데몬일 때 부른다(10-25 리규형님 결정).
// 팀원은 리규형님과 같은 권한이다. 다만 리규형님은 bypass 로 쓰며 Claude 의 실수(중요 파일 삭제·위험한 명령)를 막으려고 서버 root 설정에
// 막기(deny)·묻기(ask) 목록을 넣어 두었다 — 팀원 Claude 도 그 목록에 똑같이 걸리고, bypass·auto 모드는 못 쓴다(위험한 일은 팀원에게 매번 허가).
// 프로젝트 밖으로는 못 나간다 — 작업 폴더 밖 읽기를 막는다(쓰기는 default 모드라 폴더 밖이면 이미 매번 허가).
// 목록은 팀원 도구(ctl.py managed_sync)가 root 설정에서 뽑아 울타리 안 /etc/claude-code/managed-settings.json 에 둔다. 그 파일은 관리 설정
// 자리지만 회사 공용 계정은 claude.ai 쪽 조직 설정에 밀려 Claude 가 건너뛴다(10-25 콜어드민 실측) — 그래서 명령줄 설정(--settings)으로 넣는다.
// Paseo 가 이미 --settings {"fastMode":false} 를 넘기므로 그 값에 합쳐 하나로 넘긴다(둘을 넘기면 하나가 덮인다)
// 10-25 밤: 작업 폴더 밖 읽기 막기는 파일 도구만 거절하고 셸의 cat·cd 는 허락 창이라(공식 문서) — 셸 명령·쓰기 도구는 훅(staff-guard.mjs)이
// 프로젝트 밖이면 거절한다(리규형님 버튼 "훅으로 셸 명령 검사" · 시스템 점검은 읽기만 · 임시 폴더 열기 · 쓰기 도구도 거절).
// 팀원 홈(스킬·명령어 고치기, 10-20)과 임시 폴더는 추가 작업 폴더로 넣어 파일 도구로도 열린다
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMP_DIRS } from "./staff-guard.mjs";

export const STAFF_POLICY_FILE = "/etc/claude-code/managed-settings.json";
export const GUARD_FILE = join(dirname(fileURLToPath(import.meta.url)), "staff-guard.mjs");
/** 검사기가 보는 도구 — 셸 명령(Bash·Monitor)과 파일 쓰기 */
export const GUARD_MATCHER = "Bash|Monitor|Edit|Write|MultiEdit|NotebookEdit";
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** 훅 명령 — 셸이 실행하므로 인자마다 작은따옴표로 감싼다 */
export function guardCommand({ node, guard = GUARD_FILE, roots, home }) {
  return [node, guard, ...roots.flatMap((r) => ["--root", r]), ...(home ? ["--home", home] : [])].map(sq).join(" ");
}
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** 팀원이 못 쓰는 시작 모드 — 매번 허가 없이 도는 둘 */
const lockedMode = (mode) => mode === "bypassPermissions" || mode === "auto";
const ruleList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 2000) : []);

/** 서버 root 의 막기·묻기 목록. 못 읽으면 null — 그래도 bypass·auto 금지는 넣는다(매번 허가라 목록 없이도 혼자 못 한다) */
export function readStaffRules(file = STAFF_POLICY_FILE) {
  try {
    const p = JSON.parse(readFileSync(file, "utf8")).permissions;
    return isObject(p) ? { deny: ruleList(p.deny), ask: ruleList(p.ask) } : null;
  } catch {
    return null;
  }
}

/**
 * 직원 Claude 인자 — 설정 출처는 user 하나(팀원 홈의 스킬·명령어·지침만, 10-20) · 시작 모드가 bypass·auto 면 default(매번 허락) ·
 * bypass 를 여는 인자는 뺀다 · --settings 하나에 bypass 금지·auto 금지·작업 폴더 밖 읽기 막기와 막기·묻기 목록을 합친다 ·
 * ctx.cwd(프로젝트 폴더)가 있으면 프로젝트 밖 검사 훅을 걸고 팀원 홈·임시 폴더를 추가 작업 폴더로 넣는다
 */
export function staffArgs(argv, rules, ctx = {}) {
  const out = [];
  let inherited = {};
  const addDirs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name) => (a === name ? argv[++i] ?? "" : a.slice(name.length + 1));
    if (a === "--add-dir") {
      out.push(a);
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) { addDirs.push(argv[++i]); out.push(argv[i]); }
      continue;
    }
    if (a.startsWith("--add-dir=")) { addDirs.push(a.slice(10)); out.push(a); continue; }
    if (a === "--setting-sources" || a.startsWith("--setting-sources=")) {
      value("--setting-sources");
      continue;
    }
    if (a === "--settings" || a.startsWith("--settings=")) {
      try {
        const j = JSON.parse(value("--settings"));
        if (isObject(j)) inherited = { ...inherited, ...j };
      } catch {
        // Paseo 는 JSON 만 넘긴다 — 다른 모양이면 버리고 아래 정책만 넣는다
      }
      continue;
    }
    if (a === "--permission-mode" || a.startsWith("--permission-mode=")) {
      const mode = value("--permission-mode");
      out.push(`--permission-mode=${lockedMode(mode) ? "default" : mode}`);
      continue;
    }
    if (a === "--allow-dangerously-skip-permissions" || a === "--dangerously-skip-permissions") continue;
    out.push(a);
  }
  const permissions = isObject(inherited.permissions) ? inherited.permissions : {};
  const home = typeof ctx.home === "string" && ctx.home.startsWith("/") ? ctx.home : "";
  const guarded = typeof ctx.cwd === "string" && ctx.cwd.startsWith("/") && typeof ctx.node === "string" && ctx.node.length > 0;
  const hooks = isObject(inherited.hooks) ? inherited.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const merged = {
    ...inherited,
    permissions: {
      ...permissions,
      ...(lockedMode(permissions.defaultMode) ? { defaultMode: "default" } : {}),
      deny: [...new Set([...ruleList(permissions.deny), ...(rules?.deny ?? [])])],
      ask: [...new Set([...ruleList(permissions.ask), ...(rules?.ask ?? [])])],
      disableBypassPermissionsMode: "disable",
      disableAutoMode: "disable",
      blockReadsOutsideWorkingDirectories: true,
      ...(guarded ? { additionalDirectories: [...new Set([...ruleList(permissions.additionalDirectories), ...(home ? [home] : []), ...TEMP_DIRS])] } : {}),
    },
    ...(guarded ? {
      disableAllHooks: false,
      hooks: {
        ...hooks,
        PreToolUse: [...preToolUse, {
          matcher: GUARD_MATCHER,
          hooks: [{ type: "command", command: guardCommand({ node: ctx.node, roots: [ctx.cwd, ...addDirs], home }) }],
        }],
      },
    } : {}),
  };
  return [...out, "--setting-sources=user", "--settings", JSON.stringify(merged)];
}
