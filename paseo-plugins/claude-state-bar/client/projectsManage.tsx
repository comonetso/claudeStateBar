import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { projectsEdit, projectsHosts, UNTAGGED_GROUP, type ProjectEntry, type ProjectsEditOp } from "../shared/projects";
import { scaled, useFontScale } from "./fontScale";
import { pinKey, type ProjectsData } from "./projectsData";
import { setHoverTitle, setNoTranslate } from "./web";

// 프로젝트 관리 화면(10-10 리규형님: "사용자들이 json 을 건드는 건 좀 그래서" — 목록 파일 직접 편집 대신).
// 결정: 이름 바꾸기·카테고리 옮기기 / 추가·삭제 / 켜기·끄기 / 카테고리 이름 바꾸기·지우기 · 목록 위 단추 자리에서 연다 ·
// 오른쪽 클릭 메뉴는 없다 · 추가할 기기 = PC + ~/.ssh/config · 옮기면 그 묶음 맨 아래 · 카테고리를 지우면 안의 프로젝트는
// "카테고리 없음"으로 · 경로는 직접 입력. 실제 폴더는 건드리지 않고 목록 파일만 고친다(server/projectsEdit).
// 묶음은 카테고리 기준으로 보인다(꺼 둔 것도 원래 카테고리 안에 "꺼짐"으로) — 목록 화면의 "꺼 둠" 묶음과 다르다.

type Props = {
  theme: PluginTheme;
  data: ProjectsData | null;
  onChanged: () => void;
};

