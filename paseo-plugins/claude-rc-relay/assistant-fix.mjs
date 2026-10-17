// Paseo 화면 중복 막기(10-05 리규형님 "대화가 중복으로 계속 나온다") — 개인 중계기(relay.mjs)와 팀 실행기(claude-team-launch/launch.mjs)가 같이 쓴다.
// Claude 는 한 응답의 완성본(assistant 줄)을 블록마다 따로, 그 블록만 담아 보낸다(실측). Paseo 0.11 의 조립기
// (TimelineAssembler.applyAbsoluteFragments)는 완성본을 "그 응답의 지금까지 전체"로 보고, 실시간 조각으로 쌓은 글과
// 앞부분이 다르면 처음부터 다시 그린 셈 친다. 그래서 같은 응답에 생각·본문 블록이 둘 이상이면 두 번째부터 두 번 나온다.
// 본 대화 줄의 첫 생각·본문 블록 앞에 같은 응답에서 앞서 나온 글을 붙여 Paseo 가 기대하는 모양으로 맞춘다.
// 서브에이전트 줄(parent_tool_use_id)은 Paseo 가 조립기를 거치지 않고 블록마다 그리므로 손대지 않는다.
// 10-18: 팀 실행기에 이 장치가 없어 PC 팀 대화(como·hrg)의 생각 상자에 진행 글이 두 번 찍혔다(Codex 상담 261018_015928 —
// 대표 기록 39/39 응답이 정확히 "첫 칸+둘째 칸+둘째 칸"). 본문은 relay.mjs 에 있던 그대로 옮겼다. 실행기 한 세대(child)에 하나씩 만든다.

/** 줄 하나(끝 줄바꿈 포함)를 받아 고친 줄을 돌려준다. 안 고친 줄은 받은 그대로 */
export function createAssistantFix() {
  let curMsgId = null;
  let prevThinking = "";
  let prevText = "";
  return (line) => {
    if (!line.includes('"type":"assistant"')) return line;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return line;
    }
    if (o.type !== "assistant" || o.parent_tool_use_id || !Array.isArray(o.message?.content) || !o.message.id) return line;
    if (o.message.id !== curMsgId) {
      curMsgId = o.message.id;
      prevThinking = "";
      prevText = "";
    }
    const pT = prevThinking;
    const pX = prevText;
    let changed = false;
    let firstThinking = true;
    let firstText = true;
    for (const b of o.message.content) {
      if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
        prevThinking += b.thinking;
        if (firstThinking && pT) {
          b.thinking = pT + b.thinking;
          changed = true;
        }
        firstThinking = false;
      } else if (b?.type === "text" && typeof b.text === "string" && b.text) {
        prevText += b.text;
        if (firstText && pX) {
          b.text = pX + b.text;
          changed = true;
        }
        firstText = false;
      }
    }
    return changed ? JSON.stringify(o) + "\n" : line;
  };
}
