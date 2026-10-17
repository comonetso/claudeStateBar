import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// 생각 상자에 섞여 들어온 Claude 의 말을 상자 밖으로 꺼낼 자리(10-09 리규형님 "생각 상자 안에 나한테 하는 말이 들어간다" →
// "플러그인으로 꺼내고 Paseo 에도 요청" → "언어 추측만으로는 절대 안 된다, 생각을 한글로 하는 경우도 많다").
// 왜 섞이나: Claude 서비스는 도구를 부르기 전 중간 본문을 본문 칸 없이 두 번째 생각 칸(바꿔 쓴 한 문단)으로 돌려줄 때가 많고
// (이 대화 기록: 생각→생각→도구 300번 넘게), Paseo 는 이어진 생각 항목을 경계 없이 붙여 상자 하나로 만든다(0.11.1
// timeline-projection.js mergeReasoningChunks `${앞}${뒤}`). 합쳐진 글에는 경계가 안 남는다(칸 끝·문단 사이 줄바꿈이 같다).
// 그래서 글이 아니라 Claude 원본 기록(jsonl)에서 칸을 센다 — 거기엔 생각 칸이 칸마다 따로 있다. 데몬 쪽이 기록을 읽어
// "이 상자 글은 몇 번째 글자에서 마지막 칸이 시작되는가"를 알려 주고, 화면은 그 앞만 상자에, 마지막 칸은 상자 아래에 그린다.
// 칸이 하나뿐이거나 기록에서 못 찾으면 null — 상자를 지금처럼 통째로 둔다(언어 추측은 쓰지 않는다).

// wait: 지금 도는 턴의 상자면 true — 기록에서 못 찾으면 데몬이 기록 파일이 늘어날 때까지 기다렸다 다시 찾는다(10-09: 생각이 다
// 들어온 순간 물었는데 기록엔 아직 안 적혀 "모름"을 받고, 글이 더 안 바뀌어 다시 묻지 않아 상자에 남은 일이 있었다)
export const thinkingBoundary = defineRpc({
  name: "thinking.boundary",
  input: z.object({ agentId: z.string(), text: z.string(), wait: z.boolean().optional() }),
  output: z.object({ cut: z.number().int().nonnegative().nullable() }),
});

/** 꺼낼 자리와, 상자 글이 기록의 어느 칸 묶음과 맞았는지(matched=false 면 기록에 아직 없음 — 다시 찾을 만하다) */
export type CutResult = { cut: number | null; matched: boolean };

/**
 * 한 응답(message.id) 안에서 이어진 생각 칸 묶음들(오래된 것 → 새것)과 상자 글을 맞춰, 마지막 칸이 시작되는 글자 위치를 준다.
 * - 상자 글 = 칸1+…+칸n 이면 칸n 시작(n≥2), 칸 하나면 null
 * - 칸k 가 들어오는 중(상자 글이 칸k 앞부분에서 끝남)이면 칸k 시작(k≥2)
 * - 기록의 칸을 다 지나고도 상자 글이 길면 기록에 아직 안 적힌 다음 칸이 들어오는 중 — 그 시작
 * 글은 \r 을 뺀 뒤 비교한다(Paseo 생각 감시도 \r 을 뺀다).
 */
export function cutFromRuns(runs: readonly (readonly string[])[], text: string): CutResult {
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r];
    if (!run.length || !run[0] || !text.startsWith(run[0].slice(0, Math.min(run[0].length, text.length)))) continue;
    let pos = 0;
    let matched = true;
    for (let k = 0; k < run.length; k++) {
      const block = run[k];
      const end = pos + block.length;
      if (text.length >= end && text.startsWith(block, pos)) {
        if (text.length === end) return { cut: k >= 1 ? pos : null, matched: true };
        pos = end;
        continue;
      }
      if (text.length < end && block.startsWith(text.slice(pos))) return { cut: k >= 1 ? pos : null, matched: true };
      matched = false;
      break;
    }
    if (matched && pos > 0 && text.length > pos) return { cut: pos, matched: true };
  }
  return { cut: null, matched: false };
}
