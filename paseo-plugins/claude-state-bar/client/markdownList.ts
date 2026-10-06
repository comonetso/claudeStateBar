// 입력창 마크다운 목록 보조의 글 계산(리규형님 10-07). 화면 요소는 만지지 않는다 — 글과 커서를 받아 바뀐 글과 커서를 돌려준다.
// 바꿀 것이 없으면 null(부른 쪽이 키를 Paseo 에 그대로 넘긴다).
// 들여쓰기 칸 수는 CommonMark 규칙: 하위 항목은 윗 항목 글이 시작하는 열에 맞춘다(`- ` 아래 2칸, `1. ` 아래 3칸).

export type Edit = { text: string; start: number; end: number };

type Line = { from: number; to: number; text: string };
type Item = {
  indent: number; // 앞 공백 칸 수(탭은 한 칸으로 센다 — 우리가 넣는 들여쓰기는 공백뿐)
  marker: string; // "-" · "*" · "+" · "3." · "3)"
  number: number | null; // 번호 목록이면 번호
  delim: string; // 번호 뒤 "." 또는 ")" — 점 목록이면 ""
  gap: string; // 머리와 글 사이 공백
  body: number; // 글이 시작하는 열(indent + 머리 + 공백)
  content: string;
};

const ITEM = /^([ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+|$)(.*)$/;

function lines(text: string): Line[] {
  const out: Line[] = [];
  let from = 0;
  for (const part of text.split("\n")) {
    out.push({ from, to: from + part.length, text: part });
    from += part.length + 1;
  }
  return out;
}

function lineIndexAt(all: Line[], pos: number): number {
  for (let i = 0; i < all.length; i++) if (pos <= all[i].to) return i;
  return all.length - 1;
}

function parseItem(text: string): Item | null {
  const m = ITEM.exec(text);
  if (!m) return null;
  const [, lead, marker, digits, delim, gap, content] = m;
  return {
    indent: lead.length,
    marker,
    number: digits === undefined ? null : Number(digits),
    delim: delim ?? "",
    gap,
    body: lead.length + marker.length + gap.length,
    content,
  };
}

function leadOf(text: string): number {
  return /^[ \t]*/.exec(text)![0].length;
}

/**
 * 줄들을 바꾼 결과를 Edit 로. 줄 수는 그대로이고 줄 앞쪽(들여쓰기·머리·번호)만 바뀌므로, 커서는 자기 줄 끝에서 떨어진
 * 거리를 지킨다. 줄 맨 앞에 있던 커서(여러 줄을 고른 범위의 시작)는 그대로 줄 맨 앞에 둔다
 */
function rebuild(all: Line[], next: string[], start: number, end: number): Edit {
  const map = (pos: number) => {
    const at = lineIndexAt(all, pos);
    let base = 0;
    for (let i = 0; i < at; i++) base += next[i].length + 1;
    if (pos === all[at].from && all[at].to > pos) return base;
    return base + Math.max(0, next[at].length - (all[at].to - pos));
  };
  return { text: next.join("\n"), start: map(start), end: map(end) };
}

/** 윗줄 중 같은 칸 수에서 시작하는 형제 항목 — 사이에 더 얕은 항목이나 목록을 끊는 줄이 있으면 없다 */
function siblingAbove(texts: string[], index: number, indent: number): Item | null {
  for (let i = index - 1; i >= 0; i--) {
    const text = texts[i];
    const item = parseItem(text);
    if (item) {
      if (item.indent === indent) return item;
      if (item.indent < indent) return null;
      continue;
    }
    if (!text.trim()) continue;
    if (leadOf(text) === 0) return null;
  }
  return null;
}

/** 윗줄 중 이 줄보다 얕은 가장 가까운 항목(부모) */
function parentAbove(texts: string[], index: number, indent: number): Item | null {
  for (let i = index - 1; i >= 0; i--) {
    const text = texts[i];
    const item = parseItem(text);
    if (item) {
      if (item.indent < indent) return item;
      continue;
    }
    if (!text.trim()) continue;
    if (leadOf(text) === 0) return null;
  }
  return null;
}

function withIndent(text: string, item: Item, indent: number): string {
  return " ".repeat(Math.max(0, indent)) + text.slice(item.indent);
}

/**
 * 번호 다시 매기기. 같은 칸 수에서 이어지는 번호 항목을 한 목록으로 보고, 목록 첫 번호를 그대로 두고 1씩 올린다.
 * 빈 줄은 목록을 끊지 않고, 들여쓰지 않은 보통 줄이 끊는다(CommonMark). 들여쓴 보통 줄은 윗 항목 글이 이어진 것으로 본다.
 */
export function renumberLines(texts: string[]): string[] {
  const out = texts.slice();
  const stack: { indent: number; next: number | null; delim: string }[] = [];
  for (let i = 0; i < out.length; i++) {
    const text = out[i];
    const item = parseItem(text);
    if (!item) {
      if (!text.trim()) continue;
      const lead = leadOf(text);
      if (lead === 0) stack.length = 0;
      else while (stack.length && stack[stack.length - 1].indent >= lead) stack.pop();
      continue;
    }
    while (stack.length && stack[stack.length - 1].indent > item.indent) stack.pop();
    const top = stack[stack.length - 1];
    if (top && top.indent === item.indent) {
      if (item.number !== null && top.next !== null) {
        if (item.number !== top.next || item.delim !== top.delim) {
          out[i] = " ".repeat(item.indent) + `${top.next}${top.delim}` + item.gap + item.content;
        }
        top.next += 1;
      } else {
        top.next = item.number === null ? null : item.number + 1;
        top.delim = item.delim;
      }
    } else {
      stack.push({ indent: item.indent, next: item.number === null ? null : item.number + 1, delim: item.delim });
    }
  }
  return out;
}

function finish(all: Line[], next: string[], start: number, end: number): Edit {
  return rebuild(all, renumberLines(next), start, end);
}

/**
 * Shift+Enter — 목록 줄 글 안에서면 줄을 나누고 다음 항목 머리를 넣는다. 빈 항목이면, 들여쓴 줄은 한 단계 위 목록의
 * 다음 항목이 되고(머리는 위 목록 종류 — 리규형님 10-07 실화면 뒤 요청), 맨 바깥 줄은 목록을 끝낸다(머리를 지운다)
 */
export function continueList(text: string, start: number, end: number): Edit | null {
  if (start !== end) return null;
  const all = lines(text);
  const at = lineIndexAt(all, start);
  const line = all[at];
  const item = parseItem(line.text);
  if (!item) return null;
  const col = start - line.from;
  if (col < item.body) return null;
  if (!item.content.trim()) {
    const next = all.map((l) => l.text);
    const parent = item.indent > 0 ? parentAbove(next, at, item.indent) : null;
    next[at] = parent
      ? " ".repeat(parent.indent) + (parent.number === null ? parent.marker : `${parent.number + 1}${parent.delim}`) + (parent.gap || " ")
      : "";
    const numbered = renumberLines(next);
    let base = 0;
    for (let i = 0; i < at; i++) base += numbered[i].length + 1;
    const pos = base + numbered[at].length;
    return { text: numbered.join("\n"), start: pos, end: pos };
  }
  const gap = item.gap || " ";
  const head = item.number === null ? item.marker : `${item.number + 1}${item.delim}`;
  const insert = "\n" + " ".repeat(item.indent) + head + gap;
  const joined = text.slice(0, start) + insert + text.slice(end);
  const caret = start + insert.length;
  // 새 줄을 끼웠으니 번호를 다시 매긴다 — 커서 줄보다 앞은 길이가 안 바뀌어 커서 위치가 그대로 맞다
  const after = lines(joined);
  const numbered = renumberLines(after.map((l) => l.text));
  const caretLine = lineIndexAt(after, caret);
  let base = 0;
  for (let i = 0; i < caretLine; i++) base += numbered[i].length + 1;
  const pos = base + Math.max(0, numbered[caretLine].length - (after[caretLine].to - caret));
  return { text: numbered.join("\n"), start: pos, end: pos };
}

/** 고른 줄(커서 줄 하나 포함)의 번호 범위 */
function selectedRange(all: Line[], start: number, end: number): [number, number] {
  const first = lineIndexAt(all, start);
  let last = lineIndexAt(all, end);
  // 여러 줄을 골라 끝이 다음 줄 맨 앞에 걸쳤으면 그 줄은 뺀다
  if (last > first && end === all[last].from) last -= 1;
  return [first, last];
}

/** Tab · 메뉴 들여쓰기 — 고른 목록 줄을 윗 형제 항목의 글 시작 열로 민다. 목록 줄이 없으면 null, 밀 곳이 없으면 그대로 */
export function indentList(text: string, start: number, end: number): Edit | null {
  const all = lines(text);
  const [first, last] = selectedRange(all, start, end);
  const next = all.map((l) => l.text);
  let any = false;
  for (let i = first; i <= last; i++) {
    const item = parseItem(next[i]);
    if (!item) continue;
    any = true;
    const sibling = siblingAbove(next, i, item.indent);
    if (!sibling) continue;
    // 번호 항목은 1 로 놓고 번호 정리에 맡긴다 — 새 하위 목록의 첫 항목이면 1, 위에 형제가 있으면 그 다음 번호가 된다
    const moved = item.number === null ? item : { ...item, marker: `1${item.delim}` };
    next[i] = " ".repeat(sibling.body) + moved.marker + item.gap + item.content;
  }
  if (!any) return null;
  return finish(all, next, start, end);
}

/** 메뉴 내어쓰기 — 고른 목록 줄을 부모 항목 칸 수로 당긴다(맨 바깥 줄은 그대로) */
export function outdentList(text: string, start: number, end: number): Edit | null {
  const all = lines(text);
  const [first, last] = selectedRange(all, start, end);
  const next = all.map((l) => l.text);
  let any = false;
  for (let i = first; i <= last; i++) {
    const item = parseItem(next[i]);
    if (!item) continue;
    any = true;
    if (item.indent === 0) continue;
    const parent = parentAbove(next, i, item.indent);
    next[i] = withIndent(next[i], item, parent ? parent.indent : 0);
  }
  if (!any) return null;
  return finish(all, next, start, end);
}

/** Backspace — 커서가 목록 머리 바로 뒤일 때만. 들여쓴 줄은 한 단계 나오고, 맨 바깥 줄은 머리만 지운다 */
export function backspaceList(text: string, start: number, end: number): Edit | null {
  if (start !== end) return null;
  const all = lines(text);
  const at = lineIndexAt(all, start);
  const line = all[at];
  const item = parseItem(line.text);
  if (!item || !item.gap || start - line.from !== item.body) return null;
  const next = all.map((l) => l.text);
  if (item.indent > 0) {
    const parent = parentAbove(next, at, item.indent);
    next[at] = withIndent(line.text, item, parent ? parent.indent : 0);
  } else {
    next[at] = item.content;
  }
  const numbered = renumberLines(next);
  let base = 0;
  for (let i = 0; i < at; i++) base += numbered[i].length + 1;
  const pos = base + Math.max(0, numbered[at].length - item.content.length);
  return { text: numbered.join("\n"), start: pos, end: pos };
}

/** 메뉴 번호 목록·점 목록 — 고른 줄이 모두 그 목록이면 풀고, 아니면 그 목록으로 바꾼다(빈 줄은 건너뛴다) */
export function toggleList(text: string, start: number, end: number, kind: "number" | "bullet"): Edit | null {
  const all = lines(text);
  const [first, last] = selectedRange(all, start, end);
  const next = all.map((l) => l.text);
  const targets: number[] = [];
  for (let i = first; i <= last; i++) if (next[i].trim()) targets.push(i);
  if (!targets.length) {
    // 빈 줄 하나면 그 자리에 머리만 넣는다
    targets.push(first);
  }
  const isKind = (i: number) => {
    const item = parseItem(next[i]);
    return !!item && (kind === "number" ? item.number !== null : item.number === null);
  };
  const remove = targets.every(isKind) && targets.some((i) => next[i].trim());
  let n = 1;
  for (const i of targets) {
    const item = parseItem(next[i]);
    const lead = item ? item.indent : leadOf(next[i]);
    const content = item ? item.content : next[i].slice(lead);
    if (remove) {
      next[i] = " ".repeat(lead) + content;
      continue;
    }
    const head = kind === "number" ? `${n++}.` : "-";
    next[i] = " ".repeat(lead) + head + " " + content;
  }
  return finish(all, next, start, end);
}

/** 줄을 끼우거나 지운 뒤 번호만 다시 매긴다 — 바뀐 게 없으면 null */
export function renumberText(text: string, start: number, end: number): Edit | null {
  const all = lines(text);
  const next = renumberLines(all.map((l) => l.text));
  if (next.every((t, i) => t === all[i].text)) return null;
  return rebuild(all, next, start, end);
}
