import { appBundleId } from "./web";

// 받아쓰기는 늘 입력창에만(10-10 리규형님 결정 — "내가 먼저 확인하고 보낼 방법이 없고 바로 가 버린다").
// Paseo 는 녹음을 "넣고 보내기" 단추나 단축키(보내기·받아쓰기 확인·받아쓰기 켜고 끄기)로 끝내면 받아쓴 글을 바로 보낸다.
// 그 경로가 모두 입력창 모듈의 applyDictationTranscript(글, { autoSend, … }) 를 거치므로 그 함수만 감싸 autoSend 를 끈다.
// 모듈 번호는 판마다 다르다 — 모르는 판이면 손대지 않아 Paseo 원래 동작 그대로(로그 "off").
const DICTATION_MODULE: Record<string, number> = {
  // PC 앱·웹 0.11.1 — 내보내는 것 resolveActiveSendBehavior·applyDictationTranscript·runMessageInputKeyboardAction 등
  // (tmp/find_dictation_module_261010.cjs 로 확인. 0.11.0-beta.5 번호는 확인할 파일이 없어 넣지 않았다)
  "3a92a6be2c6767623cc9fa2aa410618e": 4737,
};
// 감싼 함수에 원본을 달아 둔다 — 플러그인이 다시 읽혀 같은 페이지에 옛 판이 남아 있어도 원본을 한 번만 감싼다
const ORIGINAL = "__claudeStateBar_originalApplyDictation";

type Apply = ((text: string, options: Record<string, unknown>) => unknown) & { [ORIGINAL]?: Apply };

export function startDictationInsertOnly(log: (message: string) => void): () => void {
  // 웹이 아니면(네이티브 앱) 판 번호가 없어 아래에서 꺼진다
  const bundle = appBundleId();
  const id = bundle ? DICTATION_MODULE[bundle] : undefined;
  const require = (globalThis as { __r?: (id: number) => unknown }).__r;
  if (!id || typeof require !== "function") {
    log(`dictation insert-only: off (bundle ${bundle ?? "none"})`);
    return () => {};
  }
  let mod: Record<string, unknown>;
  try {
    mod = require(id) as Record<string, unknown>;
  } catch (error) {
    log(`dictation insert-only: off (load ${String(error)})`);
    return () => {};
  }
  const current = mod?.applyDictationTranscript as Apply | undefined;
  if (typeof current !== "function") {
    log("dictation insert-only: off (no export)");
    return () => {};
  }
  const original = current[ORIGINAL] ?? current;
  const wrapped: Apply = (text, options) => original(text, { ...options, autoSend: false });
  wrapped[ORIGINAL] = original;
  try {
    mod.applyDictationTranscript = wrapped;
  } catch {
    /* 읽기 전용이면 아래에서 걸린다 */
  }
  if (mod.applyDictationTranscript !== wrapped) {
    log("dictation insert-only: off (not writable)");
    return () => {};
  }
  log("dictation insert-only: on");
  return () => {
    if (mod.applyDictationTranscript === wrapped) mod.applyDictationTranscript = original;
  };
}
