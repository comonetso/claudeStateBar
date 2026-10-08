import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { layoutOwnerGet, layoutOwnerSet, type LayoutOwner } from "../shared/layoutSync";
import { appBundleId, isDesktopApp, readLocal, writeLocal } from "./web";

// 기준 화면(10-08 리규형님 결정: "PC 앱은 평소 사용하지 않고, 꼭 PC 앱에서 해야 하는 것이 있으면 PC 앱에서" → 대표 PC 웹은
// 설정 화면 버튼으로 지정). 기준 화면만 화면 구성을 PC 데몬에 저장하고(layoutSync) 새 판의 공통 설정 칸을 만든다(settingsSync seed).
//  - 대표가 없으면 예전 그대로 PC 앱이 기준이다(지정 전에는 아무것도 안 바뀐다)
//  - 대표가 있으면 그 브라우저만 기준 — 다른 브라우저·폰·가끔 켠 PC 앱은 가져가기만 하고, 데몬도 그 밖의 저장을 거절한다
// 브라우저 구분은 그 브라우저 저장소에 둔 무작위 번호다(같은 브라우저의 탭들은 같은 번호 — 마지막으로 바꾼 탭의 구성이 저장된다).
// 대표 정보는 PC 데몬에 있고 PC 플러그인 인스턴스만 묻는다(설정 화면·왼쪽 칸·맞추기가 모두 PC 플러그인 것이라 모듈 값으로 충분).

type Owner = NonNullable<LayoutOwner>;
const KEY = "claude-state-bar:screen-key";

let client: PluginClientContext | null = null;
let owner: Owner | null = null;
let known = false;
const listeners = new Set<() => void>();

function set(next: Owner | null): void {
  const same = known && (owner?.id ?? null) === (next?.id ?? null) && owner?.at === next?.at;
  owner = next;
  known = true;
  if (!same) for (const l of [...listeners]) l();
}

/** 이 브라우저의 번호(웹·PC 앱 화면만). 처음이면 만들어 저장한다. 저장소를 못 쓰면 null */
export function screenKey(): string | null {
  if (!appBundleId()) return null;
  const saved = readLocal(KEY);
  if (saved) return saved;
  const made =
    typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  writeLocal(KEY, made);
  return readLocal(KEY) === made ? made : null;
}

/** 대표로 저장할 이름 — 어느 브라우저인지 알아볼 만큼만(브라우저 · 운영체제) */
export function browserLabel(): string {
  if (isDesktopApp()) return "PC app";
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "";
  const name = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${name} · ${os}` : name;
}

/** 이 화면이 기준 화면인가. 대표가 있으면 그 브라우저만, 없으면 PC 앱. 아직 데몬에 못 물었으면 null */
export function isPublisher(): boolean | null {
  if (!known) return null;
  return owner ? owner.id === screenKey() : isDesktopApp();
}

/** 지금 아는 대표(없으면 null)와 물어본 적이 있는지 */
export function ownerState(): { owner: Owner | null; known: boolean } {
  return { owner, known };
}

/** 저장이 거절되며 알게 된 대표 등 — 데몬 답을 그대로 반영한다 */
export function noteOwner(next: Owner | null): void {
  set(next);
}

export function onOwnerChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 데몬에 다시 묻는다. 실패하면 아는 값을 그대로 둔다 */
export async function refreshOwner(): Promise<void> {
  if (!client) return;
  const r = await client.rpc(layoutOwnerGet, {});
  set(r.owner);
}

/** 이 브라우저를 대표로 */
export async function claimOwner(): Promise<void> {
  const key = screenKey();
  if (!client || !key) throw new Error("this screen cannot be the representative");
  const r = await client.rpc(layoutOwnerSet, { screen: key, label: browserLabel() });
  set(r.owner);
}

/** 대표를 풀어 PC 앱이 다시 기준이 되게 */
export async function releaseOwner(): Promise<void> {
  if (!client) throw new Error("not connected to the PC");
  const r = await client.rpc(layoutOwnerSet, { screen: null, label: "" });
  set(r.owner);
}

/** PC 플러그인이 시작할 때 — 대표를 한 번 묻는다. 끊기 함수 */
export function startScreenRole(c: PluginClientContext, log: (message: string) => void): () => void {
  client = c;
  void refreshOwner().then(
    () => log(`screen role: ${owner ? `representative ${owner.label}${owner.id === screenKey() ? " (this screen)" : ""}` : "no representative — the PC app saves"}`),
    (error: unknown) => log(`screen role: owner read failed ${String(error)}`),
  );
  return () => {
    if (client === c) client = null;
  };
}

/** 화면 부품용 — 대표가 바뀌면 다시 그린다 */
export function useScreenRole(): { owner: Owner | null; known: boolean; publisher: boolean | null; mine: boolean } {
  const [, bump] = useState(0);
  useEffect(() => onOwnerChange(() => bump((n) => n + 1)), []);
  return { owner, known, publisher: isPublisher(), mine: !!owner && owner.id === screenKey() };
}
