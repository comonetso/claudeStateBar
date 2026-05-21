# 2026-05-21 세션 로그 part2 — Remote-SSH에서 플랜+토큰 동시 표시 (v1.7.0)

> **세션 성격**: 원격 "Session Key 만료" 오진 진단 → curl-impersonate 번들 시도 → AWS IP 차단 발견(우회 폐기) → 사용자 아이디어(로컬 수집→원격) PoC 검증 → UI 확장 + vscode.workspace.fs 전면 리팩토링 → v1.7.0 + 툴팁 색 구분 + README 영문/한글 + 포크/제작자 명시
> **컨텍스트 시작**: 2026-05-21 part1(v1.6.0 완전종료) 이어받기. 원격 서버에 확장 설치 후 같은 sessionKey가 "만료"로 뜨는 문제 제보
> **컨텍스트 종료**: 정상 종료 (사용자 /finish 푸시까지 요청)
> **모드**: 완전종료
> **커밋 범위**: 이 세션에서 feat(v1.7.0) 1커밋 예정

---

## 1. 작업 흐름 (시간순)

### 1-1. 원격 "Session Key 만료" 오진 진단
**배경**: 로컬에선 잘 되는데 원격 서버(Remote-SSH)에 확장 설치 후 같은 키를 넣으면 "⚠ Session Key 만료" 표시
**처리**: [planUsage.ts](src/planUsage.ts) 분석. 원격 확장 호스트는 순수 Node → `electron.net` 없음 → `https` 폴백 → Cloudflare 403 → 코드가 401/403을 무조건 AuthExpiredError로 처리. 로컬 Node로 claude.ai 직접 요청해 재현: `403 server:cloudflare cf-mitigated:challenge "Just a moment"` 확인
**결과**: 키 만료가 아니라 Cloudflare 봇 차단. 오진 수정 — `CloudflareBlockedError` + `isCloudflareChallenge()`로 분리, 정직한 "차단" 메시지 추가

### 1-2. curl-impersonate 번들 시도 (실패로 판명)
**요구사항**: 사용자 "최대한 신경 안 쓰이게(=안정적으로 그냥 되게)"
**처리**: 무의존 우회(Node http2 + Chrome cipher) 로컬 테스트 → 여전히 403(managed challenge). Node OpenSSL은 JA3/GREASE 재현 불가 확인. → linux-x64 `curl-impersonate-chrome`(4.4MB) 번들, transport: electron→curl→https. 실행 비트 런타임 chmod
**결과**: 원격 설치 후 `transport=curl`인데도 **여전히 403**

### 1-3. ★ AWS IP 평판 차단 발견 (핵심 전환점)
**처리**: 원격에서 `ipinfo.io` + 바이너리 자체 프리셋 테스트. AWS EC2(`org: Amazon.com`)=403, 가비아 2대(`LG DACOM`)=000(연결 실패). 로컬 Schannel curl은 400(통과)인데 원격 Chrome 핑거프린트가 막힘 → **TLS가 아니라 출구 IP 평판이 원인** 확정
**결과**: 클라우드/데이터센터 IP는 TLS 우회로 못 뚫음. curl-impersonate 바이너리 **제거**, 오진수정만 유지(=1.6.1 산출물)

### 1-4. ★ 사용자 아이디어 → PoC 검증
**배경**: 사용자 "어차피 로컬에서 VS Code가 돌잖아? 로컬에서 수집해 원격에 보내면?"
**처리**: VS Code UI(로컬) 확장이 `vscode.workspace.fs`로 원격 파일을 읽을 수 있는지가 관건. `extensionKind:["ui"]` + activate 자동 probe 빌드(poc2) 제작 → 사용자가 원격 설치
**결과**: probe 로그 `✅ read vscode-remote://.../root/.claude/projects → 2 entries`(원격 세션 디렉토리 존재) + `[plan] ok transport=electron`. **둘 다 성립 확정**

