import type { ProjectEntry } from "../shared/projects";
import { norm } from "./projectsData";

// 하위 공간(10-24 리규형님 "하위 스페이스는 메인에 얽매인 거잖아 — 접을 수 있으면 좋겠는데, 한데 몰려 있어야겠지. 플젝 생성할 때하고
// 활성·고정에서 얘들끼리는 몰려 다닐 수 있게") — 같은 경로로 또 추가해 만든 워크트리 항목을 메인 아래에 묶는다.
// 왼쪽 목록(projectsList)과 프로젝트 관리 화면(projectsManage)이 같이 쓴다. 화면 부품을 쓰지 않아 시험이 그대로 불러 쓴다

/**
 * 하위 → 메인. 항목의 parent(메인 경로, 같은 기기)로 찾는다. parent 가 없으면 경로가 같은 기기 다른 항목의 `<경로>/.worktrees/` 아래인지로 —
 * parent 를 적기 전(10-24 새벽)에 만든 하위(Mesa Potal1~3)용이다. 콜어드민은 모든 프로젝트의 워크트리가 `/hosting/mesa/.worktrees` 에
 * 생겨 이 판정만으로는 남의 하위를 Mesa 것으로 볼 수 있지만, 그 뒤로 만든 하위는 parent 가 있어 여기까지 오지 않는다.
 * 메인이 또 하위면 맨 위 메인으로 올린다(하위의 경로로 또 추가한 경우)
 */
export function mainsOf(entries: readonly ProjectEntry[]): Map<ProjectEntry, ProjectEntry> {
  const byPath = new Map<string, ProjectEntry>();
  for (const e of entries) {
    const k = `${e.host}|${norm(e.path)}`;
    // 같은 경로가 여럿이면(10-23 이름만 다르게 넣던 시절) parent 없는 첫 항목이 메인
    const had = byPath.get(k);
    if (!had || (had.parent && !e.parent)) byPath.set(k, e);
  }
  const direct = new Map<ProjectEntry, ProjectEntry>();
  for (const e of entries) {
    let m: ProjectEntry | undefined;
    if (e.parent) m = byPath.get(`${e.host}|${norm(e.parent)}`);
    else {
      const p = norm(e.path);
      for (const o of entries) {
        if (o === e || o.host !== e.host) continue;
        const base = norm(o.path);
        if (p.startsWith(`${base}/.worktrees/`) && (!m || base.length > norm(m.path).length)) m = o;
      }
    }
    if (m && m !== e) direct.set(e, m);
  }
  const top = new Map<ProjectEntry, ProjectEntry>();
  for (const [e, m] of direct) {
    let root = m;
    const seen = new Set<ProjectEntry>([e]);
    for (let next = direct.get(root); next && !seen.has(root); next = direct.get(root)) {
      seen.add(root);
      root = next;
    }
    if (root !== e) top.set(e, root);
  }
  return top;
}

export type GroupItems = { items: ProjectEntry[]; dragged: Set<ProjectEntry> };

/**
 * 묶음마다 들어갈 항목 — 활성(열린 대화)·고정·원래 카테고리 묶음에 넣는 것은 그대로(projectsList 10-07·10-13 규칙)이고, 하위가 들어간
 * 묶음에는 메인도 함께 넣는다. 메인이 그 묶음 소속이 아니어도 — 활성 칸에서 메인 대화가 닫혀 있을 때, 찾기에 하위만 걸렸을 때
 * (10-24 리규형님 버튼 "메인 줄도 함께 올리기"). 끌려온 메인은 dragged 에 둔다(묶음 머리 숫자에서 뺀다). 카테고리 묶음은 메인이 같은
 * 묶음일 때만 끌어온다. 고정은 메인 핀 하나로 묶음 전체(10-24 리규형님 버튼) — 하위는 자기 핀이 아니라 메인 핀을 본다
 */
export function placeEntries(
  entries: readonly ProjectEntry[],
  mains: Map<ProjectEntry, ProjectEntry>,
  o: {
    show: (e: ProjectEntry) => boolean;
    matches: (e: ProjectEntry) => boolean;
    live: (e: ProjectEntry) => boolean;
    pinned: (e: ProjectEntry) => boolean;
    category: (e: ProjectEntry) => string;
    activeGroup: string;
    pinnedGroup: string;
  },
): Map<string, GroupItems> {
  const out = new Map<string, GroupItems>();
  const put = (g: string, e: ProjectEntry, dragged: boolean) => {
    let group = out.get(g);
    if (!group) out.set(g, (group = { items: [], dragged: new Set() }));
    if (!group.items.includes(e)) {
      group.items.push(e);
      if (dragged) group.dragged.add(e);
    } else if (!dragged) group.dragged.delete(e);
  };
  for (const e of entries) {
    if (!o.show(e) || !o.matches(e)) continue;
    const m = mains.get(e);
    const groups: string[] = [];
    if (o.live(e)) groups.push(o.activeGroup);
    if (o.pinned(m ?? e)) groups.push(o.pinnedGroup);
    groups.push(o.category(e));
    for (const g of groups) {
      put(g, e, false);
      if (m && o.show(m) && (g === o.activeGroup || g === o.pinnedGroup || g === o.category(m))) put(g, m, true);
    }
  }
  return out;
}

export type ListRow = { e: ProjectEntry; sub: boolean; subs: ProjectEntry[] };

/**
 * 정렬된 묶음 하나를 줄로 — 하위는 메인 바로 아래에 이름 번호순(Mesa Potal1·2·…·10). 메인 줄의 subs 는 이 묶음 안 하위.
 * 메인이 이 묶음에 없는 하위(다른 카테고리로 옮긴 것)는 보통 줄로 둔다
 */
export function arrangeRows(sorted: readonly ProjectEntry[], mains: Map<ProjectEntry, ProjectEntry>): ListRow[] {
  const here = new Set(sorted);
  const subsOf = new Map<ProjectEntry, ProjectEntry[]>();
  for (const e of sorted) {
    const m = mains.get(e);
    if (m && here.has(m)) subsOf.set(m, [...(subsOf.get(m) ?? []), e]);
  }
  const rows: ListRow[] = [];
  for (const e of sorted) {
    const m = mains.get(e);
    if (m && here.has(m)) continue;
    const subs = (subsOf.get(e) ?? []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    rows.push({ e, sub: false, subs });
    for (const s of subs) rows.push({ e: s, sub: true, subs: [] });
  }
  return rows;
}
