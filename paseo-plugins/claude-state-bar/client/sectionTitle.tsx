import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";

/**
 * 누르면 접히고 펼쳐지는 대제목(10-09 리규형님 "설정의 항목이 2개 이상인 것은 접힌 상태로 로딩 — 너무 길어서 헷갈려").
 * 펼침 상태는 기억하지 않는다 — 설정 화면을 열 때마다 접힌 채로 시작한다(부르는 쪽 useState(false))
 */
export function FoldTitle({ icon, title, theme, open, onToggle, labels, marginTop = 8 }: {
  icon: string;
  title: string;
  theme: PluginSurfaceProps["theme"];
  open: boolean;
  onToggle: () => void;
  labels: { open: string; close: string };
  marginTop?: number;
}) {
  return (
    <Pressable onPress={onToggle} accessibilityRole="button" accessibilityLabel={`${title} ${open ? labels.close : labels.open}`} accessibilityState={{ expanded: open }}>
      <SectionTitle icon={icon} title={title} theme={theme} lead={open ? "▾" : "▸"} marginTop={marginTop} />
    </Pressable>
  );
}

// 설정 화면 대제목 — 아이콘 + 글자(10-09 리규형님 "설정에서 대제목은 아이콘이라도 둬야 하는 거 아냐? 너무 성의 없잖아").
// 아이콘은 Lucide 이름이다(Paseo 플러그인 Icon — 모르는 이름이면 아무것도 안 그린다). lead 는 접기 화살표처럼 아이콘 앞에 붙는 글자
export function SectionTitle({ icon, title, theme, lead, marginTop = 8 }: {
  icon: string;
  title: string;
  theme: PluginSurfaceProps["theme"];
  lead?: string;
  marginTop?: number;
}) {
  const c = theme.colors;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop }}>
      {lead ? <Text style={{ color: c.foreground, fontSize: 16 }}>{lead}</Text> : null}
      <Icon name={icon} size={18} color={c.foreground} />
      <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600", flexShrink: 1 }}>{title}</Text>
    </View>
  );
}
