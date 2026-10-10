export type Phase = "streaming" | "complete";
export type Paragraph = { src: string; done: boolean };
export type AudioFile = { base64: string; mimeType: string };
/** 번역 대상·읽기 음성 언어(10-08 — Paseo 언어 설정을 따른다, client/appLanguage uiLanguage) */
export type Lang = "ko" | "en";
export type ThinkingRpc = {
  translate(input: { texts: string[]; lang?: Lang }): Promise<{ translations: (string | null)[]; error?: string }>;
  synthesize(input: { text: string; lang?: Lang }): Promise<({ ok: true } & AudioFile) | { ok: false; error: string }>;
};
/** 읽기 시작 자리(10-08 생각 상자 선택 읽기) — index 번째 문단의, 화면에 보이던 글 안 offset 번째 글자부터 */
export type StartAt = { index: number; offset: number };
export type ThinkingAudio = {
  play(file: AudioFile, rate: number, ended: () => void, error: (reason: string) => void): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  stop(): void;
  setRate(rate: number): void;
};
/** 이 기기에 담아 둔 플러그인 번역(10-10, client/translationCache) — 원문 문단 그대로 찾는다. 없거나 못 쓰면 빈 결과 */
export type TranslationCache = {
  lookup(lang: Lang, texts: string[]): Promise<Map<string, string>>;
  store(lang: Lang, entries: [string, string][]): void;
};
export type ThinkingBoxState = {
  key: string;
  hostId: string;
  agentId: string;
  stamps: Set<number>;
  awaitingCompleteStamp?: boolean;
  text: string;
  phase: Phase;
  open: boolean;
  /** 본문 높이 제한을 풀어 스크롤 없이 전부 보이는가(리규형님 10-06 최대화·원복) */
  maximized: boolean;
  /**
   * 상자 글(\r 뺀 것)에서 Claude 의 말(마지막 생각 칸)이 시작되는 자리 — 데몬이 원본 기록으로 알려 준다(10-09,
   * shared/thinkingBoundary.ts). 있으면 상자·번역·읽기는 그 앞만 쓰고 뒤는 상자 아래 본문 글로 그린다. text 는 늘 전체 글이다
   * (같은 상자 알아보기·이어 받기가 전체 글로 맞춘다)
   */
  cut?: number | null;
  translate: boolean;
  /**
   * 원문 보기(10-10 리규형님 "번역본이면 원문으로, 원문이면 번역문으로") — 상자 화면이 원문을 따로 그린다(브라우저 번역 막음,
   * thinking.tsx). 보던 글(플러그인 번역·브라우저 번역기 글)은 지우지 않고 숨겨 두어 끄면 그대로 다시 보인다
   */
  original?: boolean;
  suspended: boolean;
  controls: boolean;
  error: string;
  translations: Map<string, string | null>;
  failures: Map<string, string>;
  pending: Set<string>;
  epoch: number;
  /** translations 를 어느 언어로 받았나 — Paseo 언어가 바뀌면 받은 번역을 버리고 새 언어로 다시 받는다(10-08) */
  translatedLang?: Lang;
  busy?: object;
  rpc?: ThinkingRpc;
  /**
   * index 번째 문단의 지금 화면 글(10-09 리규형님 "보이는 것을 읽어야 — 자동 번역기로 번역한 것을 그대로"). 브라우저 번역기가
   * 바꿔 놓았으면 바뀐 글이다. 없거나 null(폰·접힌 상자·아직 안 그려짐)이면 원문·플러그인 번역(shown)을 읽는다
   */
  screenText?: (index: number) => string | null;
  watch?: (update: (text: string, phase: Phase, stamp?: number) => void, error: (reason: string) => void) => () => void;
  unwatch?: () => void;
};
type Slot = { text: string; live: boolean; promise: Promise<AudioFile> };
/** 읽는 문단 뒤로 몇 문단까지 미리 합성할지(리규형님 10-07 결정 2문단 — 한 문단만 미리 하니 짧은 문단 뒤 긴 문단에서 합성이 못 따라가 끊겼다) */
const PREFETCH_AHEAD = 2;
type Run = {
  box: ThinkingBoxState;
  index: number;
  strict: boolean;
  paused: boolean;
  status: "loading" | "waiting" | "playing";
  generation: number;
  /** 지금 이 문단 소리를 준비·재생하는 작업의 표(pump) — 작업마다 새 객체라 끝난 작업이 다른 작업 표를 지우지 않는다 */
  pumping?: { generation: number };
  loaded: boolean;
  currentText?: string;
  startedAt: number;
  slots: Map<number, Slot>;
  /** 선택한 자리부터 읽기(10-08): index 문단이 시작할 때 화면 글이 text 그대로면 at 번째 글자부터 읽는다.
   *  글이 바뀌었으면(번역이 와서 번역문이 됐다 등) 그 문단 처음부터. 이전·다음을 누르면 버린다 */
  from?: { index: number; text: string; at: number };
};

