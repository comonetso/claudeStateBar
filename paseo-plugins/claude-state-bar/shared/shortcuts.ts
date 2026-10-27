// 플러그인 단축키 한곳(10-16 리규형님 "플러그인 설정에 단축키 설정 — 모든 단축키 모아놓게" · 바꿀 수 있게 · 모든 단축키 ·
// 플러그인끼리 겹치면 막고 Paseo 와 겹치면 경고만). 바꾼 키는 플러그인 설정 `shortcuts`(단축키 번호 → 키)에 저장 — 없으면 기본.
// 키 = 누름 조합 "Ctrl+Alt+Shift+Meta+<KeyboardEvent.code>"(순서 고정). code 로 보는 까닭: Alt 와 같이 누르면 key 가 특수문자로
// 바뀐다(web.ts listenGlobalKey 주석) · 한글 자판에서도 같은 자리.

// 10-16 리규형님: 입력창 목록 키(Shift+Enter·Tab·Backspace)는 설정에서 빼고 고정 · 작업 현황 탭 넘기기(Ctrl+Tab)는 기능째 없앰
export type ShortcutId = "projects-toggle" | "pane-max" | "activity-open" | "read-pause" | "read-prev" | "read-next" | "read-slower" | "read-faster";

/** ctrlOptional: Ctrl 을 같이 눌러도 된다(10-15 리규형님 읽기 속도 "Ctrl 없이도 — Ctrl 과 함께도") */
export const SHORTCUTS: { id: ShortcutId; defaultCombo: string; ctrlOptional?: boolean }[] = [
  { id: "projects-toggle", defaultCombo: "Ctrl+Alt+Shift+KeyB" },
  { id: "pane-max", defaultCombo: "Ctrl+Alt+Shift+KeyF" },
  { id: "activity-open", defaultCombo: "Ctrl+Alt+Shift+KeyW" },
  // 10-17 리규형님: 기본 < > 는 읽는 동안 입력창에 < > 를 못 친다 → Ctrl+방향키 (Ctrl 없이 받는 규칙도 뺐다 — 방향키만 누르면 커서가 안 움직인다)
  // 10-28 리규형님 "일시정지/시작을 Ctrl+Space 로" — Windows 는 중국어 입력기에만 쓰고 Paseo 단축키엔 없다(Space 단독 마이크 키는 Ctrl 이 붙으면 다른 키)
  { id: "read-pause", defaultCombo: "Ctrl+Space" },
  // 10-27 리규형님 "다음 문단 알약을 방향키로 — 쓸데없는 건 빨리 건너뛰게" · 버튼 "자리 바꾸기": 좌우는 문단 앞뒤, 속도는 위(높이기)·아래(늦추기)로 옮김
  { id: "read-prev", defaultCombo: "Ctrl+ArrowLeft" },
  { id: "read-next", defaultCombo: "Ctrl+ArrowRight" },
  { id: "read-slower", defaultCombo: "Ctrl+ArrowDown" },
  { id: "read-faster", defaultCombo: "Ctrl+ArrowUp" },
];

/** 바꿀 수 없는 입력창 목록 키 — 다른 단축키로 고르면 입력창에서 목록 쓰기가 안 먹으니 막는다(client/web.ts listenComposer) */
export const RESERVED_COMBOS = ["Shift+Enter", "Tab", "Backspace"];

/** 입력창 목록 키를 고른 단축키 — 처음 하나(저장 막기) */
export function reservedConflict(table: Record<string, string>): ShortcutId | null {
  return SHORTCUTS.find((s) => RESERVED_COMBOS.includes(effectiveCombo(s.id, table)))?.id ?? null;
}

export type KeyLike = { code?: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };
type Combo = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; code: string };

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

export function parseCombo(text: string): Combo | null {
  const parts = text.split("+");
  const code = parts.pop() ?? "";
  if (!code || MODIFIER_CODES.test(code)) return null;
  const mods = new Set(parts);
  for (const m of mods) if (!["Ctrl", "Alt", "Shift", "Meta"].includes(m)) return null;
  return { ctrl: mods.has("Ctrl"), alt: mods.has("Alt"), shift: mods.has("Shift"), meta: mods.has("Meta"), code };
}

function comboText(c: Combo): string {
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.meta && "Meta", c.code].filter(Boolean).join("+");
}

/** 누른 키 → 조합 글. 조합 키만 눌렀으면 null */
export function comboOfKey(e: KeyLike): string | null {
  if (!e.code || MODIFIER_CODES.test(e.code)) return null;
  return comboText({ ctrl: !!e.ctrl, alt: !!e.alt, shift: !!e.shift, meta: !!e.meta, code: e.code });
}

const CODE_LABELS: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Minus: "-", Equal: "=", Backquote: "`", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Space: "Space",
};

/** 보이는 글 — "Ctrl+Alt+Shift+F" · Shift+쉼표는 "<" 처럼 Shift 없이 그 글자로 */
export function formatCombo(text: string): string {
  const c = parseCombo(text);
  if (!c) return text;
  if (c.shift && !c.ctrl && !c.alt && !c.meta && (c.code === "Comma" || c.code === "Period")) return c.code === "Comma" ? "<" : ">";
  const key = /^Key[A-Z]$/.test(c.code) ? c.code.slice(3) : /^Digit\d$/.test(c.code) ? c.code.slice(5) : (CODE_LABELS[c.code] ?? c.code);
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.meta && "Meta", key].filter(Boolean).join("+");
}

