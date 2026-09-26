/* T3 제안 조각 검증 — 페이지 스크립트(인라인). 기록기에 넣을 Worker 콘솔·요청 중계와 XHR 원인 기록을 흉내 낸다. */
(function () {
  var R = (window.__t3snip = { relayed: [], appMsgs: [], xhr: {}, errs: [] });
  /* ── (A) Worker 감싸기: 워커 안 console·fetch 를 postMessage 로 중계 ── */
  var OW = window.Worker;
  var BOOT =
    "(function(){var P=self.postMessage.bind(self);var S=function(v){try{return typeof v==='string'?v:(v&&v.stack)||JSON.stringify(v)}catch(e){return String(v)}};" +
    "['log','info','warn','error','debug'].forEach(function(l){var o=console[l];console[l]=function(){try{P({__diagWorker:1,kind:'console',level:l,msg:[].map.call(arguments,S).join(' ')})}catch(e){}return o.apply(console,arguments)}});" +
    "if(self.fetch){var F=self.fetch;self.fetch=function(i){var u=String(i&&i.url||i);return F.apply(this,arguments).then(function(r){if(r.status>=400)P({__diagWorker:1,kind:'fetch',status:r.status,url:u});return r},function(e){P({__diagWorker:1,kind:'fetch',phase:'failed',url:u,err:String(e)});throw e})}}" +
    "self.addEventListener('error',function(e){P({__diagWorker:1,kind:'error',msg:e.message})});})();\n";
  window.Worker = function (url, opts) {
    if (!new.target) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator.");
    var abs = new URL(String(url), location.href).href;
    var isModule = !!(opts && opts.type === 'module');
    var loader = isModule ? 'await im' + 'port(' + JSON.stringify(abs) + ');' : 'importScripts(' + JSON.stringify(abs) + ');';
    var wrapped = URL.createObjectURL(new Blob([BOOT + loader], { type: 'text/javascript' }));
    var w = Reflect.construct(OW, [wrapped, opts], new.target);
    w.addEventListener('message', function (m) {
      if (m.data && m.data.__diagWorker) {
        m.stopImmediatePropagation();
        R.relayed.push(Object.assign({ worker: abs.slice(0, 40) }, m.data));
      }
    });
    return w;
  };
  window.Worker.prototype = OW.prototype;
  var body =
    "console.log('T3W-LOG', {a:1}); console.error('T3W-ERR'); postMessage({app:'hello'}); fetch('/__t3_wk_404.json'); fetch('https://t3-wk.invalid/').catch(function(){}); setTimeout(function(){ throw new Error('T3W-THROW'); }, 20);";
  var classic = new Worker(URL.createObjectURL(new Blob([body], { type: 'text/javascript' })));
  classic.onmessage = function (m) { R.appMsgs.push('classic ' + JSON.stringify(m.data)); };
  classic.onerror = function (e) { R.errs.push('classic ' + e.message); };
  var mod = new Worker(URL.createObjectURL(new Blob([body.replace('T3W-LOG', 'T3W-MOD-LOG')], { type: 'text/javascript' })), { type: 'module' });
  mod.onmessage = function (m) { R.appMsgs.push('module ' + JSON.stringify(m.data)); };
  mod.onerror = function (e) { R.errs.push('module ' + e.message); };
  R.subclass = (function () { class MyW extends Worker {} var x = new MyW(URL.createObjectURL(new Blob([''], { type: 'text/javascript' }))); var ok = x instanceof MyW && x instanceof Worker; x.terminate(); return ok; })();

  /* ── (B) XHR 실패 원인: timeout / error / abort 이벤트 ── */
  function x(id, url, setup) {
    var r = new XMLHttpRequest();
    r.open('GET', url);
    var why = null;
    ['timeout', 'error', 'abort'].forEach(function (t) { r.addEventListener(t, function () { why = t; }); });
    r.addEventListener('loadend', function () { R.xhr[id] = 'status ' + r.status + ' reason ' + (why || 'load'); });
    if (setup) setup(r);
    r.send();
    return r;
  }
  x('timeout', 'https://httpbin.org/delay/3?t3=xt', function (r) { r.timeout = 300; });
  x('cors', 'https://www.iana.org/?t3=xc');
  x('net', 'https://t3-xn.invalid/');
  var ab = x('abort', 'https://httpbin.org/delay/3?t3=xa');
  setTimeout(function () { ab.abort(); }, 50);
  x('ok404', '/__t3_x404.json');
})();
