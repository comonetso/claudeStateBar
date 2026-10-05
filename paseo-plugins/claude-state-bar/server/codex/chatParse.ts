// 복사본: VS Code 확장 src/providers/codexRescue/chatDiscovery.ts 의 순수 판독 부분(2026-10-05). 플러그인은 확장과 별개로 둔다(리규형님 원칙).
// 폴더 뒤지기(vscode.workspace.fs)는 빼고 chats.ts 에 Node 로 다시 썼다. 확장 쪽 판독을 고치면 여기도 같이 고쳐야 한다.

/** One exchange: what Claude threw and what Codex threw back. */
export interface ChatTurn {
    type: 'turn';
    n: number;
    /** `HH:MM:SS` as send.sh recorded it. Absent on a malformed heading. */
    time?: string;
    claude: string;
    codex: string;
}

/**
 * A discontinuity in the conversation. These matter as much as the turns: without them a
 * reader cannot tell why the context suddenly changed, only that it did.
 *   broken     — the run died and send.sh discarded the thread
 *   superseded — `--new` closed this generation on purpose
 */
export interface ChatBreak {
    type: 'break';
    kind: 'broken' | 'superseded';
    time?: string;
    text: string;
}

/**
 * The turn that is happening right now: Claude has spoken, Codex has not answered yet.
 *
 * This never comes from the document — send.sh writes a turn only once the answer is in hand,
 * so for the 7–13s of a round trip the document says nothing at all. It comes from the
 * in-flight marker, which now carries the question text alongside its crash-recovery fields.
 * Without this the panel showed a LIVE badge over an unchanged transcript, which reads as
 * frozen rather than as working.
 */
export interface ChatPending {
    type: 'pending';
    /** What this turn will be numbered once it lands. */
    n: number;
    /** `HH:MM:SS`, from the marker's `started=`. */
    time?: string;
    claude: string;
}

export type ChatEntry = ChatTurn | ChatBreak | ChatPending;

/** `260822_140040` → epoch ms. Used when the document carries no better timestamp. */
export function parseStamp(stamp: string): number | undefined {
    const m = /^(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(stamp);
    if (!m) return undefined;
    const [, yy, mo, dd, hh, mi, ss] = m;
    const t = new Date(2000 + +yy, +mo - 1, +dd, +hh, +mi, +ss).getTime();
    return Number.isFinite(t) ? t : undefined;
}

/** Read one frontmatter key. Tolerates CRLF, which a Windows checkout can introduce. */
export function fm(text: string, key: string): string | undefined {
    const end = text.indexOf('\n---', 3);
    const head = end > 0 ? text.slice(0, end) : text;
    const re = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm');
    const m = re.exec(head);
    const v = m ? m[1].replace(/\r$/, '').trim() : '';
    return v || undefined;
}

/**
 * Split the body into turns and breaks.
 *
 * Sections are found by `^## ` headings rather than by the `<!-- codex_rescue:turn N -->`
 * marker, even though the marker is the more robust signal: documents written before the
 * marker existed (2026-08-22, same day) have only the heading, and they are still worth
 * reading. The marker is an HTML comment, so it is simply skipped as content.
 */
export function parseEntries(body: string): ChatEntry[] {
    const out: ChatEntry[] = [];
    // Keep the headings: split on a lookahead so each chunk starts with its own `## `.
    const chunks = body.split(/^(?=## )/m);

    for (const chunk of chunks) {
        const nl = chunk.indexOf('\n');
        const heading = (nl < 0 ? chunk : chunk.slice(0, nl)).replace(/\r$/, '').trim();
        if (!heading.startsWith('## ')) continue;
        const title = heading.slice(3).trim();
        const rest = nl < 0 ? '' : chunk.slice(nl + 1);

        const broken = /^⚠️\s*스레드 끊김(?:\s*·\s*(\S+))?/.exec(title);
        if (broken) {
            out.push({ type: 'break', kind: 'broken', time: broken[1], text: stripMarkers(rest).trim() });
            continue;
        }
        const superseded = /^⏹\s*새 대화로 전환(?:\s*·\s*(\S+))?/.exec(title);
        if (superseded) {
            out.push({ type: 'break', kind: 'superseded', time: superseded[1], text: stripMarkers(rest).trim() });
            continue;
        }

        const turn = /^(\d+)턴(?:\s*·\s*(\S+))?/.exec(title);
        if (!turn) continue;

        // Bodies are separated by the speaker lines send.sh writes. Splitting on them keeps
        // the message text byte-for-byte, which matters: this is the record of what was said.
        const text = stripMarkers(rest);
        const c = findSpeaker(text, '✳️', '클로드');
        const x = findSpeaker(text, '🔷', '코덱스');
        let claude = '', codex = '';
        if (c && x && x.at > c.at) {
            claude = text.slice(c.at + c.len, x.at).trim();
            codex = text.slice(x.at + x.len).trim();
        } else {
            // A document someone hand-edited, or a future format change. Show it rather than
            // dropping the turn — a visible oddity beats a silently missing exchange.
            codex = text.trim();
        }
        out.push({ type: 'turn', n: +turn[1], time: turn[2], claude, codex });
    }
    return out;
}

/** Drop the turn marker comment; it is bookkeeping for send.sh, not content. */
function stripMarkers(s: string): string {
    return s.replace(/^<!-- codex_rescue:turn \d+ -->\s*$/gm, '');
}

function findSpeaker(text: string, emoji: string, name: string): { at: number; len: number } | null {
    const withEmoji = emoji + ' **' + name + '**';
    const at = text.indexOf(withEmoji);
    if (at >= 0) return { at, len: withEmoji.length };
    const plain = '**' + name + '**';
    const p = text.indexOf(plain);
    return p >= 0 ? { at: p, len: plain.length } : null;
}

export interface InflightMarker {
    slug: string;
    /** Which conversation this turn belongs to. Absent on markers written before 2026-08-22. */
    stamp?: string;
    subject?: string;
    /** `HH:MM:SS`, sliced out of the ISO `started=` field. */
    time?: string;
    /** The question, verbatim. Empty on an older marker — then there is nothing to preview. */
    msg: string;
}

const MSG_SEP = '--- msg ---';

export function parseInflight(slug: string, text: string): InflightMarker {
    const idx = text.indexOf('\n' + MSG_SEP + '\n');
    const head = idx < 0 ? text : text.slice(0, idx);
    const msg = idx < 0 ? '' : text.slice(idx + MSG_SEP.length + 2);
    const pick = (k: string): string | undefined => {
        const m = new RegExp('^' + k + '=(.*)$', 'm').exec(head);
        const v = m ? m[1].replace(/\r$/, '').trim() : '';
        return v || undefined;
    };
    const started = pick('started');
    const hhmmss = started ? /(\d{2}:\d{2}:\d{2})/.exec(started)?.[1] : undefined;
    return {
        slug,
        stamp: pick('stamp'),
        subject: pick('subject'),
        time: hhmmss,
        msg: msg.replace(/\s+$/, ''),
    };
}

function nextTurnNo(entries: ChatEntry[]): number {
    let max = 0;
    for (const e of entries) if (e.type === 'turn' && e.n > max) max = e.n;
    return max + 1;
}

export function pendingFrom(mk: InflightMarker, entries: ChatEntry[]): ChatPending {
    return { type: 'pending', n: nextTurnNo(entries), time: mk.time, claude: mk.msg };
}
