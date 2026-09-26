# 「화면 확인해 봐」 · 「어디 봐 봐」 — 특정 화면·요소가 지금 어떤가

전제: SKILL.md §0~§2 (doctor · 분류 · `K.prep` · 로그인 규칙).

## 절차
1. `openTab(url)` → `K.prep(tab, {darkReader: site.darkReader})` → 애니메이션·지연 로딩이 있으면 `K.wake(tab)`.
2. `snapshot(page, {interactive: true})` 로 대상 ref 를 찾는다.
   - 🔴 문서를 스크롤했다면 먼저 `scrollTo(0,0)` — **위로 지나간 입력칸·이미지·iframe 은 스냅샷에서 빠진다**(아래·오른쪽만 포함). 스크롤 상자(채팅 타임라인)는 `showHidden: true`.
   - 큰 페이지는 `maxDepth: 2` 로 윤곽 → `selector`(첫 일치 하나만) · `ref` 로 좁힌다.
3. 번호 붙은 그림이 필요하면 `annotatedScreenshot(page)` → `@@IMG`(번호 N = ref `eN`).
4. 요소 사진: `page.locator('eN').scrollIntoViewIfNeeded()` → `boundingBox()` → `page.screenshot()` 전체 → 서버 `image/crop.py`(좌표 × DPR). 🔴 `clip`·`locator.screenshot()`·`fullPage` 는 깨져 있다.
5. 사용자가 실제로 누를 수 있는지: `K.canAct(tab, loc)` — 유일·보임·가려지지 않음.
6. SPA 주소는 `K.href(tab)`.
7. 로그인 사이트면 `K.safeClose(tab)`, 아니면 `closeTab(tab)`.

## 판정
요소가 있다(count ≥ 1) · 보인다(boundingBox 있음·가려지지 않음) · 글자·상태(AX 트리의 expanded·checked·disabled — `K.X(tab,'Accessibility.getFullAXTree')`).

## 보고
요소 캡처 + 스냅샷 발췌(ref 줄) + 상태값. Dark Reader 경고가 있었으면 맨 앞에.
