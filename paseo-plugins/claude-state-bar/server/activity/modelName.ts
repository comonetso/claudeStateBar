// 복사본: VS Code 확장 src/providers/claude/display.ts 의 getShortModelName(2026-10-05). 확장 쪽을 고치면 여기도.
// "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-4-5-20250514" → "Sonnet 4.5", "claude-opus-5[1m]" → "Opus 5 1M"
export function getShortModelName(model: string): string {
  if (!model) return "";
  const lower = model.toLowerCase();
  // "<synthetic>" 같은 자리표시는 모델 이름이 아니다
  if (lower.charAt(0) === "<") return "";
  let family = "";
  if (lower.includes("opus")) family = "Opus";
  else if (lower.includes("sonnet")) family = "Sonnet";
  else if (lower.includes("haiku")) family = "Haiku";
  else if (lower.includes("fable")) family = "Fable";
  else if (lower.includes("mythos")) family = "Mythos";
  else {
    const parts = model.split("-");
    return parts[parts.length - 1] || model;
  }
  // 대괄호 변형 꼬리와 끝의 출시 날짜를 떼고 판수를 읽는다
  const base = lower.replace(/\[[^\]]*\]$/, "").replace(/-\d{6,}$/, "");
  const verMatch = base.match(/(\d+)-(\d+)(?!\d)/);
  const singleVerMatch = verMatch ? null : base.match(/[^\d](\d+)$/);
  const version = verMatch ? `${verMatch[1]}.${verMatch[2]}` : singleVerMatch ? singleVerMatch[1] : "";
  const onem = lower.includes("1m") ? "1M" : "";
  return `${family}${version ? ` ${version}` : ""}${onem ? ` ${onem}` : ""}`;
}
