import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { SoundSettings } from "../shared/settings";
import { SOUND_UPLOAD_MAX, type SoundKind, type soundData } from "../shared/sound";
import { amplifyWav } from "./amplify";
import { defaultChime } from "./defaultChime";

// 구버전 자동 알림에는 정상 WAV 무음을 반환한다(PCM 16bit 표본 하나). 미리듣기는 실제 음원이다.
export const LEGACY_SILENT_WAV = "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==";

// 확장 core/sound.ts 의 DEFAULT_WAVS 와 같은 파일
const DEFAULT_WAVS: Record<SoundKind, { win32: string; darwin: string }> = {
  warning: { win32: "C:\\Windows\\Media\\Windows Notify.wav", darwin: "/System/Library/Sounds/Glass.aiff" },
  danger: { win32: "C:\\Windows\\Media\\Windows Critical Stop.wav", darwin: "/System/Library/Sounds/Glass.aiff" },
  completion: { win32: "C:\\Windows\\Media\\tada.wav", darwin: "/System/Library/Sounds/Hero.aiff" },
  question: { win32: "C:\\Windows\\Media\\Speech On.wav", darwin: "/System/Library/Sounds/Ping.aiff" },
  workflow: { win32: "C:\\Windows\\Media\\Ring06.wav", darwin: "/System/Library/Sounds/Funk.aiff" },
  // 압축 준비(10-15, 확장에는 없다) — 리규형님이 고른 캘린더 알림. 맥은 다른 넷과 겹치지 않는 Submarine(Claude 가 고름)
  compact: { win32: "C:\\Windows\\Media\\Windows Notify Calendar.wav", darwin: "/System/Library/Sounds/Submarine.aiff" },
};

/** 직원 데몬은 자기 화면의 소리 정본이다. 일반 서버는 계속 PC 공급자를 쓴다. */
export function isTeamDaemon(): boolean {
  return !!process.env.TEAM_UID || process.env.PASEO_HOME === "/team/paseo";
}

export function canCoordinateSound(): boolean {
  return process.platform === "win32" || (process.platform === "linux" && isTeamDaemon());
}

export function canPlayHere(): boolean {
  return process.platform === "win32" || process.platform === "darwin" || (process.platform === "linux" && isTeamDaemon());
}

/** 이 호스트의 시스템 소리 파일(설정 화면 선택 상자 — 10-12). 폴더를 못 읽으면 빈 목록 */
export async function listSystemSounds(): Promise<{ path: string; name: string }[]> {
  const dir = process.platform === "win32" ? "C:\\Windows\\Media" : process.platform === "darwin" ? "/System/Library/Sounds" : null;
  if (!dir) return [];
  const ext = process.platform === "win32" ? /\.wav$/i : /\.(aiff|wav|mp3)$/i;
  try {
    const names = (await readdir(dir)).filter((n) => ext.test(n));
    names.sort((a, b) => a.localeCompare(b));
    return names.map((n) => ({ path: join(dir, n), name: n.replace(ext, "") }));
  } catch {
    return [];
  }
}

/** 고른 내 파일을 플러그인 폴더에 저장(10-12). 이름 = <종류>--<원래 이름>. 예전 파일은 지우지 않는다 — 저장 전 설정이 아직 가리킬 수 있다 */
export async function saveUploadedSound(kind: SoundKind, name: string, base64: string): Promise<{ ok: true; path: string } | { ok: false; reason: "type" | "size" | "write" }> {
  const ext = /\.(wav|mp3|ogg)$/i.exec(name)?.[1]?.toLowerCase();
  if (!ext) return { ok: false, reason: "type" };
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > SOUND_UPLOAD_MAX) return { ok: false, reason: "size" };
  const safe = name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N} _.-]/gu, "_").trim().slice(0, 80) || "sound";
  const dir = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "claude-state-bar", "sounds");
  const path = join(dir, `${kind}--${safe}.${ext}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, bytes);
    return { ok: true, path };
  } catch {
    return { ok: false, reason: "write" };
  }
}

export function defaultSoundPath(kind: SoundKind): string {
  const entry = DEFAULT_WAVS[kind];
  return process.platform === "darwin" ? entry.darwin : entry.win32;
}

function mimeOf(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".aiff") || lower.endsWith(".aif")) return "audio/aiff";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "audio/wav";
}

// 종류마다 마지막 하나만 둔다. 경로·수정 시각·파일 크기·소리 크기가 같으면 다시 읽지 않는다.
// 미리 듣기(file·gain 을 직접 준 호출)는 담지 않는다.
const cache = new Map<SoundKind, { key: string; dataUrl: string }>();

export function createSoundReader(readSettings: () => Promise<SoundSettings>) {
  return async ({ kind, file, gain }: RpcInput<typeof soundData>) => {
    const settings = await readSettings();
    const chosenFile = (file ?? settings[kind].file).trim();
    // 상한은 설정과 같은 1000%(10-15 리규형님) — 그날 설정만 1000 으로 올리고 이 줄은 300 에 남아 300 을 넘겨도 안 커졌다(Codex 261015_224111)
    const gainPercent = Math.max(50, Math.min(1000, Math.round(gain ?? settings[kind].gain)));
    // 리눅스 직원 기본음은 메모리에서 만든다. 윈도우 음원 복사·서버 파일 설치가 필요 없다.
    // 직접 정한 파일이 없을 때만 — 잘못 정한 경로를 조용히 기본음으로 바꾸지는 않는다.
    if (!chosenFile && process.platform === "linux" && isTeamDaemon()) {
      const key = "generated|" + kind + "|" + gainPercent;
      const hit = cache.get(kind);
      const dataUrl = hit?.key === key ? hit.dataUrl : "data:audio/wav;base64," + amplifyWav(defaultChime(kind), gainPercent).toString("base64");
      if (file === undefined && gain === undefined) cache.set(kind, { key, dataUrl });
      return { dataUrl, path: "기본 알림음(생성)" };
    }
    const path = chosenFile || defaultSoundPath(kind);
    const info = await stat(path);
    const key = `${path}|${info.mtimeMs}|${info.size}|${gainPercent}`;
    const hit = cache.get(kind);
    if (hit?.key === key) return { dataUrl: hit.dataUrl, path };
    const bytes = await readFile(path);
    // WAV 만 키울 수 있다(확장과 같음). 다른 형식은 원래 크기로 나간다.
    const body = path.toLowerCase().endsWith(".wav") ? amplifyWav(bytes, gainPercent) : bytes;
    const dataUrl = `data:${mimeOf(path)};base64,${body.toString("base64")}`;
    if (file === undefined && gain === undefined) cache.set(kind, { key, dataUrl });
    return { dataUrl, path };
  };
}
