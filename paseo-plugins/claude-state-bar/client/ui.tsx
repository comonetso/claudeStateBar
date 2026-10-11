import type { PluginTheme } from "@getpaseo/plugin";
import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Modal, Platform, Pressable, Text, TextInput, useWindowDimensions, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { scaled, useFontScale } from "./fontScale";
import { setHoverTitle } from "./web";

// ── 입력칸·선택 상자·단추·"?" 풍선 — 플러그인 화면이 모두 이 부품을 쓴다(10-11 리규형님: "다크 모드에서 라인이 흐려서 식별이 힘드니
// border 를 명시적으로 더 흰색으로" · "스킬의 모든 부분에서 적용되게 컴포넌트로 빼").

/**
 * 입력칸·선택 상자·단추 테두리 색. 테마의 border 는 어두운 테마에서 칸 바탕과 거의 같은 색이라(10-11 실측: 바탕 rgb(30,33,32) ·
 * 테두리 rgb(37,43,42)) 선이 안 보였다 → 글자 보조색(밝은 테마에서는 어두운 회색이 된다)
 */
export function lineColor(theme: PluginTheme): string {
  return theme.colors.foregroundMuted;
}

/** 목록 화면 입력칸 폭(폴더 경로·이름·찾기·아이디·스킬 찾기) — 10-11 리규형님이 화면에 표시해 준 폭 */
export const FIELD_WIDTH = 400;

/** 입력칸 모양 — compact 는 목록 화면 안 작은 칸, 아니면 설정 화면 크기 */
export function inputStyle(theme: PluginTheme, fontSize: number, compact = true): TextStyle {
  return {
    color: theme.colors.foreground,
    fontSize,
    paddingHorizontal: compact ? 8 : 10,
    paddingVertical: compact ? 5 : 8,
    borderRadius: compact ? 6 : 8,
    borderWidth: 1,
    borderColor: lineColor(theme),
    backgroundColor: theme.colors.surface0,
  };
}

export function UiInput({ theme, fontSize, compact = true, style, ...rest }: TextInputProps & { theme: PluginTheme; fontSize: number; compact?: boolean }) {
  return <TextInput placeholderTextColor={theme.colors.foregroundMuted} {...rest} style={[inputStyle(theme, fontSize, compact), style]} />;
}

export type ButtonVariant = "outline" | "filled" | "primary";

/**
 * 단추 모양 — outline: 테두리만(목록 화면 줄 단추) · filled: 바탕을 칠한 단추(설정 화면) · primary: 강조색 단추. 모두 같은 밝은 테두리.
 * UiButton 과, 단추 안 글을 따로 그리는 설정 화면·웹 로그인 칸이 같이 쓴다
 */
export function buttonStyle(theme: PluginTheme, variant: ButtonVariant = "filled", compact = false, state: { on?: boolean; hovered?: boolean; disabled?: boolean } = {}): ViewStyle {
  const c = theme.colors;
  const primary = variant === "primary";
  return {
    paddingHorizontal: compact ? 8 : 14,
    paddingVertical: compact ? 4 : 9,
    borderRadius: compact ? 6 : 8,
    borderWidth: 1,
    borderColor: state.on || primary ? c.accent : lineColor(theme),
    backgroundColor: primary ? c.accent : variant === "filled" || state.hovered || state.on ? c.surface2 : "transparent",
    opacity: state.disabled ? 0.5 : 1,
  };
}

/** 단추 — on: 고른 상태(강조색 테두리·글자) · tone: 글자색(삭제 = danger, 추가 = accent) · hint: 마우스를 올리면 뜨는 설명 */
export function UiButton({
  theme,
  label,
  onPress,
  fontSize,
  variant = "outline",
  tone,
  on,
  hint,
  disabled,
  compact = true,
  style,
  children,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  fontSize: number;
  variant?: ButtonVariant;
  tone?: "danger" | "accent";
  on?: boolean;
  hint?: string;
  disabled?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  /** 글 대신 그릴 것(아이콘 등) — 없으면 label */
  children?: ReactNode;
}) {
  const c = theme.colors;
  const primary = variant === "primary";
  const textColor = primary ? c.accentForeground : tone === "danger" ? c.statusDanger : tone === "accent" || on ? c.accent : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint ?? label}
      ref={(node: unknown) => {
        if (hint) setHoverTitle(node, hint);
      }}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [buttonStyle(theme, variant, compact, { on, hovered, disabled }), style]}
    >
      {children ?? <Text style={{ fontSize, color: textColor, textAlign: "center" }}>{label}</Text>}
    </Pressable>
  );
}

/** 바탕이 어두운 테마인지 — 브라우저 선택 상자가 펼친 목록을 테마에 맞는 색으로 그리게(테마에 밝기 표시가 따로 없다) */
function isDarkColor(color: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color.trim());
  const [r, g, b] = hex ? [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) : rgb ? [rgb[1], rgb[2], rgb[3]].map(Number) : [255, 255, 255];
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

export type UiOption = { value: string; label: string };

/**
 * 선택 상자(10-11 리규형님: 단추를 늘어놓지 말고 선택 상자) — 웹은 브라우저 선택 상자를 그대로 그린다(플러그인 도구의
 * SettingsSelect 는 설정 줄 모양이라 옆에 칸을 붙일 수 없다). 웹이 아니면 단추 줄. dim = 흐리게(옆 칸이 대신 쓰일 때)
 */
