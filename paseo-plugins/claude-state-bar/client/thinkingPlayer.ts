export type Phase = "streaming" | "complete";
export type Paragraph = { src: string; done: boolean };
export type AudioFile = { base64: string; mimeType: string };
export type ThinkingRpc = {
  translate(input: { texts: string[] }): Promise<{ translations: (string | null)[]; error?: string }>;
  synthesize(input: { text: string }): Promise<({ ok: true } & AudioFile) | { ok: false; error: string }>;
};
export type ThinkingAudio = {
  play(file: AudioFile, rate: number, ended: () => void, error: (reason: string) => void): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  stop(): void;
  setRate(rate: number): void;
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
  translate: boolean;
  suspended: boolean;
  controls: boolean;
  error: string;
  translations: Map<string, string | null>;
  failures: Map<string, string>;
  pending: Set<string>;
  epoch: number;
  busy?: object;
  rpc?: ThinkingRpc;
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
  pumping?: number;
  loaded: boolean;
  currentText?: string;
  startedAt: number;
  slots: Map<number, Slot>;
};

/** 빈 줄만 문단 경계로 삼는다. 스트리밍 마지막 비어 있지 않은 문단은 보류한다. */
export function splitParagraphs(text: string, phase: Phase): Paragraph[] {
  const parts = text.replace(/\r\n?/g, "\n").split(/\n[\t ]*\n(?:[\t ]*\n)*/).filter((s) => s.trim());
  const hasBoundary = /\n[\t ]*\n[\t \n]*$/.test(text.replace(/\r\n?/g, "\n"));
  return parts.map((src, i) => ({ src, done: phase === "complete" || i < parts.length - 1 || hasBoundary }));
}

