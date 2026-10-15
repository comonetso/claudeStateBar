// 질문 도구 결과 글에서 질문마다 고른 답 뽑기(10-15, client/askAnswer.tsx) — 화면 부품 없는 순수 함수라 따로 시험한다
const ANSWERED = "Your questions have been answered: ";
const TAIL = ". You can now continue";
/** 결과 글에서 질문마다 고른 답 — `"질문"="답"` 을 질문 글로 찾는다(답에 따옴표·쉼표가 있어도 다음 질문 자리까지를 답으로 본다) */
export function parseAnswers(output: string, questions: readonly string[]): (string | null)[] {
  const body = output.startsWith(ANSWERED) ? output.slice(ANSWERED.length) : output;
  const starts = questions.map((q) => {
    const at = body.indexOf(`"${q}"="`);
    return at < 0 ? -1 : at + q.length + 4;
  });
  return questions.map((_, i) => {
    const from = starts[i];
    if (from < 0) return null;
    const nexts = starts.map((s, j) => (j !== i && s > from ? body.lastIndexOf(", \"", s - questions[j].length - 4) : -1)).filter((s) => s >= from);
    const tail = body.indexOf(TAIL, from);
    const end = Math.min(...nexts, tail >= 0 ? tail : body.length);
    const raw = body.slice(from, end);
    return raw.endsWith('"') ? raw.slice(0, -1) : raw;
  });
}
