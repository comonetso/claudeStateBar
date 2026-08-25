# 2026-06-09 세션 로그 part2 — VS Code Marketplace 첫 등록 + CI 자동화 완성

> **세션 성격**: publisher 등록 → VSIX 수동 업로드 → Azure DevOps PAT 발급 → GitHub Secret 등록 → CI 자동화 완성
> **컨텍스트 시작**: 이전 세션(part1) 컴팩션 후 이어받음. vault/hot.md 갱신 + 프로젝트 커밋+태그+push까지 완료된 상태.
> **컨텍스트 종료**: 정상 종료 (사용자 완전종료)
> **모드**: 완전종료
> **커밋 범위**: 없음 (코드 변경 없음 — 마켓플레이스 등록 작업만)

---

## 1. 작업 흐름 (시간순)

### 1-1. VS Code Marketplace publisher 등록
**배경**: `blueming.claude-state-bar` 식별자로 배포하려면 `blueming` publisher가 먼저 등록돼야 함.
**처리**: `marketplace.visualstudio.com/manage/createpublisher` 접속 → publisher ID=`Blueming`, Description 입력, Create.
**결과**: Blueming (Blueming) publisher 생성 완료.
**함정**: 처음에 500 에러 발생 → 마켓플레이스 메인에서 계정 클릭 시 서버 오류. 직접 URL로 우회.

### 1-2. VSIX 수동 업로드
**배경**: CI 자동화 전에 첫 배포를 수동으로 진행.
**처리**: 마켓플레이스 관리 페이지 → `+ New extension` → VSIX 파일 직접 업로드.
**결과**: Claude State Bar v1.7.26 등록. 처음엔 "Verifying..." 상태 → 수분 내 Public으로 전환.
**발견**: 마켓플레이스 배포에 GitHub 리포지토리 연결·도메인 인증·PAT 불필요. VSIX만 올리면 끝.

### 1-3. Azure DevOps PAT 발급
**배경**: CI 자동 publish를 위해 `vsce publish` 명령에 필요한 PAT 발급.
**시행착오**: 
  - `dev.azure.com` 로그인 → Azure Portal로 리디렉션됨 → PAT 항목 없음
  - 조직 생성 화면(Almost done...)에서 Continue 버튼 무반응
  - `dev.azure.com/yeogiaen/_usersSettings/tokens` → 404
  - **해결**: `aex.dev.azure.com/me`에서 기존 조직 `comonet.visualstudio.com` 발견
**처리**: `dev.azure.com/comonet/_usersSettings/tokens` → New Token → Name=`vsce-blueming`, Organization=All accessible organizations, Expiration=1 year, Scopes=Marketplace→Manage → Create.
**결과**: PAT 발급 성공.

### 1-4. GitHub Secret 등록
**처리**: `github.com/comonetso/claudeStateBar` → Settings → Secrets and variables → Actions → New repository secret → `VSCE_PAT` = 발급한 PAT.
**결과**: Repository secret 등록 완료. CI Actions가 다음 태그 push 시 자동 publish 가능.

---

## 2. 의사결정 로그

| # | 결정 | 근거 | 검토한 대안 | 트레이드오프 |
|---|---|---|---|---|
| 1 | VSIX 수동 업로드로 첫 배포 | PAT 발급 전에 이미 VSIX가 준비됐고, 수동 업로드가 더 빠름 | CI 자동 publish 대기 | 없음 (수동도 유효한 방법) |
| 2 | 리포지토리 Public 유지 | Actions 무료 무제한 + 마켓 신뢰도 향상 | Private | 소스코드 공개 (오픈소스로 수용) |

---

## 3. 시행착오 / 사이드퀘스트

### 3-1. dev.azure.com 로그인 → Azure Portal 리디렉션
- **잘못된 가정**: dev.azure.com 로그인하면 DevOps 대시보드로 간다고 가정.
- **실제**: Azure 구독 없으면 Azure Portal로 리디렉션됨. PAT 항목 없음.
- **해결**: `aex.dev.azure.com/me`로 프로필 페이지 직접 접근 → 기존 조직 `comonet` 발견.
- **교훈**: DevOps 첫 접근 시 `aex.dev.azure.com/me` 먼저 확인.

