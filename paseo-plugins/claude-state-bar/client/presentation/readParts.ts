// 화면 문단 조각 다듬기 — 순수 함수(web.ts screenParts 가 쓰고 시험이 직접 부른다)
/**
 * 괄호 짝이 조각 사이에서 끊겼으면 짝이 맞는 조각까지 이어 붙인다(10-16 리규형님 "괄호 속 영문 파일명을 읽는다").
 * Paseo 는 코드 글씨를 블록 상자로 그려 "파일(" · "x.md" · ")를" 처럼 문장이 갈린다 — 그러면 서버가 괄호를 한꺼번에 보지 못해
 * 파일명 조각을 괄호 밖 글로 읽었다. 닫히지 않은 괄호 하나로 뒤 문단이 다 붙지 않게, 바로 뒤 JOIN_LOOKAHEAD 조각 안에서 닫힐 때만 잇는다.
 * 형광펜 자리는 첫 조각. 코드 글씨 하나가 만드는 조각은 앞뒤 둘이라 셋이면 넉넉하다(Claude 선택 값)
 */
const JOIN_LOOKAHEAD = 3;
const parenDepth = (text: string, from = 0): number => {
  let depth = from;
  for (const ch of text) {
    if (ch === "(" || ch === "（") depth++;
    else if ((ch === ")" || ch === "）") && depth > 0) depth--;
  }
  return depth;
};
export function joinSplitParens<T extends { text: string }>(parts: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = { ...parts[i] };
    let depth = parenDepth(head.text);
    if (depth > 0) {
      let end = -1, d = depth;
      for (let j = i + 1; j < parts.length && j <= i + JOIN_LOOKAHEAD; j++) {
        d = parenDepth(parts[j].text, d);
        if (d === 0) { end = j; break; }
      }
      if (end > 0) {
        for (let j = i + 1; j <= end; j++) head.text += parts[j].text;
        i = end;
      }
    }
    out.push(head);
  }
  return out;
}
