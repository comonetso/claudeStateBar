import type { PluginTheme } from "@getpaseo/plugin";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { scaled, useFontScale } from "./fontScale";

export type Notify = (text: string, tone?: "info" | "warn") => void;

/** 확장의 상태 표시줄·경고 알림 대신 패널 위 한 줄(정보 6초 · 경고 12초 뒤 사라진다) */
export function useNotice(): { notice: { text: string; tone: "info" | "warn" } | null; notify: Notify } {
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "warn" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify: Notify = useCallback((text, tone = "info") => {
    setNotice({ text, tone });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), tone === "warn" ? 12000 : 6000);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { notice, notify };
}

export function NoticeLine({ notice, theme }: { notice: { text: string; tone: "info" | "warn" } | null; theme: PluginTheme }) {
  const { fs } = panelStyles(theme, false, useFontScale());
  if (!notice) return null;
  const c = theme.colors;
  return (
    <View style={{ padding: 8, borderRadius: 6, borderLeftWidth: 3, borderLeftColor: notice.tone === "warn" ? c.statusWarning : c.accent, backgroundColor: c.surface1 }}>
      <Text style={{ color: c.foreground, fontSize: fs(12) }}>{notice.text}</Text>
    </View>
  );
}

// 작업 공간 패널들이 같이 쓰는 모양
/** scale = 앱 본문 글자 크기 배율(fontScale.ts). 패널 안에서 직접 쓰는 크기는 fs(px) 로 같은 배율을 곱한다 */
export function panelStyles(theme: PluginTheme, compact: boolean, scale = 1) {
  const c = theme.colors;
  const fs = (px: number) => scaled(px, scale);
  return {
    fs,
    screen: { flex: 1, backgroundColor: c.surface0 },
    content: { padding: compact ? 12 : 16, gap: 10 },
    section: { color: c.foregroundMuted, fontSize: fs(12), fontWeight: "600" as const, marginTop: 4 },
    muted: { color: c.foregroundMuted, fontSize: fs(12) },
    text: { color: c.foreground, fontSize: fs(14) },
    small: { color: c.foreground, fontSize: fs(12) },
    title: { color: c.foreground, fontSize: fs(14), fontWeight: "600" as const, flexShrink: 1 },
    card: { padding: 10, gap: 6, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 },
    head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
    chip: { paddingHorizontal: fs(9), paddingVertical: fs(2), borderRadius: fs(10), backgroundColor: c.surface2 },
    chipText: { color: c.foregroundMuted, fontSize: fs(12) },
    actions: { flexDirection: "row" as const, gap: 6, flexWrap: "wrap" as const },
    button: { paddingHorizontal: fs(11), paddingVertical: fs(2), borderRadius: fs(4), backgroundColor: c.surface2 },
    buttonText: { color: c.foreground, fontSize: fs(15), lineHeight: fs(21) },
    pane: { padding: 8, borderRadius: 6, backgroundColor: c.surface0, gap: 6 },
    mono: { color: c.foreground, fontSize: fs(12), fontFamily: "monospace" },
    error: { color: c.statusDanger, fontSize: fs(12) },
  };
}

export type PanelStyles = ReturnType<typeof panelStyles>;

export function StatusChip({ label, color, theme }: { label: string; color: string; theme: PluginTheme }) {
  const styles = panelStyles(theme, false, useFontScale());
  return (
    <View style={[styles.chip, { backgroundColor: color }]}>
      <Text style={[styles.chipText, { color: theme.colors.accentForeground }]}>{label}</Text>
    </View>
  );
}

export function Chip({ label, styles }: { label: string; styles: PanelStyles }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{label}</Text>
    </View>
  );
}

export function Button({ label, onPress, styles }: { label: string; onPress: () => void; styles: PanelStyles }) {
  return (
    <Pressable style={styles.button} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}
