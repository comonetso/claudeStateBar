// work-ledger 보기 화면 — 장부 전체를 HTML 파일 하나로 만든다(보기 전용, 서버 없음).
// 데이터는 페이지 안 JSON 으로 들어가고, 작은 스크립트가 프로젝트·날짜 보기를 바꾼다.

const STATE_META = {
  "제안": { icon: "◇", tone: "violet", label: "제안" },
  "할 일": { icon: "○", tone: "slate", label: "할 일" },
  "진행 중": { icon: "▶", tone: "blue", label: "진행 중" },
  "끝냄": { icon: "◐", tone: "amber", label: "확인 대기" },
  "확인됨": { icon: "✓", tone: "green", label: "확인됨" },
  "보류": { icon: "‖", tone: "gray", label: "보류" },
  "버림": { icon: "✕", tone: "gray", label: "버림" },
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function renderHtml(items, { builtAt, owner }) {
  const data = JSON.stringify({ items, states: STATE_META, builtAt, owner }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>작업 장부</title>
<style>
:root {
  --bg: #f4f5f9; --card: #ffffff; --ink: #1d2433; --sub: #5b6475; --line: #e6e8ef; --soft: #f7f8fb;
  --violet: #7a5af8; --violet-bg: #f1edff; --slate: #55627a; --slate-bg: #eef1f6;
  --blue: #2563eb; --blue-bg: #e8f0ff; --amber: #c27803; --amber-bg: #fff4dc;
  --green: #12805c; --green-bg: #e3f6ee; --gray: #8a93a3; --gray-bg: #f0f1f4;
  --shadow: 0 1px 2px rgba(20,30,60,.05), 0 4px 16px rgba(20,30,60,.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151c; --card: #1b1f29; --ink: #e8ebf2; --sub: #9aa3b5; --line: #2a303d; --soft: #222734;
    --violet: #a78bfa; --violet-bg: #2a2342; --slate: #a3adc2; --slate-bg: #262c39;
    --blue: #7aa7ff; --blue-bg: #1c2a47; --amber: #f2b84b; --amber-bg: #3a2e14;
    --green: #4fd1a0; --green-bg: #15342a; --gray: #8a93a3; --gray-bg: #252a35;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif; }
.wrap { max-width: 980px; margin: 0 auto; padding: 28px 20px 60px; }
header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
h1 { font-size: 22px; margin: 0; letter-spacing: -.3px; }
.built { color: var(--sub); font-size: 13px; }
.tabs { margin-left: auto; display: flex; gap: 6px; background: var(--card); padding: 4px; border-radius: 12px; box-shadow: var(--shadow); }
.tabs button { border: 0; background: transparent; color: var(--sub); font: inherit; padding: 7px 14px; border-radius: 9px; cursor: pointer; }
.tabs button.on { background: var(--ink); color: var(--card); }
.filter { display: flex; gap: 8px; margin: -6px 0 18px; }
.chip { border: 1px solid var(--line); background: var(--card); color: var(--sub); font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 99px; cursor: pointer; }
.chip.on { border-color: var(--ink); color: var(--ink); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.card { background: var(--card); border-radius: 16px; box-shadow: var(--shadow); padding: 18px 18px 16px; border: 1px solid var(--line); }
.pcard { cursor: pointer; transition: transform .12s ease; }
.pcard:hover { transform: translateY(-2px); }
.pname { font-weight: 700; font-size: 17px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.pname small { color: var(--sub); font-weight: 400; font-size: 12px; white-space: nowrap; }
.counts { display: flex; gap: 8px; flex-wrap: wrap; }
.count { border-radius: 10px; padding: 6px 10px; font-size: 13px; display: flex; gap: 6px; align-items: baseline; }
.count b { font-size: 18px; }
.next { margin-top: 12px; color: var(--sub); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-violet { color: var(--violet); background: var(--violet-bg); } .t-slate { color: var(--slate); background: var(--slate-bg); }
.t-blue { color: var(--blue); background: var(--blue-bg); } .t-amber { color: var(--amber); background: var(--amber-bg); }
.t-green { color: var(--green); background: var(--green-bg); } .t-gray { color: var(--gray); background: var(--gray-bg); }
.back { border: 0; background: none; color: var(--sub); font: inherit; cursor: pointer; padding: 0; margin-bottom: 10px; }
h2 { font-size: 20px; margin: 0 0 16px; }
.day { margin: 22px 0 8px; font-size: 13px; font-weight: 700; color: var(--sub); display: flex; align-items: center; gap: 10px; }
.day::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.list { display: flex; flex-direction: column; gap: 8px; }
.row { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; cursor: pointer; }
.row .top { display: flex; align-items: center; gap: 10px; }
.pill { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 99px; white-space: nowrap; }
.title { flex: 1; font-weight: 600; }
.row.closed .title { color: var(--sub); }
.row.dropped .title { text-decoration: line-through; }
.meta { color: var(--sub); font-size: 12px; white-space: nowrap; }
.last { color: var(--sub); font-size: 13px; margin: 4px 0 0 0; padding-left: 2px; }
.hist { display: none; margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 8px; }
.row.open .hist { display: block; }
.desc { white-space: pre-wrap; line-height: 1.6; margin-bottom: 10px; }
.kids { border-left: 2px solid var(--line); padding-left: 10px; margin-bottom: 10px; display: grid; gap: 4px; }
.qm { display: inline-block; width: 18px; height: 18px; line-height: 16px; text-align: center; border: 1px solid var(--sub); border-radius: 50%; font-size: 11px; color: var(--sub); }
.ev { display: grid; grid-template-columns: 120px 72px 80px 1fr; gap: 8px; font-size: 13px; padding: 3px 0; }
.ev .who { color: var(--sub); } .ev .when { color: var(--sub); font-variant-numeric: tabular-nums; }
.tl { display: flex; flex-direction: column; gap: 6px; }
.tlrow { display: grid; grid-template-columns: 52px 130px auto 1fr; gap: 10px; align-items: center; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; font-size: 14px; cursor: pointer; }
.tlrow .when { color: var(--sub); font-variant-numeric: tabular-nums; }
.tlrow .proj { color: var(--sub); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tlrow .st { white-space: nowrap; }
.tlrow .via { color: var(--sub); font-size: 12px; }
.tlrow .txt small { color: var(--sub); }
.empty { color: var(--sub); text-align: center; padding: 40px 0; }
@media (max-width: 640px) {
  .tabs { margin-left: 0; }
  .ev { grid-template-columns: 1fr; gap: 0; padding: 6px 0; }
  .tlrow { grid-template-columns: auto 1fr; grid-template-areas: "when proj" "st st" "txt txt"; gap: 4px 10px; align-items: start; }
  .tlrow .when { grid-area: when; } .tlrow .proj { grid-area: proj; }
  .tlrow .st { grid-area: st; white-space: normal; } .tlrow .txt { grid-area: txt; }
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>📒 작업 장부</h1>
    <span class="built">${esc(builtAt)} 기준</span>
    <nav class="tabs">
      <button data-view="projects">프로젝트</button>
      <button data-view="days">날짜별</button>
    </nav>
  </header>
  <div class="filter">
    <button class="chip" data-filter="open">남은 일</button>
    <button class="chip" data-filter="all">전체</button>
  </div>
  <main id="main"></main>
</div>
<script id="data" type="application/json">${data}</script>
<script>
(function () {
  var D = JSON.parse(document.getElementById("data").textContent);
  var S = D.states;
  // AI 가 범위 전부 검증한 끝냄은 "AI 검증 완료" — 확인 대기·남은 일에서 빠진다(10-27 리규형님, 장부 탭과 같게)
  S["AI 검증"] = { icon: "✓", tone: "green", label: "AI 검증 완료" };
  D.items.forEach(function (it) { if (it.state === "끝냄" && it.verify && it.verify.ai) it.state = "AI 검증"; });
  var OPEN = { "제안": 1, "할 일": 1, "진행 중": 1, "끝냄": 1, "보류": 1 };
  var ORDER = { "끝냄": 0, "진행 중": 1, "할 일": 2, "제안": 3, "보류": 4, "AI 검증": 5, "확인됨": 6, "버림": 7 };
  var IDS = Object.create(null);
  var AREA = Object.create(null);
  D.items.forEach(function (it) { IDS[it.id] = true; if (it.area) AREA[it.id] = it; });
  var main = document.getElementById("main");
  var state = { view: "projects", project: null, filter: "open" };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function pill(st) { var m = S[st] || { icon: "·", tone: "gray", label: st }; return '<span class="pill t-' + m.tone + '">' + m.icon + " " + esc(m.label) + "</span>"; }
  function md(at) { return at.slice(5, 10).replace("-", "/"); }
  function dayLabel(d) {
    var dt = new Date(d + "T00:00:00"); var w = "일월화수목금토"[dt.getDay()];
    return d.replace(/-/g, ".") + " (" + w + ")";
  }
  function visible(it) { return state.filter === "all" || OPEN[it.state]; }
  function lastNote(it) {
    for (var i = it.log.length - 1; i >= 0; i--) if (it.log[i].text && it.log[i].kind !== "설명" && it.log[i].kind !== "묶음" && it.log[i].kind !== "내 메모" && it.log[i].kind !== "바뀜") return it.log[i];
    return null;
  }

  function readHash() {
    var h = decodeURIComponent(location.hash.slice(1));
    if (h.indexOf("p=") === 0) { state.view = "project"; state.project = h.slice(2); }
    else if (h === "days") { state.view = "days"; state.project = null; }
    else { state.view = "projects"; state.project = null; }
  }
  function go(h) { location.hash = h; }

  function projects() {
    var by = Object.create(null); // 프로젝트 이름이 constructor·__proto__ 여도 깨지지 않게(10-26 Codex 리뷰)
    D.items.forEach(function (it) { if (isTop(it)) (by[it.project] = by[it.project] || []).push(it); });
    var names = Object.keys(by).sort(function (a, b) {
      var la = by[a].reduce(function (m, x) { return x.updated > m ? x.updated : m; }, "");
      var lb = by[b].reduce(function (m, x) { return x.updated > m ? x.updated : m; }, "");
      return la < lb ? 1 : -1;
    });
    if (!names.length) return '<div class="empty">아직 장부가 비어 있습니다.</div>';
    return '<div class="grid">' + names.map(function (n) {
      var list = by[n], c = {};
      list.forEach(function (it) { c[it.state] = (c[it.state] || 0) + 1; });
      var last = list.reduce(function (m, x) { return x.updated > m ? x.updated : m; }, "");
      var counts = ["끝냄", "진행 중", "할 일", "제안"].filter(function (k) { return c[k]; }).map(function (k) {
        var m = S[k]; return '<span class="count t-' + m.tone + '"><b>' + c[k] + "</b>" + esc(m.label) + "</span>";
      }).join("");
      if (!counts) counts = '<span class="count t-green"><b>' + (c["확인됨"] || 0) + "</b>확인됨</span>";
      var next = list.filter(function (it) { return it.state === "진행 중" || it.state === "끝냄"; })
        .sort(function (a, b) { return a.updated < b.updated ? 1 : -1; })[0];
      return '<div class="card pcard" data-p="' + esc(n) + '"><div class="pname">' + esc(n) + "<small>" + md(last) + " 갱신</small></div>" +
        '<div class="counts">' + counts + "</div>" +
        (next ? '<div class="next">' + (S[next.state].icon) + " " + esc(next.title) + "</div>" : "") + "</div>";
    }).join("") + "</div>";
  }

  function itemRow(it) {
    var ln = lastNote(it);
    var cls = "row" + (OPEN[it.state] ? "" : " closed") + (it.state === "버림" ? " dropped" : "");
    var hist = it.log.map(function (e) {
      return '<div class="ev"><span class="when">' + esc(e.at.slice(5, 16)) + '</span><span class="who">' + esc(e.who) +
        "</span><span>" + esc((S[e.kind] && S[e.kind].label) || e.kind) + "</span><span>" + esc(e.text) + "</span></div>";
    }).join("");
    // 큰 작업 = 한 줄 · 펼치면 설명·세부·기록(10-26 묶음 구조)
    var kids = kidsOf(it.id);
    var done = kids.filter(function (k) { return k.state === "끝냄" || k.state === "확인됨" || k.state === "버림"; }).length;
    var kidHtml = kids.length ? '<div class="kids">' + kids.map(function (k) {
      return '<div class="kid">' + pill(k.state) + " " + esc(k.title) + (tm(k) ? ' <span class="meta">' + esc(tm(k)) + "</span>" : "") + "</div>";
    }).join("") + "</div>" : "";
    // 번호는 화면에 안 보인다(10-26 리규형님) — 줄 끝은 세부 개수와 시작·끝 시각
    return '<div class="' + cls + '"><div class="top">' + pill(it.state) + '<span class="title">' + esc(it.title) + (it.desc ? ' <span class="qm" title="펼치면 설명">?</span>' : "") +
      '</span><span class="meta">' + (kids.length ? "세부 " + done + "/" + kids.length + (tm(it) ? " · " : "") : "") + esc(tm(it) || it.updated.slice(5, 16)) + "</span></div>" +
      (ln ? '<div class="last">' + esc(ln.who) + ": " + esc(ln.text) + "</div>" : "") +
      '<div class="hist">' + (it.desc ? '<div class="desc">' + esc(it.desc) + "</div>" : "") + kidHtml + hist + "</div></div>";
  }
  // 시작 = 처음 진행 중, 끝 = 마지막 끝냄(10-26 리규형님)
  function tm(it) { return (it.started ? "시작 " + it.started.slice(5, 16) : "") + (it.finished ? (it.started ? " · " : "") + "끝 " + it.finished.slice(5, 16) : ""); }
  // 대작업 > 중작업 > 세부(10-26 리규형님). 중작업 = 대작업 아래이거나 아직 대작업이 없는 요청
  function isTop(it) { return !it.area && (!it.parent || !IDS[it.parent] || AREA[it.parent]); }
  function kidsOf(id) { return D.items.filter(function (x) { return x.parent === id; }); }

  function project(name) {
    var list = D.items.filter(function (it) { return it.project === name && isTop(it) && (visible(it) || kidsOf(it.id).some(visible)); });
    var head = '<button class="back" data-go="">← 프로젝트 목록</button><h2>' + esc(name) + "</h2>";
    if (!list.length) return head + '<div class="empty">' + (state.filter === "open" ? "남은 일이 없습니다." : "항목이 없습니다.") + "</div>";
    // 대작업별로 묶는다 — 대작업은 상태 없이 아래 중작업 요약만(대작업 없는 요청은 맨 아래)
    var groups = Object.create(null);
    list.forEach(function (it) { var k = it.parent && AREA[it.parent] ? it.parent : ""; (groups[k] = groups[k] || []).push(it); });
    var first = function (k) { return Math.min.apply(null, groups[k].map(function (x) { return ORDER[x.state]; })); };
    // 대작업은 만든 순서로 고정(10-27 리규형님) — 대작업 없음은 맨 아래
    return head + Object.keys(groups).sort(function (a, b) { return a === "" ? 1 : b === "" ? -1 : AREA[a].created < AREA[b].created ? -1 : 1; }).map(function (k) {
      var rows = groups[k].sort(function (a, b) { return (ORDER[a.state] - ORDER[b.state]) || (a.updated < b.updated ? 1 : -1); });
      var area = k ? AREA[k] : null;
      var all = k ? D.items.filter(function (x) { return x.parent === k && !x.area; }) : [];
      var sum = ["끝냄", "진행 중", "할 일", "제안", "보류"].map(function (s) {
        var n = all.filter(function (x) { return x.state === s; }).length;
        return n ? (S[s] ? S[s].label : s) + " " + n : "";
      }).filter(Boolean).join(" · ");
      // 대작업 시작은 장부 명령이 계산해 넘긴다(areaSince — 하위 전체의 첫 진행, 없으면 "기록 시작")
      if (area && area.since) sum = (sum ? sum + " · " : "") + area.since.label + " " + area.since.at.slice(5, 16);
      return '<div class="day">' + (area ? "▣ " + esc(area.title) + (sum ? ' <span class="meta">' + esc(sum) + "</span>" : "") + (area && area.summary ? '<div class="note">' + esc(area.summary.text) + '</div>' : "") : "대작업 없음") + '</div><div class="list">' + rows.map(itemRow).join("") + "</div>";
    }).join("");
  }

  function days() {
    var ev = [];
    D.items.forEach(function (it) {
      if (!visible(it)) return;
      it.log.forEach(function (e) { if (S[e.kind]) ev.push({ e: e, it: it }); });
    });
    if (!ev.length) return '<div class="empty">기록이 없습니다.</div>';
    // 같은 날 같은 항목은 한 줄 — 그날 마지막 상태로 보이고, 거쳐 온 상태는 작게 붙인다
    ev.sort(function (a, b) { return a.e.at < b.e.at ? -1 : 1; });
    var by = Object.create(null);
    ev.forEach(function (x) {
      var d = x.e.at.slice(0, 10), day = (by[d] = by[d] || {}), g = day[x.it.id];
      if (!g) g = day[x.it.id] = { it: x.it, path: [], last: null };
      if (!g.path.length || g.path[g.path.length - 1] !== x.e.kind) g.path.push(x.e.kind);
      g.last = x.e;
    });
    return Object.keys(by).sort().reverse().map(function (d) {
      var rows = Object.keys(by[d]).map(function (k) { return by[d][k]; })
        .sort(function (a, b) { return a.last.at < b.last.at ? 1 : -1; });
      return '<div class="day">' + dayLabel(d) + '</div><div class="tl">' + rows.map(function (g) {
        var via = g.path.length > 1 ? '<span class="via">' + g.path.slice(0, -1).map(function (k) { return esc((S[k] || {}).label || k); }).join(" → ") + " →</span> " : "";
        return '<div class="tlrow" data-p="' + esc(g.it.project) + '"><span class="when">' + esc(g.last.at.slice(11, 16)) +
          '</span><span class="proj">' + esc(g.it.project) + '</span><span class="st">' + via + pill(g.last.kind) + "</span>" +
          '<span class="txt">' + esc(g.it.title) + (g.last.text ? " <small>— " + esc(g.last.text) + "</small>" : "") +
          " <small>· " + esc(g.last.who) + "</small></span></div>";
      }).join("") + "</div>";
    }).join("");
  }

  function render() {
    readHash();
    document.querySelectorAll(".tabs button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.view === (state.view === "days" ? "days" : "projects"));
    });
    document.querySelectorAll(".chip").forEach(function (b) { b.classList.toggle("on", b.dataset.filter === state.filter); });
    main.innerHTML = state.view === "days" ? days() : state.view === "project" ? project(state.project) : projects();
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-view],[data-filter],[data-p],[data-go],.row");
    if (!t) return;
    if (t.dataset.view) return go(t.dataset.view === "days" ? "days" : "");
    if (t.dataset.filter) { state.filter = t.dataset.filter; try { localStorage.setItem("wl-filter", state.filter); } catch (e) {} return render(); }
    if (t.dataset.p !== undefined) return go("p=" + encodeURIComponent(t.dataset.p));
    if (t.dataset.go !== undefined) return go(t.dataset.go);
    if (t.classList.contains("row")) t.classList.toggle("open");
  });
  try { state.filter = localStorage.getItem("wl-filter") || "open"; } catch (e) {}
  window.addEventListener("hashchange", render);
  render();
})();
</script>
</body>
</html>
`;
}
