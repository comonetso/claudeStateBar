// 폰 앱이 따라 읽기·목소리 미리 듣기 소리를 직접 튼다(10-16 22시 리규형님 "앱이 소리를 직접 튼다" — 폰 앱 대화 peer_mail d0529b49).
// 왜: WebView <audio> 는 5초 넘는 소리(길이 모름 포함)면 USAGE_MEDIA·GAIN 으로 소리 차례를 잡아 유튜브 같은 다른 앱을 멈춘다
// (Chromium AudioFocusDelegate·media_content_type.cc, 플립6 실측). 앱이 줄이기 차례(duckOthers)를 잡아도 웹이 다시 빼앗고, 끌 WebView 설정이 없다.
// 🔴 재생 코드가 둘로 갈린다 — PC·브라우저는 web.ts 의 <audio>, 폰 앱은 이 파일 → 앱 SpeechPlayer.kt(MediaPlayer).
//    빠르기·일시정지·음소거·끝남 처리를 고치면 양쪽을 다 고친다.
// 약속(앱 ShellBridge, F:/workspace/phonegapProject/Paseo): 감지 typeof PaseoShell.speechPlay === "function" ·
//   speechPlay(id 정수, base64, mimeType, rate)(새로 틀면 앞 것 멈춤·음높이 유지) · speechPause()·speechResume()·speechStop()·speechSetRate(rate) ·
//   이벤트 window "paseoshell:speech" detail {id, state: playing|ended|error, message?} — playing = 틀기·이어 듣기를 받음(준비 중 일시정지면 틀지 않고 보냄).
//   앱 재생은 다른 앱 때문에 멈추지 않는다(바깥 멈춤 알림 없음). 음소거는 앱이 처리한다.
// 페이지에 하나 — 앱 재생기는 하나라, 다른 재생기(목소리 미리 듣기)가 새로 틀면 앞 재생기의 소리는 앱이 멈춘다 → 앞 재생기에 바깥 멈춤으로 알린다.

import type { AudioFile, ThinkingAudio } from "./thinkingPlayer";

type SpeechBridge = {
  speechPlay(id: number, base64: string, mimeType: string, rate: number): unknown;
  speechPause(): unknown;
  speechResume(): unknown;
  speechStop(): unknown;
  speechSetRate(rate: number): unknown;
};
type SpeechEvent = { detail?: { id?: unknown; state?: unknown; message?: unknown } };
type Owner = { id: number; event(state: string, message: string): void; cut(): void };
type SpeechHub = { seq: number; owner: Owner | null };

function bridge(): SpeechBridge | null {
  const shell = (globalThis as { PaseoShell?: Partial<SpeechBridge> }).PaseoShell;
  return typeof shell?.speechPlay === "function" ? (shell as SpeechBridge) : null;
}

function speechHub(): SpeechHub {
  const g = globalThis as {
    __claudeStateBar_shellSpeech_v1?: SpeechHub;
    addEventListener?: (type: string, fn: (event: SpeechEvent) => void) => void;
  };
  if (g.__claudeStateBar_shellSpeech_v1) return g.__claudeStateBar_shellSpeech_v1;
  const h: SpeechHub = { seq: 0, owner: null };
  g.__claudeStateBar_shellSpeech_v1 = h;
  g.addEventListener?.("paseoshell:speech", (event) => {
    const d = event?.detail;
    const o = h.owner;
    if (!o || d?.id !== o.id) return; // 지난 소리·다른 재생기의 소리
    try {
      o.event(String(d.state), typeof d.message === "string" ? d.message : "");
    } catch {
      /* 듣는 쪽 오류가 다음 이벤트를 막지 않게 */
    }
  });
  return h;
}

/** 폰 앱이 소리를 직접 틀 수 있는가 */
export function shellCanSpeak(): boolean {
  return bridge() !== null;
}

/** 앱 재생 판 — web.ts createThinkingAudio 가 앱 함수가 있을 때 고른다 */
export function createShellAudio(): ThinkingAudio {
  type Cur = { id: number; file: AudioFile; rate: number; ended: () => void; error: (reason: string) => void; interrupted?: () => void; lost: boolean };
  let cur: Cur | null = null;
  let wait: { resolve: () => void; reject: (e: Error) => void } | null = null;
  // 틀기·이어 듣기를 기다리던 중 멈추거나 바뀌면 AbortError — 재생기가 실패로 보지 않는 이름(thinkingPlayer: 일시정지 찰나의 AbortError)
  const abort = () => Object.assign(new Error("앱 재생이 바뀌었습니다"), { name: "AbortError" });
  const settle = (ok: boolean, e?: Error) => {
    const w = wait;
    wait = null;
    if (w) {
      if (ok) w.resolve();
      else w.reject(e ?? abort());
    }
  };
  const mine = () => !!cur && speechHub().owner?.id === cur.id;
  const release = () => {
    const h = speechHub();
    if (cur && h.owner?.id === cur.id) h.owner = null;
    cur = null;
  };
  const waitFor = (send: () => void) =>
    new Promise<void>((resolve, reject) => {
      settle(false);
      wait = { resolve, reject };
      try {
        send();
      } catch (e) {
        wait = null;
        release();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  const start = (c: Cur, b: SpeechBridge): Promise<void> => {
    const h = speechHub();
    c.id = ++h.seq;
    c.lost = false;
    const prev = h.owner;
    h.owner = {
      id: c.id,
      event: (state, message) => {
        if (cur !== c) return;
        if (state === "playing") settle(true);
        else if (state === "ended") {
          settle(true);
          release();
          c.ended();
        } else if (state === "error") {
          const reason = message || "앱 재생 오류";
          if (wait) {
            release();
            settle(false, new Error(reason));
          } else {
            release();
            c.error(reason);
          }
        }
      },
      // 다른 재생기가 앱 소리를 바꿨다 — 따라 읽기는 일시정지로(다시 재생하면 이 소리를 처음부터), 바깥 멈춤을 모르는 미리 듣기는 끝낸다
      cut: () => {
        if (cur !== c) return;
        settle(false);
        if (c.interrupted) {
          c.lost = true;
          c.interrupted();
        } else {
          cur = null;
          c.ended();
        }
      },
    };
    if (prev && prev.id !== c.id) {
      try {
        prev.cut();
      } catch {
        /* 앞 재생기 오류가 새 소리를 막지 않게 */
      }
    }
    cur = c;
    return waitFor(() => b.speechPlay(c.id, c.file.base64, c.file.mimeType, c.rate));
  };
  return {
    play(file, rate, ended, error, interrupted) {
      const b = bridge();
      if (!b) return Promise.reject(new Error("앱 재생 함수가 없습니다"));
      settle(false);
      release();
      return start({ id: 0, file, rate, ended, error, interrupted, lost: false }, b);
    },
    pause() {
      if (!mine()) return;
      try {
        bridge()?.speechPause();
      } catch {
        /* 앱 오류는 다음 틀기에서 드러난다 */
      }
    },
    resume() {
      const b = bridge();
      const c = cur;
      if (!b || !c) return Promise.resolve();
      if (c.lost || !mine()) return start(c, b);
      return waitFor(() => b.speechResume());
    },
    stop() {
      const was = mine();
      settle(false);
      release();
      if (!was) return;
      try {
        bridge()?.speechStop();
      } catch {
        /* 앱이 이미 멈췄다 */
      }
    },
    setRate(rate) {
      if (cur) cur.rate = rate;
      if (!mine()) return;
      try {
        bridge()?.speechSetRate(rate);
      } catch {
        /* 다음 틀기에서 rate 로 다시 준다 */
      }
    },
  };
}
