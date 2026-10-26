import { renameRetry, serializeFileWrite } from "../renameRetry";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultSpeechSettings, speechSchema, type SpeechLang, type SpeechSettings } from "../../shared/presentation/speech";
import { googleKeysFile } from "./googleKeys";
import { listProjects } from "../projects/projects";
import { SAFE_HOST, sendRemoteFile } from "../projects/projectLabels";

export function speechFile(): string { return join(dirname(googleKeysFile()), "speech.json"); }
/** 파일이 없을 때만 화면 언어 → ko. 저장된 값이 옛 RPC의 lang보다 우선한다. 깨진 파일은 다른 공급자로 넘기지 않는다. */
export function readSpeechSettings(lang: SpeechLang = "ko"): { settings: SpeechSettings; configured: boolean } {
  let raw: string;
  try { raw = readFileSync(speechFile(), "utf8").replace(/^\uFEFF/, ""); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: defaultSpeechSettings(lang), configured: false };
    throw new Error("음성 공급자 설정을 읽지 못했습니다");
  }
  const parsed = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  const checked = speechSchema.safeParse(parsed);
  if (!checked.success) throw new Error("음성 공급자 설정 형식 오류");
  return { settings: checked.data, configured: true };
}
export async function saveSpeechSettings(input: SpeechSettings) {
  const settings = speechSchema.parse(input);
  const text = JSON.stringify(settings, null, 2) + "\n";
  const file = speechFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await serializeFileWrite(file, async () => {
      mkdirSync(dirname(file), { recursive: true });
      try {
        writeFileSync(tmp, text, "utf8");
        await renameRetry(tmp, file);
      } catch (error) { try { unlinkSync(tmp); } catch { /* 이미 없음 */ } throw error; }
    });
  } catch {
    return { ok: false as const, reason: "write" as const };
  }
  // sttHints.ts와 같은 대상·같은 SSH 전달 함수. 키 파일은 보내지 않는다.
  const list = await listProjects();
  const servers = [...new Set(list.entries.map((e) => e.host))].filter((host) => host !== "PC" && SAFE_HOST.test(host));
  const hosts = await Promise.all(servers.map(async (host) => {
    try {
      const result = await sendRemoteFile(host, "~/.paseo/claude-state-bar", "speech.json", text);
      return { host, ok: result.ok };
    } catch { return { host, ok: false }; }
  }));
  return { ok: true as const, settings, hosts };
}
