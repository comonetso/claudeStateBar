import type { TargetLang } from "../shared/translate";

// 원본 readaloud_text.py:482-485 SPOKEN_SIGNS 의 ko·en 과 같은 이름(백슬래시는 원본에 없어 추가)
const SPOKEN_SIGNS: Record<TargetLang, Record<string, string>> = {
  ko: { ".": " 쩜 ", "_": " 언더바 ", "/": " 슬래시 ", "\\": " 백슬래시 ", "-": " 대시 " },
  en: { ".": " dot ", "_": " underscore ", "/": " slash ", "\\": " backslash ", "-": " dash " },
};
const REPEATED_CHARS_MAX = 3;

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

/** 화면 글은 바꾸지 않는다. 음성에만 필요한 마크다운·코드 이름 정리를 적용한다. */
export function makeSpokenText(text: string, lang: TargetLang): string {
  let spoken = text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(URL_PATTERN, "URL");
  spoken = shortenPaths(spoken)
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/gm, "")
    .replace(/`+/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=$|[\s).,!?:;])/g, "$1$2")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/[|]/g, " ")
    .replace(/→|⇒|->|=>/g, ".\u2003")
    .replace(/([^\d\s])\1{3,}/gu, (_, char: string) => char.repeat(REPEATED_CHARS_MAX));
  const signs = SPOKEN_SIGNS[lang];
  spoken = spoken.replace(/[A-Za-z][A-Za-z0-9_]*(?:[./\\-][A-Za-z0-9_]+)*/g, (token) => {
    const named = token.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
      .replace(/[._/\\-]/g, (sign) => signs[sign] ?? sign);
    // 대문자 두 글자 띄어 읽기는 한국어 음성만(원본 readaloud_text.py:571 — 영어 음성은 그대로 둔다)
    return lang === "ko" ? named.replace(/\b[A-Z]{2}\b/g, (letters) => letters.split("").join(" ")) : named;
  });
  return spoken.replace(/[ \t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