### 1-5. 본구현 — 파일 접근 전면 비동기/Uri 전환 (v1.7.0)
**처리**: [extension.ts](src/extension.ts) 동기 `fs.*Sync` 12곳+ → `vscode.workspace.fs`(async). `getClaudeBaseUri()`(원격 홈 `/root`→`/home/*` 탐색 + 캐시), `getClaudeProjectsUri()`, `readTextFile()` 헬퍼. `getLatestTokenCount(Uri)`, `findActiveSessions`/`getGlobalEffortLevel` async화. `fs.watch`→`createFileSystemWatcher`(RelativePattern, 원격대응). `fileWatcher` 제거, 워크스페이스 변경 시 캐시 reset. `import fs` 제거. `extensionKind:["ui"]`
**결과**: 컴파일 통과. 실기기 검증 성공 — 원격 세션 토큰(35K/402K) + 플랜(30%/20%) 한 창에 동시 표시

### 1-6. 툴팁 claudeState/claudeContext 색 구분
**요구사항**: 위 구분선 아래 claudeState(플랜), 아래 구분선 아래 claudeContext(컨텍스트) 명시 구분, 색상 임의
**처리**: `sectionHeader(label,color)` + `MarkdownString.supportHtml`. claudeState=#4FC3F7(파랑), claudeContext=#AED581(초록). 후속: `Opus`가 null이면 숨김(claude.ai 미제공), Sonnet/Opus 줄에 🧩 아이콘
**결과**: 실기기 확인 — 색 구분선 정상

### 1-7. README 갱신 + 포크/제작자 명시
**처리**: [README.md](README.md) 전면 재작성(2계층/Remote-SSH/툴팁/설정/텔레그램), [README.ko.md](README.ko.md) 한글 신규. 포크 안내(원작 ezoosk/Ed Zisk → Blueming 확장). package.json `author`=Blueming, `contributors`=Ed Zisk, description에 Remote-SSH
**결과**: 컴파일·패키징 통과

---

## 2. 의사결정 로그 ★

| # | 결정 | 근거 | 검토한 대안 | 트레이드오프 |
|---|---|---|---|---|
| 1 | 403 Cloudflare를 auth_expired와 분리 | 키 만료 오인 방지, 어느 환경이든 옳음 | 그대로 둠 | 없음(순이득) |
| 2 | curl-impersonate 번들 → **제거** | AWS=403/가비아=000 실측, 모든 원격에서 무효 | 유지(다른 residential 원격 대비) | 제거가 맞음(4.4MB 무의미) |
| 3 | extensionKind:["ui"]로 전환 | 플랜은 로컬 electron(Cloudflare 통과) + 토큰은 workspace.fs 원격 라우팅 | workspace 유지(원격은 플랜 포기) / 외부채널 중계(배관 필요) | 로컬 실행이라 fs 전면 async 리팩토링 필요 |
| 4 | 파일접근 전부 vscode.workspace.fs로 통일 | file·원격 둘 다 지원, 분기 최소화 | 로컬/원격 fs 분기 | 동기→비동기 호출체인 파급 |
| 5 | 원격 홈 `/root`→`/home/*` 탐색 | SSH 사용자 계정이 환경마다 다름(root/ec2-user 등) | 워크스페이스 경로로 추론(불가) | /home 순회 1회 부하(캐시로 완화) |
| 6 | author=Blueming, contributors=Ed Zisk | 제작자 명시 + 원작 크레딧 유지 | author 원작자 유지 | 식별자/설정키는 호환 위해 ezoosk/claudeContextBar.* 유지 |

---

## 3. 시행착오 / 사이드퀘스트 ★