### 3-2. 조직 생성 화면 Continue 버튼 무반응
- **원인 추정**: 조직 이름 중복 or Azure 구독 없음 경고로 인한 JS 오류.
- **교훈**: 버튼이 안 눌리면 오류 메시지 없이 무반응할 수 있음. `aex.dev.azure.com/me`에서 이미 조직이 있는지 먼저 확인.

### 3-3. 마켓플레이스 500 에러
- **상황**: 마켓플레이스 메인에서 계정 아이콘 클릭 → 500 에러.
- **해결**: `marketplace.visualstudio.com/manage/createpublisher` 직접 URL 입력으로 우회.

---

## 4. 발견한 함정 (휘발 방지)

- **마켓플레이스 배포 = VSIX만**: repository 연결·도메인 인증·PAT 전부 선택사항. VSIX 업로드만으로 배포 가능.
- **Azure DevOps 기존 조직 확인**: `aex.dev.azure.com/me` → Organizations 섹션에 기존 조직 목록 표시. 새 조직 만들기 전 반드시 확인.
- **PAT 한 번만 보임**: 생성 직후 복사 안 하면 영구 소실. 창 닫기 전 반드시 복사.
- **PAT 만료 1년**: Microsoft가 만료 30일 전 이메일 발송. 만료 시 각 리포 Secret 재등록 필요.
- **조직 secrets로 다수 리포 일괄 관리**: GitHub Organization 사용 시 PAT Secret 한 번만 등록하면 하위 리포 전체 적용.

---

## 5. 사용자 핵심 발언

- > "아니, 무슨 수정하고 그런 거... 리포지토리 이런 거 등록하고 그럴 필요도 없이 그냥 VSIX만 등록하면 끝인 거야?"
  - 맥락: VSIX 수동 업로드 후 마켓에 등록됨을 확인하고 발언.
  - 적용: 마켓플레이스 배포는 VSIX 업로드만 필수. 나머지(CI, PAT, repo 연결)는 편의 기능.

---

## 6. 검증 매트릭스

| 항목 | 완료 | 검증 |
|---|---|---|
| blueming publisher 등록 | ✅ | 마켓플레이스 관리 페이지 확인 |
| Claude State Bar v1.7.26 마켓 등록 | ✅ | 마켓플레이스 Extensions 목록 확인 |
| Azure DevOps PAT 발급 | ✅ | Success! 팝업 확인 |
| GitHub Secret VSCE_PAT 등록 | ✅ | "repository secret added" 확인 |
| CI 자동 publish 테스트 | ❌ | 다음 태그 push 시 검증 필요 |

---

## 7. 외부 의존 보드

없음.

---

## 8. 변경 파일 인벤토리

없음 (코드 변경 없음 — 마켓플레이스·Azure DevOps·GitHub 외부 시스템 설정만).

---

## 9. 미해결 항목

### 9-1. 즉시 처리 필요
- 없음

### 9-2. 검증 미완
- CI 자동 publish 동작 확인: 다음 `git tag v1.x.x && git push origin v1.x.x` 시 마켓플레이스 자동 업로드 여부

### 9-3. 별도 트랙
- PAT 만료일 2027-06-09 — 만료 30일 전 Microsoft 이메일 오면 재발급 + GitHub Secret 갱신
- 향후 VS Code 확장 다수 배포 시 GitHub Organization 고려 (현재 1개라 불필요)

---

## 10. 이어받기 포인트

```
- 다음 한 줄 액션: 다음 버전 개발 후 git tag + push → CI 자동 publish 검증
- 현재 상태: Claude State Bar v1.7.26 마켓플레이스 공개 완료
- CI: VSCE_PAT 등록 완료. 다음 태그 push 시 자동 publish 예상
- 주의: PAT 만료 2027-06-09 (1년)
```

---

## 11. 컨텍스트 메타

- **종료 사유**: 정상 종료 (사용자 완전종료)
- **중단 시점**: 없음
- **미완성 상태**: 없음
- **다음 세션 시작 시 주의**: 없음. 깨끗한 상태.