/** 빈 줄만 문단 경계로 삼는다. 스트리밍 마지막 비어 있지 않은 문단은 보류한다. */
/** 상자에 둘 생각 글 — 꺼낼 자리(cut)가 있으면 그 앞만 */
export function boxText(box: Pick<ThinkingBoxState, "text" | "cut">): string {
  return box.cut == null ? box.text : box.text.replace(/\r/g, "").slice(0, box.cut);
}
/** 꺼낼 자리가 있으면 앞 칸들은 이미 다 들어온 것이라 마지막 문단도 끝난 문단이다 */
export function boxPhase(box: Pick<ThinkingBoxState, "phase" | "cut">): Phase {
  return box.cut == null ? box.phase : "complete";
}
/** 상자 아래에 그릴 Claude 의 말(꺼낼 자리 뒤) — 없으면 빈 글 */
export function saidText(box: Pick<ThinkingBoxState, "text" | "cut">): string {
  return box.cut == null ? "" : box.text.replace(/\r/g, "").slice(box.cut).trim();
}

export function splitParagraphs(text: string, phase: Phase): Paragraph[] {
  const parts = text.replace(/\r\n?/g, "\n").split(/\n[\t ]*\n(?:[\t ]*\n)*/).filter((s) => s.trim());
  const hasBoundary = /\n[\t ]*\n[\t \n]*$/.test(text.replace(/\r\n?/g, "\n"));
  return parts.map((src, i) => ({ src, done: phase === "complete" || i < parts.length - 1 || hasBoundary }));
}

// 라틴 문자가 아닌 글자(그리스·키릴·아르메니아·히브리·아랍·인도계·타이·한글·가나·한자). 폰 앱(Hermes)에서 \p{...} 정규식을
// 믿지 않으려고 범위로 적었다
const NON_LATIN_LETTER = /[\u0370-\u03ff\u0400-\u052f\u0530-\u058f\u0590-\u05ff\u0600-\u06ff\u0900-\u0e7f\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]/;

/** 번역할 문단인가. 한국어 대상 = 기존 생각 상자의 영어·한글 비율 기준. 영어 대상(10-08) = 라틴 문자가 아닌 글자가 있으면
 *  (Claude 가 정한 규칙 — 데몬 server/translate 의 영어 문장 판정과 같은 뜻) */
export function needsTranslation(s: string, lang: Lang = "ko"): boolean {
  if (lang === "en") return NON_LATIN_LETTER.test(s);
  const letters = s.replace(/\s/g, "").length;
  if (!letters || !/[A-Za-z]{2,}/.test(s)) return false;
  return (s.match(/[가-힣]/g) ?? []).length / letters < 0.2;
}

/** 1배에 단계량을 더한다. 느린 값은 단축키에서만 고르며 현재 값 하나만 임시 선택지로 보인다. */
export type SpeedStep = 0.1 | 0.25;
export function normalizeRate(value: number, step: SpeedStep): number {
  const max = step === 0.1 ? 2 : 5;
  const bounded = Math.max(0.5, Math.min(max, Number.isFinite(value) ? value : 1));
  return Number(Math.max(0.5, Math.min(max, 1 + Math.round((bounded - 1) / step) * step)).toFixed(2));
}
export function rateOptions(step: SpeedStep, rate = 1): number[] {
  const count = step === 0.1 ? 10 : 16;
  const options = Array.from({ length: count + 1 }, (_, i) => Number((1 + i * step).toFixed(2)));
  if (rate < 1) options.unshift(normalizeRate(rate, step));
  return options;
}

// 옛 진단 시험용 변환 함수. 새 UI와 setSpeed는 실제 배속 값을 쓴다.
export function sliderRate(value: number): number {
  const snapped = Math.max(-1, Math.min(1, Math.round(value / 0.05) * 0.05));
  return Number(Math.pow(3, snapped).toFixed(3));
}