export function UiSelect({ theme, value, options, onChange, fontSize, dim }: { theme: PluginTheme; value: string; options: UiOption[]; onChange: (value: string) => void; fontSize: number; dim?: boolean }) {
  const c = theme.colors;
  if (Platform.OS !== "web") {
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {options.map((o) => (
          <UiButton key={o.value} theme={theme} label={o.label} fontSize={fontSize} on={o.value === value} onPress={() => onChange(o.value)} />
        ))}
      </View>
    );
  }
  return createElement(
    "select",
    {
      value,
      onChange: (e: { target: { value: string } }) => onChange(e.target.value),
      style: {
        fontSize,
        fontFamily: "inherit",
        color: c.foreground,
        backgroundColor: c.surface0,
        border: `1px solid ${lineColor(theme)}`,
        borderRadius: 6,
        padding: "4px 6px",
        minWidth: 200,
        colorScheme: isDarkColor(c.surface0) ? "dark" : "light",
        opacity: dim ? 0.5 : 1,
        cursor: "pointer",
      },
    },
    options.map((o) => createElement("option", { key: o.value, value: o.value, style: { color: c.foreground, backgroundColor: c.surface0 } }, o.label)),
  );
}

/**
 * 칸 옆 "?" — 마우스를 올리면(폰은 누르면) 도움말 풍선이 뜬다(10-11 리규형님: 칸 아래 도움말 글 대신). 풍선은 "?" 오른쪽 빈자리에
 * 띄운다 — 아래로 띄우면 다음 줄(뒤에 그려지는 줄)이 풍선 위에 겹쳐 보였다. 바탕은 페이지 바탕색으로 채우고 밝은 테두리를 둘러
 * 뒤 글과 섞이지 않게 한다(10-11 리규형님 "배경이 투명이라 뒤에 것이 헷갈림")
 */
// "?" 도움말 — 누르면 풍선 모양 도움말 패널이 열리고, 패널의 닫기·바깥을 누르면 닫힌다(10-12 리규형님: 마우스 올림 풍선 말고
// 눌러서 여는 도움말 패널 — 설명 글을 화면에 늘어놓지 않으려고). 패널은 Modal(문서 맨 위 층)에 "?" 바로 아래 위치를 재서 그린다 —
// 칸 안에 두면 칸마다 겹침 층이 따로 생겨 아래 칸이 패널을 덮었다(10-12 캡처). 글은 고르고 복사할 수 있다
const HELP_WIDTH = 360;
export function HelpTip({ theme, text, fontSize }: { theme: PluginTheme; text: string; fontSize: number }) {
  const c = theme.colors;
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<View>(null);
  const win = useWindowDimensions();
  const open = at !== null;
  const size = Math.round(fontSize * 1.35);
  const toggle = () => {
    if (open) return setAt(null);
    button.current?.measureInWindow((x, y, _w, h) => setAt({ x, y: y + h }));
  };
  const left = at ? Math.max(8, Math.min(at.x - 10, win.width - HELP_WIDTH - 8)) : 0;
  return (
    <View>
      <Pressable
        ref={button}
        accessibilityRole="button"
        accessibilityLabel={open ? "도움말 닫기" : "도움말 보기"}
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1,
          borderColor: open ? c.accent : lineColor(theme),
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ fontSize: fontSize * 0.85, lineHeight: fontSize, fontWeight: "600", color: open ? c.accent : c.foregroundMuted }}>?</Text>
      </Pressable>
      <Modal transparent visible={open} onRequestClose={() => setAt(null)} animationType="none">
        {/* 바깥을 누르면 닫힌다 */}
        <Pressable accessibilityLabel="도움말 닫기" onPress={() => setAt(null)} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
        {at ? (
        <View style={{ position: "absolute", top: at.y + 8, left, width: Math.min(HELP_WIDTH, win.width - 16) }}>
          {/* 풍선 꼬리 — "?" 쪽을 가리킨다 */}
          <View
            style={{
              position: "absolute",
              top: -6,
              left: Math.max(8, at.x - left + size / 2 - 6),
              width: 12,
              height: 12,
              transform: [{ rotate: "45deg" }],
              borderLeftWidth: 1,
              borderTopWidth: 1,
              borderColor: c.accent,
              backgroundColor: c.surface0,
            }}
          />
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: c.accent, backgroundColor: c.surface0 }}>
            <Text selectable style={{ flex: 1, fontSize, lineHeight: fontSize * 1.5, color: c.foreground }}>{text}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="도움말 닫기" onPress={() => setAt(null)} hitSlop={6}>
              <Text style={{ fontSize, lineHeight: fontSize * 1.5, color: c.foregroundMuted }}>✕</Text>
            </Pressable>
          </View>
        </View>
        ) : null}
      </Modal>
    </View>
  );
}

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
    // 패널 단추(Codex·워크플로·백그라운드·통계 패널이 모두 이걸 쓴다) — 밝은 테두리(10-11, lineColor)
    button: { paddingHorizontal: fs(11), paddingVertical: fs(2), borderRadius: fs(4), borderWidth: 1, borderColor: lineColor(theme), backgroundColor: c.surface2 },
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
