import type { ProjectEntry } from "../../shared/projects/projects";

// 직원 화면 목록 합치기(10-20 — 대표님이 IVR·콜어드민 두 서버에 직원 데몬을 갖게 되며 처음 붙은 데몬 목록만 보이던 것).
// 직원 데몬마다 서버 팀원 도구가 그 서버 프로젝트만 목록에 적는다(맨 위에 직원 홈) — 화면이 데몬마다 받아 합친다.
// 직원 데몬 목록의 host 는 모두 "PC"(그 데몬 자기 기계)라 서버를 가릴 수 없어, 서버 이름을 host 에 넣고 연 데몬을 serverId 로 붙인다.
// 이 파일은 가벼운 모듈만 불러온다(시험이 이 파일만 따로 불러온다)

export type StaffPart = {
  serverId: string;
  /** 그 데몬의 연결 이름(로그인 서버 이름표 "서버 · 아이디") — 없으면 serverId */
  label: string | null;
  data: { source: string | null; entries: ProjectEntry[]; readOnly?: boolean; error?: string } | null;
  /** 그 데몬에 묻지 못한 이유 */
  failure?: string;
};

export type StaffMerged = { source: string | null; entries: ProjectEntry[]; readOnly?: boolean; error?: string };

/** 연결 이름표 "AI_IVR_Server-Gabia · ceo" → 서버 이름 "AI_IVR_Server-Gabia" */
export function serverNameOf(label: string | null, serverId: string): string {
  const name = (label ?? "").split(" · ")[0].trim();
  return name || serverId;
}

const HOME = "홈";

export function mergeStaffProjects(parts: StaffPart[]): StaffMerged {
  const ok = parts.filter((p) => p.data && !p.data.error);
  if (ok.length === 0) {
    const why = parts.map((p) => `${serverNameOf(p.label, p.serverId)}: ${p.failure ?? p.data?.error ?? "응답 없음"}`).join(" · ");
    return { source: null, entries: [], error: why || "직원 데몬이 없습니다" };
  }
  const homes = ok.reduce((n, p) => n + p.data!.entries.filter((e) => e.category === HOME).length, 0);
  const entries: ProjectEntry[] = [];
  for (const p of ok) {
    const server = serverNameOf(p.label, p.serverId);
    for (const e of p.data!.entries) {
      // 홈은 서버마다 같은 이름(아이디)이라 둘 이상이면 어느 서버 홈인지 붙인다
      const name = e.category === HOME && homes > 1 ? `${e.name} · ${server}` : e.name;
      entries.push({ ...e, name, host: server, serverId: p.serverId });
    }
  }
  // 목록 파일 위치·읽기 전용은 예전(데몬 하나)처럼 먼저 붙은 데몬 것을 따른다
  return { source: ok[0].data!.source, entries, ...(ok[0].data!.readOnly !== undefined ? { readOnly: ok[0].data!.readOnly } : {}) };
}
