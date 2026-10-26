// 직원용 Paseo(서버 울타리 안 직원 데몬, 10-11)에 붙은 화면인지 — host.info 의 team 으로 정한다.
// 직원 화면은 PC 처럼 설정·사용량·프로젝트 목록을 붙이되, 관리 탭(프로젝트 관리·팀원 관리)은 숨긴다.
// 처음엔 직원 화면에 데몬이 하나뿐이라고 보고 마지막에 답한 데몬 하나만 기억했다. 10-20 대표님이 IVR·콜어드민 두 서버에 데몬을 갖게 되자
// 왼쪽 목록이 처음 붙은 데몬 것만 보였다 — 이제 직원 데몬을 데몬마다 기억한다. 데몬마다 플러그인이 따로 올라오므로 페이지 공용 자리에 둔다
import type { PluginClientContext } from "@getpaseo/plugin/client";

/** client = 그 데몬에 올라온 플러그인 연결 — 다른 직원 데몬의 목록을 그 데몬 플러그인에 직접 묻는다(client/projects/projectsData) */
type StaffHost = { serverId: string; home: string | null; client: Pick<PluginClientContext, "rpc"> | null };
type Shared = { hosts: StaffHost[]; listeners: Set<() => void>; homeOpened: boolean };

function shared(): Shared {
  const g = globalThis as Record<string, unknown>;
  return (g.__claudeStateBar_staffHosts_v1 ??= { hosts: [], listeners: new Set(), homeOpened: false }) as Shared;
}

function changed(): void {
  for (const f of [...shared().listeners]) {
    try { f(); } catch { /* 한 화면의 오류가 다른 화면을 막지 않게 */ }
  }
}

/** 그 데몬이 직원 데몬이면 기록한다(직원이 아니면 아무것도 안 한다). 돌려준 함수로 기록을 뺀다 — 그 데몬 플러그인이 내려갈 때 */
export function markTeamHost(
  serverId: string | null | undefined,
  team: boolean,
  home: string | null,
  client: Pick<PluginClientContext, "rpc"> | null = null,
): () => void {
  if (!team || !serverId) return () => {};
  const s = shared();
  const host: StaffHost = { serverId, home, client };
  s.hosts = [...s.hosts.filter((h) => h.serverId !== serverId), host];
  changed();
  return () => {
    const now = shared();
    if (!now.hosts.includes(host)) return;
    now.hosts = now.hosts.filter((h) => h !== host);
    changed();
  };
}

export function isTeamMember(): boolean {
  return shared().hosts.length > 0;
}

/** 기록된 직원 데몬들(먼저 붙은 차례) */
export function staffServerIds(): string[] {
  return shared().hosts.map((h) => h.serverId);
}

/** 그 직원 데몬에 올라온 플러그인 연결(없으면 null) */
export function staffClient(serverId: string): Pick<PluginClientContext, "rpc"> | null {
  return shared().hosts.find((h) => h.serverId === serverId)?.client ?? null;
}

export function watchStaffHosts(listener: () => void): () => void {
  shared().listeners.add(listener);
  return () => {
    shared().listeners.delete(listener);
  };
}

/**
 * 직원 화면이 붙은 자기 데몬(먼저 붙은 것) — 데몬을 못 찾은 직원 목록 항목은 여기서 연다. 처음 만든 직원 데몬은 아직 연 적 없는 폴더를
 * 프로젝트 목록(projects.list)에 안 줘서 경로로는 못 찾는다(10-11 대표님 새 계정 "연결된 Paseo 가 없어 열 수 없습니다").
 * 직원 데몬이 여럿이면 목록 항목에 데몬이 붙어 있어(client/projects/staffProjects) 이건 마지막 대안이다
 */
export function staffServerId(): string | undefined {
  return shared().hosts[0]?.serverId;
}

/** 아직 안 열었으면 직원 홈(먼저 붙은 데몬의 홈)을 돌려주고 연 것으로 친다(페이지를 새로 열 때마다 한 번) */
export function takeStaffHome(): { serverId: string; path: string } | null {
  const s = shared();
  const first = s.hosts.find((h) => h.home);
  if (!first?.home || s.homeOpened) return null;
  s.homeOpened = true;
  return { serverId: first.serverId, path: first.home };
}
