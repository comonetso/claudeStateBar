# 「이 버튼 눌러 봐」 · 「입력해 봐」

전제: SKILL.md §0~§2. 🔴 자동화는 가려진 요소도 "성공"하고 `trial` 도 실제로 누른다 — 판정은 코드 검사로.

## 절차
1. **먼저 분류**: 그 버튼이 데이터를 바꾸는가(보내기·저장·삭제·초대·결제·설정)? 바꾸면 **누르지 말고** 예상 결과(예상 요청)를 보고하고 승인을 받는다(`policy.decide` = data-mutation). 승인된 그 대상·그 동작만.
2. `snapshot(page,{interactive:true})` → 대상 ref → `K.canAct(tab, loc)`(유일·보임·가려지지 않음). 가려져 있으면 "사용자는 못 누른다"로 보고(자동화는 합성 클릭으로 통과해 버린다).
3. 확인창이 뜰 수 있으면 `K.denyConfirm(tab)` **직전에**.
4. `__diag.mark('click')` → `page.locator(ref).click()`(오른쪽·좌표·지연이 필요하면 `boundingBox` + `page.mouse.click(x,y,{button,delay})`) → 같은 옵션 새 스냅샷 `diff` + `dump({since})` + `K.img`.
5. 입력: 입력 전 `isVisible`, 입력 뒤 `document.activeElement === 대상` 확인. 🔴 숨은 칸에 fill 하면 초점 있는 다른 칸으로 샌다. `\n` 넣지 마라 — 전송은 `keyboard.press('Enter')`, 줄바꿈은 `Shift+Enter` 로 명시. `selectOption` 은 반환값을 요청값과 비교(없는 값이면 첫 항목). `setInputFiles` 는 항상 배열. 한글은 `keyboard.type`(완성 글자) 또는 진짜 조합은 `K.X(tab,'Input.imeSetComposition',…)`→`Input.insertText`.
6. 결과 이벤트의 `isTrusted` 가 false 면 가려짐 신호.

## 판정
기대 변화가 diff·요청·화면에 나타났는가 · 오류 0 · 초점이 의도한 곳에 있는가.

## 보고
`누른 요소(ref·이름) · 가림 여부 · 화면 변화(diff 발췌) · 요청(메서드·경로·상태·rid) · 확인창 문구(__lastConfirm) · 캡처`.
