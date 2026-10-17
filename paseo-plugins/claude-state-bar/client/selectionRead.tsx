import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { hostInfo } from "../shared/sound";
import { translateKo } from "../shared/translate";
import { speechGet, type SpeechSettings } from "../shared/speech";
import { googleStatus, ttsSynthesize } from "../shared/tts";
import { uiLanguage } from "./appLanguage";
import { currentSettings, featureSwitches, onSharedSignal } from "./sounds";
import { setShellDuck } from "./shellDuck";
import { thinkingController as controller } from "./thinking";
import type { ThinkingBoxState, ThinkingRpc } from "./thinkingPlayer";
import { startComposerRail, startReadDock, startTurnReadButtons, watchSelection, type TurnReadBinding } from "./web";

/**
 * 따라 읽기(10-15) 조절 — 입력창 위 알약(followPill)이 쓴다. 대화 번호는 이 기기 데몬의 것이다(기기마다 플러그인이 따로 올라온다)
 */
export type FollowControl = {
  /** 이 기기 데몬으로 읽을 수 있나(호스트 확인·음성 합성 키·설정 소리 읽기) — 안 되면 알약을 숨긴다(턴 읽기 단추와 같다) */
  available(): boolean;
  /** 따라 읽는 대화 번호 — 꺼져 있으면 null */
  agentId(): string | null;
  /** 그 대화를 따라 읽고 있으면 끄고, 아니면 그 대화로 켠다(다른 대화를 따라 읽던 것은 끈다) */
  toggle(agentId: string): void;
  /** 대화 상태 — 일하는 중이 아니면 마지막 문단까지 끝난 글로 본다 */
  observe(agent: { id: string; status?: string | null }): void;
  forget(agentId: string): void;
  subscribe(fn: () => void): () => void;
};
const NO_FOLLOW: FollowControl = { available: () => false, agentId: () => null, toggle: () => {}, observe: () => {}, forget: () => {}, subscribe: () => () => {} };

