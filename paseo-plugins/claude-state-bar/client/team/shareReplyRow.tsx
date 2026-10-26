import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as ui from "@getpaseo/plugin/client/ui";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState, type ComponentType } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { SHARE_REPLY_KIND, SHARE_REPLY_VERSION, shareReplyAction, shareReplyData, shareReplyFileGet, shareSizeText, type ShareReplyData, type ShareReplyFile } from "../../shared/team/share";
import { shareClientFor } from "./shareGate";

// 같이 보기 — 리규형님 대화 화면 안 "팀원 답글" 줄(10-25 리규형님 결정 "내게 오고 눌러야 대화에"). 서버(server/team/share.ts)가 그 대화 기록에
// 플러그인 줄로 넣는다 — Paseo 는 그 줄을 화면에만 그리고 Claude 에게 보내지 않는다. "대화에 넣기"를 누르면 그 기기 플러그인이
// "<이름> 답글: …" 으로 대화에 보낸다(쉬고 있을 때만). 단추는 그 대화가 도는 기기(host.id)의 플러그인 연결로 묻는다(shareGate 등록부)

type Theme = { colors: Record<string, string> };
type RowProps = { agentId: string; item: { data: ShareReplyData }; theme: Theme; host?: { id: string } };
type AddRenderer = (contribution: { kind: string; version: number; schema: unknown; Component: ComponentType<RowProps> }) => () => void;
const Markdown = (ui as unknown as { Markdown?: ComponentType<{ children: string }> }).Markdown;

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

type Rpc = Pick<PluginClientContext, "rpc">;
/** 첨부 이미지 미리보기(10-25) — 그 대화가 도는 기기에 받아 둔 그림을 가져와 그린다. 누르면 크게 */
function ShareImage({ target, agentId, replyId, n, file, theme }: { target: Rpc; agentId: string; replyId: string; n: number; file: ShareReplyFile; theme: Theme }) {
  const c = theme.colors;
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let live = true;
    void target.rpc(shareReplyFileGet, { agentId, replyId, n }).then((r) => {
      if (!live) return;
      if (r.ok && r.data) setUri(`data:${r.mimeType ?? file.mimeType};base64,${r.data}`);
      else setFailed(r.error ?? "이미지를 못 가져왔습니다");
    }).catch((e: unknown) => live && setFailed(String(e)));
    return () => { live = false; };
  }, [agentId, replyId, n]);
  if (!uri) return <FileChip file={file} theme={theme} note={failed ?? "이미지 불러오는 중…"} />;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${file.name} ${big ? "작게" : "크게"} 보기`} onPress={() => setBig((v) => !v)}
      style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: "hidden", alignSelf: "flex-start" }}>
      <Image source={{ uri }} resizeMode="contain" style={{ width: big ? 640 : 220, height: big ? 420 : 140, maxWidth: "100%" }} />
    </Pressable>
  );
}
function FileChip({ file, theme, note }: { file: ShareReplyFile; theme: Theme; note?: string }) {
  const c = theme.colors;
  const how = note ?? (file.kind === "image" ? "이미지" : file.kind === "text" ? "글 첨부로 넣음" : "파일 — 넣을 때 이 기기 경로를 적음");
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8, alignSelf: "flex-start" }}>
      <Icon name="Paperclip" size={12} color={c.foregroundMuted} />
      <Text style={{ color: c.foreground, fontSize: 12 }} numberOfLines={1}>{file.name}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{shareSizeText(file.size)} · {how}</Text>
    </View>
  );
}

export function registerShareReplyRenderer(client: PluginClientContext, log: (message: string) => void): () => void {
  const add = (client as unknown as { addTimelineRenderer?: AddRenderer }).addTimelineRenderer;
  if (typeof add !== "function") {
    log("share reply renderer: this Paseo has no timeline renderers");
    return () => {};
  }
  function ReplyRow({ agentId, item, theme, host }: RowProps) {
    const c = theme.colors;
    const d = item.data;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const act = async (action: "insert" | "dismiss") => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const target = shareClientFor(host?.id) ?? client;
        const r = await target.rpc(shareReplyAction, { agentId, replyId: d.replyId, action });
        if (!r.ok) setError(r.error ?? "처리하지 못했습니다");
      } catch (e) {
        setError(String(e));
      }
      setBusy(false);
    };
    const done = d.state !== "new";
    const button = (label: string, onPress: () => void, primary: boolean) => (
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        disabled={busy}
        style={{ paddingVertical: 5, paddingHorizontal: 12, borderRadius: 6, borderWidth: 1, borderColor: primary ? c.accent : c.border,
          backgroundColor: primary ? c.accent : "transparent", opacity: busy ? 0.6 : 1 }}
      >
        <Text style={{ color: primary ? c.accentForeground : c.foreground, fontSize: 12, fontWeight: primary ? "600" : "400" }}>{label}</Text>
      </Pressable>
    );
    return (
      <View style={{ marginVertical: 6, borderWidth: 1, borderColor: done ? c.border : c.accent, borderRadius: 10, padding: 12, gap: 8, opacity: d.state === "dismissed" ? 0.6 : 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="MessageSquareReply" size={14} color={done ? c.foregroundMuted : c.accent} />
          <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{d.label} 답글</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{time(d.at)}</Text>
          <View style={{ flex: 1 }} />
          {d.state === "inserted" ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>대화에 넣었습니다</Text> : null}
          {d.state === "dismissed" ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>닫음</Text> : null}
        </View>
        {d.state === "dismissed" || !d.text ? null : Markdown ? <Markdown>{d.text}</Markdown> : <Text selectable style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }}>{d.text}</Text>}
        {d.state === "dismissed" || !d.files?.length ? null : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {d.files.map((f, n) => f.kind === "image"
              ? <ShareImage key={n} target={shareClientFor(host?.id) ?? client} agentId={agentId} replyId={d.replyId} n={n} file={f} theme={theme} />
              : <FileChip key={n} file={f} theme={theme} />)}
          </View>
        )}
        {done ? null : (
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            {button(busy ? "넣는 중…" : "대화에 넣기", () => void act("insert"), true)}
            {button("닫기", () => void act("dismiss"), false)}
            <Text style={{ color: c.foregroundMuted, fontSize: 11, flex: 1 }}>넣기 전에는 Claude 에게 가지 않습니다</Text>
          </View>
        )}
        {error ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{error}</Text> : null}
      </View>
    );
  }
  try {
    return add.call(client, { kind: SHARE_REPLY_KIND, version: SHARE_REPLY_VERSION, schema: shareReplyData, Component: ReplyRow });
  } catch (error) {
    log(`share reply renderer: ${String(error)}`);
    return () => {};
  }
}
