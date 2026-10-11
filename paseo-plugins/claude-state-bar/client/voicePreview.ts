import type { AudioProvider, SpeechLang } from "../shared/speech";
import type { AudioFile, ThinkingAudio } from "./thinkingPlayer";

export type PreviewInput = { provider: AudioProvider; voice: string; lang: SpeechLang };
export type PreviewState = { id: string; status: "loading" | "playing" } | { id: ""; status: "idle"; error?: string };
export const previewId = (input: PreviewInput) => JSON.stringify([input.provider, input.voice, input.lang]);
/** 설정 화면 한 번 열리는 동안만 합성 결과·진행 중 요청을 기억한다. 늦게 온 앞줄 소리는 재생하지 않는다. */
export class VoicePreviewPlayer {
  private cache = new Map<string, AudioFile>();
  private pending = new Map<string, Promise<AudioFile>>();
  private generation = 0;
  private active = "";
  private disposed = false;
  constructor(private audio: ThinkingAudio, private synthesize: (input: PreviewInput) => Promise<({ ok: true } & AudioFile) | { ok: false; error: string }>,
    private changed: (state: PreviewState) => void) {}
  stop(): void {
    this.generation++;
    this.active = "";
    this.audio.stop();
    if (!this.disposed) this.changed({ id: "", status: "idle" });
  }
  async toggle(input: PreviewInput): Promise<void> {
    if (this.disposed) return;
    const id = previewId(input);
    if (this.active === id) { this.stop(); return; }
    this.stop();
    this.active = id;
    const token = this.generation;
    const live = () => !this.disposed && token === this.generation;
    this.changed({ id, status: "loading" });
    try {
      let file = this.cache.get(id);
      if (!file) {
        let pending = this.pending.get(id);
        if (!pending) {
          pending = this.synthesize(input).then((result) => {
            if (!result.ok) throw new Error(result.error);
            const audio = { base64: result.base64, mimeType: result.mimeType };
            if (!this.disposed) this.cache.set(id, audio);
            return audio;
          });
          this.pending.set(id, pending);
          void pending.finally(() => { if (this.pending.get(id) === pending) this.pending.delete(id); }).catch(() => {});
        }
        file = await pending;
      }
      if (!live()) return;
      this.changed({ id, status: "playing" });
      await this.audio.play(file, 1, () => { if (live()) this.stop(); }, (error) => {
        if (live()) { this.stop(); this.changed({ id: "", status: "idle", error }); }
      });
    } catch (error) {
      if (live()) { this.stop(); this.changed({ id: "", status: "idle", error: (error as Error).message }); }
    }
  }
  dispose(): void { this.stop(); this.disposed = true; this.cache.clear(); this.pending.clear(); }
}