// 입력창 위 선택 읽기를 대신한다. 웹 DOM 은 web.ts 에만 두고 생각 상자의 재생기 하나를 같이 쓴다.
export function createTurnReadButtons(client: PluginClientContext, log: (message: string) => void): { dispose(): void; follow: FollowControl } {
  if (Platform.OS !== "web") return { dispose: () => {}, follow: NO_FOLLOW };
  let live = true;
  let hostId: string | null = null;
  let canSpeak = false;
  let speechSettings: SpeechSettings | undefined;
  let keyCheck = 0;
  let serial = 0;
  let target: unknown;
  let box: ThinkingBoxState | undefined;
  // 마지막 실패 — 재생기를 정리한 뒤에도 그 단추 옆에 남긴다(10-11 리규형님 "눌러도 아무 반응도 없어")
  let failed: { target: unknown; error: string } | null = null;
  const made = new Set<ThinkingBoxState>();
  const playing = () => box ? controller.state(box) : undefined;
  const rpcFor = (prefix: string): ThinkingRpc => ({ translate: (input) => client.rpc(translateKo, input), synthesize: async (input) => {
    log(`${prefix}: 음성 합성 요청 ${input.text.length}자`);
    const result = await client.rpc(ttsSynthesize, input);
    log(`${prefix}: 음성 합성 ${result.ok ? "성공" : "실패"}`);
    return result;
  } });

  // 따라 읽기(10-15 리규형님 "생각 상자를 뺀 Claude 말을 지금 시점부터 계속 읽어 주는 알약") — 켠 대화 하나의 새 문단을 끝나는 대로
  // 재생용 상자 글 끝에 이어 붙여 재생기 하나로 읽는다(web.ts followStep 이 화면에서 모아 넘긴다). 리규형님 결정(10-15): 말하는 중이면
  // 그 말 처음부터·쉬는 중이면 다음 말부터 / 끌 때까지 다음 턴도, 새로고침하면 꺼짐 / 입력창 위 조절 줄 중지를 누르면 꺼짐.
  // 다른 읽기 단추를 누르거나 읽기가 실패해 재생기가 이 상자를 놓아도 끈다(아래 refresh).
  // 켤 때 화면에 선택한 글이 있으면 그 문단부터(10-16 리규형님 "선택된 글자가 있으면 그 문단부터, 없을 시 기존대로")
  let follow: { agentId: string; session: number; box: ThinkingBoxState; text: string; from: unknown } | null = null;
  let followSession = 0;
  // 마지막 선택 — 알약을 누르는 순간 선택이 풀려도 마우스를 뗀 다음 차례까지 남는다(생각 상자 선택 읽기와 같은 장치)
  let picked: unknown = null;
  const stopPick = watchSelection((snapshot) => { picked = snapshot?.token ?? null; });
  let wasAvailable = false;
  const statuses = new Map<string, string>();
  const followListeners = new Set<() => void>();
  const followChanged = () => { for (const fn of followListeners) fn(); };
  // 다른 소리 줄이기 요청자 이름 — 페이지에 플러그인이 호스트마다 실려도 서로의 바람을 덮지 않게(shellDuck)
  const duckOwner = `read-${Math.random().toString(36).slice(2, 10)}`;
  const available = () => live && !!hostId && canSpeak && featureSwitches().tts;
  const endFollow = (why: string) => {
    const f = follow;
    if (!f) return;
    follow = null;
    log(`follow read: 끔 (${why})`);
    if (controller.state(f.box).active) controller.stop();
    controller.dispose(new Set([f.box]));
    followChanged();
  };
  const startFollow = (agentId: string) => {
    if (!available() || !hostId) { log(`follow read: 켤 수 없음 (${!hostId ? "호스트 번호 없음" : !canSpeak ? "음성 합성 키 없음" : "소리 읽기 꺼짐"})`); return; }
    endFollow("다른 대화로");
    const next = controller.box(hostId, `follow-read-${++serial}`, Date.now(), "", "streaming");
    // 재생용 상자 — 자동 번역·자동 펼침 대상이 아니다(화면 글을 읽는다, thinking.tsx readSaid 와 같다)
    next.said = true;
    next.translate = false;
    next.rpc = rpcFor("follow read");
    // 다른 읽기는 여기서 멈춘다. 재생기가 이 상자를 잡은 뒤에 켬으로 둔다 — 먼저 두면 앞 읽기를 멈추는 알림에서 꺼진 것으로 본다
    controller.start(next, false);
    follow = { agentId, session: ++followSession, box: next, text: "", from: picked };
    log(`follow read: 켬 ${agentId.slice(0, 8)}${picked ? " · 선택 있음" : ""}`);
    followChanged();
    dom.refresh();
  };
  const pushFollow = (texts: string[]) => {
    const f = follow;
    if (!f || !texts.length) return;
    // 문단마다 빈 줄로 끝맺어 재생기가 모두 끝난 문단으로 읽게 한다(splitParagraphs). 화면 문단 글엔 빈 줄이 없다(web.ts screenParts)
    f.text += texts.map((text) => `${text}\n\n`).join("");
    controller.update(f.box, f.text, "streaming");
  };

  const fail = (nextTarget: unknown, reason: string) => {
    failed = { target: nextTarget, error: reason };
    log(`turn read: 중단 ${reason}`);
    dom.refresh();
  };
  const refresh = () => {
    if (!live) return;
    if (box && !playing()?.active) {
      if (box.error) {
        log(`turn read: ${box.error}`);
        failed = { target, error: box.error };
      }
      controller.dispose(made);
      made.clear();
      box = undefined;
      target = undefined;
    }
    if (follow && !controller.state(follow.box).active) endFollow(follow.box.error ? `읽기 멈춤: ${follow.box.error}` : "읽기 멈춤");
    else if (follow && !available()) endFollow("읽을 수 없게 됨");
    // 읽기가 소리를 내는 동안(소리 만드는 중 포함 — 문단 사이에 오르내리지 않게) 폰 앱에 다른 소리를 줄여 달라고 한다(shellDuck).
    // 따라 읽기만이 아니라 모든 읽기(생각 상자·말·선택·따라 읽기 — 같은 재생기 하나)다(10-17 리규형님 "따라읽기 뿐 아니고, 모든 TTS 에").
    // 읽을 문단이 없어 기다리거나·일시정지·끔·설정 끔이면 되돌린다. PC 는 10-17 리규형님 "롤백" — 데몬 재생기가 빠르기를 올리면 앞 4초를 건너뛰었다
    const now = controller.current();
    setShellDuck(duckOwner, !!now && !now.paused && now.status !== "waiting" && currentSettings().followDuckPhone, log);
    const can = available();
    if (can !== wasAvailable) { wasAvailable = can; followChanged(); }
    dom.refresh();
    dock.refresh();
  };
  const dom = startTurnReadButtons((): TurnReadBinding => ({
    hostId,
    enabled: live && canSpeak && featureSwitches().tts,
    speedOptions: controller.speedOptions(),
    playing: box && playing()?.active ? { target, paused: playing()!.paused, rate: controller.rate, error: box.error, index: playing()!.index, status: playing()!.status } : null,
    failed,
    log: (message) => log(`turn read: ${message}`),
    fail,
    read: (nextTarget, text, from) => {
      const readHost = hostId;
      if (!readHost) { fail(nextTarget, "호스트 번호를 확인하지 못했습니다"); return; }
      const reason = !live ? "읽기 연결이 종료되었습니다" :
        !canSpeak ? "음성 합성 키를 확인하지 못했습니다" : !featureSwitches().tts ? "설정에서 소리 읽기가 꺼져 있습니다" :
        !text.trim() ? "화면에 읽을 글이 없습니다" : "";
      if (reason) { fail(nextTarget, reason); return; }
      failed = null;
      controller.dispose(made);
      made.clear();
      target = nextTarget;
      box = controller.box(readHost, `turn-read-${++serial}`, Date.now(), text, "complete");
      box.rpc = rpcFor("turn read");
      made.add(box);
      log(`turn read: 재생기 시작 ${text.length}자${from !== undefined ? ` · ${from + 1}번째 문단부터` : ""}`);
      // 선택한 문단이 있으면 그 문단 처음부터(10-13 리규형님 "그 문단부터")
      controller.start(box, false, from !== undefined ? { index: from, offset: 0 } : undefined);
    },
    previous: () => controller.previous(),
    toggle: () => playing()?.paused ? controller.resume() : controller.pause(),
    stop: () => controller.stop(),
    next: () => controller.next(),
    speed: (value) => controller.setSpeed(value),
    follow: follow && hostId ? {
      agentId: follow.agentId,
      session: follow.session,
      from: follow.from,
      idle: statuses.get(follow.agentId) !== "running",
      index: controller.state(follow.box).active ? controller.state(follow.box).index : null,
      push: pushFollow,
    } : null,
  }));
  // 입력창 위 읽기 컨트롤러 하나(10-11) — 턴·말·생각 상자·꺼낸 말 무엇을 읽든 이 재생기의 지금 읽는 것을 본다
  const dock = startReadDock(() => {
    const now = live && featureSwitches().tts ? controller.current() : null;
    return {
      playing: now ? { paused: now.paused, rate: controller.rate, error: now.box.error } : null,
      speedOptions: controller.speedOptions(),
      previous: () => controller.previous(),
      toggle: () => controller.current()?.paused ? controller.resume() : controller.pause(),
      stop: () => controller.stop(),
      next: () => controller.next(),
      speed: (value) => controller.setSpeed(value),
    };
  });
  // 호스트 번호가 없는 연결은 다른 서버의 키로 읽지 않는다. 화면 fiber 의 serverId 와 대조한다.
  void client.rpc(hostInfo, {}).then((info) => { if (live) { hostId = info.serverId ?? null; if (hostId && speechSettings) controller.applySpeech(hostId, speechSettings); log(`turn read: 호스트 ${hostId ? "확인" : "번호 없음"}`); refresh(); } }, (error: unknown) => { if (live) log(`turn read: host check failed ${String(error)}`); });
  const checkKeys = () => {
    const mine = ++keyCheck;
    void Promise.all([client.rpc(googleStatus, {}), client.rpc(speechGet, { lang: uiLanguage() })]).then(([status, speech]) => {
      if (!live || mine !== keyCheck) return;
      speechSettings = speech.settings;
      if (hostId) controller.applySpeech(hostId, speech.settings);
      canSpeak = status.tts;
      log(`turn read: 음성 합성 키 ${canSpeak ? "있음" : "없음"}`);
      if (!canSpeak && box && playing()?.active) controller.stop();
      refresh();
    }, (error: unknown) => {
      if (!live || mine !== keyCheck) return;
      canSpeak = false;
      if (box && playing()?.active) controller.stop();
      refresh();
      log(`turn read: key check failed ${String(error)}`);
    });
  };
  checkKeys();
  const stopKeys = onSharedSignal("googleKeys", checkKeys);
  const stopSettings = onSharedSignal("settings", () => {
    if (!featureSwitches().tts && box && playing()?.active) controller.stop();
    refresh();
  });
  const stopController = controller.subscribe(refresh);
  // 불투명 띠·맨 아래로 단추 띄우기·아이콘 가운데는 선택 읽기 알약과 독립적으로 유지한다.
  const stopRail = startComposerRail();
  return {
    dispose: () => {
      endFollow("플러그인 종료");
      setShellDuck(duckOwner, false, log);
      live = false;
      stopPick();
      keyCheck++;
      stopKeys();
      stopSettings();
      stopController();
      controller.dispose(made);
      made.clear();
      dom.dispose();
      dock.dispose();
      stopRail();
      followListeners.clear();
    },
    follow: {
      available,
      agentId: () => follow?.agentId ?? null,
      toggle: (agentId) => {
        if (follow?.agentId === agentId) { endFollow("알약"); dom.refresh(); return; }
        startFollow(agentId);
      },
      observe: (agent) => {
        const before = statuses.get(agent.id);
        const now = agent.status ?? "";
        statuses.set(agent.id, now);
        // 일하다 쉬면 마지막 문단을 끝난 글로 넘겨야 한다 — 따라 읽는 대화의 상태가 바뀌면 화면을 다시 본다
        if (follow?.agentId === agent.id && before !== now) dom.refresh();
      },
      forget: (agentId) => {
        statuses.delete(agentId);
        if (follow?.agentId === agentId) endFollow("대화 없어짐");
      },
      subscribe: (fn) => {
        followListeners.add(fn);
        return () => { followListeners.delete(fn); };
      },
    },
  };
}
