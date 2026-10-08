import type { RpcOutput } from "@getpaseo/plugin";
import type { extSettingsImport } from "../shared/extSettings";
import type { SoundKind } from "../shared/sound";
import type { SettingsText } from "./settingsI18n";

// VS Code 확장 설정 가져오기(리규형님 10-08 결정)의 화면 쪽 — 데몬이 돌려준 값으로 입력 칸(draft)만 채우고, 무엇을 가져왔고
// 무엇을 못 가져왔는지 알릴 글을 만든다. 저장은 하지 않는다(사용자가 [저장]을 눌러야 된다). React 없이 시험할 수 있게 따로 둔다.

export type ExtImportResult = RpcOutput<typeof extSettingsImport>;

/** 설정 화면 입력 칸 중 가져오기가 채우는 부분(settingsScreen 의 Draft 가 이 모양을 품는다) */
export type ImportableDraft = Record<SoundKind, { file: string; gain: string }> & {
  settleMs: string;
  warningPercent: string;
  dangerPercent: string;
  workflowBeep: boolean;
};

const KINDS: SoundKind[] = ["completion", "question", "warning", "danger", "workflow"];

/** 채울 칸 수 — 데몬이 스키마에 맞다고 돌려준 값의 개수 */
export function countImported(values: ExtImportResult["values"]): number {
  let n = 0;
  for (const kind of KINDS) {
    if (values[kind]?.file !== undefined) n++;
    if (values[kind]?.gain !== undefined) n++;
  }
  for (const key of ["settleMs", "warningPercent", "dangerPercent", "workflowBeep"] as const) if (values[key] !== undefined) n++;
  return n;
}

/** 가져온 값만 덮어쓴 새 입력 칸. 없는 값은 지금 칸 그대로 둔다 */
export function applyExtImport<D extends ImportableDraft>(draft: D, values: ExtImportResult["values"]): D {
  const next = { ...draft };
  for (const kind of KINDS) {
    const v = values[kind];
    if (!v) continue;
    next[kind] = {
      file: v.file !== undefined ? v.file : draft[kind].file,
      gain: v.gain !== undefined ? String(v.gain) : draft[kind].gain,
    } as D[typeof kind];
  }
  if (values.settleMs !== undefined) next.settleMs = String(values.settleMs);
  if (values.warningPercent !== undefined) next.warningPercent = String(values.warningPercent);
  if (values.dangerPercent !== undefined) next.dangerPercent = String(values.dangerPercent);
  if (values.workflowBeep !== undefined) next.workflowBeep = values.workflowBeep;
  return next;
}

/** 가져오기 결과 알림 — text 는 첫 줄(성공·없음·오류), details 는 "가져오지 못한 것" 아래 줄들 */
export function extImportReport(t: SettingsText, result: ExtImportResult): { text: string; bad: boolean; details: string[] } {
  if (result.status === "missing") return { text: t.importNoFile(result.path), bad: true, details: [] };
  if (result.status === "unreadable") return { text: t.importUnreadable(result.path, result.error ?? ""), bad: true, details: [] };
  const count = countImported(result.values);
  const details: string[] = [];
  for (const s of result.skipped) {
    const label = t.importFields[s.field];
    if (s.reason === "type") details.push(t.importSkippedType(label, s.value ?? ""));
    else if (s.reason === "range") details.push(t.importSkippedRange(label, s.value ?? ""));
  }
  const notSet = result.skipped.filter((s) => s.reason === "missing").map((s) => t.importFields[s.field]);
  if (notSet.length) details.push(t.importNotSet(notSet.join(t.listJoin)));
  return { text: count > 0 ? t.importDone(count) : t.importNothing, bad: false, details };
}
