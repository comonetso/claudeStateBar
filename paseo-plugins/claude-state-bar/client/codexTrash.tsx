import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { codexTrashEmpty, codexTrashList, codexTrashPurge, codexTrashRestore, type TrashItem } from "../shared/codex";
import { fmtStamp } from "./format";
import type { Notify, PanelStyles } from "./ui";

// Codex 진행 탭의 휴지통 서랍(확장 media/codexruns.js renderTrash + extension.ts onRestore·onPurge·onEmptyTrash).
// 나갈 때만 묻는다: 완전 삭제·비우기에서 "기록만 / 기록+문서". 고를 게 없으면(문서만·기록만 남음) 선택지를 내지 않는다
// — 선택지가 하나뿐인데 "기록+문서 삭제"를 띄웠던 것이 확장에서 "같은 질문을 두 번 받는" 느낌의 원인이었다.
// VS Code 확인 창 대신 줄 아래에 확인 상자를 띄운다(문구는 확장 그대로).

type Confirm =
  | { kind: "purge"; item: TrashItem }
  | { kind: "empty"; count: number; both: boolean };

export function TrashDrawer({
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
  /** 카드에서 하나 넣을 때마다 바뀐다(열려 있으면 다시 읽는다) */
  reloadKey: number;
}) {
  const c = theme.colors;
  const list = useRpc(codexTrashList);
  const restore = useRpc(codexTrashRestore);
  const purge = useRpc(codexTrashPurge);
  const empty = useRpc(codexTrashEmpty);
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);

  // 열 때마다 묻는다 — 디스크에 실제로 뭐가 있는지는 데몬만 안다(다른 창에서 지웠을 수 있다)
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

  const label = (it: TrashItem) => it.subject || it.slug;

  const doRestore = async (it: TrashItem) => {
    setBusy(true);
    try {
      const res = await restore({ cwd, stamp: it.stamp });
      if (res.conflicts.length) notify(`원래 이름이 이미 쓰이고 있어 ${res.conflicts.length}개 파일을 휴지통에 남겼습니다. 아무것도 덮어쓰지 않았습니다.`, "warn");
      // 카드는 다시 뜨지만 활동이 비어 있다 — 말하지 않으면 카드가 고장 난 것처럼 읽힌다
      else if (res.restoredDocs && !res.restoredLogs) notify(`문서 ${res.restoredDocs}개를 되돌렸습니다. 카드는 다시 뜨지만 활동 내역은 비어 있습니다 — 이벤트 기록을 이미 완전 삭제했고, 활동 목록은 그걸로 그리기 때문입니다.`);
      else notify(`"${it.stamp}" 을(를) 복구했습니다.`);
    } catch (e) {
      notify(`복구하지 못했습니다: ${String(e)}`, "warn");
    }
    setBusy(false);
    onChanged();
    void load();
  };

  const doPurge = async (it: TrashItem, includeDocs: boolean) => {
    setConfirm(null);
    setBusy(true);
    try {
      await purge({ cwd, stamp: it.stamp, includeDocs });
    } catch (e) {
      notify(`지우지 못했습니다: ${String(e)}`, "warn");
    }
    setBusy(false);
    void load();
  };

  const doEmpty = async (includeDocs: boolean) => {
    setConfirm(null);
    setBusy(true);
    try {
      const { count } = await empty({ cwd, includeDocs });
      notify(`${count}건을 비웠습니다.`);
    } catch (e) {
      notify(`비우지 못했습니다: ${String(e)}`, "warn");
    }
    setBusy(false);
    void load();
  };

  const btn = (text: string, onPress: () => void, tone?: "danger" | "warn") => (
    <Pressable
      key={text}
      disabled={busy}
      style={[styles.button, tone === "danger" ? { backgroundColor: c.statusDanger } : tone === "warn" ? { backgroundColor: c.statusWarning } : {}]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={[styles.buttonText, tone ? { color: c.accentForeground } : {}]}>{text}</Text>
    </Pressable>
  );

  const confirmBox = (text: string, buttons: ReactNode[]) => (
    <View style={{ gap: 8, padding: 10, borderRadius: 6, borderWidth: 1, borderColor: c.statusWarning, backgroundColor: c.surface0 }}>
      <Text style={[styles.small, { lineHeight: styles.fs(18) }]}>{text}</Text>
      <View style={styles.actions}>
        {buttons}
        {btn("취소", () => setConfirm(null))}
      </View>
    </View>
  );

  const purgeConfirm = (it: TrashItem) => {
    // 세 경우: 고를 것이 없는데 선택지를 내면 같은 질문을 두 번 받는 것으로 읽힌다
    if (it.hasDocs && it.hasLogs) {
      return confirmBox(
        `"${label(it)}" 을(를) 완전히 삭제합니다.\n\n원시 기록만 지울까요, 요청서·응답 문서까지 함께 지울까요?\n\n기록은 부피가 크고, 문서는 무엇을 묻고 무엇을 답했는지의 기록입니다. 문서를 남기면 그 문서만 휴지통에 남습니다. 원시 기록을 지우고 나면 그 실행은 카드로는 남지만 활동 내역이 비어 있게 됩니다 — 그 부분은 되돌릴 수 없습니다.`,
        [btn("기록만 삭제", () => void doPurge(it, false)), btn("기록 + 문서 삭제", () => void doPurge(it, true), "danger")],
      );
    }
    if (it.hasDocs) {
      return confirmBox(
        `"${label(it)}" 에 마지막으로 남은 것을 지웁니다.\n\n요청서·응답 문서만 남아 있습니다 — 원시 기록은 이미 지웠습니다. 이걸 지우면 이 실행에 대해 남는 것이 없습니다.`,
        [btn("완전 삭제", () => void doPurge(it, true), "danger")],
      );
    }
    return confirmBox(`"${label(it)}" 을(를) 완전히 삭제할까요?\n\n되돌릴 수 없는 단계는 여기입니다.`, [btn("완전 삭제", () => void doPurge(it, true), "danger")]);
  };

  const anyDocs = !!items?.some((i) => i.hasDocs);
  const anyLogs = !!items?.some((i) => i.hasLogs);

  return (
    <View style={[styles.card, { gap: 8 }]}>
      <View style={styles.head}>
        <Text style={styles.title}>휴지통</Text>
        <Text style={[styles.muted, { flex: 1 }]}>지운 실행은 비우기 전까지 여기 남습니다.</Text>
        {items?.length ? btn("휴지통 비우기", () => setConfirm({ kind: "empty", count: items.length, both: anyDocs && anyLogs }), "warn") : null}
      </View>
      {confirm?.kind === "empty"
        ? confirm.both
          ? confirmBox(`휴지통을 비웁니다 — ${confirm.count}건.\n\n원시 기록만 지울까요, 요청서·응답 문서까지 함께 지울까요?\n\n문서를 남기면 그 문서만 휴지통에 남습니다.`, [
              btn("기록만 삭제", () => void doEmpty(false)),
              btn("기록 + 문서 삭제", () => void doEmpty(true), "danger"),
            ])
          : confirmBox(`휴지통을 비울까요?\n\n${confirm.count}건이 완전히 삭제됩니다.`, [btn("완전 삭제", () => void doEmpty(true), "danger")])
        : null}
      {!items ? <Text style={styles.muted}>읽는 중입니다</Text> : null}
      {items && !items.length ? <Text style={styles.muted}>휴지통이 비어 있습니다.</Text> : null}
      {items?.map((it) => {
        // 위험도 3색: 문서만 남음 = 빨강(마지막 기록) · 기록+문서 = 주황 · 기록만 = 보통
        const docsOnly = it.hasDocs && !it.hasLogs;
        const both = it.hasDocs && it.hasLogs;
        const what = both ? "기록 + 문서" : docsOnly ? "문서만" : "기록만";
        const whatColor = docsOnly ? c.statusDanger : both ? c.statusWarning : c.foregroundMuted;
        return (
          <View key={it.stamp} style={{ gap: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: c.border }}>
            <View style={styles.head}>
              <Text style={[styles.small, { fontWeight: "600", flexShrink: 1 }]} numberOfLines={1}>
                {label(it)}
              </Text>
              <Text style={[styles.muted, { color: whatColor }]}>{what}</Text>
              <Text style={styles.muted}>
                {it.stamp} · 파일 {it.fileCount}개 · {Math.max(1, Math.round(it.bytes / 1024))}KB · {fmtStamp(it.deletedAt)} 삭제
              </Text>
              <View style={{ flex: 1 }} />
              {btn("복구", () => void doRestore(it))}
              {btn("완전 삭제", () => setConfirm({ kind: "purge", item: it }), docsOnly ? "danger" : both ? "warn" : undefined)}
            </View>
            {confirm?.kind === "purge" && confirm.item.stamp === it.stamp ? purgeConfirm(it) : null}
          </View>
        );
      })}
    </View>
  );
}
