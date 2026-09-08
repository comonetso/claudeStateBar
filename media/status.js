// @ts-nocheck
// Claude Status panel — renderer.
//
// Receives a fully-computed view model from the extension host and paints it. All
// arithmetic (percentages, streaks, heat levels) happens host-side in claudeStats.ts;
// this file only formats and lays out. Keep it that way — it makes the numbers
// testable without a webview.
(function () {
    const vscode = acquireVsCodeApi();

    let dict = {};
    let data = null;
    let activeTab = 'usage';

    function t(key, ...args) {
        let v = dict[key];
        if (v == null) return key;
        if (typeof v === 'string' && args.length) {
            v = v.replace(/\{(\d+)\}/g, (_, i) => {
                const val = args[Number(i)];
                return val == null ? '' : String(val);
            });
        }
        return v;
    }

    function applyStaticI18n() {
        document.querySelectorAll('[data-i18n]').forEach((el) => {
            const v = dict[el.getAttribute('data-i18n')];
            if (typeof v === 'string') el.textContent = v;
        });
    }

    // ── formatting ──────────────────────────────────────────────────────────

    // 8_300_000_000 → "8.3b", 43_700_000 → "43.7m", 217_689 → "217.7k".
    // Matches the CLI's own scale so a user comparing the two sees the same string.
    function fmtTokens(n) {
        if (n == null || !isFinite(n)) return '—';
        const a = Math.abs(n);
        if (a >= 1e9) return trim1(n / 1e9) + 'b';
        if (a >= 1e6) return trim1(n / 1e6) + 'm';
        if (a >= 1e3) return trim1(n / 1e3) + 'k';
        return String(Math.round(n));
    }

    function trim1(x) {
        // One decimal, but drop a trailing ".0" so "8.0b" reads as "8b".
        const s = x.toFixed(1);
        return s.endsWith('.0') ? s.slice(0, -2) : s;
    }

    function fmtInt(n) {
        if (n == null || !isFinite(n)) return '—';
        return Math.round(n).toLocaleString();
    }

    // 1_463_384_765 → "16d 22h 29m" / "16일 22시간 29분"
    function fmtDuration(ms) {
        if (ms == null || !isFinite(ms) || ms <= 0) return '—';
        const total = Math.floor(ms / 1000);
        const d = Math.floor(total / 86400);
        const h = Math.floor((total % 86400) / 3600);
        const m = Math.floor((total % 3600) / 60);
        const parts = [];
        if (d) parts.push(d + t('cs.unit.day'));
        if (h) parts.push(h + t('cs.unit.hour'));
        if (m || (!d && !h)) parts.push(m + t('cs.unit.min'));
        return parts.join(' ');
    }

    function pctClass(p) {
        if (p == null) return '';
        if (p >= 75) return 'danger';
        if (p >= 50) return 'warn';
        return 'ok';
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    // ── shared widgets ──────────────────────────────────────────────────────

    function meter(label, percent, subText) {
        const wrap = el('div', 'meter');

        const top = el('div', 'meter-top');
        top.appendChild(el('span', 'meter-label', label));
        top.appendChild(el('span', 'meter-pct', percent == null ? '—' : Math.round(percent) + '%'));
        wrap.appendChild(top);

        const bar = el('div', 'meter-bar');
        const fill = el('span', 'meter-fill ' + pctClass(percent));
        fill.style.width = Math.max(0, Math.min(100, percent || 0)) + '%';
        bar.appendChild(fill);
        wrap.appendChild(bar);

        if (subText) wrap.appendChild(el('div', 'meter-sub', subText));
        return wrap;
    }

    function barRow(name, percent, valueText) {
        const row = el('div', 'bar-row');
        row.appendChild(el('span', 'bar-name', name));
        const track = el('div', 'bar-track');
        const fill = el('span', 'bar-fill');
        fill.style.width = Math.max(0, Math.min(100, percent || 0)) + '%';
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el('span', 'bar-val', valueText));
        return row;
    }

    function section(titleKey, node) {
        const s = el('div', 'section');
        s.appendChild(el('h2', 'section-header', t(titleKey)));
        s.appendChild(node);
        return s;
    }

    // ── usage tab ───────────────────────────────────────────────────────────

    // "2h 8m" / "42m 37s" — the same shape the CLI's session summary prints.
    function fmtSpan(ms) {
        if (!ms || ms <= 0) return '0' + t('cs.unit.sec');
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h) return h + t('cs.unit.hour') + ' ' + m + t('cs.unit.min');
        if (m) return m + t('cs.unit.min') + ' ' + s + t('cs.unit.sec');
        return s + t('cs.unit.sec');
    }

    // Two decimals, but a non-zero amount never rounds to "$0.00" — that would read
    // as free when it is merely small.
    function fmtMoney(v) {
        if (v == null || !isFinite(v)) return '—';
        if (v <= 0) return '$0.00';
        if (v < 0.01) return '<$0.01';
        return '$' + v.toFixed(2);
    }

    function sessionCard(s) {
        const card = el('div', 'sess' + (s.isIdle ? ' idle' : ''));

        const head = el('div', 'sess-head');
        head.appendChild(el('span', 'sess-name', s.label || '—'));
        head.appendChild(el('span', 'sess-spacer'));
        if (s.model) head.appendChild(el('span', 'sess-model', s.model));
        if (s.isIdle) head.appendChild(el('span', 'sess-when', t('cs.sess.idle')));
        card.appendChild(head);

        const grid = el('div', 'sess-grid');
        const item = (labelKey, valueNode) => {
            const box = el('div', 'sess-item');
            box.appendChild(el('span', 'sess-label', t(labelKey)));
            box.appendChild(valueNode);
            grid.appendChild(box);
        };

        item('cs.sess.wall', el('span', 'sess-value', fmtSpan(s.wallMs)));

        // A finished session carries Claude Code's own API duration; use it when it is
        // there, and fall back to our estimate otherwise. The estimate is named "active
        // time" rather than "API time" because tool runs sit inside it.
        const hasReal = typeof s.recordedApiMs === 'number' && s.recordedApiMs > 0;
        const act = el('span', 'sess-value', fmtSpan(hasReal ? s.recordedApiMs : s.activeMs));
        act.title = t(hasReal ? 'cs.sess.apiHint' : 'cs.sess.activeHint');
        item(hasReal ? 'cs.sess.api' : 'cs.sess.active', act);

        const chg = el('span', 'sess-value');
        const plus = el('span', 'add', '+' + fmtInt(s.linesAdded));
        const minus = el('span', 'del', '−' + fmtInt(s.linesRemoved));
        chg.appendChild(plus);
        chg.appendChild(document.createTextNode(' / '));
        chg.appendChild(minus);
        item('cs.sess.changes', chg);

        item('cs.sess.requests', el('span', 'sess-value', fmtInt(s.requests)));

        // What the tokens would have cost on the API. On a subscription none of it is
        // billed — Claude Code's own record says $0 for that reason — so the label says
        // "converted" and the tooltip spells out the rates and where they came from.
        const cost = el('span', 'sess-value', fmtMoney(s.costUSD));
        cost.title = t('cs.sess.costHint')
            + (s.hasUnknownRate ? '\n' + t('cs.sess.costUnknown') : '')
            + (s.byModel && s.byModel.length ? '\n\n' + s.byModel.map(function (m) {
                return (m.model || '?') + ': ' + (m.unknownRate ? '—' : fmtMoney(m.costUSD));
            }).join('\n') : '');
        item('cs.sess.cost', cost);

        card.appendChild(grid);

        // Tokens with their own share of the bill beside them. On a long conversation
        // cache reads carry most of the cost while looking like the least "work", so
        // showing the two together is what makes the total make sense.
        const parts = s.costParts || {};
        const toks = el('div', 'sess-tokens');
        const pair = (labelKey, v, cost) => {
            const sp = el('span');
            sp.appendChild(document.createTextNode(t(labelKey) + ' '));
            sp.appendChild(el('b', null, fmtTokens(v)));
            if (cost > 0) {
                sp.appendChild(document.createTextNode(' '));
                sp.appendChild(el('span', 'sess-cost', fmtMoney(cost)));
            }
            return sp;
        };
        toks.appendChild(pair('cs.stats.input', s.input, parts.input));
        toks.appendChild(pair('cs.stats.output', s.output, parts.output));
        toks.appendChild(pair('cs.stats.cacheRead', s.cacheRead, parts.cacheRead));
        toks.appendChild(pair('cs.stats.cacheWrite', s.cacheWrite, parts.cacheWrite));
        card.appendChild(toks);

        return card;
    }

    function renderUsage() {
        const pane = document.getElementById('pane-usage');
        pane.textContent = '';
        if (!data) {
            pane.appendChild(el('div', 'empty-state', t('cs.loading')));
            return;
        }

        // This conversation first, then the account-wide limits it feeds into.
        const sess = el('div');
        const list = data.sessions || [];
        if (!list.length) {
            sess.appendChild(el('div', 'empty-state', t('cs.sess.none')));
        } else {
            list.forEach((s) => sess.appendChild(sessionCard(s)));
        }
        pane.appendChild(section('cs.sess.title', sess));

        const u = data.usage;

        // Limits block — or the reason we cannot show it.
        const limits = el('div');
        if (!u || u.status !== 'ok') {
            const box = el('div', 'error-state');
            const msgKey = !u ? 'cs.usage.unconfigured'
                : u.status === 'auth_expired' ? 'cs.usage.authExpired'
                : u.status === 'blocked' ? 'cs.usage.blocked'
                : u.status === 'unconfigured' ? 'cs.usage.unconfigured'
                : 'cs.usage.error';
            box.appendChild(el('div', null, t(msgKey)));
            if (u && u.detail) box.appendChild(el('div', 'headline-hint', u.detail));
            const link = el('button', 'linklike', t('cs.usage.openSettings'));
            link.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
            box.appendChild(link);
            limits.appendChild(box);
        } else {
            if (u.session) {
                limits.appendChild(meter(
                    t('cs.usage.session'),
                    u.session.percent,
                    u.session.resetText ? t('cs.usage.resets', u.session.resetText) : null
                ));
            }
            if (u.weekly) {
                limits.appendChild(meter(
                    t('cs.usage.weekly'),
                    u.weekly.percent,
                    u.weekly.resetText ? t('cs.usage.resets', u.weekly.resetText) : null
                ));
            }
            (u.models || []).forEach((m) => {
                limits.appendChild(meter(
                    t('cs.usage.weeklyModel', m.label),
                    m.percent,
                    m.resetText ? t('cs.usage.resets', m.resetText) : null
                ));
            });
        }
        pane.appendChild(section('cs.usage.limits', limits));

        // Local contribution block.
        const local = data.local;
        const contrib = el('div');
        if (!local || !local.available) {
            contrib.appendChild(el('div', 'empty-state', t('cs.usage.noLocal')));
        } else {
            const h = el('p', 'headline');
            const strong = el('strong', null, local.longContextPercent + '%');
            h.appendChild(strong);
            h.appendChild(document.createTextNode(' ' + t('cs.usage.longCtx', fmtTokens(local.threshold))));
            contrib.appendChild(h);
            contrib.appendChild(el('p', 'headline-hint', t('cs.usage.longCtxHint')));

            if (local.skills && local.skills.length) {
                contrib.appendChild(el('h3', 'section-header', t('cs.usage.skills')));
                local.skills.forEach((s) => {
                    contrib.appendChild(barRow('/' + s.name, s.percent, s.percent + '%'));
                });
            }
        }
        const contribSection = section('cs.usage.contrib', contrib);
        contribSection.insertBefore(
            el('p', 'section-note', t('cs.usage.localNote')),
            contribSection.childNodes[1]
        );
        pane.appendChild(contribSection);
    }

    // ── stats tab ───────────────────────────────────────────────────────────

    function renderStats() {
        const pane = document.getElementById('pane-stats');
        pane.textContent = '';
        if (!data) {
            pane.appendChild(el('div', 'empty-state', t('cs.loading')));
            return;
        }

        const s = data.stats;
        if (!s || !s.available) {
            pane.appendChild(el('div', 'empty-state', t('cs.stats.noCache')));
            return;
        }

        // Heatmap.
        pane.appendChild(section('cs.stats.activity', buildHeatmap(s)));

        // Headline figures.
        const grid = el('div', 'stat-grid');
        const add = (labelKey, value, sub) => {
            const cell = el('div', 'stat');
            cell.appendChild(el('span', 'stat-label', t(labelKey)));
            cell.appendChild(el('span', 'stat-value', value));
            if (sub) cell.appendChild(el('span', 'stat-sub', sub));
            grid.appendChild(cell);
        };
        add('cs.stats.totalTokens', fmtTokens(s.totalTokens));
        add('cs.stats.cost', fmtMoney(s.costUSD), s.hasUnknownRate ? t('cs.stats.costPartial') : null);
        add('cs.stats.favoriteModel', s.favoriteModelLabel || '—');
        add('cs.stats.sessions', fmtInt(s.sessions));
        add('cs.stats.longestSession', fmtDuration(s.longestSessionMs));
        add('cs.stats.activeDays', s.activeDays + '/' + s.windowDays);
        add('cs.stats.longestStreak', t('cs.stats.days', s.longestStreak));
        add('cs.stats.mostActiveDay', s.mostActiveDayLabel || '—');
        add('cs.stats.currentStreak', t('cs.stats.days', s.currentStreak));

        const totals = el('div');
        totals.appendChild(grid);

        const row = el('div', 'token-row');
        const pair = (labelKey, v) => {
            const sp = el('span');
            sp.appendChild(document.createTextNode(t(labelKey) + ' '));
            const b = el('b', null, fmtTokens(v));
            sp.appendChild(b);
            return sp;
        };
        row.appendChild(pair('cs.stats.input', s.input));
        row.appendChild(pair('cs.stats.output', s.output));
        row.appendChild(pair('cs.stats.cacheRead', s.cacheRead));
        row.appendChild(pair('cs.stats.cacheWrite', s.cacheWrite));
        totals.appendChild(row);

        pane.appendChild(section('cs.stats.totals', totals));

        // Per-model share.
        if (s.byModel && s.byModel.length) {
            const models = el('div');
            s.byModel.forEach((m) => {
                const row = barRow(m.label, m.percent, fmtTokens(m.tokens));
                row.title = m.label + ' · ' + fmtTokens(m.tokens) + ' · ' + fmtMoney(m.costUSD);
                models.appendChild(row);
            });
            pane.appendChild(section('cs.stats.byModel', models));
        }
    }

    // Seven rows (weekdays) x N columns (weeks), oldest week first — the same shape
    // the CLI draws. Days before the first record are rendered as empty cells so the
    // first column starts on the correct weekday.
    function buildHeatmap(s) {
        const wrap = el('div', 'heat-wrap');
        const days = s.daily || [];
        if (!days.length) {
            wrap.appendChild(el('div', 'empty-state', t('cs.stats.noActivity')));
            return wrap;
        }

        const byDate = new Map();
        days.forEach((d) => byDate.set(d.date, d));

        const first = parseDate(days[0].date);
        const last = parseDate(days[days.length - 1].date);
        // Back up to the Sunday of the first week so column boundaries are real weeks.
        const start = new Date(first.getTime());
        start.setDate(start.getDate() - start.getDay());

        const grid = el('div', 'heat');
        const months = el('div', 'heat-months');
        const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        let cursor = new Date(start.getTime());
        let lastMonth = -1;
        while (cursor <= last) {
            // One label per column, printed only when the month changes — the same
            // sparse header the CLI draws above its heatmap.
            const colMonth = cursor.getMonth();
            const lab = el('span', null, colMonth === lastMonth ? '' : MONTH_NAMES[colMonth]);
            lab.style.width = '14px';        // 11px cell + 3px gap
            lab.style.flex = '0 0 14px';
            lab.style.overflow = 'visible';
            lab.style.whiteSpace = 'nowrap';
            months.appendChild(lab);
            lastMonth = colMonth;

            for (let row = 0; row < 7; row++) {
                const key = isoDate(cursor);
                const rec = byDate.get(key);
                const inRange = cursor >= first && cursor <= last;
                const cell = el('div', 'heat-cell' + (rec ? ' l' + rec.level : (inRange ? '' : ' empty')));
                if (rec) {
                    cell.title = key + ' · ' + t('cs.stats.messages', fmtInt(rec.count));
                } else if (inRange) {
                    cell.title = key;
                }
                grid.appendChild(cell);
                cursor.setDate(cursor.getDate() + 1);
            }
        }
        wrap.appendChild(months);
        wrap.appendChild(grid);

        const legend = el('div', 'heat-legend');
        legend.appendChild(el('span', null, t('cs.stats.less')));
        [0, 1, 2, 3, 4].forEach((lv) => legend.appendChild(el('span', 'heat-cell' + (lv ? ' l' + lv : ''))));
        legend.appendChild(el('span', null, t('cs.stats.more')));
        wrap.appendChild(legend);
        return wrap;
    }

    function parseDate(iso) {
        const p = iso.split('-');
        return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    }

    function isoDate(d) {
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return d.getFullYear() + '-' + m + '-' + day;
    }

    // ── shell ───────────────────────────────────────────────────────────────

    function renderAll() {
        applyStaticI18n();
        renderUsage();
        renderStats();
        const foot = document.getElementById('footer-updated');
        if (data && data.updatedText) foot.textContent = t('cs.updated', data.updatedText);
        else foot.textContent = '';
    }

    function selectTab(name) {
        activeTab = name;
        document.querySelectorAll('.tab').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-tab') === name);
        });
        document.getElementById('pane-usage').hidden = name !== 'usage';
        document.getElementById('pane-stats').hidden = name !== 'stats';
    }

    document.querySelectorAll('.tab').forEach((b) => {
        b.addEventListener('click', () => selectTab(b.getAttribute('data-tab')));
    });

    document.getElementById('refresh-btn').addEventListener('click', () => {
        vscode.postMessage({ type: 'refresh' });
    });

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'lang') {
            dict = msg.dict || {};
            renderAll();
        } else if (msg.type === 'data') {
            data = msg.payload;
            renderAll();
        }
    });

    selectTab('usage');
    vscode.postMessage({ type: 'ready' });
}());