- **잘못된 가정 1**: "원격 = 환경이 Node라 electron 없음" 까지는 맞았으나, curl-impersonate(Chrome 핑거프린트)면 통과할 줄 알았다.
  - **발견**: 원격 `transport=curl`인데도 403. ipinfo로 AWS EC2 확인 + 로컬 Schannel은 400(통과) 대조.
  - **복구**: 원인을 TLS→IP 평판으로 재특정. 바이너리 제거.
  - **교훈**: claude.ai Cloudflare 403은 ① TLS 핑거프린트 ② **출구 IP 평판** 두 층. 클라우드/데이터센터 IP는 핑거프린트 우회로 못 뚫는다.
- **잘못된 가정 2**: "단일 확장은 한 호스트에서만 도니 로컬 수집→원격 표시는 불가" 라고 처음 판단.
  - **발견**: 사용자가 "VS Code가 로컬에서 돌잖아" 지적 → UI 확장 + `vscode.workspace.fs` 원격 라우팅이라는 길 확인.
  - **교훈**: UI(로컬) 확장도 `vscode.workspace.fs`로 **원격 워크스페이스 밖 경로(홈)**까지 읽을 수 있다(같은 authority).

---

## 4. 발견한 코드베이스 함정 ★

- **claude.ai Cloudflare 2층 차단**: TLS 핑거프린트(Node https 403) + IP 평판(AWS EC2 403, curl-impersonate도 무력). 가비아는 000(연결 실패, 별개 원인).
- **VS Code UI 확장 + 원격 fs**: `extensionKind:["ui"]`면 로컬(Electron) 실행 → 네트워크는 로컬 IP. 동시에 `vscode.workspace.fs.readDirectory/stat/readFile`로 `vscode-remote://authority/<remote-home>/.claude` 읽기 가능(VS Code가 SSH로 라우팅). 워크스페이스 폴더 밖(홈)도 같은 authority면 읽힘.
- **원격 워크스페이스 fsPath**: 로컬 Windows UI 확장에서 원격 uri.fsPath가 백슬래시(`\hosting\...`)로 나옴 → `encodeWorkspacePath`가 `\`,`/` 모두 `-`로 처리해 정상 매칭(`-hosting-sported-docs-api-sported-new`).
- **FileStat.mtime**은 number(ms epoch) → 기존 Date 로직 위해 `new Date(stat.mtime)`로 감쌌다.
- **MarkdownString 색상**: `supportHtml=true` + `<span style="color:#...">`로 툴팁 색 입힘(실기기 확인됨).
- **claude.ai usage**: `seven_day_opus`가 null이면 Opus 미표시가 정답(클라가 "—%" 찍으면 안 됨).

---

## 5. 사용자 핵심 발언 박제 ★

- > "어차피 VS Code 확장이니까 VS Code가 실행될 거 아니야? 로컬에서 수집해서 그쪽으로 보내주는 방법은?"
  - 맥락: 원격 IP 차단으로 우회 불가 결론 직후
  - 적용: 막다른 길에서 사용자의 환경 직관(어디서 코드가 실제로 도는가)을 진지하게 검증할 것. → UI 확장 해법의 단초
- > "질문하지 말고 무중단으로 완료까지 해. 완벽하게."
  - 맥락: 큰 리팩토링 착수 직전, 자리 비움
  - 적용: 큰 방향 컨펌 후엔 세부 컨펌 없이 끝까지. 단 실기기 검증 의존 지점은 명시.
- > "claudeState / claudeContext 이렇게 명시적으로 구분 가능하게"
  - 맥락: 통합 툴팁이 한 덩어리로 보일 때
  - 적용: 한 화면에 두 도메인이 섞이면 구분선+라벨(+색)로 시각 분리

---

## 6. 검증 매트릭스 ★

| 변경 항목 | 컴파일 | 패키징 | 실기기(원격) |
|---|---|---|---|
| 오진 수정(만료↔차단 분리) | ✅ | ✅ | ✅ (원격서 정직 메시지 확인) |
| UI 확장 + workspace.fs 원격 토큰 | ✅ | ✅ | ✅ (35K/402K 표시) |
| 플랜 로컬 electron | ✅ | ✅ | ✅ (30%/20%) |
| 툴팁 색 구분선 | ✅ | ✅ | ✅ (파랑/초록 확인) |
| Opus null 숨김 + Sonnet 🧩 | ✅ | ✅ | ❌ 미확인(재설치 필요) |
| README 영문/한글 | — | ✅(포함) | — |

---

## 7. 외부 의존 보드 ★

| 상태 | 항목 | 비고 |
|---|---|---|
| 진행 | GitHub remote edenaion → comonetso/claudeStateBar 전환 + push | 이 세션에서 처리(사용자 PAT 제공) |
| 경고 | 사용자 PAT가 채팅에 노출됨 | push 후 즉시 폐기/재발급 권고 |

---

## 8. 변경 파일 인벤토리

```
M src/planUsage.ts     [CloudflareBlockedError + isCloudflareChallenge 분리, curl 코드는 추가했다 제거(electron→https로 환원)]
M src/extension.ts     [fs→vscode.workspace.fs 전면 async, getClaudeBaseUri 원격홈 탐색, watcher 교체, extensionKind ui, 툴팁 색 구분 + Opus null 숨김 + 🧩]
M src/i18n.ts          [sb.blocked / sb.tooltip.blocked (EN/KO)]
M package.json         [v1.7.0, extensionKind:["ui"], author=Blueming, contributors=Ed Zisk, description Remote-SSH]
M README.md            [전면 재작성: 2계층/Remote-SSH/툴팁/설정/포크 명시]
A README.ko.md         [한글 README 신규]
M CHANGELOG.md         [1.6.0/1.6.1/1.7.0 항목]
A docs/session_logs/2026-05-21_work_log_part2.md [이 로그]
```

---

## 9. 미해결 항목

### 9-1. 즉시 처리 필요
- 없음 (핵심 기능 실기기 검증 완료)

### 9-2. 검증 미완
- Opus null 숨김 + Sonnet 🧩 아이콘: vsix 재설치 화면 미확인 (기능은 단순)
- 마켓 publish(v1.7.0 태그) — CI는 v* 태그 푸시 시 동작. 단 publisher=ezoosk PAT 필요(별개)

### 9-3. 별도 트랙
- `getLatestTokenCount` 본문 들여쓰기 한 단계 깊게 남음(기능 무관, 미용)
- root 아닌 계정으로 Claude Code 돌리는 서버: `/home/*` 폴백 실검증 안 됨
- 다중 원격 워크스페이스(폴더 여러 authority) 시 baseUri는 첫 폴더 기준 — 엣지 케이스

---

## 10. 이어받기 포인트 ★

```
- 현재 버전: v1.7.0 (package.json), extensionKind:["ui"]
- 빌드 상태: 컴파일·패키징 통과, claude-context-bar-1.7.0.vsix 생성
- 핵심: Remote-SSH에서 플랜(로컬 electron)+토큰(원격 workspace.fs) 동시. 실기기 검증됨
- 원격 홈 해석: getClaudeBaseUri() /root→/home/* 탐색
- 다음 한 줄 액션: (선택) v1.7.0 태그 push로 마켓 publish, 또는 Opus 표시 재확인
- 주의: 식별자(ezoosk.claude-context-bar)·설정키(claudeContextBar.*)는 호환 위해 유지. remote는 comonetso/claudeStateBar로 전환
```

---

## 11. 컨텍스트 메타 ★

- **종료 사유**: 정상 종료 (사용자 /finish 푸시까지 요청)
- **중단 시점**: README/툴팁 마무리 + 새 GitHub repo로 push 단계
- **미완성 상태**: 없음 (기능 완성, 문서 완성)
- **다음 세션 시작 시 주의**: remote가 comonetso/claudeStateBar로 바뀜. PAT는 폐기됐을 것(재발급 필요). vault에 Cloudflare-IP-차단 / UI확장-원격fs 노하우 박제됨
