import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type GoogleKeys = { gemini?: string; tts?: string };
let cachedPath = "";
let cachedVersion = "";
let cachedKeys: GoogleKeys = {};

const KEY_LINE = /^\s*(?:export\s+)?(GOOGLE_GEMINI_KEY|GOOGLE_TTS_KEY)\s*=\s*(.*?)\s*$/;
const ENV_NAMES = { gemini: "GOOGLE_GEMINI_KEY", tts: "GOOGLE_TTS_KEY" } as const;

/** 이 데몬의 키 파일 — ~/.paseo/claude-state-bar/google.env(PASEO_HOME 이 있으면 그 아래) */
export function googleKeysFile(): string {
  return join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-state-bar", "google.env");
}

/** 키는 이 데몬의 파일에서만 읽는다. 파일이 없어지거나 읽히지 않으면 이전 키도 버린다. */
export function readGoogleKeys(): GoogleKeys {
  const file = googleKeysFile();
  try {
    const stat = statSync(file);
    const version = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
    if (file === cachedPath && version === cachedVersion) return { ...cachedKeys };
    const keys: GoogleKeys = {};
    for (const line of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const match = KEY_LINE.exec(line);
      if (!match) continue;
      let value = match[2];
      if (value.startsWith('"') || value.startsWith("'")) {
        const end = value.indexOf(value[0], 1);
        if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) continue;
        value = value.slice(1, end).trim();
      } else {
        value = value.replace(/\s+#.*$/, "").trim();
      }
      keys[match[1] === "GOOGLE_GEMINI_KEY" ? "gemini" : "tts"] = value || undefined;
    }
    cachedPath = file;
    cachedVersion = version;
    cachedKeys = keys;
  } catch {
    cachedPath = file;
    cachedVersion = "";
    cachedKeys = {};
  }
  return { ...cachedKeys };
}

export function getGoogleStatus(): { translate: boolean; tts: boolean } {
  const keys = readGoogleKeys();
  return { translate: Boolean(keys.gemini), tts: Boolean(keys.tts) };
}

/** 키 파일 한 줄에 그대로 쓸 수 있는 글인가 — 빈칸·따옴표·#·역슬래시·제어 문자가 있으면 위 읽기 규칙이 다르게 읽는다 */
export function isWritableKey(value: string): boolean {
  return value.length > 0 && !/[\s"'#\\\u0000-\u001f\u007f]/.test(value);
}

/**
 * 설정 화면 "번역·읽기" 칸에서 넣은 키를 쓴다(리규형님 10-08 결정: 키는 지금처럼 이 파일에만). 넣은 키만 바꾸고 파일의 다른 줄
 * (주석·다른 값)은 그대로 둔다. 같은 키 줄이 여럿이면 모두 새 값으로(읽기는 마지막 줄을 쓰므로 어느 줄이 남아도 같은 값),
 * 없으면 끝에 한 줄 붙인다. 원래 파일의 줄바꿈(CRLF/LF)·앞머리 표식(BOM)·export 머리는 지킨다.
 * 임시 파일에 다 쓴 뒤 바꿔 넣는다(쓰다 끊겨도 반쯤 쓴 파일이 남지 않게). 유닉스에서는 주인만 읽게(600) 둔다.
 * 🔴 키 값은 어디에도 기록하지 않는다 — 부르는 쪽도 로그에 남기지 않는다.
 */
export function writeGoogleKeys(patch: { gemini?: string; tts?: string }): void {
  const file = googleKeysFile();
  let original = "";
  try {
    original = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? original.slice(1) : original;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.length ? body.split(/\r?\n/) : [];
  // 끝 줄바꿈으로 생긴 마지막 빈 조각은 붙일 자리 계산에서 빼 두었다가 다시 붙인다
  const trailing = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  for (const field of ["gemini", "tts"] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    const name = ENV_NAMES[field];
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const match = KEY_LINE.exec(lines[i]);
      if (!match || match[1] !== name) continue;
      found = true;
      const head = /^\s*export\s+/.test(lines[i]) ? "export " : "";
      lines[i] = `${head}${name}=${value}`;
    }
    if (!found) lines.push(`${name}=${value}`);
  }
  const text = bom + lines.join(eol) + eol;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    try {
      if (process.platform !== "win32") chmodSync(tmp, 0o600);
    } catch {
      /* 권한을 못 바꿔도 쓰기는 이어 간다 */
    }
    renameSync(tmp, file);
  } catch (error) {
    // 키가 든 임시 파일을 남기지 않는다
    try {
      unlinkSync(tmp);
    } catch {
      /* 이미 없으면 그만 */
    }
    throw error;
  }
}
