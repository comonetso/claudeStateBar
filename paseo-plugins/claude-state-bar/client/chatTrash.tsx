import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { chatTrashEmpty, chatTrashList, chatTrashPurge, chatTrashRestore, type ChatTrashItem } from "../shared/codex";
import { fmtClock } from "./format";
import type { Notify, PanelStyles } from "./ui";

// Codex 채팅 탭의 휴지통 서랍(확장 media/codexchat.js renderTrash + extension.ts codexChatCallbacks).
// 넣을 때는 묻지 않고, 되돌릴 수 없는 완전 삭제·비우기에서만 "삭제" 확인(리규형님 08-22).

type Confirm = { kind: "purge"; stamp: string } | { kind: "empty"; count: number };

export function ChatTrashDrawer({
  cwd,
  styles,
  theme,
  notify,
  onChanged,
  reloadKey,
}: {
  cwd: string;
  styles: PanelStyles;
  theme: PluginTheme;
  notify: Notify;
  onChanged: () => void;
  reloadKey: number;
}) {
  const c = theme.colors;
  const list = useRpc(chatTrashList);
  const restore = useRpc(chatTrashRestore);
  const purge = useRpc(chatTrashPurge);
  const empty = useRpc(chatTrashEmpty);
  const [items, setItems] = useState<ChatTrashItem[] | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await list({ cwd })).items);
    } catch (e) {
      notify(`휴지통을 읽지 못했습니다: ${String(e)}`, "warn");
      setItems([]);
    }
  }, [cwd, list, notify]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const run = async (fn: () => Promise<void>) => {
    setConfirm(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(`처리하지 못했습니다: ${String(e)}`, "warn");
    }
    setBusy(false);
    onChanged();
    void load();
  };

  const btn = (text: string, onPress: () => void, danger = false) => (
    <Pressable
      key={text}
      disabled={busy}
      style={[styles.button, { paddingHorizontal: styles.fs(9), paddingVertical: styles.fs(1) }, danger ? { backgroundColor: c.statusDanger } : {}]}
      onPress={onPress}
      accessibilityRole="button"
    >
      {/* Codex 진행 휴지통과 같은 작은 버튼(리규형님 10-06) */}
      <Text style={[styles.buttonText, { fontSize: styles.fs(12), lineHeight: styles.fs(18) }, danger ? { color: c.accentForeground } : {}]}>{text}</Text>
    </Pressable>
  );

  const confirmBox = (text: string, onYes: () => void) => (
    <View style={{ gap: 8, padding: 10, borderRadius: 6, borderWidth: 1, borderColor: c.statusWarning, backgroundColor: c.surface0 }}>
      <Text style={styles.small}>{text}</Text>
      <View style={styles.actions}>
        {btn("삭제", onYes, true)}
        {btn("취소", () => setConfirm(null))}
      </View>
    </View>
  );

  return (
    <View style={[styles.card, { gap: 8 }]}>
      <View style={styles.head}>
        <Text style={[styles.title, { flex: 1 }]}>휴지통</Text>
        {items?.length ? btn("비우기", () => setConfirm({ kind: "empty", count: items.length })) : null}
      </View>
      {confirm?.kind === "empty"
        ? confirmBox(`채팅 휴지통을 비울까요? 대화 ${confirm.count}건이 영영 사라집니다.`, () =>
            void run(async () => {
              await empty({ cwd });
            }),
          )
        : null}
      {!items ? <Text style={styles.muted}>읽는 중입니다</Text> : null}
      {items && !items.length ? <Text style={styles.muted}>휴지통이 비어 있습니다.</Text> : null}
      {items?.map((it) => (
        <View key={it.stamp} style={{ gap: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: c.border }}>
          <View style={styles.head}>
            <Text style={[styles.small, { fontWeight: "600", flexShrink: 1 }]} numberOfLines={1}>
              {it.subject || it.slug}
            </Text>
            <Text style={styles.muted}>
              {it.turns}턴 · {it.bytes < 1024 ? `${it.bytes} B` : `${Math.round(it.bytes / 1024)} KB`} · {fmtClock(it.deletedAt)}
            </Text>
            <View style={{ flex: 1 }} />
            {btn("복구", () =>
              void run(async () => {
                const res = await restore({ cwd, stamp: it.stamp });
                if (res.conflict) notify("복구하지 못했습니다 — 같은 이름의 파일이 이미 있습니다.", "warn");
              }),
            )}
            {btn("완전 삭제", () => setConfirm({ kind: "purge", stamp: it.stamp }))}
          </View>
          {confirm?.kind === "purge" && confirm.stamp === it.stamp
            ? confirmBox("이 대화를 완전히 삭제할까요? 되돌릴 수 없습니다.", () =>
                void run(async () => {
                  await purge({ cwd, stamp: it.stamp });
                }),
              )
            : null}
        </View>
      ))}
    </View>
  );
}
