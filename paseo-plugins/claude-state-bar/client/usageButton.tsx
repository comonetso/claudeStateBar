import {
  type PluginButton,
  type PluginButtonContentProps,
  type PluginButtonIconProps,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect } from "react";
import { View } from "react-native";
import { availableProviders, clampPct, shortName, shownWindows, summaryLabel, UsageTable, useUsage, type Usage } from "./usageFooter";
import { hideButtonTooltip, setStyleSheet } from "./web";

// 작업 공간 머리줄 "사용량" 단추(리규형님 10-06 결정): 작업 현황 단추 왼쪽에 "Claude 1·31 │ Codex 13"(계정마다 Paseo 가
// 요약으로 표시한 창 순서 — Claude 5시간·주간, Codex 주간), 누르면 왼쪽 아래 사용량 표와 같은 것을 작은 창으로 띄운다.
// 왼쪽 아래 표도 그대로 둔다(결정). 마우스를 올리면 뜨는 창은 Paseo 가 지원하지 않아 누르는 창으로 한다.
// 마우스를 올리면 Paseo 가 단추 설명(title)을 도움말로 띄우는데, 리규형님 10-09 "별 필요 없어 — 없애" → 감춘다(web.ts hideButtonTooltip).
// 설명 글은 접근성 이름으로 남는다(아래 너비 풀기가 이 이름으로 단추를 고른다)
// 숫자 읽기는 단추 그림(아이콘)이 맡는다 — 앱이 보이는 작업 공간의 단추만 그리므로 안 보이는 작업 공간은 읽지 않는다.

// 작은 창 폭 — 막대가 늘어날 자리를 주는 값으로 왼쪽 목록 칸과 비슷하게 잡았다
const POPOVER_WIDTH = 300;

// Paseo 는 머리줄 단추 폭을 160px 로 묶어 "Claude 3·31 │ C…" 로 잘린다(리규형님 10-06: "더 넓혀야겠음").
// 플러그인 기능으로는 못 풀어서 웹·데스크톱 화면에서 이 단추만 제한을 걷는다. 단추 바깥 요소의 접근성 이름이
// 단추 설명(title)이라 "사용량 — " 로 시작하는 것을 고른다(Paseo plugins/buttons/view.tsx, 0.11.0-beta.5).
// 좁은 화면(폰)은 Paseo 가 단추에 글자 없이 아이콘만 그린다 — 숫자는 누르면 뜨는 창에서 본다
const TITLE_PREFIX = "사용량 — ";
const WIDTH_STYLE_ID = "claude-state-bar-usage-button-width";
const WIDTH_CSS = `[aria-label^="${TITLE_PREFIX}"]{max-width:none !important}`;

function presentation(usage: Usage | null): Pick<PluginButton, "label" | "title"> {
  const providers = availableProviders(usage);
  if (!providers.length) return { label: "사용량", title: `${TITLE_PREFIX}읽는 중` };
  const pct = (n: number | null | undefined) => {
    const v = clampPct(n);
    return v === null ? "—" : `${Math.round(v)}%`;
  };
  const label = summaryLabel(providers);
  const detail = providers.map((p) => `${shortName(p)} ${shownWindows(p).map((w) => `${w.shortLabel || w.label} ${pct(w.usedPct)}`).join(" · ")}`).join(" │ ");
  return { label, title: `${TITLE_PREFIX}${detail}` };
}

export type HeaderButtonSet = { add(workspaceId: string): void; drop(workspaceId: string): void; dispose?(): void };

export function createUsageButtons(client: PluginClientContext): HeaderButtonSet {
  const registrations = new Map<string, PluginButtonRegistration>();
  const shown = new Map<string, string>();
  setStyleSheet(WIDTH_STYLE_ID, WIDTH_CSS);
  const stopTip = hideButtonTooltip(TITLE_PREFIX);

  function UsageIcon({ workspaceId, size, color }: PluginButtonIconProps) {
    const { usage } = useUsage();
    useEffect(() => {
      const next = presentation(usage);
      const key = `${next.label}\n${next.title}`;
      if (shown.get(workspaceId) === key) return;
      shown.set(workspaceId, key);
      registrations.get(workspaceId)?.update(next);
    }, [workspaceId, usage]);
    return <Icon name="Gauge" size={size} color={color} />;
  }

  function UsagePopover({ theme }: PluginButtonContentProps) {
    return (
      <View style={{ width: POPOVER_WIDTH }}>
        <UsageTable theme={theme} />
      </View>
    );
  }

  return {
    add(workspaceId) {
      if (registrations.has(workspaceId)) return;
      registrations.set(
        workspaceId,
        client.addHeaderButton({
          id: "usage",
          workspaceId,
          button: { ...presentation(null), icon: UsageIcon, behavior: { kind: "popover", Content: UsagePopover } },
        }),
      );
    },
    drop(workspaceId) {
      registrations.get(workspaceId)?.remove();
      registrations.delete(workspaceId);
      shown.delete(workspaceId);
    },
    dispose() {
      setStyleSheet(WIDTH_STYLE_ID, null);
      stopTip();
    },
  };
}
