import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { hostInfo } from "../shared/sound";
import { translateKo } from "../shared/translate";
import { speechGet, type SpeechSettings } from "../shared/speech";
import { googleStatus, ttsSynthesize } from "../shared/tts";
import { uiLanguage } from "./appLanguage";
import { featureSwitches, onSharedSignal } from "./sounds";
import { thinkingController as controller } from "./thinking";
import type { ThinkingBoxState } from "./thinkingPlayer";
import { startComposerRail, startReadDock, startTurnReadButtons, type TurnReadBinding } from "./web";

// 입력창 위 선택 읽기를 대신한다. 웹 DOM 은 web.ts 에만 두고 생각 상자의 재생기 하나를 같이 쓴다.
export function createTurnReadButtons(client: PluginClientContext, log: (message: string) => void): () => void {
  if (Platform.OS !== "web") return () => {};
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
    read: (nextTarget, text) => {
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
      box.rpc = { translate: (input) => client.rpc(translateKo, input), synthesize: async (input) => {
        log(`turn read: 음성 합성 요청 ${input.text.length}자`);
        const result = await client.rpc(ttsSynthesize, input);
        log(`turn read: 음성 합성 ${result.ok ? "성공" : "실패"}`);
        return result;
      } };
      made.add(box);
      log(`turn read: 재생기 시작 ${text.length}자`);
      controller.start(box, false);
    },
    previous: () => controller.previous(),
    toggle: () => playing()?.paused ? controller.resume() : controller.pause(),
    stop: () => controller.stop(),
    next: () => controller.next(),
    speed: (value) => controller.setSpeed(value),
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
  return () => {
    live = false;
    keyCheck++;
    stopKeys();
    stopSettings();
    stopController();
    controller.dispose(made);
    made.clear();
    dom.dispose();
    dock.dispose();
    stopRail();
  };
}
