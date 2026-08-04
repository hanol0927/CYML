# distro-ci — Forge/NeoForge 로더 자동 생성 워크플로우

`tools/distro-builder`의 "GitHub Actions로 생성 시작" 버튼이 트리거하는 GitHub Actions
워크플로우입니다. Forge/NeoForge(1.13+)는 설치 과정에 실제 로컬 Java 바이트패치
단계가 있어서 브라우저에서 만들 수 없기 때문에, 여기서 대신
[NeoNebula](https://github.com/bayergg/NeoNebula)를 실행해줍니다.

## ⚠️ 실험적 기능

이 폴더의 워크플로우/스크립트는 **실제로 GitHub Actions에서 실행해서 검증하지
못했습니다.** NeoNebula 자체가 관리자도 "hacky and dirty"라고 표현하는 포크이고,
정확한 산출물 디렉터리 구조를 문서만으로 완전히 확인하지 못했습니다. 특히
`merge-server.js`의 `locateGeneratedDistribution()`/`urlToLocalPath()`가 가장
깨지기 쉬운 부분입니다. 처음 실행해서 실패하면:

1. Actions 탭에서 실패한 실행의 로그를 열어 `neonebula/` 안에 실제로 뭐가
   생성됐는지 확인하세요(`generate distro` 단계 로그, 이후 파일 목록).
2. `merge-server.js`의 경로 가정을 실제 구조에 맞게 고치세요.
3. 그래도 막히면 `tools/distro-builder`의 "Forge·NeoForge (JSON 직접
   붙여넣기)"로 우회할 수 있습니다 — 로컬에서 NeoNebula를 직접 실행해서 나온
   서버 JSON을 붙여넣으면 됩니다.

## 설정 방법

### 1. 새 저장소 만들기

이 `tools/distro-ci` 폴더 전체(`.github/workflows/generate-server.yml`,
`merge-server.js`)를 새 저장소(예: `hanol0927/distro-ci`)의 루트에 그대로
복사해서 커밋하세요. `.github/workflows/` 경로는 그대로 유지해야 GitHub가
워크플로우로 인식합니다.

### 2. 저장소 변수(Variables) 등록

새 저장소의 **Settings → Secrets and variables → Actions → Variables** 탭에서:

| 이름 | 값 예시 | 설명 |
|---|---|---|
| `OWNER` | `hanol0927` | GitHub 계정 |
| `DISTRO_REPO` | `ddumon` | distribution.json 저장소 |
| `ASSET_REPO` | `hanol0927.github.io` | 모드/라이브러리 파일이 올라갈 저장소 |
| `ASSET_BASE_URL` | `https://hanol0927.github.io` | 위 저장소가 서빙되는 주소 (끝에 슬래시 없이) |
| `DISTRO_BRANCH` | `main` | (선택) 기본값 main |

### 3. 저장소 시크릿(Secrets) 등록

같은 화면의 **Secrets** 탭에서:

| 이름 | 값 |
|---|---|
| `DISTRO_PAT` | `DISTRO_REPO`와 `ASSET_REPO` 양쪽에 **Contents: Read and write** 권한을 준 fine-grained PAT |

`tools/distro-builder/README.md`의 PAT 발급 방법을 그대로 따르되, 범위를 이 두
저장소로 잡으면 됩니다. 브라우저에 붙여넣는 토큰과는 별개로 발급하는 걸
권장합니다(이 토큰은 사람이 직접 보지 않고 Actions 시크릿에만 저장됨).

### 4. distro-builder 쪽 설정

`tools/distro-builder`의 "1. GitHub 연결 설정" 패널에서 "Forge·NeoForge 자동 생성
워크플로우 저장소"를 이 새 저장소 이름(예: `distro-ci`)으로 맞추세요. 워크플로우
파일명은 기본값(`generate-server.yml`) 그대로면 됩니다.

브라우저에서 쓰는 PAT(`tools/distro-builder`용)에는 **Actions: Read and write**
권한도 추가로 필요합니다 — 워크플로우를 트리거하고 상태를 조회하려면 필요합니다.

## 동작 흐름

1. `distro-builder`에서 서버 id / 마인크래프트 버전 / 로더 종류 / 로더 버전을
   입력하고 "GitHub Actions로 생성 시작" 클릭.
2. 이 저장소의 `generate-server.yml`이 `workflow_dispatch`로 트리거됨.
3. NeoNebula를 체크아웃 → Java/Node 설치 → 빌드 → `init root` → `generate
   server` (Forge/NeoForge 설치 프로그램을 실제로 로컬 Java로 실행, 여기서
   시간이 좀 걸림) → `generate distro`로 이번 실행 한정 distribution.json 조립.
4. `merge-server.js`가 그 결과에서 이 서버 하나만 꺼내서:
   - 참조하는 실제 파일들을 `ASSET_REPO`로 커밋
   - `DISTRO_REPO`의 `distribution.json`에 이 서버만 안전하게 upsert(다른
     서버, `distro-builder`가 관리하는 whitelist/background/icon/onceFiles/
     모드 모듈은 절대 안 건드림 — 로더 관련 모듈만 교체)
5. `distro-builder`가 실행 완료를 감지하면 자동으로 그 서버를 편집 화면에
   불러옵니다 — 이름/설명/화이트리스트/배경화면 등을 마저 채우고 평소처럼
   "GitHub에 배포"를 누르면 끝.
