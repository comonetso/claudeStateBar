import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type GoogleKeys = { gemini?: string; tts?: string };
let cachedPath = "";
let cachedVersion = "";
let cachedKeys: GoogleKeys = {};

/** 키는 이 데몬의 파일에서만 읽는다. 파일이 없어지거나 읽히지 않으면 이전 키도 버린다. */
export function readGoogleKeys(): GoogleKeys {
  const file = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-state-bar", "google.env");
  try {
    const stat = statSync(file);
    const version = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
    if (file === cachedPath && version === cachedVersion) return { ...cachedKeys };
    const keys: GoogleKeys = {};
    for (const line of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?(GOOGLE_GEMINI_KEY|GOOGLE_TTS_KEY)\s*=\s*(.*?)\s*$/.exec(line);
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
