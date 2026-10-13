import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startRouter } from "./server/router";

// peer-mail — Paseo 대화끼리 묻고 알리기의 PC 중계기(리모트 컨트롤 없이). 이 플러그인은 PC 에만 설치한다.
// 서버에는 플러그인 없이 runtime/ 의 스크립트(bridge.cjs·mail.cjs)만 둔다 — PC 가 SSH 로 띄운다.
export default function contribute(_server: PluginServerContext) {
  const stop = startRouter();
  return () => stop();
}
