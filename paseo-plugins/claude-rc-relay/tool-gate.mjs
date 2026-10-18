#!/usr/bin/env node
// 도구 문지기 — Claude Code PreToolUse 훅(10-16 19:4x 리규형님 "전환기가 최대한 알아서, 안 되면 포기").
// bypass 여도 사람을 기다리게 되는 호출을 무중단 대화에서만 막고, 그 자리에서 대신할 방법을 Claude 에게 알려 준다 —
// 대화 Claude 의 메모리 규칙에 기대지 않는다. 막는 것: 질문 버튼(AskUserQuestion) · 그 서버 설정의 "실행 전 확인"(permissions.ask) 목록.
// 목록 매칭은 Claude Code 규칙을 흉내 낸 것이라 완벽하지 않다(드문 일이라 여기까지 — 리규형님). 놓친 것은 권한 창이 뜨고 감독자가 폰으로 알린다.
// 앞단 tool-gate.sh 가 등록한 대화만 이 파일을 부른다. 실패하면 아무것도 출력하지 않는다(막지 않음).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, claudeConfigDir, isRegistered, validId, workRoot } from "./workstate.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "work-cli.mjs");
const ASK_HOW = `node ${CLI} set --state ready --next "답 없이 할 다음 조각" --question "물을 것"`;

/** 규칙 "Bash(git reset --hard:*)" → { tool, body } · 괄호 없으면 body null(그 도구 전부) */
export function parseRule(rule) {
  const m = /^([A-Za-z]+)(?:\((.*)\))?$/.exec(String(rule ?? "").trim());
  return m ? { tool: m[1], body: m[2] ?? null } : null;
}
/** 규칙 본문 → 정규식. ":*" 와 "*" 는 아무 글자, 나머지는 그대로(Claude Code 의 접두·와일드카드 규칙 흉내) */
function bodyRegex(body) {
  const parts = body.split(/:\*|\*/).map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[\\s\\S]*")}$`);
}
/** 복합 명령을 나눈다(&& || ; | 줄바꿈) · 앞의 VAR=값 은 뗀다.
 *  따옴표 안 글자와 히어독 본문은 명령이 아니라 나누지 않는다 — 10-17 02:15·02:25 Mesa 하위 작업의 검색
 *  `grep -n "function halt\|halt();" …` 를 따옴표 안 `halt();` 때문에 Bash(halt:*) 로 막았다. 따옴표 안이라도 $( ) 와 백틱 안은
 *  실제로 실행되니 꺼내서 함께 대조한다. 따옴표가 닫히지 않으면 예전처럼 전부 나눈다(더 막는 쪽).
 *  히어독 본문은 끝 표시에 따옴표가 있을 때(<<'EOF' · <<"EOF" · <<\EOF)만 글자 그대로다. 따옴표가 없으면(<<EOF · <<-EOF) 셸이 본문의
 *  $( ) 와 백틱을 실행하므로 그것만 꺼내 대조한다(10-18 Codex 261018_052815 함정 1 — 예전엔 따옴표 여부와 상관없이 본문을 통째로 건너뛰었다).
 *  본문 안 따옴표는 셸에서도 글자일 뿐이라 치환을 막지 못하고, \$ · \` · \\ 만 글자가 된다. 본문의 치환이 닫히지 않으면 전부 나눈다(더 막는 쪽).
 *  히어독이 아닌 것(10-18 보수 2차 검증 — 히어독으로 잘못 읽어 그 뒤 명령을 통째로 건너뛰었다): 한 줄 입력 <<< · 산술 (( 1<<n )) ·
 *  $(( 1<<n )) (산술 안 $( ) · 백틱은 꺼낸다). 끝 표시는 공백·메타 문자 전까지 한 낱말(<<END-DOC). 줄 끝 CRLF 는 LF 로 본다 */