// 10-11: 화면 위 탭(프로젝트 목록 · 프로젝트 관리 · 팀원 관리)으로 오간다 — "목록으로"·"목록 파일 직접 편집" 단추는 탭 줄로 옮겼다
export function ProjectsManage({ theme, data, onChanged }: Props) {
  const c = theme.colors;
  const scale = useFontScale();
  const fs = (px: number) => scaled(px + 3, scale);
  const edit = useRpc(projectsEdit);
  const readHosts = useRpc(projectsHosts);
  const entries = data?.entries ?? [];

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

  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (op: ProjectsEditOp, done: string): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await edit(op);
      if (!r.ok) {
        setMessage({ text: r.error ?? "고치지 못했습니다", bad: true });
        return false;
      }
      setMessage({ text: done, bad: false });
      onChanged();
      return true;
    } catch (error) {
      setMessage({ text: `고치지 못했습니다: ${String(error instanceof Error ? error.message : error)}`, bad: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // 카테고리 — 목록 파일에 처음 나오는 순서, 카테고리 없음은 맨 끝
  const categories = useMemo(() => [...new Set(entries.map((e) => e.category).filter(Boolean))], [entries]);
  const [filter, setFilter] = useState("");
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const shown = entries.filter((e) => !q || e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q) || e.category.toLowerCase().includes(q));
    const list = categories.map((name) => ({ name, items: shown.filter((e) => e.category === name) }));
    list.push({ name: "", items: shown.filter((e) => !e.category) });
    return list.filter((g) => g.items.length > 0);
  }, [entries, categories, filter]);

  // 새 프로젝트
  const [host, setHost] = useState("PC");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [pickCat, setPickCat] = useState("");
  const [newCat, setNewCat] = useState("");
  const add = async () => {
    const ok = await run({ op: "add", host, path, name, category: newCat.trim() || pickCat }, "추가했습니다");
    if (ok) {
      setPath("");
      setName("");
      setNewCat("");
    }
  };

  // 줄·묶음 단위로 지금 무엇을 하고 있는지 — 한 번에 하나만
  const [renaming, setRenaming] = useState<{ key: string; draft: string } | null>(null);
  const [moving, setMoving] = useState<{ key: string; draft: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [catRenaming, setCatRenaming] = useState<{ name: string; draft: string } | null>(null);
  const [confirmCatDelete, setConfirmCatDelete] = useState<string | null>(null);
  const resetRow = () => {
    setRenaming(null);
    setMoving(null);
    setConfirmRemove(null);
    setCatRenaming(null);
    setConfirmCatDelete(null);
  };

  const input = { color: c.foreground, fontSize: fs(12), paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 } as const;
  const button = (label: string, onPress: () => void, opts: { tone?: "danger" | "accent"; on?: boolean; hint?: string } = {}) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={opts.hint ?? label}
      ref={(node: unknown) => {
        if (opts.hint) setHoverTitle(node, opts.hint);
      }}
      disabled={busy}
      onPress={onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => ({
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: opts.on ? c.accent : c.border,
        backgroundColor: hovered ? c.surface2 : opts.on ? c.surface2 : "transparent",
        opacity: busy ? 0.5 : 1,
      })}
    >
      <Text style={{ fontSize: fs(11), color: opts.tone === "danger" ? c.statusDanger : opts.tone === "accent" || opts.on ? c.accent : c.foreground }}>{label}</Text>
    </Pressable>
  );
  const escape = (cancel: () => void) => ({ nativeEvent }: { nativeEvent: { key: string } }) => {
    if (nativeEvent.key === "Escape") cancel();
  };

  const row = (e: ProjectEntry) => {
    const key = pinKey(e);
    const editingName = renaming?.key === key;
    const movingHere = moving?.key === key;
    return (
      <View key={key} style={{ gap: 6, paddingVertical: 6, paddingLeft: 12, borderBottomWidth: 1, borderColor: c.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 160 }}>
            {editingName ? (
              <TextInput
                autoFocus
                selectTextOnFocus
                value={renaming.draft}
                onChangeText={(draft) => setRenaming({ key, draft })}
                onSubmitEditing={() => {
                  const draft = renaming.draft;
                  setRenaming(null);
                  if (draft.trim() && draft.trim() !== e.name) void run({ op: "rename", key, name: draft }, "이름을 바꿨습니다");
                }}
                onKeyPress={escape(() => setRenaming(null))}
                onBlur={() => setRenaming(null)}
                style={input}
              />
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${e.name} 이름 바꾸기`}
                ref={(node: unknown) => setHoverTitle(node, "눌러서 이름 바꾸기 — Enter 저장, Esc 취소")}
                onPress={() => {
                  resetRow();
                  setRenaming({ key, draft: e.name });
                }}
              >
                <Text style={{ fontSize: fs(13), color: e.enabled ? c.foreground : c.foregroundMuted }} numberOfLines={1}>
                  {e.name}
                  {e.enabled ? "" : "  (꺼짐)"}
                </Text>
              </Pressable>
            )}
            <Text style={{ fontSize: fs(10), color: c.foregroundMuted }} numberOfLines={1}>
              {e.host} · {e.path}
              {e.missing ? " · 폴더 없음" : ""}
            </Text>
          </View>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {button("옮기기", () => {
              const open = !movingHere;
              resetRow();
              if (open) setMoving({ key, draft: "" });
            }, { on: movingHere, hint: "다른 카테고리로 옮기기 — 그 묶음 맨 아래로 갑니다" })}
            {button(e.enabled ? "끄기" : "켜기", () => {
              resetRow();
              void run({ op: "enabled", key, enabled: !e.enabled }, e.enabled ? "껐습니다 — 목록의 \"꺼 둠\" 묶음으로 갑니다" : "켰습니다");
            }, { hint: e.enabled ? "목록의 \"꺼 둠\" 묶음으로 보냅니다" : "원래 카테고리로 되살립니다" })}
            {confirmRemove === key
              ? [
                  button("정말 삭제", () => {
                    resetRow();
                    void run({ op: "remove", key }, "목록에서 지웠습니다(폴더는 그대로입니다)");
                  }, { tone: "danger" }),
                  button("취소", () => setConfirmRemove(null)),
                ]
              : button("삭제", () => {
                  resetRow();
                  setConfirmRemove(key);
                }, { tone: "danger", hint: "목록에서만 지웁니다 — 실제 폴더는 그대로" })}
          </View>
        </View>
        {movingHere ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingLeft: 4 }}>
            {[...categories, ""].filter((cat) => cat !== e.category).map((cat) =>
              button(cat || UNTAGGED_GROUP, () => {
                resetRow();
                void run({ op: "category", key, category: cat }, `"${cat || UNTAGGED_GROUP}" 로 옮겼습니다`);
              }),
            )}
            <TextInput
              value={moving.draft}
              onChangeText={(draft) => setMoving({ key, draft })}
              placeholder="새 카테고리 이름"
              placeholderTextColor={c.foregroundMuted}
              onSubmitEditing={() => {
                const draft = moving.draft.trim();
                if (!draft) return;
                resetRow();
                void run({ op: "category", key, category: draft }, `"${draft}" 로 옮겼습니다`);
              }}
              onKeyPress={escape(() => setMoving(null))}
              style={[input, { minWidth: 140 }]}
            />
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View ref={setNoTranslate} style={{ gap: 14 }}>
      <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>목록에 보이는 이름·묶음만 바뀝니다. 실제 폴더는 건드리지 않습니다.</Text>
      {message ? <Text style={{ fontSize: fs(12), color: message.bad ? c.statusDanger : c.statusSuccess }}>{message.text}</Text> : null}
      {data?.error ? <Text style={{ fontSize: fs(12), color: c.statusDanger }}>{data.error}</Text> : null}

      {/* 새 프로젝트 */}
      <View style={{ gap: 8, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
        <Text style={{ fontSize: fs(13), fontWeight: "600", color: c.foreground }}>새 프로젝트</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>기기</Text>
          {hosts.map((h) => button(h, () => setHost(h), { on: host === h }))}
        </View>
        <TextInput
          value={path}
          onChangeText={setPath}
          placeholder={host === "PC" ? "폴더 경로 (예: F:\\workspace\\my-project)" : "서버 폴더 경로 (예: /home/me/my-project)"}
          placeholderTextColor={c.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={input}
        />
        <TextInput value={name} onChangeText={setName} placeholder="이름 (비우면 폴더 이름)" placeholderTextColor={c.foregroundMuted} style={input} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>카테고리</Text>
          {[...categories, ""].map((cat) => button(cat || UNTAGGED_GROUP, () => {
            setPickCat(cat);
            setNewCat("");
          }, { on: !newCat.trim() && pickCat === cat }))}
          <TextInput value={newCat} onChangeText={setNewCat} placeholder="새 카테고리 이름" placeholderTextColor={c.foregroundMuted} style={[input, { minWidth: 140 }]} />
        </View>
        <View style={{ flexDirection: "row" }}>{button("추가", () => void add(), { tone: "accent" })}</View>
      </View>

      <TextInput value={filter} onChangeText={setFilter} placeholder="이름·경로·카테고리로 찾기" placeholderTextColor={c.foregroundMuted} style={input} />

      {groups.map((g) => {
        const untagged = !g.name;
        const editingCat = catRenaming?.name === g.name && !untagged;
        return (
          <View key={g.name || UNTAGGED_GROUP} style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingVertical: 4 }}>
              {editingCat ? (
                <TextInput
                  autoFocus
                  selectTextOnFocus
                  value={catRenaming.draft}
                  onChangeText={(draft) => setCatRenaming({ name: g.name, draft })}
                  onSubmitEditing={() => {
                    const draft = catRenaming.draft.trim();
                    setCatRenaming(null);
                    if (draft && draft !== g.name) void run({ op: "renameCategory", from: g.name, to: draft }, `카테고리 이름을 "${draft}" 로 바꿨습니다`);
                  }}
                  onKeyPress={escape(() => setCatRenaming(null))}
                  onBlur={() => setCatRenaming(null)}
                  style={[input, { minWidth: 180 }]}
                />
              ) : (
                <Text style={{ fontSize: fs(13), fontWeight: "600", color: c.foregroundMuted }}>{g.name || UNTAGGED_GROUP}</Text>
              )}
              <Text style={{ fontSize: fs(11), color: c.foregroundMuted }}>{g.items.length}</Text>
              {untagged || editingCat ? null : (
                <>
                  {button("이름 바꾸기", () => {
                    resetRow();
                    setCatRenaming({ name: g.name, draft: g.name });
                  }, { hint: "카테고리 이름 바꾸기 — 안의 프로젝트가 함께 따라갑니다. 있는 이름이면 두 묶음이 합쳐집니다" })}
                  {confirmCatDelete === g.name
                    ? [
                        button("정말 지우기", () => {
                          resetRow();
                          void run({ op: "deleteCategory", name: g.name }, `"${g.name}" 를 지웠습니다 — 안의 프로젝트는 "${UNTAGGED_GROUP}" 로 갔습니다`);
                        }, { tone: "danger" }),
                        button("취소", () => setConfirmCatDelete(null)),
                      ]
                    : button("지우기", () => {
                        resetRow();
                        setConfirmCatDelete(g.name);
                      }, { tone: "danger", hint: `카테고리만 지웁니다 — 안의 프로젝트는 "${UNTAGGED_GROUP}" 로 갑니다` })}
                </>
              )}
            </View>
            {g.items.map(row)}
          </View>
        );
      })}
      {data && entries.length === 0 && !data.error ? (
        <Text style={{ fontSize: fs(12), color: c.foregroundMuted }}>아직 프로젝트가 없습니다. 위 "새 프로젝트" 칸에서 추가하세요.</Text>
      ) : null}
    </View>
  );
}