/** 기존 생각 상자의 영어·한글 비율 기준. */
export function needsTranslation(s: string): boolean {
  const letters = s.replace(/\s/g, "").length;
  if (!letters || !/[A-Za-z]{2,}/.test(s)) return false;
  return (s.match(/[가-힣]/g) ?? []).length / letters < 0.2;
}

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

  constructor(private audio: ThinkingAudio, private saveRate: (rate: number) => void = () => {}, private now = Date.now) {}

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
      open: true, maximized: false, translate: false, suspended: false, controls: false, error: "", translations: new Map(), failures: new Map(), pending: new Set(), epoch: 0,
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

  toggleOpen(box: ThinkingBoxState): void { box.open = !box.open; this.notify(); }
  toggleMaximized(box: ThinkingBoxState): void { box.maximized = !box.maximized; this.notify(); }
  toggleControls(box: ThinkingBoxState): void { box.controls = !box.controls; this.notify(); }

  toggleTranslation(box: ThinkingBoxState): void {
    box.translate = !box.translate;
    box.suspended = false;
    box.error = "";
    if (!box.translate) this.cancelTranslation(box);
    if (this.run?.box === box) { this.run.strict = false; this.seek(this.run.index); }
    this.syncWatch(box);
    this.translateMore(box);
    this.notify();
  }

  private cancelTranslation(box: ThinkingBoxState): void {
    box.epoch += 1;
    box.pending.clear();
    box.busy = undefined;
  }

  private translateMore(box: ThinkingBoxState): void {
    if (!box.translate || box.suspended || box.busy || !box.rpc) return;
    const texts = [...new Set(splitParagraphs(box.text, box.phase).filter((p) => p.done && needsTranslation(p.src) && !box.translations.has(p.src)).map((p) => p.src))].slice(0, 20);
    if (!texts.length) return;
    const epoch = box.epoch;
    const busy = {};
    box.busy = busy;
    texts.forEach((text) => box.pending.add(text));
    void box.rpc.translate({ texts }).then((result) => {
      if (box.epoch !== epoch) return;
      texts.forEach((text, i) => {
        const value = result.translations[i];
        const translation = typeof value === "string" && value.trim() ? value : null;
        box.translations.set(text, translation);
        if (translation === null) box.failures.set(text, result.error || "문단을 번역하지 못했습니다");
      });
      if (result.error || texts.some((t) => box.translations.get(t) === null)) box.error = result.error || "일부 문단 번역 실패";
    }, (error: unknown) => {
      if (box.epoch !== epoch) return;
      const reason = String(error);
      box.error = reason;
      texts.forEach((text) => { box.translations.set(text, null); box.failures.set(text, reason); });
    }).finally(() => {
      if (box.epoch !== epoch || box.busy !== busy) return;
      box.busy = undefined;
      texts.forEach((text) => box.pending.delete(text));
      // 먼저 재생 실패를 판정한다. 번역읽기 중 실패하면 다음 번역 배치를 보내지 않는다.
      if (this.run?.box === box) void this.pump(this.run);
      this.translateMore(box);
      this.notify();
    });
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

  start(box: ThinkingBoxState, strict: boolean): void {
    if (this.run) this.stop();
    box.error = "";
    box.suspended = false;
    if (strict) box.translate = true;
    const run: Run = { box, index: 0, strict, paused: false, status: "loading", generation: 0, loaded: false, startedAt: 0, slots: new Map() };
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
    if (run) this.seek(run.index === 0 || (run.loaded && this.now() - run.startedAt > 3000) ? run.index : Math.max(0, run.index - 1));
  }

  next(): void {
    const run = this.run;
    if (!run) return;
    const complete = splitParagraphs(run.box.text, run.box.phase).filter((p) => p.done).length;
    if (run.box.phase === "streaming" && run.index >= complete) return;
    this.seek(run.index + 1);
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

  setSpeed(value: number): void {
    this.rate = sliderRate(value);
    this.audio.setRate(this.rate);
    this.saveRate(this.rate);
    this.notify();
  }

  private trimSlots(run: Run): void {
    for (const [index, slot] of run.slots) if (index < run.index || index > run.index + PREFETCH_AHEAD) { slot.live = false; run.slots.delete(index); }
  }

  private readable(run: Run, index: number): string | undefined {
    const paragraph = splitParagraphs(run.box.text, run.box.phase)[index];
    if (!paragraph?.done) return;
    if (run.strict && needsTranslation(paragraph.src) && typeof run.box.translations.get(paragraph.src) !== "string") return;
    return this.shown(run.box, paragraph);
  }

  private slot(run: Run, index: number, text: string): Slot {
    const old = run.slots.get(index);
    if (old?.text === text) return old;
    if (old) old.live = false;
    const slot: Slot = { text, live: true, promise: Promise.resolve().then(async () => {
      if (!slot.live || this.run !== run || run.box.suspended) throw new Error("취소된 합성");
      const result = await run.box.rpc!.synthesize({ text });
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
    const paragraphs = splitParagraphs(run.box.text, run.box.phase);
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
    return box.translate && !box.suspended && paragraph.done && needsTranslation(paragraph.src) && !box.translations.has(paragraph.src);
  }

  private async pump(run: Run): Promise<void> {
    if (this.run !== run || run.paused || !run.box.rpc) return;
    const paragraphs = splitParagraphs(run.box.text, run.box.phase);
    const paragraph = paragraphs[run.index];
    if (!paragraph?.done) {
      if (run.box.phase === "complete") { this.finish(run); this.syncWatch(run.box); }
      else run.status = "waiting";
      this.notify();
      return;
    }
    if (run.strict && needsTranslation(paragraph.src) && run.box.translations.get(paragraph.src) === null) {
      this.stop(`번역 실패로 읽기 중지: ${run.box.failures.get(paragraph.src) || "문단 번역 실패"}`);
      return;
    }
    const text = this.readable(run, run.index);
    if (text === undefined) { run.status = "waiting"; this.notify(); return; }
    if (run.loaded && run.currentText === text) { this.prefetch(run); return; }
    if (run.loaded) { this.seek(run.index); return; }
    if (run.pumping === run.generation) return;
    const generation = run.generation;
    run.pumping = generation;
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
        if (run.loaded && error && typeof error === "object" && "name" in error && error.name === "NotAllowedError") {
          // 합성 뒤 play()는 브라우저에서 막힐 수 있다. 같은 소리를 남겨 두고 사용자 클릭으로 재개한다.
          run.paused = true;
          run.box.controls = true;
          run.box.error = "브라우저 소리 차단: 아래 재생을 눌러 주세요";
        } else this.stop(`소리 읽기 실패: ${String(error)}`);
      }
    } finally {
      if (run.pumping === generation) run.pumping = undefined;
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