export function splitCommands(command) {
  const text = String(command ?? "").replace(/\r\n?/g, "\n");
  const clean = (parts) => parts.map((s) => s.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")).filter(Boolean);
  const rough = () => clean(text.split(/&&|\|\||;|\||\n/));
  const out = [];
  const inner = []; // $( ) · 백틱 안 명령
  let cur = "", i = 0, quote = null;
  const heredocs = []; // 이 줄이 끝나면 건너뛸 본문 — { end: 끝 표시, quoted: 끝 표시에 따옴표가 있었는지 }
  // $( 부터 짝이 맞는 ) 까지의 안쪽(따옴표 안 괄호는 세지 않는다). 못 찾으면 null
  const subshell = (from) => {
    let depth = 1, q = null;
    for (let k = from; k < text.length; k++) {
      const ch = text[k];
      if (q) { if (ch === "\\" && q === '"') k++; else if (ch === q) q = null; continue; }
      if (ch === "\\") { k++; continue; }
      if (ch === "'" || ch === '"') q = ch;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return { body: text.slice(from, k), end: k };
    }
    return null;
  };
  // 따옴표 없는 히어독 본문 text[from, to) 의 $( ) · 백틱 안 명령을 꺼낸다. 본문 밖으로 넘어가거나 닫히지 않으면 false
  const bodySubstitutions = (from, to) => {
    for (let k = from; k < to; k++) {
      const ch = text[k];
      if (ch === "\\") { k++; continue; }
      if (ch === "$" && text[k + 1] === "(") {
        const s = subshell(k + 2);
        if (!s || s.end >= to) return false;
        inner.push(...splitCommands(s.body));
        k = s.end; continue;
      }
      if (ch === "`") {
        let e = k + 1;
        while (e < to && text[e] !== "`") e += text[e] === "\\" ? 2 : 1;
        if (e >= to) return false;
        inner.push(...splitCommands(text.slice(k + 1, e)));
        k = e; continue;
      }
    }
    return true;
  };
  // 산술 (( … )) 의 안쪽 시작(from)부터 짝이 맞는 )) 의 첫 ) 위치. 못 찾으면 -1
  const arithEnd = (from) => {
    let depth = 0;
    for (let k = from; k < text.length; k++) {
      const ch = text[k];
      if (ch === "\\") { k++; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { if (depth === 0) return text[k + 1] === ")" ? k : -1; depth--; }
    }
    return -1;
  };
  // 산술 구간을 건너뛰며 안쪽 $( ) · 백틱만 꺼낸다. 처리했으면 다음 위치, 닫히지 않으면 -1
  const skipArith = (at, open) => {
    const end = arithEnd(open);
    if (end < 0 || !bodySubstitutions(open, end)) return -1;
    cur += text.slice(at, end + 2);
    return end + 2;
  };
  const cut = () => { out.push(cur); cur = ""; };
  while (i < text.length) {
    const ch = text[i], two = text.slice(i, i + 2);
    if (quote === "'") { cur += ch; if (ch === "'") quote = null; i++; continue; }
    if (ch === "\\") { cur += text.slice(i, i + 2); i += 2; continue; }
    // 산술 확장 $(( … ))는 큰따옴표 안에서도 계산된다 — 서브셸이 아니다
    if (text.startsWith("$((", i)) {
      const next = skipArith(i, i + 3);
      if (next < 0) return rough();
      i = next; continue;
    }
    if (two === "$(") {
      const s = subshell(i + 2);
      if (!s) return rough();
      inner.push(...splitCommands(s.body));
      cur += text.slice(i, s.end + 1); i = s.end + 1; continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0) return rough();
      inner.push(...splitCommands(text.slice(i + 1, end)));
      cur += text.slice(i, end + 1); i = end + 1; continue;
    }
    if (quote === '"') { cur += ch; if (ch === '"') quote = null; i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; i++; continue; }
    // 산술 명령 (( … )) · 한 줄 입력 <<< 는 히어독이 아니다
    if (two === "((") {
      const next = skipArith(i, i + 2);
      if (next < 0) return rough();
      i = next; continue;
    }
    if (text.startsWith("<<<", i)) { cur += "<<<"; i += 3; continue; }
    if (two === "<<") {
      const m = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()'"`]+))/.exec(text.slice(i));
      // 'EOF' · "EOF" 는 m[1]·m[2], 맨 낱말은 m[3] — \EOF 도 셸에선 따옴표와 같다(m[0] 에 \ 가 남는다)
      if (m) { heredocs.push({ end: m[1] ?? m[2] ?? m[3], quoted: m[3] === undefined || m[0].includes("\\") }); cur += m[0]; i += m[0].length; continue; }
    }
    if (two === "&&" || two === "||") { cut(); i += 2; continue; }
    if (ch === ";" || ch === "|") { cut(); i++; continue; }
    if (ch === "\n") {
      cut(); i++;
      // 이 줄에서 연 히어독 본문은 명령 줄이 아니다 — 끝 표시만 있는 줄까지 건너뛴다(앞 탭은 <<- 일 때 허용되니 함께 받아 준다).
      // 끝 표시에 따옴표가 없었으면 건너뛴 본문에서 $( ) · 백틱만 꺼내 대조한다. 끝 표시를 못 만나면 끝까지가 본문이다(셸과 같다)
      while (heredocs.length) {
        const { end, quoted } = heredocs.shift();
        const bodyStart = i;
        let bodyEnd = text.length, found = false;
        while (i < text.length) {
          const lineStart = i;
          const nl = text.indexOf("\n", i);
          const line = text.slice(i, nl < 0 ? text.length : nl);
          i = nl < 0 ? text.length : nl + 1;
          if (line.replace(/^\t+/, "") === end) { found = true; bodyEnd = lineStart; break; }
        }
        if (!quoted && !bodySubstitutions(bodyStart, bodyEnd)) return rough();
        if (!found) break;
      }
      continue;
    }
    cur += ch; i++;
  }
  if (quote) return rough();
  cut();
  return [...clean(out), ...inner];
}
/** 경로 규칙(Edit(/boot/**)) — ** 는 아무 글자, * 는 / 를 뺀 글자 */
function pathRegex(body) {
  const esc = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, "[\\s\\S]*");
  return new RegExp(`^${esc}$`);
}

