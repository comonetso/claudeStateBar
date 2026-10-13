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
 * 괄호 안은 읽지 않는다(10-13 리규형님 "괄호 안은 거의 필요가 없어") — 소괄호·전각 괄호, 겹친 괄호는 안쪽부터. 짝 없는 괄호는 기호만 지운다.
 * 뒤가 한글·빈칸·부호·끝이면 빈칸 없이 지운다 — "3대(DB)는" 이 "3대 는" 으로 조사 앞에서 끊겨 들렸다. 뒤가 영어·숫자면 빈칸을 둬 낱말이 붙지 않게
 */
export function dropParens(text: string): string {
  let prev: string;
  do {
    prev = text;
    text = text.replace(/\([^()\n]*\)|（[^（）\n]*）/g, (m: string, at: number, all: string) => {
      const next = all.charAt(at + m.length);
      return /[\p{L}\p{N}]/u.test(next) && !/\p{Script=Hangul}/u.test(next) ? " " : "";
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

export function readNumbersKo(text: string): string {
  return text
    // 연도 붙은 날짜(2026-10-14 · 2026/10/14 · 2026.10.14) — 하이픈 날짜는 범위(3-5초)와 같은 모양이라 연도가 있을 때만. 바로 뒤 ISO 의 T 는 띄운다
    .replace(/(?<![\d.:/-])(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?![\d/-]|[.:]\d)(T(?=\d{1,2}:\d{2}))?/g,
      (m, year: string, _sep: string, month: string, day: string, iso?: string) => (validMonthDay(month, day) ? `${year}년 ${+month}월 ${+day}일${iso ? " " : ""}` : m))
    // 시각(9:05 · 16:24 · 06:51:51) — 0 인 분·초는 끝에서부터 뺀다(09:00 → 9시). 주소 번호(127.0.0.1:6800)는 앞이 숫자·점이라 아니다.
    // ISO 끝의 Z 는 세계 표준시 표시라 "UTC"(한국 시각과 9시간 차이 — 빼면 틀린 시각으로 들린다)
    .replace(/(?<![\d.:])([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(Z(?![A-Za-z0-9]))?(?![\d:]|\.\d)/g, (_m, hour: string, minute: string, second?: string, utc?: string) => {
      const parts = [`${+hour}시`];
      if (+minute || (second && +second)) parts.push(`${+minute}분`);
      if (second && +second) parts.push(`${+second}초`);
      if (utc) parts.push("UTC");
      return parts.join(" ");
    })
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
    .replace(/(?<![\d./:-])(\d{1,2})\/(\d{1,2})(?![\d/]|\.\d)/g, (m, month: string, day: string) => (validMonthDay(month, day) ? `${+month}월 ${+day}일` : m));
}

/** 화면 글은 바꾸지 않는다. 음성에만 필요한 마크다운·코드 이름 정리를 적용한다. */
export function makeSpokenText(text: string, lang: TargetLang): string {
  let spoken = text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(URL_PATTERN, "URL");
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
  // 영어 이름 안 기호는 소리로 읽지 않고 띄운다(readaloud_text.py → "readaloud text py")
  spoken = spoken.replace(/[A-Za-z][A-Za-z0-9_]*(?:[./\\-][A-Za-z0-9_]+)*/g, (token) => {
    const named = token.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/[._/\\-]+/g, " ");
    // 대문자 두 글자 띄어 읽기는 한국어 음성만(원본 readaloud_text.py:571 — 영어 음성은 그대로 둔다)
    return lang === "ko" ? named.replace(/\b[A-Z]{2}\b/g, (letters) => letters.split("").join(" ")) : named;
  });
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
