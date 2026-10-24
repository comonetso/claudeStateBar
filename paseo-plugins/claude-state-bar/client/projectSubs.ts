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

/** 왼쪽 목록 묶음 이름 — 프로젝트 관리 탭도 같은 묶음을 쓴다(10-24) */
export const PINNED_GROUP = "고정";
export const ACTIVE_GROUP = "활성";
export const DISABLED_GROUP = "숨김";
export type ListGroup = { name: string; rows: ListRow[]; count: number };

/**
 * 왼쪽 목록의 묶음과 줄 순서 — 왼쪽 목록과 프로젝트 관리 탭이 같이 쓴다(10-24 리규형님 "프로젝트 매니저도 왼쪽 리스트의 사용자
 * 경험대로"). 어느 묶음에 넣는지는 placeEntries — 아래 규칙에 "하위가 든 묶음엔 메인도"·"고정은 메인 핀으로"를 더했다.
 * 열린 대화가 있는 것(점이 회색·초록)은 고정이든 아니든 "활성"에 모은다 — 활성은 활성끼리 모아 보는 칸이고 고정은
 * 그대로 고정에 남는다(10-07 리규형님: "고정은 고정, 활성은 활성끼리"). 원래 묶음 쪽도 지금처럼(대화를 열고 닫을 때
 * 줄이 들락날락하지 않게). 고정한 것은 맨 위 "고정" 묶음에도 넣고 원래 묶음에도 그대로 둔다 — 원래 묶음에서 빠지면 지워진
 * 줄로 착각한다(10-06 처음엔 원래 묶음에서 뺐다 → 10-13 리규형님 "핀으로 고정을 해도 원래 카테에 남도록").
 * 숨긴 것(enabled false)은 카테고리 대신 맨 아래 "숨김" 묶음에만.
 */
export function groupProjects(
  entries: readonly ProjectEntry[],
  mains: Map<ProjectEntry, ProjectEntry>,
  o: {
    /** 찾기 글 */
    filter: string;
    /** 보일 것(팀원 화면은 숨긴 프로젝트를 아예 안 보인다) */
    show: (e: ProjectEntry) => boolean;
    /** 열린 대화가 있는가 */
    live: (e: ProjectEntry) => boolean;
    /** 고정 순서(키 목록) — 들어 있으면 고정 */
    pinOrder: readonly string[];
    /** 묶음별 끌어 놓은 순서(키 목록) — 활성은 activeOrderKey 칸 */
    orders: Readonly<Record<string, readonly string[]>>;
    activeOrderKey: string;
    /** 카테고리 번호 순서 */
    categories: readonly string[];
    untaggedGroup: string;
    /** 고정·순서 키(projectsData pinKey) */
    key: (e: ProjectEntry) => string;
  },
): ListGroup[] {
  const q = o.filter.trim().toLowerCase();
  const pins = new Set(o.pinOrder);
  const fileRank = new Map(entries.map((e, i) => [e, i] as const));
  const placed = placeEntries(entries, mains, {
    show: o.show,
    matches: (e) => !q || e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q) || e.category.toLowerCase().includes(q),
    live: o.live,
    pinned: (e) => pins.has(o.key(e)),
    category: (e) => (!e.enabled ? DISABLED_GROUP : e.category || o.untaggedGroup),
    activeGroup: ACTIVE_GROUP,
    pinnedGroup: PINNED_GROUP,
  });
  // 묶음 순서: 고정·활성은 맨 위, 카테고리는 번호 순서, 그다음 카테고리 없음, 숨김은 맨 아래(10-11 리규형님 "숨김은 이동에서 제외,
  // 항상 맨 끝" — 카테고리 없음도 번호가 없어 자리 고정)
  const order = o.categories.filter((g) => placed.has(g));
  if (placed.has(ACTIVE_GROUP)) order.unshift(ACTIVE_GROUP);
  if (placed.has(PINNED_GROUP)) order.unshift(PINNED_GROUP);
  if (placed.has(o.untaggedGroup)) order.push(o.untaggedGroup);
  if (placed.has(DISABLED_GROUP)) order.push(DISABLED_GROUP);
  // 고정 묶음은 고정 목록 파일의 순서. 나머지는 끌어 놓은 순서(묶음별 순서 파일) 다음에, 끌어 놓은 적 없는 것을 목록 파일
  // 순서로 뒤에 붙인다 — 활성에 처음 들어온 것은 맨 아래(10-07 리규형님 결정. 처음엔 이름순이었다가 같은 날 목록 파일 순서로).
  // 고정 여부·순서는 하위면 메인 것을 본다 — 하위는 메인 바로 아래에 붙는다(arrangeRows)
  const pinOwner = (e: ProjectEntry) => mains.get(e) ?? e;
  const pinRank = (e: ProjectEntry) => o.pinOrder.indexOf(o.key(pinOwner(e)));
  const sortIn = (g: string, items: ProjectEntry[]) => {
    if (g === PINNED_GROUP) return items.sort((a, b) => pinRank(a) - pinRank(b));
    const saved = o.orders[g === ACTIVE_GROUP ? o.activeOrderKey : g] ?? [];
    const rank = (e: ProjectEntry) => {
      const i = saved.indexOf(o.key(e));
      return i < 0 ? saved.length : i;
    };
    // 고정한 것은 원래 카테고리 안에서도 끌어 놓은 순서와 상관없이 맨 위, 고정 순서대로(10-13 리규형님 "즐겨찾기를 하면
    // 순서와 상관없이 해당 카테에서 최상단"). 활성 묶음은 대화를 열고 닫는 순서를 지키려고 그대로 둔다
    const pinFirst = g !== ACTIVE_GROUP;
    return items.sort((a, b) => {
      if (pinFirst) {
        const pa = pins.has(o.key(pinOwner(a)));
        const pb = pins.has(o.key(pinOwner(b)));
        if (pa !== pb) return pa ? -1 : 1;
        if (pa && pb) return pinRank(a) - pinRank(b);
      }
      return rank(a) - rank(b) || (fileRank.get(a) ?? 0) - (fileRank.get(b) ?? 0);
    });
  };
  return order.map((g) => {
    const { items, dragged } = placed.get(g) ?? { items: [], dragged: new Set<ProjectEntry>() };
    // 머리 숫자는 그 묶음 소속만 — 하위를 따라 끌려온 메인(활성 칸에서 메인 대화가 닫힌 것 등)은 빼고 센다
    return { name: g, rows: arrangeRows(sortIn(g, items), mains), count: items.length - dragged.size };
  });
}
