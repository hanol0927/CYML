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

1. Actions 탭에서 실패한 실행의 로그를 열어보세요 — `locateGeneratedDistribution()`이
   후보 경로를 못 찾으면 ROOT 아래 전체 파일 트리를 그 실행의 로그에 그대로
   찍어주므로, 재실행 없이 그 로그만 보고 실제 구조를 바로 확인할 수 있습니다.
2. `merge-server.js`의 `locateGeneratedDistribution()`/`urlToLocalPath()` 경로
   가정을 그 로그에 맞게 고치세요.
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
| `WORKER_BASE_URL` | `https://cyml-distro-worker.chaenna02.workers.dev` | `tools/distro-builder`가 쓰는 것과 동일한 distro-worker 주소 (끝에 슬래시 없이) |

생성된 로더 모듈과 실제 바이너리 파일은 모두 이 Worker(R2 버킷 하나)의
`servers/<서버id>/forge/` 아래로 올라갑니다 — `tools/distro-builder`가 모드/설정
파일을 올릴 때와 동일한 저장소라, 서버마다 별도 GitHub Pages 저장소를 만들
필요가 없습니다.

### 3. 저장소 시크릿(Secrets) 등록

같은 화면의 **Secrets** 탭에서:

| 이름 | 값 |
|---|---|
| `WORKER_UPLOAD_SECRET` | distro-worker에 `wrangler secret put UPLOAD_SECRET`으로 설정한 값과 동일한 값 (`tools/distro-builder`에서 "업로드 시크릿"으로 브라우저에 입력하는 것과 같은 값) |

이 토큰은 사람이 직접 보지 않고 Actions 시크릿에만 저장됩니다 — 브라우저에
붙여넣는 값과 같아도 되고, 별도로 발급해도 됩니다(Worker 쪽에서 시크릿을
회전시키면 여기도 같이 바꿔야 함).

### 4. distro-builder 쪽 설정

`tools/distro-builder`의 "1-1. Forge·NeoForge 자동 생성 (GitHub Actions, 선택)"
패널에서 워크플로우 저장소를 이 새 저장소 이름(예: `distro-ci`)으로 맞추세요.
워크플로우 파일명은 기본값(`generate-server.yml`) 그대로면 됩니다.

브라우저에서 쓰는 PAT(`tools/distro-builder`용)에는 **Actions: Read and write**
권한도 추가로 필요합니다 — 워크플로우를 트리거하고 상태를 조회하려면 필요합니다.

## 동작 흐름

1. `distro-builder`의 "3. 서버 정보"에서 서버 id / 마인크래프트 버전을 채우고,
   로더 선택에서 Forge·NeoForge 자동 생성을 고른 뒤 로더 종류/버전을 입력하고
   "GitHub Actions로 생성 시작" 클릭.
2. 이 저장소의 `generate-server.yml`이 `workflow_dispatch`로 트리거됨.
3. NeoNebula를 체크아웃 → Java/Node 설치 → 빌드 → `init root` → `generate
   server` (Forge/NeoForge 설치 프로그램을 실제로 로컬 Java로 실행, 여기서
   시간이 좀 걸림) → `generate distro`로 이번 실행 한정 distribution.json 조립.
   이때 NeoNebula의 `BASE_URL`은 `<WORKER_BASE_URL>/files/servers/<서버id>/forge/`로
   설정되어, 생성되는 모듈들의 `artifact.url`이 처음부터 distro-worker의 올바른
   경로를 가리킴.
4. `merge-server.js`가 그 결과에서 이 서버 하나만 꺼내서:
   - 참조하는 실제 파일들을 distro-worker(R2)에 업로드
   - distro-worker의 `distribution.json`에 이 서버만 안전하게 upsert(다른
     서버, `distro-builder`가 관리하는 whitelist/background/icon/onceFiles/
     모드 모듈은 절대 안 건드림 — 로더 관련 모듈만 교체)
5. `distro-builder`가 실행 완료를 감지하면 자동으로 그 서버를 편집 화면에
   불러옵니다 — 이름/설명/화이트리스트/배경화면 등을 마저 채우고 평소처럼
   "Worker에 배포"를 누르면 끝.
