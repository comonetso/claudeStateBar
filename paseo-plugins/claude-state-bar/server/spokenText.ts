import type { TargetLang } from "../shared/translate";

// 기호는 소리로 읽지 않는다(10-13 리규형님 "쩜·슬래시·대시는 가끔 이상하게 읽음 — 한글이 아닌 기호는 이상하게 읽어서 짜증").
// 그 전엔 원본 readaloud_text.py SPOKEN_SIGNS 대로 영어 이름 안 기호를 " 쩜 "·" 언더바 "·" 슬래시 "·" 대시 " 로 읽었다
// (claude-state-bar → "claude 대시 state 대시 bar"). 이제 띄어 읽고, 나머지 기호는 지우거나 쉼표(잠깐 쉼)로 바꾼다
const REPEATED_CHARS_MAX = 3;
const PAUSE = ", ";

// 구분줄 — 칸마다 대시 하나 이상, 정렬 표시(:--·:-:·--:) 가능
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const tableCells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
/**
 * 마크다운 표(머리줄 + 구분줄 + 줄들)를 줄마다 "첫 칸, 머리글 값, 머리글 값." 문장으로 바꾼다(10-13 리규형님 "표는 한 덩어리로,
 * 안에서는 줄마다 머리글과 짝지어"). 표가 빈 줄 없이 이어진 한 문단이라 재생기에서도 한 덩어리 — 다음 한 번이면 표 전체를 건너뛴다.
 * 첫 칸은 줄 이름이라 머리글 없이 값만, 빈 칸은 뺀다. Paseo 말 블록의 표는 화면 쪽(web.ts screenParts)이 같은 모양으로 만든다
 */
export function tableToSentences(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("|") || !TABLE_RULE.test(lines[i + 1] ?? "")) { out.push(lines[i]); continue; }
    const head = tableCells(lines[i]);
    const sentences: string[] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].includes("|"); j++) {
      const cells = tableCells(lines[j]);
      const parts = cells.map((cell, k) => (!cell ? "" : k === 0 || !head[k] ? cell : `${head[k]} ${cell}`)).filter(Boolean);
      if (parts.length) sentences.push(`${parts.join(PAUSE)}.`);
    }
    out.push(sentences.join(" "));
    i = j - 1;
  }
  return out.join("\n");
}

/**
 * 괄호 안을 읽을지(10-16 리규형님 — 10-13 "괄호 안은 통째로 안 읽음"을 바꿈). 괄호 규칙을 만든 이유는 괄호 속 영문 파일명이었다:
 * 한글이 든 괄호는 안의 영어까지 그대로 읽고, 파일명이라고 판단되는 것(확장자 붙은 이름·경로)이 들었거나 한글이 없는 괄호는 건너뛴다.
 * 파일명 판단 = 확장자 붙은 이름(work-cli.mjs · readaloud_text.py) 또는 구분자가 붙은 경로(docs/x · C:\ · ~/)
 */
// 영문·숫자 이름만 본다 — "(읽기/쓰기)" 같은 한글 사이 빗금은 경로가 아니다
const FILE_NAME = /[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,5}(?![A-Za-z0-9])|[A-Za-z0-9_.~-]*[\\/][A-Za-z0-9_.-]+|[A-Za-z]:[\\/]/;
export function keepParenContent(inner: string): boolean {
  return /\p{Script=Hangul}/u.test(inner) && !FILE_NAME.test(inner);
}
/**
 * 괄호 정리 — 읽을 괄호는 기호만 빼고 안을 남기고(keepParenContent), 아닌 괄호는 통째로 지운다. 소괄호·전각 괄호, 겹친 괄호는 안쪽부터. 짝 없는 괄호는 기호만 지운다.
 * 통째로 지울 때 뒤가 한글·빈칸·부호·끝이면 빈칸 없이 — "3대(DB)는" 이 "3대 는" 으로 조사 앞에서 끊겨 들렸다. 뒤가 영어·숫자면 빈칸을 둬 낱말이 붙지 않게
 */
