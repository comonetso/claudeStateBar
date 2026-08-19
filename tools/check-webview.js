// Syntax-check the JS embedded in a panel's webview HTML.
//
//   node tools/check-webview.js out/codexRescuePanel.js out/workflowPanel.js
//
// Why this exists: the webview scripts live inside a `return /* html */ \`...\`` template
// literal, so tsc only ever sees them as a string. A stray backtick, or a `\n` written with
// one backslash instead of two, compiles cleanly and then splits the generated JS in two at
// runtime — the panel renders its static HTML and nothing else works. That shipped once
// (2026-08-19) and cost a debugging round trip, hence this check.
//
// It evaluates the template the way the extension host will, pulls out every <script> body,
// and parses it. Exit code is non-zero if any block fails.
const fs = require('fs');

const BT = String.fromCharCode(96);   // backtick, unquotable in a file this script may check
const BS = String.fromCharCode(92);   // backslash

function extractTemplate(src) {
    const marker = src.indexOf('return /* html */ ');
    if (marker < 0) return null;
    const start = src.indexOf(BT, marker);
    let end = start + 1;
    while (end < src.length) {
        if (src[end] === BS) { end += 2; continue; }
        if (src[end] === BT) break;
        end++;
    }
    return src.slice(start + 1, end);
}

function check(file) {
    const src = fs.readFileSync(file, 'utf8');
    const raw = extractTemplate(src);
    if (raw === null) { console.log('SKIP  ' + file + ' (no html template)'); return 0; }

    // Substitutions are irrelevant to syntax; any plausible value will do.
    const nonce = 'NONCE';
    const wsRow = '  <div class="wspath">dummy</div>';
    const webview = { cspSource: 'vscode-webview:' };
    void nonce; void wsRow; void webview;

    let html;
    try {
        html = eval(BT + raw + BT);
    } catch (e) {
        console.log('FAIL  ' + file + ' - template would not evaluate: ' + e.message);
        return 1;
    }

    const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
    let m, blocks = 0, bad = 0;
    while ((m = re.exec(html)) !== null) {
        blocks++;
        try {
            new Function(m[1]);
        } catch (e) {
            bad++;
            console.log('FAIL  ' + file + ' - script #' + blocks + ': ' + e.message);
        }
    }
    if (!bad) console.log('OK    ' + file + ' (' + blocks + ' script block(s))');
    return bad ? 1 : 0;
}

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node tools/check-webview.js <compiled .js> ...'); process.exit(2); }
process.exit(files.map(check).reduce((a, b) => a + b, 0) ? 1 : 0);
