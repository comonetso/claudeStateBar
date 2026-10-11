import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { CATEGORY_ORDER_KEY, projectsEdit, projectsHosts, UNTAGGED_GROUP, type ProjectEntry, type ProjectsEditOp } from "../shared/projects";
import { scaled, useFontScale } from "./fontScale";
import { moveCategory, orderedCategories, pinKey, useGroupOrders, type ProjectsData } from "./projectsData";
import { FIELD_WIDTH, HelpTip, UiButton, UiInput, UiSelect } from "./ui";
import { setDraggableRow, setHoverTitle, setNoTranslate } from "./web";

// 프로젝트 관리 화면(10-10 리규형님: "사용자들이 json 을 건드는 건 좀 그래서" — 목록 파일 직접 편집 대신).
// 결정: 이름 바꾸기·카테고리 옮기기 / 추가·삭제 / 숨김·보임 / 카테고리 이름 바꾸기·지우기 · 오른쪽 클릭 메뉴는 없다 ·
// 추가할 기기 = PC + ~/.ssh/config · 옮기면 그 묶음 맨 아래 · 카테고리를 지우면 안의 프로젝트는 "카테고리 없음"으로 · 경로는 직접 입력.
// 실제 폴더는 건드리지 않고 목록 파일만 고친다(server/projectsEdit).
// 10-11 리규형님: 새 프로젝트 칸은 카테고리를 맨 위로, 입력칸은 흐린 안내 글 대신 왼쪽 이름표 · 카테고리 번호는 이름에서 떼고
// 카테고리 머리를 끌어 옮긴 순서대로 붙인다(왼쪽 목록과 같은 순서 파일) · "꺼짐/끄기/켜기" → "숨김/보임" · 목록 파일 편집 단추는
// "프로젝트 파일 수정"으로 이 탭 맨 위 오른쪽. 묶음은 카테고리 기준(숨긴 것도 원래 카테고리 안에 "(숨김)") — 왼쪽 목록의 "숨김" 묶음과 다르다.
// 팀원 프로젝트(teamManage, 10-11)도 같은 편집기를 쓴다 — 팀원(1단계) → 그 팀원의 카테고리(2단계) → 프로젝트.
// 10-11 저녁 리규형님: 카테고리·디바이스(옛 "기기")는 단추를 늘어놓지 말고 선택 상자, 새 카테고리 칸은 카테고리 상자 오른쪽 ·
// 칸 아래 도움말 글은 칸 옆 "?" 풍선으로 · 입력칸 폭 FIELD_WIDTH(처음 300 → 같은 날 400) · 디바이스는 실제 기기만(github.com 같은 SSH 항목은 뺀다).
// 입력칸·선택 상자·단추·풍선은 공용 부품(client/ui.tsx — 밝은 테두리)을 쓴다.

/** 편집 단위 — 리규형님 목록은 하나(id ""), 팀원 프로젝트는 팀원마다 하나 */
export type EditScope = {
  id: string;
  /** 1단계 머리(팀원 아이디). 리규형님 목록은 없다 */
  title?: string;
  entries: ProjectEntry[];
  /** 끌어 놓은 카테고리 순서(번호) */
  categoryOrder: string[];
  /** 새 프로젝트를 둘 기기 */
  hosts: string[];
  /** 1단계 머리 오른쪽에 붙일 것(팀원 프로젝트: 서버 반영 상태·단추) */
  extra?: ReactNode;
  /** 1단계 머리 아래에 붙일 것(서버 작업 진행) */
  below?: ReactNode;
  /**
   * 맨 위에 고정하는 기본 프로젝트(팀원 홈 /home/<아이디> — 10-11 리규형님 "삭제 불가, 항상 최상위") — 고치기 단추가 없다.
   * category 는 추가할 때 카테고리 선택지 맨 앞에 넣는다(리규형님 "홈도 선택할 수 있게")
   */
  pinned?: { name: string; host: string; path: string; category?: string }[];
};

