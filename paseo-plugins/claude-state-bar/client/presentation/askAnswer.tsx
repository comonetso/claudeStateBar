import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { z } from "zod";
import { parseAnswers } from "../../shared/presentation/askAnswer";

// 질문(AskUserQuestion)에 답한 뒤 고른 답을 대화에 보이기(10-15 리규형님 "질문 버튼에 답변을 했을 때 내가 어떤 답을 했는지 명시적으로
// 확인이 필요함 — 지금은 아무것도 안 나타남. RC 는 보여 줘서 좋았음"). Paseo 는 답한 질문 도구 줄을 도구 묶음 안에 접어 둬 답이 안 보인다.
// 대화 기록 변환기로 끝난 질문 도구 줄만 "질문 → 고른 답" 카드로 바꿔 그린다. 답을 기다리는 중(running)은 그대로 둬 Paseo 질문 창이 뜬다.
// 데이터(10-15 실측, Paseo 0.11 Claude): detail.type "unknown" · detail.input.questions[{question, header, options}] ·
// detail.output.output = `Your questions have been answered: "질문"="답", "질문"="답". You can now continue …` ·
// 버튼 대신 말로 답하면 status "failed" + error.content "The user answered with a message instead of approving…"

const KIND = "ask-answer";
type Row = { header: string; question: string; answer: string | null };
type Data = { rows: Row[]; byMessage: boolean };
const schema = z.object({
  rows: z.array(z.object({ header: z.string(), question: z.string(), answer: z.string().nullable() })),
  byMessage: z.boolean(),
});

type Question = { question?: unknown; header?: unknown };
function rowsOf(item: { detail?: unknown; status?: unknown; error?: unknown }): Data | undefined {
  const detail = item.detail as { input?: { questions?: unknown }; output?: { output?: unknown } | null } | undefined;
  const questions = Array.isArray(detail?.input?.questions) ? (detail!.input!.questions as Question[]) : [];
  if (!questions.length) return undefined;
  const texts = questions.map((q) => (typeof q.question === "string" ? q.question : ""));
  const headers = questions.map((q) => (typeof q.header === "string" ? q.header : ""));
  if (item.status === "completed" && typeof detail?.output?.output === "string") {
    const answers = parseAnswers(detail.output.output, texts);
    return { rows: texts.map((question, i) => ({ header: headers[i], question, answer: answers[i] })), byMessage: false };
  }
  const reason = (item.error as { content?: unknown } | null)?.content;
  if (item.status === "failed" && typeof reason === "string" && reason.includes("answered with a message")) {
    return { rows: texts.map((question, i) => ({ header: headers[i], question, answer: null })), byMessage: true };
  }
  return undefined;
}

function AnswerCard(props: PluginTimelineItemProps<Data>) {
  const c = props.theme.colors;
  const { rows, byMessage } = props.item.data;
  return (
    <View style={{ marginVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, paddingHorizontal: 10, paddingVertical: 8, gap: 6 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{byMessage ? "질문 — 버튼 대신 말로 답함" : "질문에 고른 답"}</Text>
      {rows.map((r, i) => (
        <View key={i} style={{ gap: 2 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }} numberOfLines={2}>
            {r.header ? `${r.header} · ` : ""}{r.question}
          </Text>
          {r.answer !== null ? <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>→ {r.answer}</Text> : null}
        </View>
      ))}
    </View>
  );
}

export function registerAskAnswer(client: PluginClientContext, log: (message: string) => void): () => void {
  const a = client.addTimelineTransformer({
    id: "ask-answer",
    query: { itemType: "tool_call" },
    transform: ({ item }) => {
      if (item.name !== "AskUserQuestion") return undefined;
      try {
        const data = rowsOf(item);
        return data ? { items: [{ type: "plugin", kind: KIND, version: 1, data }] } : undefined;
      } catch (error) {
        log(`ask answer: ${String(error)}`);
        return undefined;
      }
    },
  });
  const b = client.addTimelineRenderer({ kind: KIND, version: 1, schema, Component: AnswerCard });
  return () => {
    void a();
    void b();
  };
}

// 스킬 호출을 이름과 함께 한 줄로(10-27 리규형님 버튼 "둘 다"). Paseo 는 스킬 호출을 다른 도구와 함께 "다른 도구 N개 사용함"으로 접어,
// 중계기가 연 Admin DEV 대화가 korean-rule 을 먼저 불렀는데도 화면에선 peer_mail 만 부른 것처럼 보였다(기록엔 korean-rule → peer_mail).
// 대화 기록 변환기로 Skill 도구 줄만 "스킬 불러옴 · 이름" 줄로 바꾼다. 묶음 요약 문구는 앱 본체 것이라 못 고치므로 묶음에서 빼서 따로 그린다.
// 데이터: tool_call · name "Skill" · detail.input.skill(스킬 이름) — Paseo 기록 줄도 "[Skill] korean-rule" 로 찍힌다

const SKILL_KIND = "skill-call";
type SkillData = { skill: string; state: "running" | "completed" | "failed" };
const skillSchema = z.object({ skill: z.string(), state: z.enum(["running", "completed", "failed"]) });

function skillOf(item: { detail?: unknown }): string | undefined {
  const d = item.detail as { type?: unknown; label?: unknown; input?: { skill?: unknown } } | undefined;
  // 0.13.0 Claude: detail { type "plain_text", label "korean-rule", text "Launching skill: korean-rule" }(10-27 진단 줄 실측) — 다른 판 대비로 input.skill 도 본다
  if (d?.type === "plain_text" && typeof d.label === "string" && d.label) return d.label;
  return typeof d?.input?.skill === "string" && d.input.skill ? d.input.skill : undefined;
}

const SKILL_LABEL: Record<SkillData["state"], string> = { running: "스킬 부르는 중", completed: "스킬 불러옴", failed: "스킬 못 부름" };

function SkillRow(props: PluginTimelineItemProps<SkillData>) {
  const c = props.theme.colors;
  const { skill, state } = props.item.data;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginVertical: 2 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{SKILL_LABEL[state]} ·</Text>
      <Text style={{ color: state === "failed" ? c.statusWarning : c.foreground, fontSize: 13, fontWeight: "600" }}>
        {skill}
      </Text>
    </View>
  );
}

export function registerSkillCall(client: PluginClientContext, log: (message: string) => void): () => void {
  const a = client.addTimelineTransformer({
    id: "skill-call",
    query: { itemType: "tool_call" },
    transform: ({ item }) => {
      if (item.name !== "Skill") return undefined;
      try {
        const skill = skillOf(item);
        if (!skill) return undefined;
        const state: SkillData["state"] = item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : "running";
        return { items: [{ type: "plugin", kind: SKILL_KIND, version: 1, data: { skill, state } }] };
      } catch (error) {
        log(`skill call: ${String(error)}`);
        return undefined;
      }
    },
  });
  const b = client.addTimelineRenderer({ kind: SKILL_KIND, version: 1, schema: skillSchema, Component: SkillRow });
  return () => {
    void a();
    void b();
  };
}