type StreamEvent = { type: string; timestamp?: string; item?: { type: string; text?: string } };
type StreamSubscription = (() => void) & { ready: Promise<void> };

/** 구독 준비 전 델타도 모아 둔다. UI 스냅샷과 같은 델타를 두 번 덧붙이지 않는다. */
export function watchThinking(
  subscribe: (handler: (message: { event: StreamEvent }) => void) => StreamSubscription,
  currentText: () => string,
  update: (text: string, phase: Phase, stamp?: number) => void,
  error: (reason: string) => void,
): () => void {
  let live = true;
  let ready = false;
  let accumulated = currentText();
  let phase: Phase = "streaming";
  let stamp: number | undefined;
  let failure = "";
  const deliver = () => {
    if (!live || !ready) return;
    if (failure) error(failure);
    else update(accumulated, phase, stamp);
  };
  const subscription = subscribe(({ event }) => {
    if (!live || phase === "complete" || failure) return;
    if (event.type === "replacement" || event.type === "subscription_restored" || event.type === "error") {
      failure = "대화 연결이 바뀌었습니다. 다시 버튼을 눌러 주세요";
    } else if (event.type === "timeline") {
      if (event.item?.type === "reasoning") {
        accumulated += (event.item.text ?? "").replace(/\r/g, "");
        const nextStamp = event.timestamp ? Date.parse(event.timestamp) : NaN;
        if (Number.isFinite(nextStamp)) stamp = nextStamp;
      } else if (event.item?.type !== "plugin") phase = "complete";
    } else if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_canceled") phase = "complete";
    else return;
    deliver();
  });
  void subscription.ready.then(() => {
    if (!live) return;
    const snapshot = currentText();
    if (snapshot.startsWith(accumulated)) accumulated = snapshot;
    else if (!accumulated.startsWith(snapshot)) failure = "생각 내용이 바뀌었습니다. 다시 버튼을 눌러 주세요";
    ready = true;
    deliver();
  }, (reason: unknown) => { if (live) error(`대화 관찰 실패: ${String(reason)}`); });
  return () => { live = false; subscription(); };
}

/** UI 수명과 독립된 번역·재생 상태. 테스트에서는 RPC와 Audio만 대체한다. */
export class ThinkingController {
  readonly boxes = new Map<string, ThinkingBoxState>();
  private listeners = new Set<() => void>();
  private run?: Run;
  private serial = 0;
  rate = 1;
  speedStep: SpeedStep = 0.25;
  /** 번역을 보내기 전에 먼저 보는 이 기기 보관(10-10). 없으면(폰·시험) 늘 번역을 보낸다 */
  cache?: TranslationCache;