/** 판정(순수) — 돌려주는 값: { rule, reason } 이면 막는다, null 이면 통과 */
export function judgeTool({ tool_name: tool, tool_input: input = {} }, askRules = []) {
  if (tool === "AskUserQuestion") {
    return { rule: "AskUserQuestion", reason: "무중단 대화에서는 질문 버튼을 쓰지 않는다 — 답이 올 때까지 턴이 서고, 좌석 강제 넘김 때 사라진다. "
      + `질문은 장부에 적으면 감독자가 폰으로 알린다: ${ASK_HOW} (답 없이 더 할 일이 없으면 --state waiting_human --question "물을 것" 으로 두고 턴을 끝낸다. 답을 받으면 --question "" 로 지운다)` };
  }
  for (const raw of askRules) {
    const r = parseRule(raw);
    if (!r || r.tool !== tool) continue;
    let hit = false;
    if (tool === "Bash") hit = r.body === null || (() => { const re = bodyRegex(r.body); const cmd = String(input.command ?? ""); return re.test(cmd.trim()) || splitCommands(cmd).some((c) => re.test(c)); })();
    else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) hit = r.body === null || pathRegex(r.body).test(String(input.file_path ?? input.notebook_path ?? ""));
    if (!hit) continue;
    return { rule: raw, reason: `이 호출은 이 서버 Claude Code 설정의 "실행 전 확인" 목록(${raw})에 걸려 bypass 여도 사람 승인을 기다리며 멈춘다 — 무중단 대화라 막았다. `
      + "되살릴 수 있는 방법(git stash·git revert·파일을 백업한 뒤 고쳐 쓰기)으로 같은 일을 하고, 목록에 안 걸리는 다른 파괴 명령으로 바꿔 쓰지 않는다. "
      + `꼭 필요하면 실행하지 말고 장부에 질문으로 적는다: ${ASK_HOW}` };
  }
  return null;
}

/** 그 대화에 적용되는 "실행 전 확인" 규칙 — 사용자·프로젝트·관리 설정 */
export function askRulesFor(cwd, configDir = claudeConfigDir()) {
  const files = [join(configDir, "settings.json"), "/etc/claude-code/managed-settings.json"];
  if (cwd) files.push(join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json"));
  const out = [];
  for (const f of files) {
    try { const ask = JSON.parse(readFileSync(f, "utf8"))?.permissions?.ask; if (Array.isArray(ask)) out.push(...ask.filter((x) => typeof x === "string")); } catch { /* 없거나 깨짐 */ }
  }
  return out;
}

function main(raw) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!validId(agentId)) return;
  const root = workRoot();
  if (!isRegistered(root, agentId)) return;
  let hook = {};
  try { hook = JSON.parse(raw || "{}"); } catch { return; }
  const hit = judgeTool(hook, askRulesFor(hook.cwd));
  if (!hit) return;
  try { appendEvent(root, { kind: "tool-gate", agentId, tool: hook.tool_name, rule: hit.rule }); } catch { /* 기록 실패는 판정에 영향 없음 */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: `[work-gate] ${hit.reason}\n(사람 말이 아니라 도구 문지기가 넣은 안내)` } }));
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { /* 입력 없음 */ }
  try { main(raw); } catch { /* 문지기가 실패하면 막지 않는다 — 권한 창이 뜨면 감독자가 알린다 */ }
}
