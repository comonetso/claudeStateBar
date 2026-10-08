import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcOutput } from "@getpaseo/plugin";
import { settingsSchema } from "../shared/settings";
import type { ExtImportField, extSettingsImport } from "../shared/extSettings";

// VS Code 확장 설정 가져오기(리규형님 10-08 결정) — 이 기기 VS Code 사용자 설정 파일에서 확장 claudeContextBar.* 값을 읽어
// 플러그인 소리 설정 칸에 맞는 것만 돌려준다. 파일은 읽기만 한다(고치지 않는다). 저장은 화면에서 사용자가 [저장]을 눌러야 된다.
// 범위·형식 판정은 플러그인 스키마(shared/settings settingsSchema)를 그대로 쓴다 — 확장 정의(package.json
// contributes.configuration)와 대조: 소리 크기 50~300·대기 100~5000 은 같고, 경고·위험 기준은 확장에 범위가 없어 플러그인
// 1~100 에 맞는 것만 받는다. 크기·대기는 플러그인이 정수만 받는다(확장은 소수도 받아 반올림해 쓴다) — 소수는 채우지 않는다.

type ImportResult = RpcOutput<typeof extSettingsImport>;
type Skipped = ImportResult["skipped"][number];
type SoundKey = "completion" | "question" | "warning" | "danger" | "workflow";

// 복사본: 같은 플러그인 server/projects.ts vscodeUserDir(그 파일은 내보내지 않아 여기 둔다 — 고치면 둘 다)
function vscodeUserDir(): string {
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Code", "User");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Code", "User");
  return join(homedir(), ".config", "Code", "User");
}

export function vscodeSettingsPath(): string {
  return join(vscodeUserDir(), "settings.json");
}

/** 확장 키(claudeContextBar. 뒤) → 플러그인 칸. 순서는 설정 화면 순서(끝남·질문·경고·위험·따르릉 → 대기·기준·따르릉 켜기) */
const MAP: { ext: string; field: ExtImportField; type: "string" | "number" | "boolean" }[] = [
  { ext: "soundCompletion", field: "completion.file", type: "string" },
  { ext: "soundCompletionGain", field: "completion.gain", type: "number" },
  { ext: "soundQuestion", field: "question.file", type: "string" },
  { ext: "soundQuestionGain", field: "question.gain", type: "number" },
  { ext: "soundWarning", field: "warning.file", type: "string" },
  { ext: "soundWarningGain", field: "warning.gain", type: "number" },
  { ext: "soundDanger", field: "danger.file", type: "string" },
  { ext: "soundDangerGain", field: "danger.gain", type: "number" },
  { ext: "soundWorkflow", field: "workflow.file", type: "string" },
  { ext: "soundWorkflowGain", field: "workflow.gain", type: "number" },
  { ext: "completionBeepSettleMs", field: "settleMs", type: "number" },
  { ext: "warningThreshold", field: "warningPercent", type: "number" },
  { ext: "dangerThreshold", field: "dangerPercent", type: "number" },
  { ext: "workflowCompleteBeep", field: "workflowBeep", type: "boolean" },
];

/** 가져오지 못한 값을 화면에 보일 때 줄이는 길이(Claude 가 정한 값 — 근거 없음, 긴 경로·객체가 화면을 덮지 않게) */
const VALUE_PREVIEW_MAX = 80;

function preview(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > VALUE_PREVIEW_MAX ? `${text.slice(0, VALUE_PREVIEW_MAX - 1)}…` : text;
}

/**
 * VS Code 설정 파일(JSONC)을 해석한다 — 줄 주석·블록 주석·끝 쉼표를 문자열 밖에서만 걷어 내고 JSON.parse 에 맡긴다.
 * 문자열 안의 "//"(경로·주소)나 "," 는 건드리지 않는다. 형식이 깨졌으면 JSON.parse 오류가 그대로 나간다.
 */
export function parseJsonc(text: string): unknown {
  const src = text.replace(/^﻿/, "");
  // 1) 주석 걷기
  let noComments = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      noComments += ch;
      if (ch === "\\") {
        noComments += src[i + 1] ?? "";
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      noComments += ch;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      noComments += "\n";
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
      noComments += " ";
      continue;
    }
    noComments += ch;
  }
  // 2) 끝 쉼표 걷기(쉼표 뒤 공백을 지나 } 나 ] 가 오면 그 쉼표를 뺀다)
  let out = "";
  inString = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += noComments[i + 1] ?? "";
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (noComments[j] === "}" || noComments[j] === "]") continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

/** 한 칸 값이 플러그인 스키마에 맞는지 — 그 칸만 든 설정으로 검사한다(나머지 칸은 스키마 기본값이 채운다) */
function fitsSchema(field: ExtImportField, value: unknown): boolean {
  const [head, sub] = field.split(".") as [string, string | undefined];
  const probe = sub ? { [head]: { [sub]: value } } : { [head]: value };
  return settingsSchema.safeParse(probe).success;
}

/** 해석한 설정 객체에서 대응 값을 고른다(파일 읽기와 떼어 시험할 수 있게) */
export function pickExtSettings(raw: unknown): Pick<ImportResult, "values" | "skipped"> {
  const values: ImportResult["values"] = {};
  const skipped: Skipped[] = [];
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  for (const { ext, field, type } of MAP) {
    const key = `claudeContextBar.${ext}`;
    if (!(key in obj) || obj[key] === undefined) {
      skipped.push({ field, reason: "missing" });
      continue;
    }
    let value = obj[key];
    if (typeof value !== type || (type === "number" && !Number.isFinite(value as number))) {
      skipped.push({ field, reason: "type", value: preview(value) });
      continue;
    }
    // 확장도 경로를 쓸 때 앞뒤 공백을 걷는다(확장 core/sound.ts getSoundPath 의 trim)
    if (type === "string") value = (value as string).trim();
    if (!fitsSchema(field, value)) {
      skipped.push({ field, reason: "range", value: preview(value) });
      continue;
    }
    const [head, sub] = field.split(".") as [string, string | undefined];
    if (sub) {
      const k = head as SoundKey;
      values[k] = { ...(values[k] ?? {}), [sub]: value };
    } else {
      (values as Record<string, unknown>)[head] = value;
    }
  }
  return { values, skipped };
}

export async function importExtSettings(): Promise<ImportResult> {
  const path = vscodeSettingsPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { path, status: "missing", values: {}, skipped: [] };
    return { path, status: "unreadable", error: String(error), values: {}, skipped: [] };
  }
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch (error) {
    return { path, status: "unreadable", error: String(error), values: {}, skipped: [] };
  }
  const picked = pickExtSettings(raw);
  console.log(
    `[ext-settings] ${path}: imported ${MAP.length - picked.skipped.length}, skipped ${picked.skipped
      .filter((s) => s.reason !== "missing")
      .map((s) => `${s.field}(${s.reason})`)
      .join(" ") || "none"} (+${picked.skipped.filter((s) => s.reason === "missing").length} not set)`,
  );
  return { path, status: "ok", ...picked };
}