// ── 바꾼 키 읽기 — 화면 플러그인이 설정 읽는 함수를 넣어 둔다(같은 페이지 여러 호스트·옛 판이 같이 쓰므로 globalThis) ──
type Source = () => Record<string, string> | undefined;
const SOURCE_KEY = "__claudeStateBar_shortcutSource_v1";

export function setShortcutSource(source: Source): void {
  (globalThis as Record<string, unknown>)[SOURCE_KEY] = source;
}

function overrides(): Record<string, string> {
  try {
    const source = (globalThis as Record<string, unknown>)[SOURCE_KEY] as Source | undefined;
    return source?.() ?? {};
  } catch {
    return {};
  }
}

/** 10-27 자리 바꾸기 전 읽기 속도 키. 이 값이 저장돼 있으면 옛 배치이므로 새 처음 값을 쓴다 — PC 설정에 이 둘이 저장돼 있어
 *  속도가 계속 Ctrl+← → 에 남고 문단 키에 가려 속도를 바꿀 키가 없었다(10-27 ego 실측). 다른 키를 고르면 그 키는 그대로 쓴다 */
const RETIRED_COMBOS: Partial<Record<ShortcutId, string>> = { "read-slower": "Ctrl+ArrowLeft", "read-faster": "Ctrl+ArrowRight" };

/** 지금 쓰는 키 — 바꾼 값이 있고 읽을 수 있으면 그것, 아니면 기본 */
export function effectiveCombo(id: ShortcutId, table: Record<string, string> = overrides()): string {
  const def = SHORTCUTS.find((s) => s.id === id)!;
  const custom = table[id];
  return custom && custom !== RETIRED_COMBOS[id] && parseCombo(custom) ? custom : def.defaultCombo;
}

export function shortcutMatches(id: ShortcutId, e: KeyLike): boolean {
  const want = parseCombo(effectiveCombo(id));
  if (!want || e.code !== want.code) return false;
  if (!!e.alt !== want.alt || !!e.shift !== want.shift || !!e.meta !== want.meta) return false;
  if (!!e.ctrl === want.ctrl) return true;
  return !want.ctrl && !!e.ctrl && SHORTCUTS.find((s) => s.id === id)?.ctrlOptional === true;
}

/** 플러그인 단축키끼리 같은 키 — 처음 하나(저장 막기) */
export function pluginConflict(table: Record<string, string>): [ShortcutId, ShortcutId] | null {
  const seen = new Map<string, ShortcutId>();
  for (const s of SHORTCUTS) {
    const combo = effectiveCombo(s.id, table);
    const other = seen.get(combo);
    if (other) return [other, s.id];
    seen.set(combo, s.id);
  }
  return null;
}

