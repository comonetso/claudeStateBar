import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, Platform, View } from "react-native";

// 프로젝트 줄의 상태 표시 — Paseo 왼쪽 워크스페이스 목록과 같은 모양(리규형님 10-07: "워크스페이스 것이 더 직관적").
// 모양·크기·색·우선순위는 Paseo 0.11.0-beta.5 를 그대로 옮겼다:
//   sidebar-workspace-row-content.tsx WorkspaceStatusIndicator · status-ring/* · utils/status-dot-color.ts ·
//   utils/status-indicator-geometry.ts · styles/theme.ts(statusDot* 두 벌) · @getpaseo/protocol agent-state-bucket
// 돌고 있음 = 파란 점 둘레를 도는 고리 · 답을 기다림 = 주황 느낌표 원 · 실패 = 폴더 아이콘에 빨간 점 ·
// 끝났는데 아직 안 봄 = 초록 점 · 끝남 = 흐린 점

export type StatusBucket = "needs_input" | "failed" | "running" | "attention" | "done";

// 대화 하나의 상태(@getpaseo/protocol deriveAgentStateBucket 과 같은 규칙)
export function agentBucket(agent: {
  status: string;
  pendingPermissions?: readonly unknown[] | null;
  requiresAttention?: boolean | null;
  attentionReason?: string | null;
}): StatusBucket {
  if ((agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission") return "needs_input";
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  if (agent.status === "running") return "running";
  if (agent.requiresAttention) return "attention";
  return "done";
}

// 여러 대화를 한 줄로 합칠 때는 가장 급한 것 — Paseo 가 접힌 프로젝트 줄에 쓰는 순서(돌고 있음이 확인 필요보다 앞)
const PRIORITY: readonly StatusBucket[] = ["needs_input", "failed", "running", "attention", "done"];
export function mostUrgent(a: StatusBucket | undefined, b: StatusBucket): StatusBucket {
  return a === undefined || PRIORITY.indexOf(b) < PRIORITY.indexOf(a) ? b : a;
}

// Paseo 상태 점 색은 테마와 따로 밝은·어두운 두 벌뿐이다(theme.ts lightStatusDotColors·darkStatusDotColors).
// 플러그인 테마에는 이 색이 없어서 바탕(surface0) 밝기로 고른다
const LIGHT = { success: "#299f51", danger: "#f12e2f", warning: "#b37824", running: "#268ae0" };
const DARK = { success: "#35c264", danger: "#f7796d", warning: "#db932e", running: "#5caaf6" };
export function dotColors(theme: PluginTheme) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(theme.colors.surface0);
  if (!m) return DARK;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? LIGHT : DARK;
}

const DOT = 6; // STATUS_INDICATOR_FILLED_DOT_SIZE
const OVERLAY_DOT = DOT + 2; // STATUS_INDICATOR_DOT_SIZE
const ALERT = 12; // STATUS_INDICATOR_ALERT_SIZE
const RING_STROKE = 1.5;
const RING = DOT + (1.5 + RING_STROKE) * 2; // STATUS_RING_SIZE(간격 1.5 + 굵기 1.5)
const RING_PERIOD_MS = 900;
/** 상태 자리(workspaceStatusDot: 폭 theme.iconSize.md · 높이 20) — 표시가 없을 때도 이만큼 비워 이름 줄이 흔들리지 않게 */
export const STATUS_SLOT = 16;
const SLOT_HEIGHT = 20;

/** 돌아가는 사분원. 웹은 Paseo 처럼 문서 시간 0 에 맞춘 애니메이션이라 여러 고리가 같은 박자로 돈다 */
function RingArc({ color }: { color: string }) {
  const spin = useRef(new Animated.Value(0)).current;
  const webRef = useRef<unknown>(null);
  useEffect(() => {
    const el = webRef.current as { animate?: (k: unknown, o: unknown) => { startTime: number | null; cancel(): void } } | null;
    if (Platform.OS === "web" && el && typeof el.animate === "function") {
      const animation = el.animate({ transform: ["rotate(0deg)", "rotate(360deg)"] }, { duration: RING_PERIOD_MS, easing: "linear", iterations: Infinity });
      animation.startTime = 0;
      return () => animation.cancel();
    }
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: RING_PERIOD_MS, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const arc = { width: RING, height: RING, borderRadius: RING / 2, borderWidth: RING_STROKE, borderColor: "transparent", borderTopColor: color, opacity: 0.9 };
  if (Platform.OS === "web") {
    return (
      <View ref={webRef as never} style={{ position: "absolute", width: RING, height: RING }}>
        <View style={arc} />
      </View>
    );
  }
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ position: "absolute", width: RING, height: RING, transform: [{ rotate }] }}>
      <View style={arc} />
    </Animated.View>
  );
}

export function StatusIndicator({ bucket, theme, label }: { bucket: StatusBucket | null; theme: PluginTheme; label?: string }) {
  const c = theme.colors;
  const dot = dotColors(theme);
  const slot = { position: "relative", width: STATUS_SLOT, height: SLOT_HEIGHT, flexShrink: 0, alignItems: "center", justifyContent: "center" } as const;
  if (!bucket) return <View style={slot} />;
  let mark: ReactNode;
  if (bucket === "running") {
    mark = (
      <View style={{ width: RING, height: RING, alignItems: "center", justifyContent: "center" }}>
        <View style={{ position: "absolute", width: RING, height: RING, borderRadius: RING / 2, borderWidth: RING_STROKE, borderColor: dot.running, opacity: 0.3 }} />
        <RingArc color={dot.running} />
        <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: dot.running }} />
      </View>
    );
  } else if (bucket === "needs_input") {
    // lucide CircleAlert 를 주황으로 채우고 선은 바탕색 — 주황 원을 깔고 바탕색 선 아이콘을 얹어 같은 그림을 만든다
    mark = (
      <View style={{ width: ALERT, height: ALERT, alignItems: "center", justifyContent: "center" }}>
        <View style={{ position: "absolute", width: ALERT - 2, height: ALERT - 2, borderRadius: ALERT / 2, backgroundColor: dot.warning }} />
        <Icon name="CircleAlert" size={ALERT} color={c.surface0} />
      </View>
    );
  } else if (bucket === "failed") {
    // 폴더 아이콘(14) + 자리 오른쪽 아래 빨간 점(statusDotOverlay: right 0 · bottom 0 · 8px · 바탕색 테두리 1)
    mark = (
      <>
        <Icon name="Folder" size={14} color={c.foregroundMuted} />
        <View style={{ position: "absolute", right: 0, bottom: 0, width: OVERLAY_DOT, height: OVERLAY_DOT, borderRadius: OVERLAY_DOT / 2, borderWidth: 1, borderColor: c.surface0, backgroundColor: dot.danger }} />
      </>
    );
  } else if (bucket === "attention") {
    mark = <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: dot.success }} />;
  } else {
    // 끝남: 상태를 알리지 않고 자리만 지키는 흐린 점(Paseo idleStatusDot — foregroundExtraMuted 30%, 플러그인 테마엔 없어 foregroundMuted)
    mark = <View style={{ width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: c.foregroundMuted, opacity: 0.3 }} />;
  }
  return (
    <View style={slot} accessibilityLabel={label}>
      {mark}
    </View>
  );
}
