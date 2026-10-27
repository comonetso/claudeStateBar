import { appBundleId } from "../web";

// 받아쓰기는 늘 입력창에만(10-10 리규형님 결정 — "내가 먼저 확인하고 보낼 방법이 없고 바로 가 버린다").
// Paseo 는 녹음을 "넣고 보내기" 단추나 단축키(보내기·받아쓰기 확인·받아쓰기 켜고 끄기)로 끝내면 받아쓴 글을 바로 보낸다.
// 그 경로가 모두 입력창 모듈의 applyDictationTranscript(글, { autoSend, … }) 를 거치므로 그 함수만 감싸 autoSend 를 끈다.
// 모듈 번호는 판마다 다르다 — 모르는 판이면 손대지 않아 Paseo 원래 동작 그대로(로그 "off").
const DICTATION_MODULE: Record<string, number> = {
  // PC 앱·웹 0.11.1 — 내보내는 것 resolveActiveSendBehavior·applyDictationTranscript·runMessageInputKeyboardAction 등
  // (tmp/find_dictation_module_261010.cjs 로 확인. 0.11.0-beta.5 번호는 확인할 파일이 없어 넣지 않았다)
  "3a92a6be2c6767623cc9fa2aa410618e": 4737,
  // PC 앱 0.11.4(10-17) — 같은 번호·같은 내보내기(find_dictation_module_261010.cjs 로 0.11.1 과 대조)
  "8bce0495199b6764c1ef3c14273ac681": 4737,
  // PC 앱 0.12.0(10-20 자동 설치) — 번호만 4942 로 바뀌고 내보내기는 같다(find_dictation_module_261010.cjs 로 0.11.4 와 대조)
  "35dfa9cf1abfa4f304ac50232f52b8f4": 4942,
  // PC 앱 0.13.0(10-24 밤 자동 설치) — 번호만 4766 으로 바뀌고 내보내기 같음 · applyDictationTranscript 본문은 0.12.0 과 글자까지 같다
  "65a3b645223750cd0d8a429bfc7fa2a7": 4766,
  // PC 앱 0.13.2(10-27 저녁 자동 설치) — 같은 번호 4766 · 모듈 본문이 0.13.0 과 글자까지 같다(docs tests-261027/check_bundle_0132)
  "28c20820ac99aadc9968e445b53733c4": 4766,
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
