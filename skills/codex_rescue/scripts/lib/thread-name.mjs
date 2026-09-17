// thread-name.mjs — codex_rescue 가 만든 Codex 대화에 붙일 이름 (2026-09-17)
//
// Codex 앱·CLI 이어하기 목록은 이름이 없는 대화를 첫 사용자 메시지로 보여준다. codex_rescue 의
// 첫 메시지는 늘 "아래 요청서 파일을 읽고, …" 라서 목록이 같은 줄로 채워져 구분이 안 됐다.
// 형식은 사용자 결정: `rescue · <모드> · <요청서 주제>`. 새 대화에만 붙인다(옛 대화·되묻기는 손대지 않는다).

import fs from 'node:fs';

// 요청서 frontmatter 의 mode 값 → 목록에 보일 말
const MODE_LABEL = { readonly: '분석', edit: '수정', review: '리뷰', chat: '핑퐁' };

function oneLine(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** 이름을 만든다. 주제(subject → slug)가 없으면 null — 지어낸 제목을 붙이지 않는다. */
export function threadNameFor({ mode, subject, slug }) {
    const topic = oneLine(subject) || oneLine(slug);
    if (!topic) return null;
    const label = MODE_LABEL[mode] || oneLine(mode) || '?';
    return `rescue · ${label} · ${topic}`;
}

/** 요청서 파일의 frontmatter(mode·subject·slug)로 이름을 만든다. 못 읽으면 null. */
export function threadNameFromRequest(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) return null;
    const fm = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
        if (kv) fm[kv[1]] = kv[2];
    }
    return threadNameFor({ mode: fm.mode, subject: fm.subject, slug: fm.slug });
}
