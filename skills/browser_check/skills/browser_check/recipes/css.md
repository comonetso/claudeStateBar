# 「CSS 오류 확인해 봐」 — 레이아웃 깨짐·가로 넘침·잘림·겹침·안 먹는 스타일·CSS/폰트 로드 실패·대비

전제: SKILL.md §0~§2.

## 절차
1. `openTab(url)` → `K.prep` → `K.wake`.
2. **로드 실패(첫 로딩)**: 로그인 없는 사이트면 기록기 v2.1 을 `K.X(tab,'Page.addScriptToEvaluateOnNewDocument',{source: DIAG})` → `reload()` → `__diag.dump({types:['resource-error','resource-status','csp']})`. 🔴 로그인 앱은 새로고침 = 토큰 회전 — Vite 기록기(v2.1)가 이미 있는 개발 서버면 그것을 쓰고, 없으면 새 target 의 **첫 navigation 전에** 주입한다.
3. 화면 전체 `K.img(tab,'full')` → 서버에서 눈으로 확인. 긴 화면은 스크롤 타일 + `image/stitch.py`.
4. 자동 점검(순서 고정): `__diag.dump` 먼저 → `scrollTo(0,0)` → `page.evaluate(WEBCHECK)` → axe(접근성 레시피) → `__diag.mark('extra')` → `page.evaluate(WEBCHECK_EXTRA)` **마지막**(focus·간격 CSS·합성 paste·자체 HEAD/robots 요청 부작용).
   볼 항목: `pageHorizontalScroll` · `overflowBeyondClientWidth` · 안쪽 가로 스크롤 · `textClipped`(line-clamp 포함) · 글자 겹침 · 효과 없는 z-index · 갇힌 fixed · 안 붙는 sticky · 크기 없는 이미지 · `font-display` · `100vh` · `lowContrast`(조상 opacity 반영 조각).
5. **원인 규명**: 의심 요소를 `K.X` 로 `DOM.getDocument`→`DOM.querySelector`→`CSS.getMatchedStylesForNode` — 적용 규칙·이긴 규칙·`styleSheetId`·줄. 상태 모양은 `CSS.forcePseudoState`(끝나면 `[]` 로 원복).
6. 넘친 요소는 `scrollIntoViewIfNeeded` → `boundingBox` → 전체 캡처 → 서버 자르기.

## 판정
`scrollWidth > clientWidth` 0 · 의도 없는 안쪽 가로 스크롤 0 · CSS·폰트 404 0 · 대비 4.5:1(큰 글 3:1) 이상 · 의도 없는 잘림·겹침 0. 🔴 색 판정은 `darkReader:false` 일 때만.

## 보고
문제마다 `요소 설명 · 값/기준 · 이긴 규칙(시트:줄) · 잘라낸 캡처 · 수정 제안`.

## 미확인
CSS **문법 오류**(브라우저가 버린 선언)는 CSSOM 에 안 남는다 — `CSS.getStyleSheetText` 원문과 CSSOM 비교로 찾을 수 있을 것(미실측).
