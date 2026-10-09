import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { hostInfo } from "../shared/sound";
import { translateKo } from "../shared/translate";
import { googleStatus, ttsSynthesize } from "../shared/tts";
import { featureSwitches, onSharedSignal } from "./sounds";
import { thinkingController as controller } from "./thinking";
import type { ThinkingBoxState } from "./thinkingPlayer";
import { startComposerRail, startTurnReadButtons, type TurnReadBinding } from "./web";

// 입력창 위 선택 읽기를 대신한다. 웹 DOM 은 web.ts 에만 두고 생각 상자의 재생기 하나를 같이 쓴다.
export function createTurnReadButtons(client: PluginClientContext, log: (message: string) => void): () => void {
  if (Platform.OS !== "web") return () => {};
  let live = true;
  let hostId: string | null = null;
  let canSpeak = false;
  let keyCheck = 0;
  let serial = 0;
  let target: unknown;
  let box: ThinkingBoxState | undefined;
  const made = new Set<ThinkingBoxState>();
  const playing = () => box ? controller.state(box) : undefined;
  const refresh = () => {
    if (!live) return;
    if (box && !playing()?.active) {
      if (box.error) log(`turn read: ${box.error}`);
      controller.dispose(made);
      made.clear();
      box = undefined;
      target = undefined;
    }
    dom.refresh();
  };
  const dom = startTurnReadButtons((): TurnReadBinding => ({
    hostId,
    enabled: live && canSpeak && featureSwitches().tts,
    speedOptions: controller.speedOptions(),
    playing: box && playing()?.active ? { target, paused: playing()!.paused, rate: controller.rate, error: box.error, index: playing()!.index } : null,
    read: (nextTarget, text) => {
      if (!live || !hostId || !canSpeak || !featureSwitches().tts) return;
      controller.dispose(made);
      made.clear();
      target = nextTarget;
      box = controller.box(hostId, `turn-read-${++serial}`, Date.now(), text, "complete");
      box.rpc = { translate: (input) => client.rpc(translateKo, input), synthesize: (input) => client.rpc(ttsSynthesize, input) };
      made.add(box);
      controller.start(box, false);
    },
    previous: () => controller.previous(),
    toggle: () => playing()?.paused ? controller.resume() : controller.pause(),
    stop: () => controller.stop(),
    next: () => controller.next(),
    speed: (value) => controller.setSpeed(value),
  }));
  // 호스트 번호가 없는 연결은 다른 서버의 키로 읽지 않는다. 화면 fiber 의 serverId 와 대조한다.
  void client.rpc(hostInfo, {}).then((info) => { if (live) { hostId = info.serverId ?? null; refresh(); } }, (error: unknown) => { if (live) log(`turn read: host check failed ${String(error)}`); });
  const checkKeys = () => {
    const mine = ++keyCheck;
    void client.rpc(googleStatus, {}).then((status) => {
      if (!live || mine !== keyCheck) return;
      canSpeak = status.tts;
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
    stopRail();
  };
}
