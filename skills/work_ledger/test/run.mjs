// work-ledger 시험 — 임시 폴더에 가짜 원격(bare)과 사본 둘을 만들어 명령·안전장치·동시 쓰기 합치기를 본다.
// 실제 장부·사용자 설정은 건드리지 않는다(WORK_LEDGER_HOME·WORK_LEDGER_DIR 를 임시 폴더로).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LEDGER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ledger.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "work-ledger-test-"));
const bare = path.join(tmp, "remote.git");
const A = path.join(tmp, "pc");
const B = path.join(tmp, "server");
let pass = 0, failN = 0;

function ok(cond, name, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failN++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
}
function sh(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}
function baseEnv(home, dir) {
  const e = { ...process.env, WORK_LEDGER_HOME: home, WORK_LEDGER_DIR: dir, WORK_LEDGER_NO_PUSH: "1" };
  for (const k of Object.keys(e)) if (k.startsWith("CODEX_") || k.startsWith("CLAUDE")) delete e[k];
  delete e.PASEO_AGENT_ID; delete e.GEMINI_CLI; delete e.WORK_LEDGER_AGENT;
  return e;
}
function ledger(who, dir, args, cwd = dir) {
  const home = path.join(tmp, `home-${path.basename(dir)}`);
  const env = baseEnv(home, dir);
  if (who !== "human") env.WORK_LEDGER_AGENT = who;
  return spawnSync(process.execPath, [LEDGER, ...args], { cwd, encoding: "utf8", env });
}
function idOf(out) { const m = out.match(/\s([0-9a-z]{4})\s+\[/); return m && m[1]; }

console.log(`임시 폴더: ${tmp}`);
sh("git", ["init", "-q", "--bare", "-b", "main", bare], tmp);
sh("git", ["clone", "-q", bare, A], tmp);

console.log("\n[틀 만들기]");
let r = ledger("human", A, ["init", "--owner", "리규형님"]);
ok(r.status === 0, "init 성공", r.stderr);
ok(fs.existsSync(path.join(A, ".gitattributes")) && /merge=union/.test(fs.readFileSync(path.join(A, ".gitattributes"), "utf8")), "합치기 설정(.gitattributes) 생김");
ok(fs.existsSync(path.join(tmp, "home-pc", "config.json")), "이 기계 설정 생김");
r = ledger("human", A, ["sync"]);
ok(r.status === 0, "처음 올리기", r.stderr);
sh("git", ["clone", "-q", bare, B], tmp);
ledger("human", B, ["init", "--owner", "리규형님"]);
ok(fs.existsSync(path.join(B, "README.md")), "둘째 사본이 틀을 받음");

console.log("\n[추가·상태·메모]");
r = ledger("human", A, ["add", "플러그인 폴더 정리", "--project", "demo", "--note", "세 묶음"]);
ok(r.status === 0 && /\[할 일\]/.test(r.stdout), "사람이 할 일 추가", r.stderr);
const id1 = idOf(r.stdout);
r = ledger("Claude", A, ["suggest", "Backlog.md 시험", "README 보강", "--project", "demo"]);
ok(r.status === 0 && (r.stdout.match(/\[제안\]/g) || []).length === 2, "AI 가 제안 두 개 넣기", r.stderr);
r = ledger("Claude", A, ["status", id1, "진행", "중", "--why", "Codex 에 맡김"]);
ok(r.status === 0 && /할 일 → 진행 중/.test(r.stdout), "AI 가 진행 중으로(따옴표 없이 친 두 낱말도)", r.stderr);
r = ledger("Claude", A, ["status", id1, "끝냄"]);
ok(r.status !== 0 && /근거/.test(r.stderr), "AI 가 근거 없이 끝냄 → 거부");
r = ledger("Claude", A, ["status", id1, "끝냄", "--why", "시험 12개 통과"]);
ok(r.status === 0, "AI 가 근거와 함께 끝냄", r.stderr);
r = ledger("Claude", A, ["status", id1, "확인됨"]);
ok(r.status !== 0 && /사람|리규형님/.test(r.stderr), "AI 가 확인됨 → 거부");
r = ledger("Claude", A, ["add", "사칭", "--project", "demo", "--by", "리규형님"]);
ok(r.status !== 0, "AI 가 사람 이름으로 쓰기 → 거부");
r = ledger("Claude", A, ["add", "사칭 공백", "--project", "demo", "--by", "리규형님 "]);
ok(r.status !== 0, "AI 가 끝 공백 붙인 사람 이름으로 쓰기 → 거부");
r = ledger("Claude", A, ["add", "처음부터 확인됨", "--project", "demo", "--state", "확인됨"]);
ok(r.status !== 0 && /리규형님/.test(r.stderr), "AI 가 새 항목을 확인됨으로 → 거부");
r = ledger("Claude", A, ["add", "처음부터 끝냄", "--project", "demo", "--state", "끝냄"]);
ok(r.status !== 0 && /근거/.test(r.stderr), "AI 가 새 항목을 근거 없이 끝냄으로 → 거부");
r = ledger("human", A, ["note", id1, "화면도 봐야 함"]);
ok(r.status === 0, "메모 덧붙이기", r.stderr);
r = ledger("human", A, ["list", "--project", "demo"]);
ok(r.status === 0 && /플러그인 폴더 정리/.test(r.stdout) && /Backlog/.test(r.stdout), "목록에 남은 일 보임", r.stdout);
r = ledger("human", A, ["status", "zzzz", "할 일"]);
ok(r.status !== 0 && /못 찾/.test(r.stderr), "없는 번호 → 알기 쉬운 오류");
r = ledger("human", A, ["status", id1, "다됨"]);
ok(r.status !== 0 && /모르는 상태/.test(r.stderr), "모르는 상태 → 거부");

console.log("\n[파일 모양]");
const file1 = fs.readdirSync(path.join(A, "projects", "demo", "items")).map((f) => path.join(A, "projects", "demo", "items", f))
  .find((f) => f.endsWith(`${id1}.md`));
const text1 = fs.readFileSync(file1, "utf8");
ok(/^# 플러그인 폴더 정리/m.test(text1) && (text1.match(/^- \d{4}-/gm) || []).length === 4, "항목 파일 = 제목 + 기록 4줄", text1);
const log = spawnSync("git", ["log", "--oneline"], { cwd: A, encoding: "utf8" }).stdout.trim().split("\n");
ok(log.length >= 6, `바꿀 때마다 커밋(${log.length}개)`);

console.log("\n[두 기계 동시 쓰기]");
r = ledger("human", A, ["sync"]);
ok(r.status === 0, "PC 올리기", r.stderr);
r = ledger("human", B, ["sync"]);
ok(r.status === 0, "서버 받기", r.stderr);
// 같은 항목에 서로 모르게 덧붙인다
ledger("Codex", B, ["note", id1, "서버에서 덧붙임"]);
ledger("human", A, ["note", id1, "PC 에서 덧붙임"]);
ledger("human", A, ["status", id1, "확인됨"]);
r = ledger("human", B, ["sync"]);
ok(r.status === 0, "서버 먼저 올림", r.stderr);
r = ledger("human", A, ["sync"]);
ok(r.status === 0, "PC 가 받아 합친 뒤 올림(충돌 없음)", r.stdout + r.stderr);
r = ledger("human", B, ["sync"]);
const fileB = path.join(B, path.relative(A, file1));
const tA = fs.readFileSync(file1, "utf8"), tB = fs.readFileSync(fileB, "utf8");
ok(/서버에서 덧붙임/.test(tA) && /PC 에서 덧붙임/.test(tA), "PC 사본에 두 줄 다 있음", tA);
ok(tA === tB, "두 사본이 똑같아짐");
ok(!/<<<<<<<|>>>>>>>/.test(tA), "충돌 표시 없음");
r = ledger("human", B, ["show", id1]);
ok(/\[확인됨\]/.test(r.stdout), "합친 뒤 상태 = 마지막 상태(확인됨)", r.stdout);
// 커밋이 잠금에 걸려 파일만 남은 기록 → 다음 sync 가 커밋해 올린다
const lockA = path.join(A, ".git", "index.lock");
fs.writeFileSync(lockA, "");
r = ledger("human", A, ["add", "잠금 중 추가", "--project", "demo"]);
fs.rmSync(lockA);
ok(r.status === 0 && /커밋 실패/.test(r.stderr), "커밋 잠금 중 추가 → 파일은 저장·경고", r.stdout + r.stderr);
r = ledger("human", A, ["sync"]);
const leftA = spawnSync("git", ["status", "--porcelain", "--", "projects"], { cwd: A, encoding: "utf8" }).stdout.trim();
const inBare = spawnSync("git", ["log", "-1", "--format=%s", "main"], { cwd: bare, encoding: "utf8" }).stdout;
ok(r.status === 0 && !leftA && /남은 기록/.test(inBare), "sync 가 남은 기록을 커밋해 원격까지 올림", r.stderr + leftA + inBare);

console.log("\n[큰 작업·세부]");
r = ledger("Claude", A, ["add", "장부 화면 다듬기", "--project", "grp"]);
const big = idOf(r.stdout);
r = ledger("Claude", A, ["add", "확인 단추 옮기기", "숫자 칸 누르기", "--under", big]);
ok(r.status === 0 && (r.stdout.match(/└/g) || []).length === 2 && /grp/.test(r.stdout), "세부 둘을 큰 작업 아래 넣음(프로젝트도 큰 작업 따라감)", r.stdout + r.stderr);
const kid1 = (r.stdout.match(/\s([0-9a-z]{4})\s+\[/g) || []).map((s) => s.trim().slice(0, 4))[0];
r = ledger("Claude", A, ["add", "세부의 세부", "--under", kid1]);
ok(r.status !== 0 && /세부입니다/.test(r.stderr), "세부 아래 세부 → 거부", r.stderr);
r = ledger("Claude", A, ["add", "따로 넣은 조각", "--project", "grp"]);
const loose = idOf(r.stdout);
r = ledger("Claude", A, ["move", loose, "--under", big]);
ok(r.status === 0 && /→/.test(r.stdout), "따로 있던 항목을 큰 작업 아래로 옮김", r.stdout + r.stderr);
r = ledger("Claude", A, ["move", big, "--under", loose]);
ok(r.status !== 0, "세부를 가진 큰 작업을 남의 아래로 → 거부");
ledger("Claude", A, ["status", kid1, "끝냄", "--why", "화면 확인"]);
ledger("Claude", A, ["status", big, "끝냄", "--why", "세부 확인"]);
r = ledger("human", A, ["list", "--project", "grp"]);
ok(/세부 1\/3/.test(r.stdout) && (r.stdout.match(/└/g) || []).length === 3 && r.stdout.trim().split("\n").filter((l) => l.trim() && !/└|⚠|▣/.test(l)).length === 1, "목록 = 큰 작업 한 줄 + 세부 셋 들여쓰기", r.stdout);
r = ledger("human", A, ["status", big, "확인됨"]);
ok(r.status === 0 && (r.stdout.match(/└/g) || []).length === 1, "사람이 큰 작업 확인 → 끝난 세부 하나만 같이 확인됨", r.stdout + r.stderr);
r = ledger("human", A, ["show", kid1]);
ok(/\[확인됨\]/.test(r.stdout), "끝냄이던 세부가 확인됨이 됨", r.stdout);
r = ledger("human", A, ["list", "--project", "grp"]);
ok(/장부 화면 다듬기/.test(r.stdout) && (r.stdout.match(/└/g) || []).length === 2, "세부가 남으면 확인된 큰 작업도 머리로 보임", r.stdout);
r = ledger("Claude", A, ["move", loose, "--top"]);
ok(r.status === 0 && /묶음 풂/.test(r.stdout), "세부를 큰 작업으로 되돌림", r.stdout + r.stderr);

console.log("\n[대작업 > 중작업 > 세부]");
{
  r = ledger("Claude", A, ["area", "작업 장부", "--project", "tri"]);
  const area = idOf(r.stdout);
  ok(r.status === 0 && /대작업/.test(r.stdout) && area, "대작업 만들기", r.stdout + r.stderr);
  r = ledger("Claude", A, ["add", "번호 복사", "--under", area]);
  const mid = idOf(r.stdout);
  ok(r.status === 0 && /tri/.test(r.stdout), "대작업 아래 중작업(프로젝트도 따라감)", r.stdout + r.stderr);
  r = ledger("Claude", A, ["add", "제목 앞 번호", "--under", mid]);
  const leaf = idOf(r.stdout);
  ok(r.status === 0, "중작업 아래 세부", r.stdout + r.stderr);
  r = ledger("Claude", A, ["add", "네 번째 단", "--under", leaf]);
  ok(r.status !== 0 && /세부입니다/.test(r.stderr), "세부 아래 → 거부(세 단까지)", r.stderr);
  r = ledger("Claude", A, ["status", area, "진행 중"]);
  ok(r.status !== 0 && /대작업/.test(r.stderr), "대작업 상태 바꾸기 → 거부", r.stderr);
  r = ledger("Claude", A, ["move", area, "--under", mid]);
  ok(r.status !== 0 && /대작업/.test(r.stderr), "대작업 옮기기 → 거부", r.stderr);
  r = ledger("Claude", A, ["area", "--end", area]);
  ok(r.status !== 0 && /열린 일/.test(r.stderr), "열린 일 남은 대작업 없애기 → 거부", r.stderr);
  r = ledger("Claude", A, ["area", "빈 줄기", "--project", "tri"]);
  const empty = idOf(r.stdout);
  r = ledger("Claude", A, ["area", "--end", empty]);
  const l2 = ledger("human", A, ["list", "--project", "tri"]);
  ok(r.status === 0 && !/빈 줄기/.test(l2.stdout), "빈 대작업 없애기 → 목록에서 빠짐", r.stdout + r.stderr + l2.stdout);
  r = ledger("Claude", A, ["add", "따로 온 요청", "--project", "tri"]);
  const lone = idOf(r.stdout);
  ledger("Claude", A, ["add", "그 조각", "--under", lone]);
  r = ledger("Claude", A, ["move", lone, "--under", area]);
  ok(r.status === 0, "세부 가진 중작업을 대작업 아래로 옮김(세부는 따라감)", r.stdout + r.stderr);
  ledger("Claude", A, ["status", mid, "진행 중"]);
  ledger("Claude", A, ["status", leaf, "진행 중"]);
  ledger("Claude", A, ["status", leaf, "끝냄", "--why", "화면 확인"]);
  r = ledger("human", A, ["list", "--project", "tri"]);
  const lines = r.stdout.split("\n");
  const head = lines.findIndex((l) => /^▣ .*작업 장부/.test(l));
  ok(head >= 0 && /진행 중 1/.test(lines[head]) && /할 일 1/.test(lines[head]), "목록: 대작업 머리 줄에 아래 중작업 요약", r.stdout);
  ok(lines.some((l) => /^  \S.*번호 복사.*시작 /.test(l)) && lines.some((l) => /^      └ .*제목 앞 번호.*시작 .*끝 /.test(l)) && lines.some((l) => /^      └ .*그 조각/.test(l)), "목록: 중작업 두 칸·세부 여섯 칸 들여쓰기, 시작·끝 시각", r.stdout);
  r = ledger("human", A, ["list", "--project", "tri", "--json"]);
  const js = JSON.parse(r.stdout || "[]");
  const jl = js.find((x) => x.id.endsWith(leaf));
  ok(jl && jl.started && jl.finished && jl.started <= jl.finished && js.find((x) => x.id.endsWith(area))?.area === true, "JSON: area·started·finished", r.stdout);
  ledger("Claude", A, ["status", leaf, "진행 중"]);
  r = ledger("human", A, ["list", "--project", "tri", "--json"]);
  const again = JSON.parse(r.stdout || "[]").find((x) => x.id.endsWith(leaf));
  ok(again && again.started && !again.finished, "다시 진행 중이면 완료 시각 비움", r.stdout);
}

console.log("\n[설명]");
{
  const env = { ...baseEnv(path.join(tmp, "home-pc"), A), WORK_LEDGER_AGENT: "Claude" };
  const d = spawnSync(process.execPath, [LEDGER, "describe", big, "-"], { cwd: A, encoding: "utf8", env, input: "무엇을: 화면 다듬기\n왜: 목록이 길어서 · 사람이 못 봄\n" });
  ok(d.status === 0 && /설명:/.test(d.stdout), "여러 줄 설명을 표준 입력으로 넣음", d.stdout + d.stderr);
  const j = JSON.parse(ledger("human", A, ["list", "--project", "grp", "--closed", "--json"]).stdout);
  const got = j.find((x) => x.id.endsWith(big));
  ok(got && got.desc === "무엇을: 화면 다듬기\n왜: 목록이 길어서 ・ 사람이 못 봄", "설명이 줄바꿈 그대로 되읽힘", JSON.stringify(got && got.desc));
  r = ledger("Claude", A, ["add", "설명 붙은 큰 작업", "--project", "grp", "--desc", "한 줄 설명"]);
  const j2 = JSON.parse(ledger("human", A, ["list", "--project", "grp", "--json"]).stdout);
  ok(j2.some((x) => x.title === "설명 붙은 큰 작업" && x.desc === "한 줄 설명"), "add --desc 로 만들 때 설명이 붙음");
}

console.log("\n[바뀐 것]");
{
  r = ledger("Claude", A, ["change", big, "확인 단추 오른쪽 위 → 확인 대기 옆", "--why", "폰과 같은 자리로"]);
  ok(r.status === 0 && /바뀜:/.test(r.stdout), "change 로 바뀐 기록 남김", r.stdout + r.stderr);
  const j = JSON.parse(ledger("human", A, ["list", "--project", "grp", "--closed", "--json"]).stdout);
  const ch = (j.find((x) => x.id.endsWith(big))?.log ?? []).filter((e) => e.kind === "바뀜");
  ok(ch.length === 1 && ch[0].text === "확인 단추 오른쪽 위 → 확인 대기 옆 — 이유: 폰과 같은 자리로", "바뀜 줄이 전 → 후 — 이유 로 되읽힘", JSON.stringify(ch));
  r = ledger("Claude", A, ["change", big]);
  ok(r.status !== 0 && /ledger change/.test(r.stderr + r.stdout), "내용 없는 change 는 사용법을 알려 주고 실패", r.stdout + r.stderr);
}

console.log("\n[내 메모]");
{
  const humanE = baseEnv(path.join(tmp, "home-pc"), A);
  let m = spawnSync(process.execPath, [LEDGER, "memo", big, "-"], { cwd: A, encoding: "utf8", env: humanE, input: "첫 줄\n둘째 줄" });
  ok(m.status === 0 && /내 메모 저장/.test(m.stdout), "사람이 큰 작업에 여러 줄 메모", m.stdout + m.stderr);
  r = ledger("Claude", A, ["memo", big, "AI 가 쓰려 함"]);
  ok(r.status !== 0 && /사람|리규형님/.test(r.stderr), "AI 가 내 메모 쓰기 → 거부", r.stderr);
  m = spawnSync(process.execPath, [LEDGER, "memo", "project", "-", "--project", "grp"], { cwd: A, encoding: "utf8", env: humanE, input: "프로젝트 전체 메모" });
  ok(m.status === 0, "프로젝트 메모 저장", m.stdout + m.stderr);
  const v = JSON.parse(ledger("human", A, ["view", "--project", "grp"]).stdout);
  const bi = v.items.find((x) => x.id.endsWith(big));
  ok(bi && bi.memo === "첫 줄\n둘째 줄" && v.projectMemo === "프로젝트 전체 메모", "화면용 출력에 큰 작업 메모·프로젝트 메모가 실림", JSON.stringify({ memo: bi && bi.memo, pm: v.projectMemo }));
  ledger("human", A, ["memo", big, "--clear"]);
  const v2 = JSON.parse(ledger("human", A, ["view", "--project", "grp"]).stdout);
  ok(v2.items.find((x) => x.id.endsWith(big)).memo === "", "--clear 로 메모를 지움");
}

console.log("\n[보기 화면]");
r = ledger("human", A, ["html"]);
const html = path.join(A, "_site", "index.html");
ok(r.status === 0 && fs.existsSync(html), "HTML 만들어짐", r.stderr);
const page = fs.readFileSync(html, "utf8");
ok(/플러그인 폴더 정리/.test(page) && /Backlog/.test(page), "HTML 에 항목이 들어감");
ok(!/<\/script>[^]*<\/script>[^]*<\/script>[^]*<\/script>/.test(page.replace(/<script id="data"[^]*?<\/script>/, "")), "데이터가 스크립트 밖으로 새지 않음");
const st = spawnSync("git", ["status", "--porcelain"], { cwd: A, encoding: "utf8" }).stdout;
ok(!/_site/.test(st), "화면 파일은 git 에 안 들어감");

console.log("\n[훅]");
const HOOK = path.join(path.dirname(LEDGER), "hook.mjs");
function hook(event, input, extraEnv = {}) {
  const env = { ...baseEnv(path.join(tmp, "home-pc"), A), ...extraEnv };
  return spawnSync(process.execPath, [HOOK, event], { cwd: A, encoding: "utf8", env, input: JSON.stringify(input) });
}
const projA = path.basename(A); // 프로젝트 목록에 없는 폴더 → 폴더 이름
ledger("human", A, ["add", "훅 시험 항목"]);
r = hook("session-start", { cwd: A, session_id: "s1" });
ok(r.stdout === "", "켜지 않은 프로젝트에서는 조용함", r.stdout);
r = ledger("human", A, ["on"]);
ok(r.status === 0 && new RegExp(projA).test(r.stdout), "ledger on 으로 켬", r.stdout + r.stderr);
r = hook("session-start", { cwd: A, session_id: "s1" });
ok(/\[work-ledger\]/.test(r.stdout) && /훅 시험 항목/.test(r.stdout) && /ledger skip/.test(r.stdout), "세션 시작에 규칙·남은 일이 들어감", r.stdout + r.stderr);
hook("prompt", { cwd: A, session_id: "s1" });
r = hook("stop", { cwd: A, session_id: "s1", stop_hook_active: false });
let j = null; try { j = JSON.parse(r.stdout); } catch {}
ok(j && j.decision === "block" && /no ledger record/.test(j.reason), "기록 없이 끝내면 막음", r.stdout + r.stderr);
r = hook("stop", { cwd: A, session_id: "s1", stop_hook_active: true });
ok(r.stdout === "", "같은 차례 두 번째는 안 막음(끝없이 돌지 않음)", r.stdout);
hook("prompt", { cwd: A, session_id: "s2" });
spawnSync(process.execPath, [LEDGER, "skip", "질문에 답만 함"], { cwd: A, encoding: "utf8", env: { ...baseEnv(path.join(tmp, "home-pc"), A), WORK_LEDGER_SESSION: "s2", WORK_LEDGER_AGENT: "Claude" } });
r = hook("stop", { cwd: A, session_id: "s2" });
ok(r.stdout === "", "기록 없음 표시를 하면 통과", r.stdout);
hook("prompt", { cwd: A, session_id: "s3" });
spawnSync(process.execPath, [LEDGER, "add", "Codex 가 받은 일"], { cwd: A, encoding: "utf8", env: { ...baseEnv(path.join(tmp, "home-pc"), A), WORK_LEDGER_SESSION: "s3", WORK_LEDGER_AGENT: "Codex" } });
r = hook("stop", { cwd: A, session_id: "s3" });
ok(r.stdout === "", "장부에 적으면 통과", r.stdout);
hook("prompt", { cwd: A, session_id: "s4" });
r = hook("stop", { cwd: A, session_id: "s4" }, { CR_CONFIRMED: "1" });
ok(r.stdout === "", "Codex 상담 실행(CR_ 변수)에서는 조용함", r.stdout);
r = hook("stop", { cwd: A, session_id: "never-prompted" });
ok(r.stdout === "", "사람 말 표시가 없는 차례는 안 막음", r.stdout);
hook("prompt", { cwd: A, session_id: "s5" });
hook("prompt", { cwd: A, session_id: "s6" });
spawnSync(process.execPath, [LEDGER, "skip", "세션 번호 없는 표시"], { cwd: A, encoding: "utf8", env: { ...baseEnv(path.join(tmp, "home-pc"), A), WORK_LEDGER_AGENT: "Claude" } });
r = hook("stop", { cwd: A, session_id: "s6" });
j = null; try { j = JSON.parse(r.stdout); } catch {}
ok(j && j.decision === "block", "다른 대화 차례가 열려 있으면 세션 번호 없는 기록으로는 통과 못 함", r.stdout + r.stderr);
r = ledger("human", A, ["off"]);
r = hook("stop", { cwd: A, session_id: "s1" });
ok(r.stdout === "", "ledger off 뒤에는 조용함", r.stdout);

console.log("\n[설치]");
r = spawnSync(process.execPath, [LEDGER, "install"], { cwd: A, encoding: "utf8", env: { ...baseEnv(path.join(tmp, "home-pc"), A), HOME: tmp, USERPROFILE: tmp } });
const app = path.join(tmp, "home-pc", "app");
ok(r.status === 0 && fs.existsSync(path.join(app, "ledger.mjs")) && fs.existsSync(path.join(app, "hook.mjs")) && fs.existsSync(path.join(app, "templates", "data-README.md")), "설치본에 명령·훅·안내 틀", r.stdout + r.stderr);
const shim = path.join(tmp, "bin", "ledger");
ok(fs.existsSync(shim) && /exec node ".+ledger\.mjs" "\$@"\n$/.test(fs.readFileSync(shim, "utf8")), "짧은 이름 ledger 만들어짐", fs.existsSync(shim) ? fs.readFileSync(shim, "utf8") : "없음");
r = spawnSync(process.execPath, [path.join(app, "ledger.mjs"), "list"], { cwd: A, encoding: "utf8", env: baseEnv(path.join(tmp, "home-pc"), A) });
ok(r.status === 0 && /훅 시험 항목/.test(r.stdout), "설치본으로 목록 보기", r.stdout + r.stderr);

console.log("\n[Codex 의견 반영 — 순서 고정·다시 열기·시작 시각·없앤 대작업]");
{
  r = ledger("Claude", A, ["area", "먼저 만든 줄기", "--project", "ord"]); const a1 = idOf(r.stdout);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100); // 기록 시각이 초 단위 — 같은 초면 만든 순서를 가릴 수 없다
  r = ledger("Claude", A, ["area", "나중 만든 줄기", "--project", "ord"]); const a2 = idOf(r.stdout);
  r = ledger("Claude", A, ["add", "앞 요청", "--under", a1]); const m1 = idOf(r.stdout);
  r = ledger("Claude", A, ["add", "뒤 요청", "--under", a2]); const m2 = idOf(r.stdout);
  ledger("Claude", A, ["status", m2, "진행 중"]);
  ledger("Claude", A, ["status", m2, "끝냄", "--why", "시험"]);
  r = ledger("human", A, ["list", "--project", "ord"]);
  ok(r.stdout.indexOf("먼저 만든 줄기") < r.stdout.indexOf("나중 만든 줄기"), "대작업은 만든 순서(확인 대기가 있어도 자리 그대로)", r.stdout);
  r = ledger("human", A, ["status", m2, "확인됨"]);
  r = ledger("Claude", A, ["add", "확인 뒤 붙은 조각", "--under", m2]);
  ok(r.status === 0 && /↺/.test(r.stdout), "확인된 중작업에 세부를 넣으면 다시 엶", r.stdout + r.stderr);
  r = ledger("human", A, ["show", m2]);
  ok(/\[진행 중\]/.test(r.stdout), "다시 연 중작업은 진행 중", r.stdout);
  r = ledger("Claude", A, ["add", "세부만 진행", "--under", m1]); const p1 = idOf(r.stdout);
  ledger("Claude", A, ["status", p1, "진행 중"]);
  const v = JSON.parse(ledger("human", A, ["view", "--project", "ord"]).stdout);
  const av = v.items.find((x) => x.id.endsWith(a1));
  ok(av && av.since && av.since.label === "시작", "대작업 시작 = 하위 세부의 진행까지 봄", JSON.stringify(av && av.since));
  r = ledger("Claude", A, ["area", "빈 줄기2", "--project", "ord"]); const a3 = idOf(r.stdout);
  const v0 = JSON.parse(ledger("human", A, ["view", "--project", "ord"]).stdout);
  const a3v = v0.items.find((x) => x.id.endsWith(a3));
  ok(a3v && a3v.since === null, "아래가 없는 대작업은 시작 시각 없음", JSON.stringify(a3v));
  ledger("Claude", A, ["area", "--end", a3]);
  const v3 = JSON.parse(ledger("human", A, ["view", "--project", "ord"]).stdout);
  ok(!v3.items.some((x) => x.id.endsWith(a3)), "없앤 대작업은 화면 데이터에서 빠짐", JSON.stringify(v3.items.map((x) => x.title)));
}

console.log("\n[AI 검증 완료·직접 확인 질문·현황 요약]");
{
  r = ledger("Claude", A, ["area", "검증 줄기", "--project", "vf"]); const av = idOf(r.stdout);
  r = ledger("Claude", A, ["add", "AI 가 다 본 일", "--under", av]); const t1 = idOf(r.stdout);
  r = ledger("Claude", A, ["add", "사람이 볼 일", "--under", av]); const t2 = idOf(r.stdout);
  ledger("Claude", A, ["status", t1, "진행 중"]);
  r = ledger("Claude", A, ["status", t1, "끝냄", "--verified", "--why", "시험·화면 확인"]);
  ok(r.status === 0 && /AI 검증 완료/.test(r.stdout), "끝냄 --verified", r.stdout + r.stderr);
  r = ledger("Claude", A, ["status", t2, "끝냄", "--why", "시험", "--ask", "폰에서 길게 눌러 복사가 되는지 봐 주세요"]);
  ok(r.status === 0 && /직접 확인/.test(r.stdout), "끝냄 --ask 질문", r.stdout + r.stderr);
  let v = JSON.parse(ledger("human", A, ["view", "--project", "vf"]).stdout);
  const g1 = v.items.find((x) => x.id.endsWith(t1)); const g2 = v.items.find((x) => x.id.endsWith(t2));
  ok(g1.verify && g1.verify.ai === true && g2.verify && /복사/.test(g2.verify.ask), "화면 데이터에 검증 표시·질문", JSON.stringify([g1.verify, g2.verify]));
  ledger("Claude", A, ["status", t1, "진행 중"]);
  v = JSON.parse(ledger("human", A, ["view", "--project", "vf"]).stdout);
  ok(!v.items.find((x) => x.id.endsWith(t1)).verify, "다시 진행 중이면 검증 표시 사라짐", "");
  r = ledger("Claude", A, ["status", t1, "끝냄", "--why", "x", "--verified", "--ask", "q"]);
  ok(r.status !== 0, "--verified 와 --ask 같이 → 거부", r.stderr);
  r = ledger("Claude", A, ["status", t1, "진행 중", "--verified"]);
  ok(r.status !== 0 && /끝냄과 함께만/.test(r.stderr), "끝냄이 아닌데 --verified → 거부", r.stderr);
  r = ledger("Claude", A, ["status", t1, "--verified", "끝냄", "--why", "순서 바꿔 씀"]);
  ok(r.status === 0 && /AI 검증 완료/.test(r.stdout), "--verified 가 뒤 낱말(끝냄)을 먹지 않음", r.stdout + r.stderr);
  r = ledger("Claude", A, ["summary", av, "장부 탭에서 확인 대기가 줄었다 · 남은 것: 폰 복사"]);
  ok(r.status === 0, "대작업 현황 쓰기", r.stdout + r.stderr);
  r = ledger("Claude", A, ["summary", "project", "--project", "vf", "PC 에서 쓰는 중 · 다음: 서버"]);
  ok(r.status === 0, "프로젝트 현황 쓰기", r.stdout + r.stderr);
  v = JSON.parse(ledger("human", A, ["view", "--project", "vf"]).stdout);
  const ga = v.items.find((x) => x.id.endsWith(av));
  ok(ga.summary && /확인 대기가 줄었다/.test(ga.summary.text) && v.projectSummary && /서버/.test(v.projectSummary.text), "화면 데이터에 대작업·프로젝트 현황", JSON.stringify([ga.summary, v.projectSummary]));
  r = ledger("Claude", A, ["summary", t2, "중작업엔 안 씀"]);
  ok(r.status !== 0 && /대작업이 아닙니다/.test(r.stderr), "중작업에 현황 → 거부", r.stderr);
  r = ledger("human", A, ["list", "--project", "vf"]);
  ok(/AI 검증 1/.test(r.stdout) && /확인 대기 1/.test(r.stdout), "목록 대작업 줄: AI 검증과 확인 대기 따로 셈", r.stdout);
}

console.log(`\n결과: 통과 ${pass} · 실패 ${failN}`);
if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`(남겨 둠: ${tmp})`);
process.exit(failN ? 1 : 0);
