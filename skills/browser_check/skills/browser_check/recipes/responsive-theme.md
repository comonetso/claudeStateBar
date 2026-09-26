# 「반응형 봐」 · 「모바일에서 어떻게 보여」 · 「다크모드 확인」 · 「인쇄」

전제: SKILL.md §0~§2. `setViewportSize`·`emulateMedia` 는 없다 — CDP(B 또는 C)가 1순위.

## 폭
1. `openTab(url)` → `K.prep` → `K.hasX(tab)`.
2. **1순위(CDP)**: 폭마다(예 320·375·390·768·1024·1280) `K.X(tab,'Emulation.setDeviceMetricsOverride',{width:w,height:844,deviceScaleFactor:(w<768?3:1),mobile:w<768})` → `K.wake` → `page.evaluate(()=>({iw:innerWidth, cw:document.documentElement.clientWidth, sw:document.documentElement.scrollWidth}))` + 넘치는 요소 → `K.img`. 끝나면 **반드시** `K.X(tab,'Emulation.clearDeviceMetricsOverride')`.
   - 🔴 `mobile:true` 에서 넓은 콘텐츠가 있으면 `innerWidth` 가 설정 폭보다 커진다 → **`iw > w` 또는 `sw > cw` 가 곧 가로 넘침 신호**.
   - 로그인 앱도 추가 요청 없음(iframe 방식보다 안전).
   - 터치 분기(`hover:none`·`pointer:coarse`): `Emulation.setTouchEmulationEnabled({enabled:true,maxTouchPoints:5})` → 끝나면 false.
3. **2순위(CDP 없음)**: 같은 출처 iframe 폭별(`kit/responsive-iframe.js`, iframe 안 `scrollbarWidth:'none'`·Dark Reader 잠금은 iframe 마다). XFO/`frame-ancestors` 로 막히면 srcdoc. 🔴 로그인 앱은 iframe 이 앱을 한 번 더 부팅(토큰 회전) — 개발 서버에서만, 요청 0 뒤 제거.

## 테마·미디어
- CDP: `K.X(tab,'Emulation.setEmulatedMedia',{media:'print'|'', features:[{name:'prefers-color-scheme',value:'dark'},{name:'prefers-reduced-motion',value:'reduce'}]})` → 끝나면 `{media:'',features:[]}`.
- CDP 없음: `kit/emu-lib.js`(`__emu` — mediaText 재작성 + `light-dark()`·color-scheme 고정, 교차 출처 시트 불가) — `try/finally` 로 복원.
- 첫 로딩에 등록된 앱의 `matchMedia` 리스너를 CDP 방식이 깨우는지는 **미실측**.
- 인쇄 미리보기: `page.pdf({paperWidth:8.27,paperHeight:11.69,printBackground:true})`(`format` 무시됨) → 서버에서 확인.

## 판정
폭마다 가로 넘침 0 · 잘림 0 · 메뉴/사이드바 전환이 설계대로 · 목표 크기 24px · 글자 12px 미만 없음 · 다크에서 대비 유지.

## 보고
폭별 표(`iw/cw/sw · 넘친 요소 · 분기 상태`) + 폭별 캡처 + 되돌림 확인.