export function dropParens(text: string): string {
  let prev: string;
  do {
    prev = text;
    text = text.replace(/\(([^()\n]*)\)|（([^（）\n]*)）/g, (m: string, a: string | undefined, b: string | undefined, at: number, all: string) => {
      const inner = a ?? b ?? "";
      const next = all.charAt(at + m.length);
      const spaceAfter = /[\p{L}\p{N}]/u.test(next) && !/\p{Script=Hangul}/u.test(next) ? " " : "";
      // 읽는 괄호는 안쪽을 남긴다 — 앞은 띄우고, 뒤는 조사·부호면 붙인다("허용(사람 확인)을" → "허용 사람 확인을"). 빈칸 겹침은 끝에서 줄인다
      if (keepParenContent(inner)) return ` ${inner}${spaceAfter}`;
      return spaceAfter;
    });
  } while (text !== prev);
  return text.replace(/[()（）]/g, " ");
}

// 10-10 리규형님 "URL은 그냥 'URL'이라고만" — http 뿐 아니라 ssh://·ws://·file:// 같은 주소 형식 전부
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()`]+/gi;
// 10-10 리규형님 "긴 경로는 파일명이나 맨 끝 경로만" + 버튼 "짧은 파일 경로까지 전부".
// 시작이 분명한 경로(C:\ · ~/ · ./ · ../ · /root/x 처럼 폴더가 붙은 절대 경로)는 길이와 상관없이 끝 이름만.
// 선행 / 는 뒤에 폴더 구분자가 하나 더 있어야 경로로 본다 — /start 같은 슬래시 명령은 그대로.
const ANCHORED_PATH = /(?<![\p{L}\p{N}_.~@+\-:/\\])(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/](?=[\p{L}\p{N}_.@+\-]+[\\/]))(?:[\p{L}\p{N}_.@+\-]+[\\/])*[\p{L}\p{N}_.@+\-]*/gu;
// 상대 경로(src/extension.ts)는 일반 글의 슬래시(ko/en · 읽기/쓰기)와 섞이므로 영문 이름만, 그리고
// 끝이 확장자 있는 파일이거나 · 폴더가 둘 이상 붙었거나 · 끝이 구분자(docs/)일 때만 경로로 본다.
const RELATIVE_PATH = /(?<![\w.~@+\-:/\\])[\w.@+-]+(?:[\\/][\w.@+-]+)+[\\/]?(?![\w.@+\-\\/])/g;
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

function lastName(path: string): string | undefined {
  return path.split(/[\\/]/).filter((part) => part && part !== "~" && part !== "." && part !== ".." && !/^[A-Za-z]:$/.test(part)).pop();
}

/** 경로는 끝 이름(파일명·마지막 폴더)만 남긴다. 화면 글은 그대로이고 소리로 읽을 글에만 쓴다. */
export function shortenPaths(text: string): string {
  return text
    .replace(ANCHORED_PATH, (path) => lastName(path) ?? path)
    .replace(RELATIVE_PATH, (path) => {
      const parts = path.split(/[\\/]/).filter(Boolean);
      const name = parts[parts.length - 1];
      if (!/[A-Za-z]/.test(name)) return path;
      const isPath = parts.length >= 3 || FILE_EXTENSION.test(name) || /[\\/]$/.test(path);
      return isPath ? name : path;
    });
}

// 날짜·시각·수식은 기호를 지우기 전에 말로 바꾼다 — 한국어 음성만(10-13 리규형님 "시간, 날짜 읽기는 정확히" · "수식 기호는 읽어야 함" +
// 버튼: 숫자 두 개 날짜는 월·일 범위면 날짜 · 등호는 은/는 · 빼기·나누기는 등호 있는 식에서만 · 한국어 음성만). 다른 언어는 나라마다
// 날짜 순서·말이 달라 그대로 둔다(기호는 아래에서 지워진다)
const validMonthDay = (month: string, day: string) => +month >= 1 && +month <= 12 && +day >= 1 && +day <= 31;
// 숫자 하나 — 소수·천 단위·퍼센트(1.5 · 1,000 · 50%). 수식 연산자 — 별표 하나(** 굵게는 아님)·더하기·빼기·곱하기·나누기·플러스마이너스·등호
const MATH_NUMBER = String.raw`\d+(?:[.,]\d+)*%?`;
const MATH_OPERATOR = String.raw`\s*(?:\*(?!\*)|[-−+×÷±=/])\s*`;
const MATH = new RegExp(String.raw`(?<![\w.,])${MATH_NUMBER}(?:${MATH_OPERATOR}${MATH_NUMBER})+(?!\w)`, "g");
// 등호 앞 숫자의 끝소리 받침 — 2(이)·4(사)·5(오)·9(구)·%(퍼센트)는 받침이 없어 "는", 나머지(0 영·1 일·3 삼·6 육·7 칠·8 팔, 끝 0 = 십·백·천·만)는 "은"
const equalsJosa = (before: string) => (/[2459%]\s*$/.test(before) ? "는" : "은");

// ── 한국어 숫자 말(10-19 리규형님 "전수조사해서 올바른 한국식으로 모두" — 80,055 를 "팔십에 오십오", 54,926~80,055 를 쉼표·물결에서 끊어 읽었다) ──
const KO_DIGITS = ["영", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const KO_SMALL = ["", "십", "백", "천"];
const KO_BIG = ["", "만", "억", "조", "경"];
/** 정수(숫자 글자)를 한자어 수사로 — 80055 → 팔만 오십오 · 54926 → 오만 사천구백이십육 · 1000000 → 백만 · 10000 → 만 · 100000000 → 일억.
 *  만 단위마다 띄우고, 십·백·천 앞의 일과 "일만"의 일은 뺀다(억·조는 "일억"). 경을 넘으면 그대로 */
export function koreanNumber(digits: string): string {
  const n = digits.replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(n)) return digits;
  if (/^0+$/.test(n)) return "영";
  if (n.length > 20) return n;
  const groups: string[] = [];
  for (let end = n.length; end > 0; end -= 4) groups.unshift(n.slice(Math.max(0, end - 4), end));
  const words: string[] = [];
  groups.forEach((group, gi) => {
    const big = KO_BIG[groups.length - 1 - gi];
    const padded = group.padStart(4, "0");
    let word = "";
    for (let i = 0; i < 4; i++) {
      const d = +padded[i];
      if (!d) continue;
      const unit = KO_SMALL[3 - i];
      word += (d === 1 && unit ? "" : KO_DIGITS[d]) + unit;
    }
    if (!word) return;
    if (word === "일" && big === "만") word = "";
    words.push(word + big);
  });
  return words.join(" ");
}
/** 소수 자리는 한 자리씩(.56 → 점 오육) */
const koreanFraction = (frac: string) => ` 점 ${frac.split("").map((d) => KO_DIGITS[+d]).join("")}`;
// 숫자 바로 뒤에 붙은 단위 — 영어 철자 대신 한국어로(35ms → 35밀리초). "m"(미터·분)은 뜻이 갈려 뺀다. 긴 이름을 먼저
const UNIT_WORDS: Record<string, string> = {
  ms: "밀리초", sec: "초", min: "분", s: "초", h: "시간", px: "픽셀", fps: "프레임",
  KiB: "키비바이트", MiB: "메비바이트", GiB: "기비바이트", TiB: "테비바이트", KB: "킬로바이트", kB: "킬로바이트", MB: "메가바이트", GB: "기가바이트", TB: "테라바이트",
  kHz: "킬로헤르츠", MHz: "메가헤르츠", GHz: "기가헤르츠", Hz: "헤르츠", km: "킬로미터", kg: "킬로그램", "°C": "도", "℃": "도",
};
const UNIT_NAMES = Object.keys(UNIT_WORDS).sort((a, b) => b.length - a.length).join("|");
// 하이픈 범위 뒤에 바로 붙는 한국어 단위(3-5초 · 1-3명) — 이때 하이픈은 "에서"
const RANGE_UNIT = "초|분|시간|일|주|개월|달|년|명|개|번|회|배|대|건|줄|쪽|장|마리|권|차|단계|가지|글자|자|살|원|위|곳|층|호|퍼센트|%";

export function readNumbersKo(text: string): string {
  return text
    // 연도 붙은 날짜(2026-10-14 · 2026/10/14 · 2026.10.14). 바로 뒤 ISO 의 T 는 띄운다
    .replace(/(?<![\d.:/-])(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?![\d/-]|[.:]\d)(T(?=\d{1,2}:\d{2}))?/g,
      (m, year: string, _sep: string, month: string, day: string, iso?: string) => (validMonthDay(month, day) ? `${year}년 ${+month}월 ${+day}일${iso ? " " : ""}` : m))
    // 끝자리를 x 로 둔 시각(18:4x — 기록에 대략 시각을 이렇게 쓴다) — "18시 40분쯤", 0x 는 "18시쯤"
    .replace(/(?<![\d.:])([01]?\d|2[0-3]):([0-5])x(?![A-Za-z0-9])/g, (_m, hour: string, tens: string) => (+tens ? `${+hour}시 ${tens}0분쯤` : `${+hour}시쯤`))
    // 시각(9:05 · 16:24 · 06:51:51) — 0 인 분·초는 끝에서부터 뺀다(09:00 → 9시). 주소 번호(127.0.0.1:6800)는 앞이 숫자·점이라 아니다.
    // ISO 끝의 Z 는 세계 표준시 표시라 "UTC"(한국 시각과 9시간 차이 — 빼면 틀린 시각으로 들린다)
    .replace(/(?<![\d.:])([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(Z(?![A-Za-z0-9]))?(?![\d:]|\.\d)/g, (_m, hour: string, minute: string, second?: string, utc?: string) => {
      const parts = [`${+hour}시`];
      if (+minute || (second && +second)) parts.push(`${+minute}분`);
      if (second && +second) parts.push(`${+second}초`);
      if (utc) parts.push("UTC");
      return parts.join(" ");
    })
    // 하이픈 범위 뒤에 한국어 단위가 바로 붙으면(3-5초 · 1-3명 · 20-25배) 하이픈은 "에서" — 날짜보다 먼저
    .replace(new RegExp(String.raw`(?<![\w.:/-])(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)(?=(?:${RANGE_UNIT}))`, "g"), "$1에서 $2")
    // 연도 없는 하이픈 날짜(10-10 · 10-18) — 월·일 범위면 날짜(10-19 리규형님 — 예전엔 범위와 모양이 같아 연도 있을 때만 바꿨다). 범위 밖(0-2 · 13-20)·
    // 등호 식(10-3=7)·전화번호(010-1234 — 앞이 숫자)는 그대로. 물결 범위(10-18~10-25)는 양쪽 다 날짜
    .replace(/(?<![\w.:/=+×*÷±-])(\d{1,2})-(\d{1,2})(?![\d./-]|:\d|\s*[=+×*÷±])/g, (m, month: string, day: string) => (validMonthDay(month, day) ? `${+month}월 ${+day}일` : m))
    // 수식 — 더하기·곱하기·나누기(÷)·플러스마이너스는 늘, 빼기·나누기(/)는 등호가 있는 식에서만(1-3명 · 010-1234 · 날짜 10/14 는 아니다)
    .replace(MATH, (expr) => {
      const equation = expr.includes("=");
      return expr.replace(new RegExp(MATH_OPERATOR, "g"), (op, at: number) => {
        switch (op.trim()) {
          case "+": return " 더하기 ";
          case "*": case "×": return " 곱하기 ";
          case "÷": return " 나누기 ";
          case "±": return " 플러스 마이너스 ";
          case "-": case "−": return equation ? " 빼기 " : op;
          case "/": return equation ? " 나누기 " : op;
          default: return `${equalsJosa(expr.slice(0, at))} `; // =
        }
      });
    })
    // 숫자 두 개 날짜(10/14) — 월·일 범위면 날짜(같은 모양의 진행도 3/5 도 날짜로 읽힌다 — 리규형님 결정). 범위 밖(13/20 · 44/44)은 그대로
    .replace(/(?<![\d./:-])(\d{1,2})\/(\d{1,2})(?![\d/]|\.\d)/g, (m, month: string, day: string) => (validMonthDay(month, day) ? `${+month}월 ${+day}일` : m))
    // 홀로 선 부호 숫자(+9 · -30 · −5 · +45.6k) — 부호가 기호 정리에서 지워져 뜻이 사라졌다 → 플러스·마이너스. 목록 글머리(- 30개)·날짜(10-18)는 아니다
    .replace(/(^|[\s(（,])([+−-])(?=\d)/gm, (_m, before: string, sign: string) => `${before}${sign === "+" ? "플러스" : "마이너스"} `)
    // 천·백만 접미(45.6k · 2K · 1.5M) — 값으로 풀어 수사로(사만 오천육백). kg·MB 같은 단위는 아니다
    .replace(/(?<![\w.,])(\d+(?:\.\d+)?)([kKM])(?![A-Za-z0-9])/g, (_m, value: string, suffix: string) =>
      koreanNumber(String(Math.round(Number(value) * (suffix === "M" ? 1_000_000 : 1000)))))
    // 배속·배수(1.3x · 4x) — "엑스"가 아니라 "배". 16진수(0x1F)는 뒤에 글자가 붙어 아니다
    .replace(/(?<![\w.,])(\d+(?:\.\d+)?)x(?![A-Za-z0-9])/g, "$1배")
    // 숫자 바로 뒤 단위(35ms · 19MB · 30px · 5h · 1,024MB) — 한국어 이름으로. 숫자는 그대로(쉼표 숫자는 아래에서 수사로)
    .replace(new RegExp(String.raw`(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(${UNIT_NAMES})(?![A-Za-z0-9])`, "g"), (_m, value: string, unit: string) => `${value}${UNIT_WORDS[unit]}`)
    // 천 단위 쉼표 숫자(54,926 · 80,055 · 1,000,000) — 엔진이 쉼표에서 끊어 "오십사, 구백이십육"으로 읽었다 → 수사로 직접(오만 사천구백이십육)
    .replace(/(?<![\d.,])(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?(?![\d,])/g, (_m, whole: string, frac?: string) => koreanNumber(whole.replace(/,/g, "")) + (frac ? koreanFraction(frac) : ""))
    // 남은 곱하기(30초×60 · 25ms×40 — 수식은 숫자 사이만 본다) → "곱하기"
    .replace(/\s*×\s*(?=\d)/g, " 곱하기 ")
    // 물결 범위(4~5개 · 15:39~15:45 · 54,926~80,055 · 10-18~10-25) — 물결이 기호 정리에서 지워져 "4 5개"로 붙어 읽혔다 → "에서". 위에서 날짜·시각·수사로 바꾼 뒤라
    // 뒤가 숫자이거나 한글 수사로 시작할 때만(그 밖의 물결은 그대로 지워진다)
    .replace(/([\d%가-힣A-Za-z])[ \t]*~[ \t]*(?=[\d일이삼사오육칠팔구십백천만억조영])/g, "$1에서 ");
}

/** 화면 글은 바꾸지 않는다. 음성에만 필요한 마크다운·코드 이름 정리를 적용한다. */
export function makeSpokenText(text: string, lang: TargetLang): string {
  let spoken = text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(URL_PATTERN, "URL");
  // 괄호 바로 안쪽의 줄바꿈은 먼저 없앤다 — 화면이 코드 글씨를 따로 상자로 그려 "파일(" ↵ "~/.claude/settings.json" ↵ ")에" 로 들어오면
  // 괄호로 알아보지 못해 경로를 읽었다(10-16 19:46 리규형님 "괄호안에 경로를 읽었음"). 괄호 판정은 그대로 줄을 넘지 않는다(짝 없는 괄호가 다음 문단을 먹지 않게)
  spoken = spoken.replace(/([(（])[ \t]*\n\s*/g, "$1").replace(/\s*\n[ \t]*([)）])/g, "$1");
  // 표를 먼저 문장으로(칸 구분 | 가 아래에서 지워지기 전에), 그다음 괄호 안을 지운다(표 칸의 "1명(이 계정)" 도)
  spoken = dropParens(tableToSentences(spoken));
  spoken = shortenPaths(spoken);
  // 경로를 줄인 뒤(경로 안 숫자는 끝 이름만 남는다), 기호를 지우기 전에
  if (lang === "ko") spoken = readNumbersKo(spoken);
  spoken = spoken
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gm, "")
    .replace(/`+/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=$|[\s).,!?:;])/g, "$1$2")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/[|]/g, " ")
    .replace(/→|⇒|->|=>|←|⇐|<-/g, PAUSE)
    .replace(/([^\d\s])\1{3,}/gu, (_, char: string) => char.repeat(REPEATED_CHARS_MAX));
  // 영어 이름 안 기호는 소리로 읽지 않고 띄운다(readaloud_text.py → "readaloud text py").
  // 대문자 두 글자(PC·OK·DB)는 떼지 않고 그대로 넘긴다 — 원본 readaloud_text.py 의 "한국어 음성은 두 글자 대문자를 떼어 준다
  // (VS → V S)"를 옮겼다가 "P C"·"O K"로 읽혀 리규형님이 어색하다고 해 없앴다(10-14)
  spoken = spoken.replace(/[A-Za-z][A-Za-z0-9_]*(?:[./\\-][A-Za-z0-9_]+)*/g, (token) =>
    token.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/[._/\\-]+/g, " "),
  );
  // 남은 기호 — 숫자 안 점·콜론·쉼표(1.5 · 19:41 · 1,000)와 %, 영어 낱말 안 작은따옴표, 문장 끝 부호만 둔다
  spoken = spoken
    .replace(/[•◦▪▫▸▹►▶●○■□◆◇★☆※]/g, " ") // 글머리·표시 기호
    .replace(/[·‧∙…]/g, PAUSE) // 가운뎃점·말줄임 = 나열 쉼
    .replace(/(?<!\d):|:(?!\d)|;/g, PAUSE) // 숫자 사이(19:41)가 아니면 쉼
    .replace(/[–—―]|(?<=\s)-(?=\s)/g, PAUSE) // 대시(띄어 쓴 하이픈 포함)
    .replace(/\p{Extended_Pictographic}|[\uFE0F\u200D\u20E3]/gu, " ") // 그림 문자
    .replace(/(?<![A-Za-z])['’]|['’](?![A-Za-z])/g, " ") // 영어 낱말 안 작은따옴표(don't)만 둔다
    // 그 밖의 기호(/ - _ " ~ + = * # @ & < > [ ] { } 등). 남은 콜론은 숫자 사이(19:41)뿐. 읽기 언어 일곱 개의 문장 부호
    // (일본어·중국어 。、，！？：； · 아랍어 ، ؛ ؟)는 쉬는 자리라 둔다
    .replace(/[^\p{L}\p{N}\p{M}\s.,:?!%'’。、，！？：；،؛؟]/gu, " ")
    .replace(/[ \t\u00a0]+([.,?!])/g, "$1") // 부호 앞 빈칸
    .replace(/([.?!]),+/g, "$1") // 마침표 뒤에 붙은 쉼표
    .replace(/,(?:[ \t\u00a0]*,)+/g, ",") // 겹친 쉼표
    .replace(/^[ \t\u00a0]*[,.]+/gm, ""); // 줄머리 쉼표·마침표
  return spoken.replace(/[ \t\u00a0]+/g, " ").replace(/ +\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
