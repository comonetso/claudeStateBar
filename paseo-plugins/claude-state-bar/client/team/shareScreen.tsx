import * as ui from "@getpaseo/plugin/client/ui";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SHARE_ACCEPT, SHARE_ALLOWED_TEXT, SHARE_FILES_MAX, SHARE_FILE_MAX_BYTES, SHARE_FILES_TOTAL_BYTES, shareFileAllowed, shareSizeText } from "../../shared/team/share";
import { getShare, sendShareReply, shareErrorText, shareGateReachable, type ShareFull, type ShareOutFile } from "./shareGate";

// 같이 보기 — 팀원 화면(10-25 리규형님 "공유화면은 별도의 화면으로 간단하게, 깔쌈하게"). 공유받은 대화의 사람 말·Claude 답을 읽기 전용으로
// 보여 주고, 맨 아래 답글 칸에서 공유한 사람에게 답글을 보낸다(그 사람이 넣어야 대화에 들어간다). 게이트에 "바뀔 때까지 기다리기"로 묻는다.
// 답 글은 Paseo 의 글 그리기 부품(0.13.0 @getpaseo/plugin/client/ui Markdown)으로 — 옛 판이면 보통 글로

type Theme = { colors: Record<string, string> };
type Props = { theme: Theme; params?: Record<string, string>; layout?: { compact: boolean } };
const Markdown = (ui as unknown as { Markdown?: ComponentType<{ children: string }> }).Markdown;

// 답글 첨부(10-25 리규형님 — "+" 단추로 아무 파일 · 이미지는 붙여넣기). 파일 → base64(브라우저 FileReader), 이미지면 미리보기 주소도
type Att = ShareOutFile & { size: number; uri: string | null };
// 이 플러그인은 브라우저 형 정의(DOM) 없이 짜여 있다 — 웹(게이트 화면)에서만 쓰는 두 부품의 필요한 모양만 적는다
type FileInput = { type: string; accept: string; multiple: boolean; files: ArrayLike<File> | null; onchange: (() => void) | null; click(): void };
type DomTarget = { addEventListener(type: string, fn: (e: unknown) => void): void; removeEventListener(type: string, fn: (e: unknown) => void): void };
const readAtt = (file: File) => new Promise<Att>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result ?? "");
    const mimeType = file.type || "application/octet-stream";
    const image = mimeType.startsWith("image/");
    resolve({ name: file.name || (image ? `붙여넣은 이미지.${mimeType.split("/")[1] ?? "png"}` : "file"), mimeType, size: file.size,
      data: url.slice(url.indexOf(",") + 1), uri: image ? url : null });
  };
  reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다"));
  reader.readAsDataURL(file);
});