// ── Paseo 단축키(겹침 경고용) — Paseo 0.11.2 PC 앱 화면 묶음(index-ba3ca584…)에서 맥 전용을 뺀 30개를 옮겼다(10-16).
// 묶음 안 항목 모양 {id, action, combo:"Alt+Shift+W", when:{desktop, mac, …}, help:{label}} · where = desktop(PC 앱만) / web(웹만) / both.
// Paseo 가 바뀌면 이 표는 낡는다 — 리규형님이 받아들인 한계("업데이트 뒤엔 경고가 안 뜰 수 있다").
// 사용자가 Paseo 에서 바꾼 키는 브라우저 저장소 "@paseo:keyboard-shortcut-overrides"(항목 id → 키, null = 끔)에서 그때그때 읽는다.
// 입력창 Shift+Tab 은 이 표 밖에서 Paseo 가 쓴다(web.ts listenComposer 주석, 10-07 실측).
const PASEO_SHORTCUTS: [id: string, combo: string, where: "desktop" | "web" | "both", label: string][] = [
  ["agent-new-ctrl-shift-o-non-mac", "Ctrl+O", "both", "Open project"],
  ["workspace-new-ctrl-n-non-mac", "Ctrl+N", "both", "New workspace"],
  ["worktree-archive-ctrl-shift-backspace-non-mac", "Ctrl+Shift+Backspace", "both", "Archive workspace"],
  ["workspace-pin-ctrl-shift-p-non-mac", "Ctrl+Shift+P", "both", "Pin chat"],
  ["workspace-tab-new-ctrl-t-non-mac", "Ctrl+T", "both", "New tab"],
  ["workspace-tab-target-agent-ctrl-shift-a-non-mac", "Ctrl+Shift+A", "both", "New agent"],
  ["workspace-tab-target-browser-ctrl-shift-b-non-mac", "Ctrl+Shift+B", "both", "New browser"],
  ["workspace-tab-target-changes-ctrl-shift-c-non-mac", "Ctrl+Shift+G", "both", "Changes"],
  ["workspace-tab-target-files-ctrl-shift-e-non-mac", "Ctrl+Shift+E", "both", "Files"],
  ["workspace-tab-close-current-ctrl-w-non-mac", "Ctrl+W", "desktop", "Close current tab"],
  ["workspace-tab-close-current-alt-shift-w-web", "Alt+Shift+W", "web", "Close current tab"],
  ["workspace-navigate-index-ctrl-digit-non-mac", "Ctrl+Digit", "desktop", "Jump to workspace"],
  ["workspace-navigate-index-alt-digit-web", "Alt+Digit", "web", "Jump to workspace"],
  ["workspace-tab-navigate-index-alt-digit-desktop", "Alt+Digit", "desktop", "Jump to tab"],
  ["workspace-tab-navigate-index-alt-shift-digit-web", "Alt+Shift+Digit", "web", "Jump to tab"],
  ["workspace-navigate-relative-ctrl-left-non-mac", "Ctrl+[", "desktop", "Previous workspace"],
  ["workspace-navigate-relative-ctrl-right-non-mac", "Ctrl+]", "desktop", "Next workspace"],
  ["workspace-navigate-relative-alt-left-web", "Alt+[", "web", "Previous workspace"],
  ["workspace-navigate-relative-alt-right-web", "Alt+]", "web", "Next workspace"],
  ["workspace-tab-navigate-relative-alt-shift-left", "Alt+Shift+[", "both", "Previous tab"],
  ["workspace-tab-navigate-relative-alt-shift-right", "Alt+Shift+]", "both", "Next tab"],
  ["workspace-terminal-new-ctrl-shift-t-non-mac", "Ctrl+Shift+T", "both", "New terminal"],
  ["sidebar-toggle-left-ctrl-period-non-mac", "Ctrl+B", "both", "Toggle left sidebar"],
  ["sidebar-toggle-right-ctrl-e-non-mac", "Ctrl+E", "both", "Toggle Explorer sidebar"],
  ["sidebar-toggle-right-ctrl-backquote", "Ctrl+`", "both", "sidebar.toggle.right"],
  ["sidebar-toggle-both-ctrl-period-non-mac", "Ctrl+.", "both", "Toggle both sidebars"],
  ["settings-toggle-ctrl-comma-non-mac", "Ctrl+,", "both", "Toggle settings"],
  ["view-toggle-focus-ctrl-shift-f-non-mac", "Ctrl+Shift+F", "both", "Toggle focus mode"],
  ["theme-cycle-ctrl-alt-t-non-mac", "Ctrl+Alt+T", "both", "Cycle theme"],
  ["agent-interrupt", "Escape", "both", "Interrupt agent"],
  ["composer-shift-tab", "Shift+Tab", "both", "Composer: Shift+Tab"],
];

const PASEO_KEYS: Record<string, string> = {
  "[": "BracketLeft", "]": "BracketRight", ".": "Period", ",": "Comma", "`": "Backquote", "/": "Slash", ";": "Semicolon",
  "'": "Quote", "\\": "Backslash", "-": "Minus", "=": "Equal", Esc: "Escape",
};

/** Paseo 조합("Ctrl+Shift+P"·"Alt+Digit") → 우리 조합. Digit 는 숫자 아무거나("Digit*") */
function fromPaseo(text: string): Combo | null {
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  const last = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => (p === "Cmd" || p === "Mod" ? "Ctrl" : p === "Control" ? "Ctrl" : p === "Option" ? "Alt" : p)));
  const code = /^[A-Za-z]$/.test(last) ? "Key" + last.toUpperCase() : /^\d$/.test(last) ? "Digit" + last : last === "Digit" ? "Digit*" : (PASEO_KEYS[last] ?? last);
  return { ctrl: mods.has("Ctrl"), alt: mods.has("Alt"), shift: mods.has("Shift"), meta: mods.has("Meta"), code };
}

function sameCombo(a: Combo, b: Combo): boolean {
  const codeOk = a.code === b.code || (b.code === "Digit*" && /^Digit\d$/.test(a.code)) || (a.code === "Digit*" && /^Digit\d$/.test(b.code));
  return codeOk && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta;
}

function paseoOverrides(): Record<string, string | null> {
  try {
    const store = (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage;
    const raw = store?.getItem("@paseo:keyboard-shortcut-overrides");
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return value && typeof value === "object" ? (value as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

/** 이 키와 겹치는 Paseo 단축키 설명들(where 붙임) — 경고만 한다 */
export function paseoConflicts(combo: string): { label: string; where: "desktop" | "web" | "both" }[] {
  const mine = parseCombo(combo);
  if (!mine) return [];
  const over = paseoOverrides();
  const out: { label: string; where: "desktop" | "web" | "both" }[] = [];
  for (const [id, def, where, label] of PASEO_SHORTCUTS) {
    const set = Object.prototype.hasOwnProperty.call(over, id) ? over[id] : def;
    if (set === null || set === "") continue;
    const theirs = fromPaseo((typeof set === "string" ? set : def).split(" ")[0]);
    if (theirs && sameCombo(mine, theirs) && !out.some((o) => o.label === label)) out.push({ label, where });
  }
  return out;
}
