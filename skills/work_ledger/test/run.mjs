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
ok(/세부 1\/3/.test(r.stdout) && (r.stdout.match(/└/g) || []).length === 3 && r.stdout.trim().split("\n").filter((l) => l.trim() && !/└|⚠/.test(l)).length === 1, "목록 = 큰 작업 한 줄 + 세부 셋 들여쓰기", r.stdout);
r = ledger("human", A, ["status", big, "확인됨"]);
ok(r.status === 0 && (r.stdout.match(/└/g) || []).length === 1, "사람이 큰 작업 확인 → 끝난 세부 하나만 같이 확인됨", r.stdout + r.stderr);
r = ledger("human", A, ["show", kid1]);
ok(/\[확인됨\]/.test(r.stdout), "끝냄이던 세부가 확인됨이 됨", r.stdout);
r = ledger("human", A, ["list", "--project", "grp"]);
ok(/장부 화면 다듬기/.test(r.stdout) && (r.stdout.match(/└/g) || []).length === 2, "세부가 남으면 확인된 큰 작업도 머리로 보임", r.stdout);
r = ledger("Claude", A, ["move", loose, "--top"]);
ok(r.status === 0 && /큰 작업으로/.test(r.stdout), "세부를 큰 작업으로 되돌림", r.stdout + r.stderr);

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

console.log(`\n결과: 통과 ${pass} · 실패 ${failN}`);
if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`(남겨 둠: ${tmp})`);
process.exit(failN ? 1 : 0);