const time = (ms: number | string | null | undefined) => {
  if (ms === null || ms === undefined) return "";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function ShareScreen({ theme, params, layout }: Props) {
  const c = theme.colors;
  const id = params?.id ?? "";
  const [share, setShare] = useState<ShareFull | null>(null);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [files, setFiles] = useState<Att[]>([]);
  const [fileNote, setFileNote] = useState<string | null>(null);
  // 붙여넣기 듣는 쪽이 옛 값을 보지 않게 첨부 목록은 ref 에도 둔다
  const filesRef = useRef<Att[]>([]);
  const setAll = (next: Att[]) => { filesRef.current = next; setFiles(next); };
  const input = useRef<TextInput | null>(null);
  const scroll = useRef<ScrollView | null>(null);
  const nearBottom = useRef(true);
  const pad = layout?.compact ? 12 : 24;

  useEffect(() => {
    if (!id || !shareGateReachable()) return;
    let stop = false;
    let rev: number | null = null;
    void (async () => {
      while (!stop) {
        try {
          const r = await getShare(id, rev);
          if (stop) return;
          if (r.status !== 200) {
            setError(shareErrorText(r.status));
            await new Promise((res) => setTimeout(res, 10_000));
            continue;
          }
          setError(null);
          if (r.json?.ended) { setEnded(true); setShare(null); return; }
          if (r.json?.same) continue;
          const next = r.json?.share as ShareFull | undefined;
          if (next) { rev = next.rev; setShare(next); }
        } catch (e) {
          if (stop) return;
          setError(`게이트에 닿지 못했습니다 (${String(e)})`);
          await new Promise((res) => setTimeout(res, 10_000));
        }
      }
    })();
    return () => { stop = true; };
  }, [id]);

  // 새 글이 오면 맨 아래에 있던 사람만 따라 내려간다(위를 읽는 중이면 그대로)
  useEffect(() => {
    if (nearBottom.current) setTimeout(() => scroll.current?.scrollToEnd({ animated: false }), 0);
  }, [share?.rev]);

  const addFiles = async (picked: File[]) => {
    const have = filesRef.current;
    let total = have.reduce((n, a) => n + a.size, 0);
    const take: File[] = [];
    const notes: string[] = [];
    for (const f of picked) {
      if (have.length + take.length >= SHARE_FILES_MAX) { notes.push(`첨부는 ${SHARE_FILES_MAX}개까지입니다`); break; }
      // 10-25 리규형님 명시 지시 — 이미지·PDF·PPT 등만(게이트도 한 번 더 거른다)
      if (!shareFileAllowed(f.name, f.type)) { notes.push(`${f.name || "이 파일"} — ${SHARE_ALLOWED_TEXT} 파일만 보낼 수 있습니다`); continue; }
      if (f.size > SHARE_FILE_MAX_BYTES) { notes.push(`${f.name} — 파일 하나 ${shareSizeText(SHARE_FILE_MAX_BYTES)}까지입니다`); continue; }
      if (total + f.size > SHARE_FILES_TOTAL_BYTES) { notes.push(`모두 합쳐 ${shareSizeText(SHARE_FILES_TOTAL_BYTES)}까지입니다`); break; }
      total += f.size;
      take.push(f);
    }
    setFileNote(notes.length ? [...new Set(notes)].join(" · ") : null);
    try {
      const read = await Promise.all(take.map(readAtt));
      if (read.length) setAll([...filesRef.current, ...read]);
    } catch (e) {
      setFileNote(`파일을 읽지 못했습니다 (${String(e)})`);
    }
  };
  // "+" 단추 — 브라우저 파일 고르기 창(여러 개)
  const pick = () => {
    const doc = (globalThis as unknown as { document?: { createElement(tag: "input"): FileInput } }).document;
    if (!doc) return;
    const el = doc.createElement("input");
    el.type = "file";
    el.accept = SHARE_ACCEPT;
    el.multiple = true;
    el.onchange = () => void addFiles(Array.from(el.files ?? []));
    el.click();
  };
  // 답글 칸에 붙여넣기 — 이미지(또는 복사한 파일)가 있으면 첨부로, 글만이면 그대로 글로
  useEffect(() => {
    const el = input.current as unknown as DomTarget | null;
    if (!el || typeof el.addEventListener !== "function") return;
    const onPaste = (e: unknown) => {
      const ev = e as { clipboardData?: { files?: ArrayLike<File> } | null; preventDefault(): void };
      const list = Array.from(ev.clipboardData?.files ?? []);
      if (!list.length) return;
      ev.preventDefault();
      void addFiles(list);
    };
    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
  }, [share !== null]);
  // 답글 칸 Enter = 보내기 · Shift+Enter = 줄바꿈(10-25 리규형님 명시 지시). 한글 조합 중 Enter(조합 확정)는 보내지 않는다.
  // 리스너는 한 번 붙이고 보내기는 늘 최신 상태로 — sendRef
  const sendRef = useRef<() => void>(() => {});
  useEffect(() => {
    const el = input.current as unknown as DomTarget | null;
    if (!el || typeof el.addEventListener !== "function") return;
    const onKey = (e: unknown) => {
      const ev = e as { key?: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number; preventDefault(): void };
      if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      sendRef.current();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [share !== null]);

  const send = async () => {
    const text = draft.trim();
    if ((!text && !files.length) || sending) return;
    setSending(true);
    setSent(null);
    try {
      const r = await sendShareReply(id, text, files.map(({ name, mimeType, data }) => ({ name, mimeType, data })));
      if (r.status === 200) { setDraft(""); setAll([]); setFileNote(null); setSent("보냈습니다"); }
      else setSent(shareErrorText(r.status));
    } catch (e) {
      setSent(`보내지 못했습니다 (${String(e)})`);
    }
    setSending(false);
  };
  sendRef.current = () => void send();

  if (!shareGateReachable()) return <Center theme={theme} text="공유 화면은 웹 로그인 화면에서만 볼 수 있습니다" />;
  if (!id) return <Center theme={theme} text="열 공유가 없습니다" />;
  if (ended) return <Center theme={theme} text="공유가 끝났습니다" />;
  if (!share) return <Center theme={theme} text={error ?? "불러오는 중…"} />;
  // 공유한 사람 — 게이트가 열쇠 주인으로 정한 이름(리규형님 공유는 "관리자"·팀원 공유는 아이디)
  const owner = share.ownerName || share.owner || "공유한 사람";

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 ?? c.background }}>
      <View style={{ paddingHorizontal: pad, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="Users" size={16} color={c.foregroundMuted} />
          <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "600", flex: 1 }} numberOfLines={1}>{share.title}</Text>
          {share.running ? <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.statusSuccess ?? c.accent }} />
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>진행 중</Text>
          </View> : null}
        </View>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {owner} 공유 · 읽기 전용 · {time(share.updatedAt)} 갱신{error ? ` · ${error}` : ""}
        </Text>
      </View>

      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: pad, paddingVertical: 16, gap: 14, maxWidth: 900, width: "100%", alignSelf: "center" }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80;
        }}
        scrollEventThrottle={100}
      >
        {share.truncated ? <Text style={{ color: c.foregroundMuted, fontSize: 12, textAlign: "center" }}>앞부분은 생략했습니다</Text> : null}
        {share.items.map((it, i) => it.role === "user" ? (
          <View key={i} style={{ alignSelf: "flex-end", maxWidth: "85%", gap: 2 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 11, textAlign: "right" }} numberOfLines={1}>{speakerOf(it.text, owner).name}</Text>
            <View style={{ backgroundColor: c.surface2, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text selectable style={{ color: c.foreground, fontSize: 14, lineHeight: 20 }}>{speakerOf(it.text, owner).body}</Text>
              {it.at ? <Text style={{ color: c.foregroundMuted, fontSize: 11, marginTop: 4, textAlign: "right" }}>{time(it.at)}</Text> : null}
            </View>
          </View>
        ) : (
          <View key={i} style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name="Sparkles" size={13} color={c.foregroundMuted} />
              <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Claude{it.at ? ` · ${time(it.at)}` : ""}</Text>
            </View>
            {Markdown ? <Markdown>{it.text}</Markdown> : <Text selectable style={{ color: c.foreground, fontSize: 14, lineHeight: 21 }}>{it.text}</Text>}
          </View>
        ))}
      </ScrollView>

      {/* 답글 칸은 위 글 영역과 같은 폭(최대 900·가운데)으로 — 넓은 화면에서 칸만 끝까지 퍼지지 않게(10-25 리규형님).
          관리자가 대상이 아닌 공유를 미리 볼 때는 답글 칸 대신 안내(게이트도 403 — 10-25 팀원도 공유) */}
      {share.forMe === false ? (
        <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingHorizontal: pad, paddingVertical: 12 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12, textAlign: "center" }}>미리보기 — 답글은 이 공유의 대상만 쓸 수 있습니다</Text>
        </View>
      ) : (
      <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
      <View style={{ paddingHorizontal: pad, paddingVertical: 10, gap: 6, maxWidth: 900, width: "100%", alignSelf: "center" }}>
        {share.pendingReplies.length ? (
          <View style={{ gap: 4 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>보낸 답글 — 아직 확인 전</Text>
            {share.pendingReplies.map((r) => (
              <Text key={r.id} style={{ color: c.foreground, fontSize: 13 }} numberOfLines={2}>· {r.text}{r.files?.length ? `${r.text ? " " : ""}(첨부 ${r.files.length}개)` : ""}</Text>
            ))}
          </View>
        ) : null}
        {files.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {files.map((a, i) => (
              <View key={`${i}-${a.name}`} style={{ flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 4, paddingRight: 2 }}>
                {a.uri ? <Image source={{ uri: a.uri }} resizeMode="cover" style={{ width: 40, height: 40, borderRadius: 4 }} /> : <Icon name="Paperclip" size={14} color={c.foregroundMuted} />}
                <View style={{ maxWidth: 180 }}>
                  <Text style={{ color: c.foreground, fontSize: 12 }} numberOfLines={1}>{a.name}</Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{shareSizeText(a.size)}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel={`${a.name} 빼기`} onPress={() => setAll(filesRef.current.filter((_, j) => j !== i))} style={{ padding: 4 }}>
                  <Icon name="X" size={14} color={c.foregroundMuted} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="파일 첨부"
            onPress={pick}
            disabled={sending}
            style={{ width: 40, height: 40, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignItems: "center", justifyContent: "center", backgroundColor: c.surface1 }}
          >
            <Icon name="Plus" size={18} color={c.foreground} />
          </Pressable>
          <TextInput
            ref={input}
            value={draft}
            onChangeText={setDraft}
            multiline
            placeholder="답글 남기기… (이미지는 붙여넣기, 파일은 +)"
            placeholderTextColor={c.foregroundMuted}
            style={{ flex: 1, minHeight: 40, maxHeight: 140, color: c.foreground, fontSize: 14, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: c.surface1 }}
          />
          <Pressable
            accessibilityRole="button"
            onPress={() => void send()}
            disabled={sending || (!draft.trim() && !files.length)}
            style={{ height: 40, paddingHorizontal: 16, borderRadius: 10, justifyContent: "center", backgroundColor: c.accent, opacity: sending || (!draft.trim() && !files.length) ? 0.5 : 1 }}
          >
            <Text style={{ color: c.accentForeground, fontSize: 14, fontWeight: "600" }}>{sending ? "보내는 중…" : "보내기"}</Text>
          </Pressable>
        </View>
        {fileNote ? <Text style={{ color: c.statusWarning ?? c.foregroundMuted, fontSize: 11 }}>{fileNote}</Text> : null}
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{sent ?? `Enter 보내기 · Shift+Enter 줄바꿈 · 첨부는 ${SHARE_ALLOWED_TEXT}. 답글은 공유한 사람의 대화로 갑니다.`}</Text>
      </View>
      </View>
      )}
    </View>
  );
}

// 대화에 들어간 답글은 "<이름> 답글: …"(server/team/share.ts) — 말한 사람을 이름 칸으로 올려 참여자끼리 서로의 답글을 가른다(10-25 명시 지시 6-3).
// 그 밖의 사람 말은 공유한 사람의 말이다
const REPLY_HEAD = /^(\S[^\n]{0,39}?) 답글:(?: |\n|$)/;
function speakerOf(text: string, owner: string): { name: string; body: string } {
  const m = REPLY_HEAD.exec(text);
  return m ? { name: `${m[1]} 답글`, body: text.slice(m[0].length) } : { name: owner, body: text };
}

function Center({ theme, text }: { theme: Theme; text: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>{text}</Text>
    </View>
  );
}
