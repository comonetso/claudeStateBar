// Copy the codex_rescue skill from the live install into this repo's public copy, masked.
//
//   node tools/sync-codex-skill.js            # copy, mask, check
//   node tools/sync-codex-skill.js --dry-run  # report what would change, write nothing
//
// The skill that actually runs — and that `skill_cp_install deploy` pushes to the servers — is
// `~/.claude/skills/codex_rescue`. `skills/codex_rescue/` here is the copy the public guide tells
// people to download. The live files carry measurement notes with server names, the user's
// form of address and local paths, so the copy has to be masked on the way in. Doing that by
// hand dropped a backslash on 2026-09-16; this script is the replacement.
//
// The masking rules are NOT in this repo: a list of names to hide would publish those names.
// They live in a local file (default `~/.claude/_private/codex_rescue_mask.tsv`, override with
// CODEX_SKILL_MASK). Without that file the script refuses to run.
//
// Order of work: read everything, mask in memory, check for leftovers, and only then write.
// A leftover aborts the run with nothing written. Files that exist only in the repo copy are
// reported, never deleted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DRY = process.argv.includes('--dry-run');
const SRC = process.env.CODEX_SKILL_SRC || path.join(os.homedir(), '.claude', 'skills', 'codex_rescue');
const DST = path.join(__dirname, '..', 'skills', 'codex_rescue');
const MASK = process.env.CODEX_SKILL_MASK || path.join(os.homedir(), '.claude', '_private', 'codex_rescue_mask.tsv');

// Only text the skill is known to consist of. Anything else stops the run rather than being
// published unread.
const TEXT_EXT = new Set(['.md', '.sh', '.mjs', '.js', '.json', '.txt']);
const BS = String.fromCharCode(92);

function fail(msg) {
    console.error('중단: ' + msg);
    process.exit(1);
}

function listFiles(root) {
    const out = [];
    const walk = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(full);
            else if (ent.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
        }
    };
    if (fs.existsSync(root)) walk(root);
    return out.sort();
}

function loadRules(file) {
    if (!fs.existsSync(file)) {
        fail(`마스킹 규칙 파일이 없습니다: ${file}\n  규칙 없이 공개 사본을 만들 수 없습니다.`);
    }
    const replace = [];
    const forbid = [];
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!raw.trim() || raw.startsWith('#')) continue;
        if (raw.startsWith('!')) { forbid.push(raw.slice(1)); continue; }
        const tab = raw.indexOf('\t');
        if (tab < 1) fail(`규칙 줄에 탭이 없습니다: ${raw}`);
        replace.push([raw.slice(0, tab), raw.slice(tab + 1)]);
    }
    if (!replace.length && !forbid.length) fail(`규칙 파일이 비어 있습니다: ${file}`);
    return { replace, forbid };
}

// Personal path segments that need no list: whatever the name, it becomes <user>.
const USERS_RE = new RegExp('([A-Za-z]:' + BS + BS + 'Users' + BS + BS + ')(?!<user>)[A-Za-z0-9_.-]+', 'g');
const HOME_RE = /(\/home\/)(?!<user>)[A-Za-z0-9_.-]+/g;

function mask(text, rules) {
    let t = text;
    for (const [from, to] of rules.replace) t = t.split(from).join(to);
    t = t.replace(USERS_RE, '$1<user>').replace(HOME_RE, '$1<user>');
    return t;
}

function leftovers(text, rules) {
    const hits = [];
    const needles = [...rules.replace.map(r => r[0]), ...rules.forbid];
    const lines = text.split('\n');
    lines.forEach((line, i) => {
        for (const n of needles) if (line.includes(n)) hits.push(`${i + 1}행: "${n}"`);
        if (/[A-Za-z]:\\Users\\(?!<user>)[A-Za-z0-9_.-]/.test(line)) hits.push(`${i + 1}행: 사용자 폴더 경로`);
        if (/\/home\/(?!<user>)[A-Za-z0-9_.-]/.test(line)) hits.push(`${i + 1}행: /home 계정 경로`);
    });
    return hits;
}

function syntaxCheck(file) {
    const ext = path.extname(file);
    const r = ext === '.sh'
        ? spawnSync('bash', ['-n', file], { encoding: 'utf8' })
        : (ext === '.mjs' || ext === '.js')
            ? spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
            : null;
    if (!r) return null;
    return r.status === 0 ? null : (r.stderr || r.stdout || `종료 코드 ${r.status}`).trim();
}

function main() {
    if (!fs.existsSync(SRC)) fail(`원본 스킬 폴더가 없습니다: ${SRC}`);
    const rules = loadRules(MASK);
    const srcFiles = listFiles(SRC);

    const plan = [];
    const problems = [];
    for (const rel of srcFiles) {
        const ext = path.extname(rel);
        if (!TEXT_EXT.has(ext)) {
            problems.push(`${rel}: 알 수 없는 파일 종류(${ext || '확장자 없음'}) — 원본에 있어선 안 될 파일인지 확인하십시오`);
            continue;
        }
        const masked = mask(fs.readFileSync(path.join(SRC, rel), 'utf8'), rules);
        for (const h of leftovers(masked, rules)) problems.push(`${rel} ${h}`);
        const dstFile = path.join(DST, rel);
        const before = fs.existsSync(dstFile) ? fs.readFileSync(dstFile, 'utf8') : null;
        plan.push({ rel, masked, state: before === null ? '추가' : before === masked ? '동일' : '갱신' });
    }
    if (problems.length) {
        fail('공개하면 안 되는 내용이 남았습니다. 아무 파일도 쓰지 않았습니다.\n  ' + problems.join('\n  ')
             + `\n  규칙 파일: ${MASK}`);
    }

    const onlyInRepo = listFiles(DST).filter(rel => !srcFiles.includes(rel));

    for (const p of plan) if (p.state !== '동일') console.log(`${p.state}  ${p.rel}`);
    for (const rel of onlyInRepo) console.log(`레포에만 있음(지우지 않음)  ${rel}`);
    const count = s => plan.filter(p => p.state === s).length;
    console.log(`원본 ${plan.length}개 — 추가 ${count('추가')} · 갱신 ${count('갱신')} · 동일 ${count('동일')}`
                + (DRY ? ' (미리보기, 쓰지 않음)' : ''));
    if (DRY) return;

    for (const p of plan) {
        if (p.state === '동일') continue;
        const dstFile = path.join(DST, p.rel);
        fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        fs.writeFileSync(dstFile, p.masked, 'utf8');
    }

    const bad = [];
    for (const p of plan) {
        const err = syntaxCheck(path.join(DST, p.rel));
        if (err) bad.push(`${p.rel}: ${err}`);
    }
    if (bad.length) fail('문법 검사 실패:\n  ' + bad.join('\n  '));
    console.log('문법 검사 통과');
}

if (require.main === module) main();
module.exports = { mask, leftovers, loadRules };
