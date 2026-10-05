import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { codexLogDir } from "../chime/scan";

// 복사본: VS Code 확장 src/providers/codexRescue/usageFile.ts 의 parseUsage(2026-10-05). 확장 쪽을 고치면 여기도.
// codex_rescue 1.17.3+ 가 정리를 마칠 때마다 <저장소>/docs/codex_rescue/.log/_usage.json 에 적는 기록 용량을 읽기만 한다.
// 직접 재지 않는다(리규형님 결정: 정리는 플러그인이 한다 — VS Code 없이 쓰는 사람을 위해).
//   { "schema": 1, "computed_at": "<ISO>", "items": { "scratch"|"log"|"trash"|"codex": { "bytes": n, "count": n } },
//     "clean": { "script": "<…/cleanup-logs.mjs>", "dir": "<root>/docs/codex_rescue" } }

export const CLEAN_ITEMS = ["scratch", "log", "trash", "codex"] as const;
export type CleanItem = (typeof CLEAN_ITEMS)[number];

export type UsageRead =
  | { state: "ok"; computedAt: number; items: { key: CleanItem; bytes: number; count: number }[] }
  | { state: "missing" }
  | { state: "broken"; why: string };

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/)/;

/** 계약에서 벗어난 것은 broken — 화면은 missing 과 똑같이 다룬다 */
export function parseUsage(text: string): UsageRead {
  const broken = (why: string): UsageRead => ({ state: "broken", why });
  let j: any;
  try {
    j = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return broken("json");
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return broken("object");
  if (j.schema !== 1) return broken("schema");
  const at = typeof j.computed_at === "string" ? Date.parse(j.computed_at) : NaN;
  if (!Number.isFinite(at)) return broken("computed_at");
  const items: { key: CleanItem; bytes: number; count: number }[] = [];
  for (const k of CLEAN_ITEMS) {
    const it = j.items && typeof j.items === "object" ? j.items[k] : undefined;
    if (!it || !isCount(it.bytes) || !isCount(it.count)) return broken(`items.${k}`);
    items.push({ key: k, bytes: it.bytes, count: it.count });
  }
  const script = j.clean && typeof j.clean === "object" ? j.clean.script : undefined;
  const dir = j.clean && typeof j.clean === "object" ? j.clean.dir : undefined;
  if (typeof script !== "string" || !ABSOLUTE.test(script)) return broken("clean.script");
  if (typeof dir !== "string" || !ABSOLUTE.test(dir)) return broken("clean.dir");
  return { state: "ok", computedAt: at, items };
}

export async function readUsage(cwd: string): Promise<UsageRead> {
  const logDir = await codexLogDir(cwd);
  if (!logDir) return { state: "missing" };
  let text: string;
  try {
    text = await readFile(join(logDir, "_usage.json"), "utf8");
  } catch {
    return { state: "missing" };
  }
  return parseUsage(text);
}