type EditorProps = {
  theme: PluginTheme;
  scopes: EditScope[];
  edit: (scope: string, op: ProjectsEditOp) => Promise<{ ok: boolean; error?: string }>;
  setCategoryOrder: (scope: string, names: string[]) => void;
  /** 맨 위 설명 줄 */
  intro: string;
  /** 설명 줄 오른쪽 단추(프로젝트 파일 수정) */
  headerAction?: ReactNode;
  notice?: string | null;
  error?: string;
  emptyText: string;
  /** 1단계 이름표(팀원 프로젝트 = "팀원"). 있으면 새 프로젝트 칸 맨 위에 그 줄이 생기고 목록이 팀원별로 묶인다 */
  scopeLabel?: string;
  /** 폴더 경로 칸 아래 도움말 */
  pathHint: (host: string) => string;
};

export function ProjectsEditor({ theme, scopes, edit, setCategoryOrder, intro, headerAction, notice, error, emptyText, scopeLabel, pathHint }: EditorProps) {
  const c = theme.colors;
  const scale = useFontScale();
  const fs = (px: number) => scaled(px + 3, scale);

  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (scope: string, op: ProjectsEditOp, done: string): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await edit(scope, op);
      if (!r.ok) {
        setMessage({ text: r.error ?? "고치지 못했습니다", bad: true });
        return false;
      }
      setMessage({ text: done, bad: false });
      return true;
    } catch (err) {
      setMessage({ text: `고치지 못했습니다: ${String(err instanceof Error ? err.message : err)}`, bad: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // 카테고리 순서 = 번호 — 끌어 놓은 순서 다음에 목록에 처음 나오는 순서. 카테고리 없음은 번호 없이 맨 끝
  const catsOf = useMemo(() => new Map(scopes.map((s) => [s.id, orderedCategories(s.entries, s.categoryOrder)] as const)), [scopes]);
  const label = (cats: string[], name: string) => (name ? `${cats.indexOf(name) + 1}. ${name}` : UNTAGGED_GROUP);

  const [filter, setFilter] = useState("");
  const groupsOf = (s: EditScope) => {
    const q = filter.trim().toLowerCase();
    const shown = s.entries.filter((e) => !q || e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q) || e.category.toLowerCase().includes(q));
    const list = (catsOf.get(s.id) ?? []).map((name) => ({ name, items: shown.filter((e) => e.category === name) }));
    list.push({ name: "", items: shown.filter((e) => !e.category) });
    return list.filter((g) => g.items.length > 0);
  };

  // 새 프로젝트 — 팀원(팀원 프로젝트만) · 카테고리 · 기기 · 폴더 경로 · 이름.
  // 팀원·디바이스는 처음에 "선택"(빈 값) — 저절로 첫 항목이 골라져 엉뚱한 곳에 넣지 않게(10-11 리규형님)
  const [scopeId, setScopeId] = useState("");
  const formScope = scopeLabel ? scopes.find((s) => s.id === scopeId) : scopes[0];
  // 고정 기본 프로젝트의 카테고리(팀원 "홈")는 목록에 없어도 맨 앞에 — 그 안에 프로젝트를 더 넣을 수 있게
  const formCats = formScope
    ? [...new Set([...(formScope.pinned ?? []).map((p) => p.category ?? "").filter(Boolean), ...(catsOf.get(formScope.id) ?? [])])]
    : [];
  const [hostPick, setHost] = useState("");
  const host = formScope?.hosts.includes(hostPick) ? hostPick : "";
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [catPick, setPickCat] = useState("");
  const pickCat = formCats.includes(catPick) ? catPick : "";
  const [newCat, setNewCat] = useState("");
  const add = async () => {
    if (!formScope) {
      const word = scopeLabel ?? "편집 단위";
      const last = word.charCodeAt(word.length - 1);
      const batchim = last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 !== 0;
      return setMessage({ text: `${word}${batchim ? "을" : "를"} 골라 주세요`, bad: true });
    }
    if (!host) return setMessage({ text: "디바이스를 골라 주세요", bad: true });
    const ok = await run(formScope.id, { op: "add", host, path, name, category: newCat.trim() || pickCat }, "추가했습니다");
    if (ok) {
      setPath("");
      setName("");
      setNewCat("");
    }
  };

  // 줄·묶음 단위로 지금 무엇을 하고 있는지 — 한 번에 하나만. 키는 "<편집 단위>|<기기>|<경로>"·"<편집 단위>|<카테고리>"
  const [renaming, setRenaming] = useState<{ key: string; draft: string } | null>(null);
  const [moving, setMoving] = useState<{ key: string; draft: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [catRenaming, setCatRenaming] = useState<{ key: string; draft: string } | null>(null);
  const [confirmCatDelete, setConfirmCatDelete] = useState<string | null>(null);
  // 디바이스·경로는 평소 접어 두고 이름을 누르면 펼친다(10-12 리규형님: "평소에는 안 보는 정보" — 마우스 오버 말고 클릭).
  // 이름 바꾸기는 펼친 칸 안 단추로 옮겼다
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // 새 프로젝트 칸·팀원 묶음도 평소 접어 둔다(10-12 리규형님: 팀원이 10명이면 다 펼쳐진 게 어지럽다 — 두 탭 모두).
  // 찾기 글이 있으면 팀원 묶음은 펼친 것으로 본다(접혀 있으면 찾은 것이 안 보이니까)
  const [formOpen, setFormOpen] = useState(false);
  const chevron = (open: boolean, size: number) => <Icon name={open ? "ChevronDown" : "ChevronRight"} size={size} color={c.foregroundMuted} />;
  const resetRow = () => {
    setRenaming(null);
    setMoving(null);
    setConfirmRemove(null);
    setCatRenaming(null);
    setConfirmCatDelete(null);
  };

  const muted = (text: string, size = 11) => <Text style={{ fontSize: fs(size), color: c.foregroundMuted }}>{text}</Text>;
  const button = (text: string, onPress: () => void, opts: { tone?: "danger" | "accent"; on?: boolean; hint?: string } = {}) => (
    <UiButton key={text} theme={theme} label={text} fontSize={fs(11)} onPress={onPress} disabled={busy} tone={opts.tone} on={opts.on} hint={opts.hint} />
  );
  const escape = (cancel: () => void) => ({ nativeEvent }: { nativeEvent: { key: string } }) => {
    if (nativeEvent.key === "Escape") cancel();
  };
  // 새 프로젝트 칸 한 줄 — 왼쪽 이름표 + 입력(10-11 리규형님: 흐린 안내 글로 이름을 대신하지 말고 이름표를 붙인다).
  // 도움말은 칸 옆 "?" 풍선(HelpTip)
  const labelWidth = fs(11) * 5.5;
  const field = (fieldLabel: string, content: ReactNode) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ width: labelWidth, fontSize: fs(11), color: c.foregroundMuted }}>{fieldLabel}</Text>
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>{content}</View>
    </View>
  );
  const help = (text: string) => <HelpTip theme={theme} text={text} fontSize={fs(11)} />;

  const row = (s: EditScope, cats: string[], e: ProjectEntry) => {
    const key = pinKey(e);
    const rowKey = `${s.id}|${key}`;
    const editingName = renaming?.key === rowKey;
    const movingHere = moving?.key === rowKey;
    const open = expanded.has(rowKey);
    return (
      <View key={rowKey} style={{ gap: 6, paddingVertical: 6, paddingLeft: 12, borderBottomWidth: 1, borderColor: c.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 160 }}>
            {editingName ? (
              <UiInput theme={theme} fontSize={fs(12)}
                autoFocus
                selectTextOnFocus
                value={renaming.draft}
                onChangeText={(draft) => setRenaming({ key: rowKey, draft })}
                onSubmitEditing={() => {
                  const draft = renaming.draft;
                  setRenaming(null);
                  if (draft.trim() && draft.trim() !== e.name) void run(s.id, { op: "rename", key, name: draft }, "이름을 바꿨습니다");
                }}
                onKeyPress={escape(() => setRenaming(null))}
                onBlur={() => setRenaming(null)}
              />
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${e.name} 디바이스·경로 ${open ? "접기" : "보기"}`}
                ref={(node: unknown) => setHoverTitle(node, open ? "눌러서 접기" : "눌러서 디바이스·경로 보기")}
                onPress={() => toggleExpanded(rowKey)}
              >
                <Text style={{ fontSize: fs(13), color: e.enabled ? c.foreground : c.foregroundMuted }} numberOfLines={1}>
                  {e.name}
                  {e.enabled ? "" : "  (숨김)"}
                  {e.missing ? <Text style={{ fontSize: fs(10), color: c.foregroundMuted }}>{"  · 폴더 없음"}</Text> : null}
                </Text>
              </Pressable>
            )}
            {open ? (
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                <Text style={{ fontSize: fs(10), color: c.foregroundMuted }} numberOfLines={1}>
                  {e.host} · {e.path}
                </Text>
                {editingName
                  ? null
                  : button("이름 바꾸기", () => {
                      resetRow();
                      setRenaming({ key: rowKey, draft: e.name });
                    }, { hint: "Enter 저장, Esc 취소" })}
              </View>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {button("옮기기", () => {
              const open = !movingHere;
              resetRow();
              if (open) setMoving({ key: rowKey, draft: "" });
            }, { on: movingHere, hint: "다른 카테고리로 옮기기 — 그 묶음 맨 아래로 갑니다" })}
            {button(e.enabled ? "숨김" : "보임", () => {
              resetRow();
              void run(s.id, { op: "enabled", key, enabled: !e.enabled }, e.enabled ? "숨겼습니다 — 목록에서는 맨 아래 \"숨김\" 묶음에 들어갑니다" : "다시 보이게 했습니다");
            }, { hint: e.enabled ? "목록 맨 아래 \"숨김\" 묶음으로 보냅니다" : "원래 카테고리로 되돌립니다" })}
            {confirmRemove === rowKey
              ? [
                  button("정말 삭제", () => {
                    resetRow();
                    void run(s.id, { op: "remove", key }, "목록에서 지웠습니다(폴더는 그대로입니다)");
                  }, { tone: "danger" }),
                  button("취소", () => setConfirmRemove(null)),
                ]
              : button("삭제", () => {
                  resetRow();
                  setConfirmRemove(rowKey);
                }, { tone: "danger", hint: "목록에서만 지웁니다 — 실제 폴더는 그대로" })}
          </View>
        </View>
        {movingHere ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingLeft: 4 }}>
            {/* 고정 기본 프로젝트의 카테고리(팀원 "홈")로도 옮길 수 있게 — 목록에 아직 없으면 번호 없이 이름만 */}
            {[...new Set([...(s.pinned ?? []).map((p) => p.category ?? "").filter(Boolean), ...cats, ""])].filter((cat) => cat !== e.category).map((cat) =>
              button(cats.includes(cat) || !cat ? label(cats, cat) : cat, () => {
                resetRow();
                void run(s.id, { op: "category", key, category: cat }, `"${cat || UNTAGGED_GROUP}" 로 옮겼습니다`);
              }),
            )}
            {muted("새 카테고리")}
            <UiInput theme={theme} fontSize={fs(12)}
              value={moving.draft}
              onChangeText={(draft) => setMoving({ key: rowKey, draft })}
              onSubmitEditing={() => {
                const draft = moving.draft.trim();
                if (!draft) return;
                resetRow();
                void run(s.id, { op: "category", key, category: draft }, `"${draft}" 로 옮겼습니다`);
              }}
              onKeyPress={escape(() => setMoving(null))}
              style={{ minWidth: 140 }}
            />
          </View>
        ) : null}
      </View>
    );
  };

  const categoryGroups = (s: EditScope) => {
    const cats = catsOf.get(s.id) ?? [];
    // 카테고리 머리를 끌어 놓은 자리로(10-11 리규형님) — 번호가 이 순서대로 바뀐다. 카테고리 없음은 자리 고정
    const onDropCategory = (from: string, to: string, after: boolean) => {
      const next = moveCategory(cats, from, to, after);
      if (next) setCategoryOrder(s.id, next);
    };
    return groupsOf(s).map((g) => {
      const untagged = !g.name;
      const catKey = `${s.id}|${g.name}`;
      const editingCat = catRenaming?.key === catKey && !untagged;
      return (
        <View key={catKey} style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingVertical: 4 }}>
            {editingCat ? (
              <UiInput theme={theme} fontSize={fs(12)}
                autoFocus
                selectTextOnFocus
                value={catRenaming.draft}
                onChangeText={(draft) => setCatRenaming({ key: catKey, draft })}
                onSubmitEditing={() => {
                  const draft = catRenaming.draft.trim();
                  setCatRenaming(null);
                  if (draft && draft !== g.name) void run(s.id, { op: "renameCategory", from: g.name, to: draft }, `카테고리 이름을 "${draft}" 로 바꿨습니다`);
                }}
                onKeyPress={escape(() => setCatRenaming(null))}
                onBlur={() => setCatRenaming(null)}
                style={{ minWidth: 180 }}
              />
            ) : (
              <View
                ref={(node: unknown) => {
                  if (untagged) return;
                  setDraggableRow(node, g.name, `:manage-categories|${s.id}`, c.accent, onDropCategory);
                  setHoverTitle(node, "끌어서 카테고리 순서 바꾸기 — 번호가 이 순서대로 붙습니다");
                }}
                style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
              >
                {untagged ? null : <Icon name="GripVertical" size={fs(13)} color={c.foregroundMuted} />}
                <Text style={{ fontSize: fs(13), fontWeight: "600", color: c.foregroundMuted }}>{label(cats, g.name)}</Text>
                <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>{g.items.length}</Text>
              </View>
            )}
            {untagged || editingCat ? null : (
              <>
                {button("이름 바꾸기", () => {
                  resetRow();
                  setCatRenaming({ key: catKey, draft: g.name });
                }, { hint: "카테고리 이름 바꾸기 — 안의 프로젝트가 함께 따라갑니다. 있는 이름이면 두 묶음이 합쳐집니다" })}
                {confirmCatDelete === catKey
                  ? [
                      button("정말 지우기", () => {
                        resetRow();
                        void run(s.id, { op: "deleteCategory", name: g.name }, `"${g.name}" 를 지웠습니다 — 안의 프로젝트는 "${UNTAGGED_GROUP}" 로 갔습니다`);
                      }, { tone: "danger" }),
                      button("취소", () => setConfirmCatDelete(null)),
                    ]
                  : button("지우기", () => {
                      resetRow();
                      setConfirmCatDelete(catKey);
                    }, { tone: "danger", hint: `카테고리만 지웁니다 — 안의 프로젝트는 "${UNTAGGED_GROUP}" 로 갑니다` })}
              </>
            )}
          </View>
          {g.items.map((e) => row(s, cats, e))}
        </View>
      );
    });
  };

  const total = scopes.reduce((n, s) => n + s.entries.length, 0);
  return (
    <View ref={setNoTranslate} style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1 }}>{muted(intro)}</View>
        {headerAction}
      </View>
      {message ? <Text style={{ fontSize: fs(12), color: message.bad ? c.statusDanger : c.statusSuccess }}>{message.text}</Text> : null}
      {notice ? <Text style={{ fontSize: fs(12), color: c.statusWarning }}>{notice}</Text> : null}
      {error ? <Text style={{ fontSize: fs(12), color: c.statusDanger }}>{error}</Text> : null}

      {/* 새 프로젝트 */}
      {formScope || (scopeLabel && scopes.length > 0) ? (
        <View style={{ gap: 8, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={formOpen ? "새 프로젝트 칸 접기" : "새 프로젝트 칸 열기"}
            onPress={() => setFormOpen((v) => !v)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            {chevron(formOpen, fs(13))}
            <Icon name="FolderPlus" size={fs(14)} color={c.accent} />
            <Text style={{ fontSize: fs(13), fontWeight: "600", color: c.foreground }}>새 프로젝트</Text>
          </Pressable>
          {formOpen ? (
          <>
          {scopeLabel
            ? field(
                scopeLabel,
                <UiSelect
                  theme={theme}
                  fontSize={fs(12)}
                  value={formScope?.id ?? ""}
                  options={[{ value: "", label: `${scopeLabel} 선택` }, ...scopes.map((s) => ({ value: s.id, label: s.title ?? s.id }))]}
                  onChange={setScopeId}
                />,
              )
            : null}
          {field(
            "카테고리",
            <>
              {/* 선택 상자에는 번호 없이 이름만(10-11 리규형님) · 새 카테고리 칸에 이름이 있으면 그쪽이 쓰여 상자는 흐리게 */}
              <UiSelect theme={theme} fontSize={fs(12)} dim={!!newCat.trim()} value={pickCat} options={[...formCats, ""].map((cat) => ({ value: cat, label: cat || UNTAGGED_GROUP }))} onChange={(v) => {
                setPickCat(v);
                if (v) setNewCat("");
              }} />
              {muted("새 카테고리")}
              {/* 기존 카테고리를 고르면 새 카테고리 칸은 막는다(10-11 리규형님) */}
              <UiInput theme={theme} fontSize={fs(12)} value={newCat} onChangeText={setNewCat} editable={!pickCat} style={{ width: 180, opacity: pickCat ? 0.5 : 1 }} />
              {help("새 카테고리 칸에 이름을 넣으면 그 이름으로 새로 만들어 넣습니다(카테고리 상자가 '카테고리 없음'일 때만)")}
            </>,
          )}
          {field(
            "디바이스",
            !formScope || formScope.hosts.length ? (
              <UiSelect
                theme={theme}
                fontSize={fs(12)}
                value={host}
                options={[{ value: "", label: "디바이스 선택" }, ...(formScope?.hosts ?? []).map((h) => ({ value: h, label: h }))]}
                onChange={setHost}
              />
            ) : (
              muted("고를 디바이스가 없습니다")
            ),
          )}
          {field(
            "폴더 경로",
            <>
              <UiInput theme={theme} fontSize={fs(12)} value={path} onChangeText={setPath} autoCapitalize="none" autoCorrect={false} style={{ width: FIELD_WIDTH }} />
              {help(pathHint(host))}
            </>,
          )}
          {field(
            "이름",
            <>
              <UiInput theme={theme} fontSize={fs(12)} value={name} onChangeText={setName} style={{ width: FIELD_WIDTH }} />
              {help("비우면 폴더 이름을 씁니다")}
            </>,
          )}
          <View style={{ flexDirection: "row" }}>{button("추가", () => void add(), { tone: "accent" })}</View>
          </>
          ) : null}
        </View>
      ) : null}

      <UiInput theme={theme} fontSize={fs(12)} value={filter} onChangeText={setFilter} placeholder="이름·경로·카테고리로 찾기" style={{ width: FIELD_WIDTH }} />

      {scopes.map((s) => {
        if (!scopeLabel)
          return (
            <View key={`scope-${s.id}`} style={{ gap: 14 }}>
              {categoryGroups(s)}
            </View>
          );
        // 1단계 — 팀원. 머리를 누르면 펼친다(서버 반영 상태·진행 기록은 접혀 있어도 보인다)
        const scopeKey = `scope-${s.id}`;
        const open = expanded.has(scopeKey) || !!filter.trim();
        return (
          <View key={scopeKey} style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: c.border }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${s.title ?? s.id} 프로젝트 ${open ? "접기" : "펼치기"}`}
                onPress={() => toggleExpanded(scopeKey)}
                style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}
              >
                {chevron(open, fs(14))}
                <Text style={{ fontSize: fs(14), fontWeight: "700", color: c.foreground }}>{s.title ?? s.id}</Text>
                {muted(`서버 ${s.hosts.join(", ") || "없음"} · 프로젝트 ${s.entries.length}`)}
              </Pressable>
              {s.extra ? <View style={{ flex: 1 }} /> : null}
              {s.extra}
            </View>
            {s.below}
            {open ? (
            <View style={{ gap: 10, paddingLeft: 12 }}>
              {(s.pinned ?? []).map((p) => {
                // 기본 프로젝트(팀원 홈) — 맨 위 고정, 고치기 단추 없음(10-11 리규형님 "삭제 불가, 항상 최상위")
                const pinRow = `pin-${s.id}|${p.host}|${p.path}`;
                const open = expanded.has(pinRow);
                return (
                  <View key={pinRow} style={{ gap: 2, paddingVertical: 6, paddingLeft: 12, borderBottomWidth: 1, borderColor: c.border }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${p.name} 디바이스·경로 ${open ? "접기" : "보기"}`}
                        ref={(node: unknown) => setHoverTitle(node, open ? "눌러서 접기" : "눌러서 디바이스·경로 보기")}
                        onPress={() => toggleExpanded(pinRow)}
                      >
                        <Text style={{ fontSize: fs(12), fontWeight: "600", color: c.foreground }}>{p.name}</Text>
                      </Pressable>
                      {muted("기본 프로젝트 · 지울 수 없음")}
                    </View>
                    {open ? muted(`${p.host} · ${p.path}`) : null}
                  </View>
                );
              })}
              {s.entries.length ? categoryGroups(s) : muted((s.pinned ?? []).length ? "그 밖의 프로젝트는 아직 없습니다" : "아직 프로젝트가 없습니다")}
            </View>
            ) : null}
          </View>
        );
      })}
      {total === 0 && !error && !scopeLabel ? muted(emptyText, 12) : null}
    </View>
  );
}

type Props = {
  theme: PluginTheme;
  data: ProjectsData | null;
  onChanged: () => void;
  /** 목록 파일을 Paseo 편집기로 연다 — 못 열면 이유 */
  onEditFile: () => Promise<string | null>;
  /** 마우스를 올리면 보일 목록 파일 경로 */
  fileTitle: string;
};

// 리규형님 프로젝트 목록(PC 데몬 목록 파일)
export function ProjectsManage({ theme, data, onChanged, onEditFile, fileTitle }: Props) {
  const c = theme.colors;
  const scale = useFontScale();
  const edit = useRpc(projectsEdit);
  const readHosts = useRpc(projectsHosts);
  const { orders, setOrder, reload } = useGroupOrders();

  const [hosts, setHosts] = useState<string[]>(["PC"]);
  useEffect(() => {
    let alive = true;
    void readHosts({})
      .then((r) => alive && setHosts(r.hosts))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [readHosts]);

  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const entries = data?.entries ?? [];
  const savedCats = orders[CATEGORY_ORDER_KEY];
  // 디바이스는 실제 기기만(10-11 리규형님) — PC + 목록에 프로젝트가 있는 SSH 호스트(팀원 관리의 서버 후보와 같은 기준).
  // github.com·터널 같은 SSH 항목은 프로젝트가 없어 저절로 빠진다
  const devices = useMemo(() => hosts.filter((h) => h === "PC" || entries.some((e) => e.host === h)), [hosts, entries]);
  const scopes = useMemo<EditScope[]>(() => [{ id: "", entries, categoryOrder: savedCats ?? [], hosts: devices }], [entries, savedCats, devices]);

  // 10-11 리규형님: 프로젝트 목록 탭의 "목록 파일 직접 편집"을 "프로젝트 파일 수정"으로 바꿔 이 탭 맨 위 오른쪽으로
  const fileButton = (
    <UiButton
      theme={theme}
      label="프로젝트 파일 수정"
      hint={fileTitle}
      fontSize={scaled(14, scale)}
      onPress={() => {
        setFileProblem(null);
        void onEditFile().then(setFileProblem);
      }}
    />
  );

  return (
    <ProjectsEditor
      theme={theme}
      scopes={scopes}
      edit={async (_scope, op) => {
        const r = await edit(op);
        if (r.ok) {
          onChanged();
          // 카테고리 이름 바꾸기·지우기·옮기기는 데몬이 순서 파일도 고친다 — 번호가 그대로 남게 바로 다시 읽는다
          reload();
        }
        return r;
      }}
      setCategoryOrder={(_scope, names) => setOrder(CATEGORY_ORDER_KEY, names)}
      intro="목록에 보이는 이름·묶음만 바뀝니다. 실제 폴더는 건드리지 않습니다."
      headerAction={fileButton}
      notice={fileProblem}
      error={data?.error}
      emptyText={'아직 프로젝트가 없습니다. 위 "새 프로젝트" 칸에서 추가하세요.'}
      pathHint={(h) => (h === "PC" ? "예: F:\\workspace\\my-project — 이 PC 에 있는 폴더여야 합니다" : "예: /home/me/my-project — 서버 경로는 / 로 시작합니다")}
    />
  );
}
