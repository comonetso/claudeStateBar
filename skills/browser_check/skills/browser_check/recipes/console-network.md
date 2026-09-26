# 「콘솔 에러 봐」 · 「API 실패 봐」 — 오류·요청 실패·원인 분류

전제: SKILL.md §0~§2. 이벤트(console·request)는 A/B 로 **오지 않는다** — 페이지 안 기록기(v2.1) 또는 C 로만.

## 콘솔 에러
1. **로그인 없는 사이트**: `openTab` → `K.X(tab,'Page.addScriptToEvaluateOnNewDocument',{source: DIAG_V21})` → `reload()` → (사용자가 말한 조작) → `page.evaluate(() => __diag.dump({types:['error','rejection','resource-error','resource-status','csp','ws-error','worker-error','sse-error','console']}))`.
   🔴 `summary().problems` 는 잘린다 — 개수(`problemCount`·`truncated`)만 보고 내용은 `dump`.
2. **로그인 앱**: Vite 기록기(v2.1)가 첫 로딩부터 깔려 있는 개발 서버면 탭을 연 뒤 `dump`. 없으면 (조립·미실측) 앱 없는 같은 출처 주소를 먼저 열고 → 주입 → `goto(앱)` 로 회전 1번에 첫 로딩부터. C 통로가 있으면 `Runtime.consoleAPICalled`·`exceptionThrown` 이벤트를 직접 받는다. 확장 프로그램이 낸 것은 `ext-console`·`ext-exception` 으로 따로 온다 — 페이지 오류가 아니다.
3. **운영(기록기 없음)**: 사후 회수 — `new ReportingObserver(cb,{buffered:true})`(사용 중단·CSP) + resource 실패 + 이후 조작분은 `page.evaluate` 로 console/error/unhandledrejection 감싸기.
4. 오류를 일부러 내야 하면 **인라인 `<script>`** 로(evaluate 발 거절은 안 잡힘).
5. 구간 표시: 조작 전 `__diag.mark('단계')` → `dump({since})`.

**판정**: `error`·`rejection`(v2.1 `handledLater` 제외)·`resource-error/status`·`csp` 가 0. `console.warn` 은 따로 목록.
**보고**: 오류마다 `종류 · 메시지 · 파일:줄:열 · 스택 첫 줄 · 발생 단계 · 요청이면 rid`.

## API 실패
1. 기록기가 있으면 `dump({types:['fetch','xhr','ws-close','ws-error']})` → `status ≥ 400` · `phase:'failed'`(`aborted` 는 의도된 중단) · `ms` · `rid`(요청 번호 헤더).
2. 없으면 사후: `performance.getEntriesByType('resource')` 의 fetch/xhr `responseStatus`·`duration`. 🔴 250개면 잘린 것 — `performance.setResourceTimingBufferSize(10000)` 뒤 재현.
3. 원인 구분(상태 0): 같은 시각 `csp` 이벤트 → CSP 차단 · 페이지 `fetch(url,{mode:'no-cors',cache:'no-store'})` 가 풀리면 CORS, 거절이면 네트워크(**GET 만**) · XHR 은 `reason`(timeout/error/abort).
4. 서버 로그 대조: rid 로 grep. 대상 서버가 4xx 를 로그에 안 남기면 시각+경로로.
5. 재현은 **GET 만**. 🔴 POST/PUT/DELETE 재전송 금지 · repl `fetch` 로 인증 창구(`sites[].authPathPrefixes`) 금지.

**판정**: 사용자 동작에 대응하는 요청이 2xx, 의도된 4xx 와 구분.
**보고**: `메서드 경로 · 상태 · ms · rid · 응답 요지(가림) · 서버 로그 줄 · 원인(CORS/CSP/네트워크/서버)`.
