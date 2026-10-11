// 작고 빠른 글 모델: 공식 모델 문서가 smaller/faster, low latency without a reasoning step으로 명시.
// https://developers.openai.com/api/docs/models/gpt-4.1-mini (2026-10-12 확인)
export const OPENAI_TEXT_MODEL = "gpt-4.1-mini";
export async function openaiText(key: string, instruction: string, text: string, signal: AbortSignal): Promise<{ text: string } | { error: string }> {
  // https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, signal,
    body: JSON.stringify({ model: OPENAI_TEXT_MODEL, temperature: 0, messages: [
      { role: "system", content: instruction }, { role: "user", content: text },
    ] }),
  });
  if (!response.ok) return { error: `OpenAI HTTP ${response.status}` };
  const data = await response.json() as { choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: string }[] };
  const choice = data.choices?.[0];
  const value = choice?.message?.content;
  if (choice?.finish_reason !== "stop" || choice.message?.refusal || typeof value !== "string" || value.includes(key)) {
    return { error: "OpenAI 응답 형식 오류" };
  }
  return { text: value };
}
