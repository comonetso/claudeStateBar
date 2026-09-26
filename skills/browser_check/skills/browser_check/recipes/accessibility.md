# 「접근성 점검해」

전제: SKILL.md §0~§2.

## 절차
1. `openTab(url)` → `K.prep`(DeepL 숨김·Dark Reader 잠금 — 대비·axe 오염 방지) → `scrollTo(0,0)`.
2. **좌표를 쓰는 점검 먼저**(webcheck 의 가림·대비) → 그다음 focus 를 움직이는 점검(focus 가 페이지를 스크롤해 가림 판정이 바뀐다).
3. axe: `const s = await (await fetch('https://cdn.jsdelivr.net/npm/axe-core@4.13.0/axe.min.js')).text(); await page.evaluate(s)` → `page.evaluate(() => axe.run({exclude:[['deepl-input-controller'],['deepl-page-load-popup'],['aside-inline-menu']]},{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']},resultTypes:['violations']}))`. (evaluate 는 페이지 CSP 를 우회한다. 인자 128KB 한도 → PC 쪽 fetch.)
4. 이름·역할·상태 정본: `K.X(tab,'Accessibility.getFullAXTree')`(expanded·required·invalid·describedby 까지) — 확장 노드 제외. 간단히는 snapshot.
5. webcheck + extra: 포커스 표시 없음(2.4.7) · 포커스 가림(2.4.11) · 텍스트 간격(1.4.12) · 붙여넣기 차단(3.3.8) · 목표 크기(예외 반영) · 가짜 버튼(onclick/`__reactProps$`) · 조상 opacity 반영 대비.
6. 키보드: `keyboard.press('Tab')` N회 → `document.activeElement` 기록(순서·함정 2.1.2). Space 조작은 `K.X(tab,'Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '})`+`keyUp` — 🔴 `keyboard.press('Space')` 는 key 가 빈 문자열이라 판정에 쓰지 마라.

## 판정
axe `violations` 0(critical·serious 먼저) · 키보드만으로 모든 조작·빠져나오기 가능 · 수동 확인 항목은 목록으로 넘김.

## 보고
`WCAG 기준 번호 · 규칙 · 요소 · 값 · 수정 제안`, 수동 항목 따로.
