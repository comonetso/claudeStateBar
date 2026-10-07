import { readFile, stat } from "node:fs/promises";
import type { RpcInput } from "@getpaseo/plugin";
import type { SoundSettings } from "../shared/settings";
import type { SoundKind, soundData } from "../shared/sound";
import { amplifyWav } from "./amplify";

// 구버전 자동 알림에는 정상 WAV 무음을 반환한다(PCM 16bit 표본 하나). 미리듣기는 실제 음원이다.
export const LEGACY_SILENT_WAV = "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==";

// 확장 core/sound.ts 의 DEFAULT_WAVS 와 같은 파일
const DEFAULT_WAVS: Record<SoundKind, { win32: string; darwin: string }> = {
  warning: { win32: "C:\\Windows\\Media\\Windows Notify.wav", darwin: "/System/Library/Sounds/Glass.aiff" },
  danger: { win32: "C:\\Windows\\Media\\Windows Critical Stop.wav", darwin: "/System/Library/Sounds/Glass.aiff" },
  completion: { win32: "C:\\Windows\\Media\\tada.wav", darwin: "/System/Library/Sounds/Hero.aiff" },
  question: { win32: "C:\\Windows\\Media\\Speech On.wav", darwin: "/System/Library/Sounds/Ping.aiff" },
  workflow: { win32: "C:\\Windows\\Media\\Ring06.wav", darwin: "/System/Library/Sounds/Funk.aiff" },
};

export function canPlayHere(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
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
    const path = chosenFile || defaultSoundPath(kind);
    const gainPercent = Math.max(50, Math.min(300, Math.round(gain ?? settings[kind].gain)));
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