  /** lang = 지금 번역 대상·음성 언어를 그때그때 묻는 함수(10-08). 시험·옛 부르기는 한국어 */
  constructor(
    private audio: ThinkingAudio,
    private saveRate: (rate: number) => void = () => {},
    private now = Date.now,
    private lang: () => Lang = () => "ko",
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void { for (const listener of this.listeners) listener(); }

  // Paseo beta.4는 생각 델타마다 timestamp를 바꾼다. 에이전트 안에서 누적 텍스트가 이어지는 상자를 찾아
  // 최초 timestamp 키를 유지한다. 완료 상자는 timestamp 별로 구별하고, 웹 호스트도 키에 포함한다.
  box(hostId: string, agentId: string, stamp: number, text: string, phase: Phase, mounted?: ThinkingBoxState): ThinkingBoxState {
    // SDK는 같은 소스 행의 컴포넌트 identity를 유지한다. 그 동안에는 늦은 스냅샷도 같은 상태로 연결한다.
    if (mounted?.hostId === hostId && mounted.agentId === agentId) { mounted.stamps.add(stamp); return mounted; }
    const candidates = [...this.boxes.values()].filter((b) => b.hostId === hostId && b.agentId === agentId);
    let box = candidates.find((b) => b.stamps.has(stamp) && (b.text === text || (b.phase === "streaming" && text.startsWith(b.text))));
    if (!box) box = candidates.find((b) => b.awaitingCompleteStamp && phase === "complete" && b.text === text);
    if (!box) box = candidates.filter((b) => b.phase === "streaming" && text.startsWith(b.text))
      .sort((a, b) => b.text.length - a.text.length)[0];
    if (box) {
      box.stamps.add(stamp);
      if (phase === "complete" && box.text === text) box.awaitingCompleteStamp = false;
      return box;
    }
    box = {
      key: JSON.stringify([hostId, agentId, stamp, ++this.serial]), hostId, agentId, stamps: new Set([stamp]), text, phase,
      open: this.openByDefault, maximized: false, translate: false, suspended: false, controls: false, error: "", translations: new Map(), failures: new Map(), pending: new Set(), epoch: 0,
    };
    this.boxes.set(box.key, box);
    return box;
  }

  update(box: ThinkingBoxState, text: string, phase: Phase, stamp?: number): void {
    // 구독이 먼저 받은 델타를 뒤늦은 화면 렌더가 덮어쓰지 않는다.
    if (box.text.length > text.length && box.text.startsWith(text)) return;
    if (box.phase === "streaming" && phase === "complete") box.awaitingCompleteStamp = true;
    if (stamp !== undefined) box.stamps.add(stamp);
    box.text = text;
    box.phase = box.phase === "complete" ? "complete" : phase;
    this.syncWatch(box);
    this.translateMore(box);
    if (this.run?.box === box) void this.pump(this.run);
    this.notify();
  }

  shown(box: ThinkingBoxState, paragraph: Paragraph): string {
    const translated = box.translations.get(paragraph.src);
    return box.translate && paragraph.done && typeof translated === "string" ? translated : paragraph.src;
  }

  /** 읽을 글 — 화면에 보이는 글이 있으면 그것(브라우저 번역 반영, 원문 보기면 원문 칸), 없으면 shown(원문 보기면 원문) */
  private spoken(box: ThinkingBoxState, index: number, paragraph: Paragraph): string {
    return box.screenText?.(index) ?? (box.original ? paragraph.src : this.shown(box, paragraph));
  }

  toggleOpen(box: ThinkingBoxState): void { box.open = !box.open; this.notify(); }
  /** 새 상자가 펼친 채로 시작하는가 — 입력창 위 "모두 접기·펼치기" 알약이 정한다(10-08, thinkingFold) */
  openByDefault = true;
  /** 지금 있는 상자 전부와 앞으로 생길 상자를 접거나 펼친다 */
  setAllOpen(open: boolean): void {
    this.openByDefault = open;
    for (const box of this.boxes.values()) box.open = open;
    this.notify();
  }
  toggleMaximized(box: ThinkingBoxState): void { box.maximized = !box.maximized; this.notify(); }
  /**
   * 누르면 자동으로 펼치기(설정 thinkingAutoOpen) — 접혀 있으면 열고 높이 제한도 푼다(10-10 리규형님 "텍스트 에어리어가 확장돼서
   * 펼쳐져야지 — 번역·읽기를 켜면 스크롤이 생겨 내용이 안 보인다"). 끝나도 원래 크기로 돌리지 않는다(접지 않는 것과 같게)
   */
  expand(box: ThinkingBoxState): void {
    if (box.open && box.maximized) return;
    box.open = true;
    box.maximized = true;
    this.notify();
  }
  /** 데몬이 알려 준 꺼낼 자리(10-09). 한 번 찾은 자리는 글이 늘어도 그대로다(앞 칸은 이미 끝났다) */
  setCut(box: ThinkingBoxState, cut: number | null): void {
    if (cut === (box.cut ?? null) || (cut === null && box.cut != null)) return;
    box.cut = cut;
    this.translateMore(box);
    this.notify();
  }
  toggleControls(box: ThinkingBoxState): void { box.controls = !box.controls; this.notify(); }

  toggleTranslation(box: ThinkingBoxState): void {
    box.translate = !box.translate;
    box.suspended = false;
    box.error = "";
    // 번역을 켜면 원문 보기는 푼다(번역을 보겠다는 뜻). 끌 때 이미 보낸 번역은 버리지 않고 받아 둔다 — 다시 켤 때 그 문단을 또
    // 번역하지 않는다(10-10 리규형님 "번역된 것은 다시 번역해서 비용이 나가지 않게"). 아직 안 보낸 문단은 보내지 않는다
    if (box.translate) box.original = false;
    if (this.run?.box === box) { this.run.strict = false; this.seek(this.run.index); }
    this.syncWatch(box);
    this.translateMore(box);
    this.notify();
  }

  /** 원문 보기 켜기·끄기(10-10). 읽는 중이면 그 문단을 바뀐 화면 글로 다시 읽는다(번역 켜기·끄기와 같게) */
  toggleOriginal(box: ThinkingBoxState): void {
    box.original = !box.original;
    if (this.run?.box === box) { this.run.strict = false; this.seek(this.run.index); }
    this.notify();
  }

  private cancelTranslation(box: ThinkingBoxState): void {
    box.epoch += 1;
    box.pending.clear();
    box.busy = undefined;
  }

  private translateMore(box: ThinkingBoxState): void {
    const lang = this.lang();
    // Paseo 언어가 바뀌었으면 옛 언어로 받은 번역을 버린다(10-08) — 다음 줄부터 새 언어로 다시 받는다
    if (box.translatedLang !== undefined && box.translatedLang !== lang) {
      this.cancelTranslation(box);
      box.translations.clear();
      box.failures.clear();
    }
    box.translatedLang = lang;
    if (!box.translate || box.suspended || box.busy || !box.rpc) return;
    const texts = [...new Set(splitParagraphs(boxText(box), boxPhase(box)).filter((p) => p.done && needsTranslation(p.src, lang) && !box.translations.has(p.src)).map((p) => p.src))].slice(0, 20);
    if (!texts.length) return;
    const epoch = box.epoch;
    const busy = {};
    box.busy = busy;
    texts.forEach((text) => box.pending.add(text));
    void this.fetchTranslations(box, box.rpc, texts, lang, epoch).finally(() => {
      if (box.epoch !== epoch || box.busy !== busy) return;
      box.busy = undefined;
      texts.forEach((text) => box.pending.delete(text));
      // 먼저 재생 실패를 판정한다. 번역읽기 중 실패하면 다음 번역 배치를 보내지 않는다.
      if (this.run?.box === box) void this.pump(this.run);
      this.translateMore(box);
      this.notify();
    });
  }

  /**
   * 이 기기에 담아 둔 번역(10-10, 7일)을 먼저 쓰고 없는 문단만 번역을 보낸다. 받은 번역은 번역을 껐거나 상자가 닫혀도 담아 둔다
   * (이미 비용이 나간 글이다). 보관을 다 본 사이 번역을 껐으면 남은 문단은 보내지 않는다
   */
  private async fetchTranslations(box: ThinkingBoxState, rpc: ThinkingRpc, texts: string[], lang: Lang, epoch: number): Promise<void> {
    const live = () => box.epoch === epoch;
    let rest = texts;
    if (this.cache) {
      const cached = await this.cache.lookup(lang, texts).catch(() => new Map<string, string>());
      if (!live()) return;
      for (const [text, value] of cached) box.translations.set(text, value);
      rest = texts.filter((text) => !cached.has(text));
      if (!rest.length || !box.translate) return;
    }
    try {
      const result = await rpc.translate({ texts: rest, lang });
      const got: [string, string][] = [];
      rest.forEach((text, i) => {
        const value = result.translations[i];
        if (typeof value === "string" && value.trim()) got.push([text, value]);
      });
      if (got.length) this.cache?.store(lang, got);
      if (!live()) return;
      rest.forEach((text, i) => {
        const value = result.translations[i];
        const translation = typeof value === "string" && value.trim() ? value : null;
        box.translations.set(text, translation);
        if (translation === null) box.failures.set(text, result.error || "문단을 번역하지 못했습니다");
      });
      // 끈 상자에는 실패 글을 띄우지 않는다(실패 문단은 기록돼 다시 켜면 그 문단 실패로 보인다)
      if (box.translate && (result.error || rest.some((t) => box.translations.get(t) === null))) box.error = result.error || "일부 문단 번역 실패";
    } catch (error) {
      if (!live()) return;
      const reason = String(error);
      if (box.translate) box.error = reason;
      rest.forEach((text) => { box.translations.set(text, null); box.failures.set(text, reason); });
    }
  }

  private syncWatch(box: ThinkingBoxState): void {
    const needed = box.phase === "streaming" && ((!box.suspended && box.translate) || this.run?.box === box);
    if (!needed) { box.unwatch?.(); box.unwatch = undefined; }
    else if (!box.unwatch && box.watch) {
      box.unwatch = box.watch((text, phase, stamp) => this.update(box, text, phase, stamp), (reason) => {
        if (this.run?.box === box) this.stop(reason);
        else { box.error = reason; box.suspended = true; this.cancelTranslation(box); this.syncWatch(box); this.notify(); }
      });
    }
  }

  state(box: ThinkingBoxState): { active: boolean; index: number; paused: boolean; status: string; strict: boolean } {
    const run = this.run?.box === box ? this.run : undefined;
    return { active: !!run, index: run?.index ?? -1, paused: run?.paused ?? false, status: run?.status ?? "", strict: run?.strict ?? false };
  }

  /** 지금 읽는 것 — 입력창 위 읽기 컨트롤러 하나가 무엇을 읽든(턴·말·생각 상자·꺼낸 말) 이것을 본다(10-11 리규형님 "컨트롤러를 여기로 통일") */
  current(): { box: ThinkingBoxState; paused: boolean; status: string } | null {
    const run = this.run;
    return run ? { box: run.box, paused: run.paused, status: run.status } : null;
  }

  /** 읽기 시작. at 이 있으면 그 문단(가능하면 그 글자)부터 — 없으면 처음 문단부터(10-08 생각 상자 선택 읽기) */
  start(box: ThinkingBoxState, strict: boolean, at?: StartAt): void {
    if (this.run) this.stop();
    box.error = "";
    box.suspended = false;
    // 글자 자리는 누를 때 화면에 보이던 글 기준이다 — 번역읽기가 번역을 켜 화면 글이 바뀌기 전에 그 글을 잡아 둔다
    const target = at ? splitParagraphs(boxText(box), boxPhase(box))[at.index] : undefined;
    const shownAtPress = target && at ? this.spoken(box, at.index, target) : undefined;
    // 번역읽기는 번역을 읽겠다는 뜻 — 원문 보기를 푼다(10-10). 그냥 읽기는 보이는 글(원문 보기면 원문)을 읽는다
    if (strict) { box.translate = true; box.original = false; }
    const run: Run = { box, index: 0, strict, paused: false, status: "loading", generation: 0, loaded: false, startedAt: 0, slots: new Map() };
    if (at && target && shownAtPress !== undefined) {
      run.index = at.index;
      // 글자 자리가 글 안이고 그 뒤에 읽을 글이 남을 때만 — 아니면 그 문단 처음부터
      if (at.offset > 0 && at.offset < shownAtPress.length && shownAtPress.slice(at.offset).trim()) {
        run.from = { index: at.index, text: shownAtPress, at: at.offset };
      }
    }
    this.run = run;
    this.syncWatch(box);
    this.translateMore(box);
    void this.pump(run);
    this.notify();
  }

  /** 수동 중지는 번역 켜짐 표시를 유지하되 새 요청을 막는다. 다시 누르기 전까지 스트리밍도 요청하지 않는다. */
  stop(reason = ""): void {
    const run = this.run;
    if (!run) return;
    this.finish(run);
    run.box.suspended = true;
    this.cancelTranslation(run.box);
    if (reason) run.box.error = reason;
    this.syncWatch(run.box);
    this.notify();
  }

  private finish(run: Run): void {
    this.audio.stop();
    run.generation += 1;
    for (const slot of run.slots.values()) slot.live = false;
    run.slots.clear();
    run.box.controls = false;
    this.run = undefined;
  }

  pause(): void {
    if (!this.run) return;
    this.run.paused = true;
    this.audio.pause();
    this.notify();
  }

  resume(): void {
    const run = this.run;
    if (!run) return;
    run.paused = false;
    run.box.error = "";
    if (run.loaded && this.readable(run, run.index) !== run.currentText) { this.seek(run.index); return; }
    if (run.loaded) {
      const generation = run.generation;
      void this.audio.resume().then(() => {
        if (this.run === run && run.generation === generation) {
          if (run.paused) this.audio.pause();
          else this.prefetch(run);
        }
      }, (error: unknown) => { if (this.run === run && run.generation === generation) this.stop(`재생 실패: ${String(error)}`); });
    } else void this.pump(run);
    this.notify();
  }

  previous(): void {
    const run = this.run;
    if (!run) return;
    // 이전·다음은 문단 단위다 — 선택한 글자 자리는 처음 한 번만 쓴다(10-08)
    run.from = undefined;
    this.seek(run.index === 0 || (run.loaded && this.now() - run.startedAt > 3000) ? run.index : Math.max(0, run.index - 1));
  }

  next(): void {
    const run = this.run;
    if (!run) return;
    const complete = splitParagraphs(boxText(run.box), boxPhase(run.box)).filter((p) => p.done).length;
    if (run.box.phase === "streaming" && run.index >= complete) return;
    run.from = undefined;
    this.seek(run.index + 1);
  }

  /** 읽는 문단의 형광펜을 몇 번째 글자부터 칠할지 — 선택한 글자부터 읽는 중이고 화면 글이 그때 그대로면 그 자리, 아니면 0(문단 전체) */
  readingFrom(box: ThinkingBoxState, index: number, shownText: string): number {
    const run = this.run;
    const from = run?.box === box && run.index === index ? run.from : undefined;
    return from && from.index === index && from.text === shownText ? from.at : 0;
  }

  /**
   * 설정 화면에서 번역·읽기를 끄면(10-08) 그 기능을 멈춘다 — 버튼이 숨으므로 켜 둔 채 남으면 끌 방법이 없다.
   * 읽기를 끄면 읽기를 멈추고, 번역을 끄면 번역읽기를 멈추고 모든 상자의 번역 표시를 끈다. 다시 켜도 저절로 돌아오지 않는다
   */
  applyFeatures(translate: boolean, tts: boolean): void {
    if (this.run && (!tts || (!translate && this.run.strict))) this.stop();
    if (!translate) {
      for (const box of this.boxes.values()) {
        if (!box.translate) continue;
        box.translate = false;
        this.cancelTranslation(box);
        if (this.run?.box === box) this.seek(this.run.index);
        this.syncWatch(box);
      }
    }
    this.notify();
  }

  private seek(index: number): void {
    const run = this.run;
    if (!run) return;
    this.audio.stop();
    run.generation += 1;
    run.pumping = undefined;
    run.loaded = false;
    run.currentText = undefined;
    run.index = index;
    run.status = "loading";
    this.trimSlots(run);
    if (!run.paused) void this.pump(run);
    this.notify();
  }

  speedOptions(): number[] { return rateOptions(this.speedStep, this.rate); }

  applySpeedStep(step: SpeedStep, value = this.rate): void {
    const changed = this.speedStep !== step;
    this.speedStep = step;
    const rate = normalizeRate(value, step);
    if (rate !== this.rate || value !== rate) this.setSpeed(rate);
    else if (changed) this.notify();
  }

  isReading(): boolean { return !!this.run && !this.run.paused; }

  stepSpeed(direction: -1 | 1): boolean {
    if (!this.isReading()) return false;
    this.setSpeed(this.rate + direction * this.speedStep);
    return true;
  }

  setSpeed(value: number): void {
    this.rate = normalizeRate(value, this.speedStep);
    this.audio.setRate(this.rate);
    this.saveRate(this.rate);
    this.notify();
  }

  private trimSlots(run: Run): void {
    for (const [index, slot] of run.slots) if (index < run.index || index > run.index + PREFETCH_AHEAD) { slot.live = false; run.slots.delete(index); }
  }

  private readable(run: Run, index: number): string | undefined {
    const paragraph = splitParagraphs(boxText(run.box), boxPhase(run.box))[index];
    if (!paragraph?.done) return;
    if (run.strict && needsTranslation(paragraph.src, this.lang()) && typeof run.box.translations.get(paragraph.src) !== "string") return;
    const shown = this.spoken(run.box, index, paragraph);
    // 선택한 글자부터(10-08) — 그 문단 화면 글이 누를 때 그대로일 때만
    const from = run.from;
    return from && from.index === index && from.text === shown ? shown.slice(from.at) : shown;
  }

  private slot(run: Run, index: number, text: string): Slot {
    const old = run.slots.get(index);
    if (old?.text === text) return old;
    if (old) old.live = false;
    const slot: Slot = { text, live: true, promise: Promise.resolve().then(async () => {
      if (!slot.live || this.run !== run || run.box.suspended) throw new Error("취소된 합성");
      const result = await run.box.rpc!.synthesize({ text, lang: this.lang() });
      if (!result.ok) throw new Error(result.error);
      return { base64: result.base64, mimeType: result.mimeType };
    }) };
    // 미리 합성한 오류는 그 문단 차례에만 사용자에게 알린다.
    void slot.promise.catch(() => {});
    run.slots.set(index, slot);
    return slot;
  }

  private prefetch(run: Run): void {
    if (this.run !== run || run.paused || !run.loaded) return;
    const paragraphs = splitParagraphs(boxText(run.box), boxPhase(run.box));
    for (let index = run.index + 1; index <= run.index + PREFETCH_AHEAD; index++) {
      const paragraph = paragraphs[index];
      // 번역을 켠 채 읽을 때 번역이 아직 안 온 문단은 기다린다 — 원문으로 미리 합성해 두면 번역이 와서 읽을 글이 바뀌어
      // 버리고 다시 합성했다(10-07). 번역이 오면 translateMore → pump → 여기로 다시 온다
      if (paragraph && !run.strict && this.awaitingTranslation(run.box, paragraph)) break;
      const text = this.readable(run, index);
      if (text === undefined) break;
      this.slot(run, index, text);
    }
  }

  private awaitingTranslation(box: ThinkingBoxState, paragraph: Paragraph): boolean {
    return box.translate && !box.original && !box.suspended && paragraph.done && needsTranslation(paragraph.src, this.lang()) && !box.translations.has(paragraph.src);
  }

  private async pump(run: Run): Promise<void> {
    if (this.run !== run || run.paused || !run.box.rpc) return;
    const paragraphs = splitParagraphs(boxText(run.box), boxPhase(run.box));
    const paragraph = paragraphs[run.index];
    if (!paragraph?.done) {
      if (run.box.phase === "complete") { this.finish(run); this.syncWatch(run.box); }
      else run.status = "waiting";
      this.notify();
      return;
    }
    if (run.strict && needsTranslation(paragraph.src, this.lang()) && run.box.translations.get(paragraph.src) === null) {
      this.stop(`번역 실패로 읽기 중지: ${run.box.failures.get(paragraph.src) || "문단 번역 실패"}`);
      return;
    }
    const text = this.readable(run, run.index);
    if (text === undefined) { run.status = "waiting"; this.notify(); return; }
    if (run.loaded && run.currentText === text) { this.prefetch(run); return; }
    if (run.loaded) { this.seek(run.index); return; }
    if (run.pumping?.generation === run.generation) return;
    const generation = run.generation;
    // 이 작업만의 표(10-10) — 화면 글이 바뀌어 다시 시도로 넘긴 뒤 이 작업의 마무리가 새 작업의 표를 지우면, 다음 화면 갱신이
    // 같은 문단을 한 번 더 틀어 재생 장치가 앞 재생을 일시정지로 끊었다("소리 읽기 실패: AbortError", 번역을 켠 채 읽을 때)
    const mine = { generation };
    run.pumping = mine;
    run.status = "loading";
    this.notify();
    const slot = this.slot(run, run.index, text);
    try {
      const file = await slot.promise;
      if (this.run !== run || run.generation !== generation || !slot.live) return;
      if (this.readable(run, run.index) !== text) { run.pumping = undefined; void this.pump(run); return; }
      if (run.paused) return;
      run.loaded = true;
      run.currentText = text;
      run.startedAt = this.now();
      run.status = "playing";
      await this.audio.play(file, this.rate, () => {
        if (this.run !== run || run.generation !== generation) return;
        run.generation += 1;
        run.loaded = false;
        run.pumping = undefined;
        run.index += 1;
        this.trimSlots(run);
        void this.pump(run);
      }, (reason) => { if (this.run === run && run.generation === generation) this.stop(`재생 실패: ${reason}`); });
      if (this.run !== run || run.generation !== generation) return;
      if (run.paused) this.audio.pause();
      else this.prefetch(run);
    } catch (error) {
      if (this.run === run && run.generation === generation && slot.live) {
        const name = error && typeof error === "object" && "name" in error ? error.name : "";
        // 소리를 틀기 시작하는 찰나에 일시정지를 누르면 브라우저가 그 재생을 AbortError 로 끊는다 — 실패가 아니다(10-10).
        // 일시정지로 두고, 이어서 읽기가 같은 소리를 다시 튼다
        if (run.paused && name === "AbortError") return;
        if (run.loaded && name === "NotAllowedError") {
          // 합성 뒤 play()는 브라우저에서 막힐 수 있다. 같은 소리를 남겨 두고 사용자 클릭으로 재개한다.
          run.paused = true;
          run.box.controls = true;
          run.box.error = "브라우저 소리 차단: 아래 재생을 눌러 주세요";
        } else this.stop(`소리 읽기 실패: ${String(error)}`);
      }
    } finally {
      if (run.pumping === mine) run.pumping = undefined;
      this.notify();
    }
  }

  dispose(boxes: Set<ThinkingBoxState>): void {
    if (this.run && boxes.has(this.run.box)) this.stop();
    for (const box of boxes) {
      box.suspended = true;
      this.cancelTranslation(box);
      box.unwatch?.();
      box.unwatch = undefined;
      this.boxes.delete(box.key);
    }
  }
}
