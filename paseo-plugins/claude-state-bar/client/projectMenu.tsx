import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Modal, Pressable, Text, View, useWindowDimensions } from "react-native";
import { projectsEdit, type ProjectEntry } from "../shared/projects";
import { pinKey } from "./projectsData";
import { lineColor, UiInput } from "./ui";
import { copyText, setNoTranslate } from "./web";

// 프로젝트 줄 오른쪽 클릭(폰은 길게 누르기) 메뉴(10-15 리규형님): 이름 복사 · 이름 바꾸기를 관리 화면에 가지 않고 바로.
// 이름 복사는 peer_mail 로 다른 프로젝트 대화에 말을 보낼 때 받는 곳 이름(프로젝트 매니저 이름)을 붙여 넣으려는 것.
// 10-10 엔 "우클릭 메뉴 말고 관리 화면"으로 정했는데 리규형님이 이번에 바꿨다. 이름 바꾸기는 관리 화면과 같은 기능(projects.edit rename)
export type ProjectMenuAt = { entry: ProjectEntry; x: number; y: number };

const MENU_WIDTH = 220;

export function ProjectMenu({ theme, at, readOnly, fontSize, onClose, onChanged }: {
  theme: PluginTheme;
  at: ProjectMenuAt;
  /** PC 가 꺼져 서버가 대신 보여 주거나 직원 화면 — 이름 복사만 */
  readOnly: boolean;
  fontSize: number;
  onClose: () => void;
  /** 이름을 바꾼 뒤 목록 다시 읽기 */
  onChanged: () => void;
}) {
  const c = theme.colors;
  const win = useWindowDimensions();
  const edit = useRpc(projectsEdit);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const { entry } = at;
  const width = Math.min(MENU_WIDTH, win.width - 16);
  const left = Math.max(8, Math.min(at.x, win.width - width - 8));
  const top = Math.max(8, Math.min(at.y, win.height - 140));

  const copy = async () => {
    if (await copyText(entry.name)) return onClose();
    setMessage({ text: `복사하지 못했습니다 — 이름을 직접 고르세요: ${entry.name}`, bad: true });
  };
  const save = async () => {
    const name = (renaming ?? "").trim();
    if (!name || name === entry.name) return onClose();
    setSaving(true);
    try {
      const r = await edit({ op: "rename", key: pinKey(entry), name });
      if (!r.ok) return setMessage({ text: r.error ?? "이름을 바꾸지 못했습니다", bad: true });
      onChanged();
      onClose();
    } catch (err) {
      setMessage({ text: `이름을 바꾸지 못했습니다: ${String(err instanceof Error ? err.message : err)}`, bad: true });
    } finally {
      setSaving(false);
    }
  };
  const item = (label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => ({ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: hovered ? c.surface2 : "transparent" })}
    >
      <Text style={{ color: c.foreground, fontSize }}>{label}</Text>
    </Pressable>
  );

  return (
    <Modal transparent visible onRequestClose={onClose} animationType="none">
      {/* 바깥을 누르거나 오른쪽 클릭하면 닫힌다 */}
      <Pressable accessibilityLabel="메뉴 닫기" onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
      <View
        accessibilityRole="menu"
        style={{ position: "absolute", top, left, width, padding: 4, gap: 2, borderRadius: 8, borderWidth: 1, borderColor: lineColor(theme), backgroundColor: c.surface0 }}
      >
        <Text ref={(node: unknown) => setNoTranslate(node)} numberOfLines={1} style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 4, color: c.foregroundMuted, fontSize: fontSize - 1 }}>
          {entry.name}
        </Text>
        {renaming === null ? (
          <>
            {item("이름 복사", () => void copy())}
            {readOnly ? null : item("이름 바꾸기", () => setRenaming(entry.name))}
          </>
        ) : (
          <View style={{ paddingHorizontal: 8, paddingVertical: 6, gap: 6 }}>
            <UiInput
              theme={theme}
              fontSize={fontSize}
              autoFocus
              selectTextOnFocus
              editable={!saving}
              value={renaming}
              onChangeText={setRenaming}
              onSubmitEditing={() => void save()}
              onKeyPress={({ nativeEvent }: { nativeEvent: { key: string } }) => {
                if (nativeEvent.key === "Escape") onClose();
              }}
            />
            <Text style={{ color: c.foregroundMuted, fontSize: fontSize - 2 }}>Enter 저장 · Esc 취소 — 목록 이름만 바뀌고 폴더는 그대로입니다</Text>
          </View>
        )}
        {message ? (
          <Text selectable style={{ paddingHorizontal: 12, paddingVertical: 6, color: message.bad ? c.statusWarning : c.foregroundMuted, fontSize: fontSize - 1 }}>
            {message.text}
          </Text>
        ) : null}
      </View>
    </Modal>
  );
}
