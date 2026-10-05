import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { KINDS, isKindKey, type KindKey } from "./activityKinds";
import { BackgroundPanel } from "./bgPanel";
import { CodexChatPanel } from "./chatPanel";
import { CodexRunsPanel } from "./codexPanel";
import { fontStep, scaled, useFontScale } from "./fontScale";
import { onTabRequest, takeRequestedTab, useCounts } from "./useCounts";
import { listenCtrlTab } from "./web";
import { WorkflowsPanel } from "./workflowPanel";

// 작업 현황 패널 하나에 탭 넷(확장 activityPanel.ts 와 같은 모양 — 리규형님 10-05: 패널이 넷으로 따로 있으면 불편하다).
// 탭 순서·이름은 확장 그대로. 탭 옆 숫자 = 돌고 있는 수(확장 activityCounts). 고른 탭만 그려 그 탭만 읽는다
// (확장 09-30 결정 "보이는 탭만 읽기"). 처음 여는 탭: 머리줄 단추에서 고른 탭 → 이 작업 공간에서 마지막으로 본 탭 → 첫 탭.

const PANES: Record<KindKey, ComponentType<PluginWorkspacePanelProps>> = {
  workflows: WorkflowsPanel,
  background: BackgroundPanel,
  codexRuns: CodexRunsPanel,
  codexChats: CodexChatPanel,
};

const lastTab = new Map<string, KindKey>();

function initialTab(workspaceId: string): KindKey {
  const want = takeRequestedTab(workspaceId);
  if (isKindKey(want)) return want;
  return lastTab.get(workspaceId) ?? KINDS[0].key;
}

export function ActivityPanel(props: PluginWorkspacePanelProps) {
  const { workspaceId, theme } = props;
  const [tab, setTab] = useState<KindKey>(() => initialTab(workspaceId));
  const counts = useCounts(workspaceId);
  const scale = useFontScale();

  // 패널이 열려 있는 채로 머리줄 단추에서 다른 탭을 고르면 그 탭으로 간다
  useEffect(
    () =>
      onTabRequest(() => {
        const want = takeRequestedTab(workspaceId);
        if (isKindKey(want)) setTab(want);
      }),
    [workspaceId],
  );
  useEffect(() => {
    lastTab.set(workspaceId, tab);
  }, [workspaceId, tab]);

  // Ctrl+Tab · Ctrl+Shift+Tab: 다음·앞 탭(확장 media/activity.js 와 같은 키, 마지막으로 누른 곳이 이 패널일 때만)
  const rootId = `csb-activity-${workspaceId}`;
  useEffect(
    () =>
      listenCtrlTab(rootId, (backward) =>
        setTab((cur) => {
          const i = KINDS.findIndex((k) => k.key === cur);
          return KINDS[(i + (backward ? KINDS.length - 1 : 1)) % KINDS.length].key;
        }),
      ),
    [rootId],
  );

  const c = theme.colors;
  const s = useMemo(
    () => ({
      bar: { flexDirection: "row" as const, gap: 2, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface0 },
      tab: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 2, borderBottomColor: "transparent" },
      tabOn: { borderBottomColor: c.accent },
      label: { color: c.foregroundMuted, fontSize: scaled(13, scale) },
      labelOn: { color: c.foreground, fontWeight: "600" as const },
      count: { color: c.accent, fontSize: scaled(12, scale), fontWeight: "600" as const },
      tools: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, marginLeft: "auto" as const, paddingLeft: 12 },
      flabel: { color: c.foregroundMuted, fontSize: scaled(12, scale) },
      fbtn: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 4, backgroundColor: c.surface2 },
      fbtnText: { color: c.foreground, fontSize: scaled(12, scale) },
    }),
    [c, scale],
  );

  const Pane = PANES[tab];
  return (
    <View nativeID={rootId} style={{ flex: 1, backgroundColor: c.surface0 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={[s.bar, { flexGrow: 1, alignItems: "center" }]}>
        {KINDS.map((k) => {
          const on = k.key === tab;
          const n = counts ? counts[k.key] : 0;
          return (
            <Pressable
              key={k.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={n > 0 ? `${k.tab}, ${n}개 진행 중` : k.tab}
              onPress={() => setTab(k.key)}
              style={[s.tab, on && s.tabOn]}
            >
              <Icon name={n > 0 ? "LoaderCircle" : k.icon} size={scaled(14, scale)} color={n > 0 ? c.accent : on ? c.foreground : c.foregroundMuted} />
              <Text style={[s.label, on && s.labelOn]}>{k.tab}</Text>
              {n > 0 ? <Text style={s.count}>{n}</Text> : null}
            </Pressable>
          );
        })}
        {/* 글자 크기(확장 툴바 "Font size A− A+") — 모든 패널·프로젝트 화면에 같이 적용 */}
        <View style={s.tools}>
          <Text style={s.flabel}>글자 크기</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="글자 작게" onPress={() => fontStep(-1)} style={s.fbtn}>
            <Text style={s.fbtnText}>A−</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="글자 크게" onPress={() => fontStep(1)} style={s.fbtn}>
            <Text style={s.fbtnText}>A+</Text>
          </Pressable>
        </View>
      </ScrollView>
      <View style={{ flex: 1 }}>
        <Pane key={tab} {...props} />
      </View>
    </View>
  );
}
