# distribution.json 관리 도구

`distribution.json`을 손으로 편집하고 직접 올리는 대신, 브라우저에서 서버 정보 /
모드 / 설정파일 / 배경화면 / 화이트리스트를 입력하고 "배포" 버튼 한 번으로 자동
업로드되게 해주는 정적 웹 도구입니다. 백엔드 서버나 데이터베이스가 없고, 전부
`index.html` / `app.js` / `worker-api.js` / `github-api.js` / `md5.js` 정적 파일과
`tools/distro-worker`(Cloudflare Worker + R2) API 호출로만 동작합니다.

파일/`distribution.json` 저장은 더 이상 GitHub를 쓰지 않습니다 — GitHub Git Data API가
가진 ~25-30MB 실질 업로드 한도(base64 인코딩 오버헤드 때문) 때문에 `tools/distro-worker`
(Cloudflare Worker + R2)로 옮겼습니다. 자세한 배경과 이관 방법은
`tools/distro-worker/README.md`를 참고하세요.

## 이 도구가 하는 일

- 서버 메타데이터(이름/설명/아이콘/주소/버전), Java 요구 버전 자동 계산, 화이트리스트,
  배경화면·아이콘 파일 업로드(URL 자동 생성), 모드 jar 추가(버전 교체 지정 가능), 설정 파일
  추가("최초 1회만" vs "매번 강제 적용"), 기존 모드/설정 모듈 삭제.
- **로더(모드로더) 생성**: 새 서버를 만들 때
  - **Fabric**: 브라우저에서 완전 자동 생성 (Mojang/Fabric 공개 API가 CORS를 허용해서
    JVM 없이도 가능함을 확인함). 생성된 파일은 R2에 올라갑니다.
  - **Forge/NeoForge**: 브라우저에서는 원천적으로 불가능(설치 과정에 로컬 Java 바이트패치가
    필요하고 그 결과물이 공개 배포되지 않음). **이 부분만은 예전처럼 GitHub Actions를
    그대로 씁니다** — `tools/distro-ci`의 워크플로우가 NeoNebula를 실행해 로더 모듈을
    만들고, 결과물을 GitHub Pages 저장소(서버별로 별도, 예: `hanol0927/Ssachon`)에 올립니다
    (별도 저장소 설정 필요, `tools/distro-ci/README.md` 참고, **이 환경에서 실행 검증은
    못 해서 실험적**). 안 되면 로컬에서 NeoNebula를 한 번 돌리고 결과 JSON을 붙여넣는
    수동 경로도 그대로 남아있습니다.
    **⚠️ 로컬에서 NeoNebula를 직접 돌릴 때는 `.env`의 `BASE_URL`을 반드시 끝에 슬래시를
    붙여서 `https://<계정>.github.io/<이 워크플로우 전용 자산 저장소>/` 형태로 설정하세요.**
    슬래시가 없으면 NeoNebula가 URL을 합칠 때(WHATWG `new URL(relative, base)` 규칙)
    저장소 이름이 사라지고 내부 상수 `repo`로 대체되어, 붙여넣은 JSON의 `Library` 등
    로더 모듈이 `https://<계정>.github.io/repo/...`처럼 엉뚱한 경로를 가리키게 됩니다.
    **이전 버전과 달리 이 도구가 더 이상 이 문제를 자동으로 감지/보정해주지 않으므로
    (R2로 옮기면서 GitHub Pages 전용이던 그 로직을 제거함), 붙여넣기 전에 URL을 눈으로
    한 번 확인하세요.**
- 기존 서버 편집 중에는 로더 관련 모듈을 절대 재생성/덮어쓰지 않습니다 — 로더 갱신은 항상
  "새 서버 만들기" 흐름(자동 생성 또는 붙여넣기)으로만 이루어집니다.

## 저장소 구조 (중요)

`distribution.json`과 모드/설정파일/배경화면/아이콘 같은 실제 파일은 전부
**Cloudflare Worker 뒤의 R2 버킷 하나**에 저장됩니다. GitHub 시절처럼 서버마다 별도
저장소를 만들 필요가 없습니다 — `servers/<서버id>/...` 경로만으로 서버별 파일이 구분됩니다.

예외는 Forge/NeoForge 자동 생성(GitHub Actions) 흐름뿐입니다. 이건 여전히 GitHub Pages
저장소(서버마다 별도, 예: `hanol0927/Ssachon`)를 대상으로 동작하고, "3-1. 로더" 섹션의
**"GitHub 자산 저장소"** 칸에 그 흐름 전용으로만 입력합니다 — R2에는 전혀 영향이 없습니다.

## 처음 설정하기

### 1. Cloudflare Worker 배포 (아직 안 했다면)

`tools/distro-worker/README.md`의 안내대로 Worker를 배포하고 `UPLOAD_SECRET`을
설정해두세요. 이 도구를 쓰려면 그 Worker의 기본 URL과 업로드 시크릿이 필요합니다.

### 2. 이 도구 접속 후 최초 설정

1. 페이지를 열면 "1. Cloudflare Worker 연결 설정" 패널이 보입니다.
2. Worker 기본 URL과 업로드 시크릿(`wrangler secret put UPLOAD_SECRET`에서 설정한 값)을
   입력합니다.
3. "설정 저장"을 누르면 Worker URL은 `localStorage`에, 시크릿은 선택에 따라
   `localStorage`(브라우저 재시작 후에도 유지) 또는 `sessionStorage`(탭을 닫으면 삭제)에
   저장됩니다.
4. Forge/NeoForge 자동 생성(GitHub Actions) 기능을 쓸 계획이라면 "1-1. Forge·NeoForge
   자동 생성" 패널도 채웁니다 — GitHub PAT 발급은 아래 참고.

### 3. (선택) Forge/NeoForge 자동 생성용 GitHub PAT 발급

이 기능을 안 쓴다면(Fabric만 쓰거나 항상 수동 붙여넣기로 처리한다면) 건너뛰어도 됩니다.

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token
2. **Repository access**: `tools/distro-ci` 설정 시 만든 워크플로우 저장소를 선택합니다.
3. **Permissions** → Repository permissions → **Actions: Read and write**를 체크합니다.
4. 만료 기간을 짧게(예: 90일) 설정해두고, 만료되면 다시 발급하는 걸 권장합니다.
5. 생성된 토큰(`github_pat_...`)을 "1-1. Forge·NeoForge 자동 생성" 패널에 붙여넣습니다.
   **이 토큰은 워크플로우 실행 권한이므로 다른 사람과 공유하지 마세요.**

### 4. 이 도구 호스팅

정적 파일이므로 아무 정적 호스팅에 올려도 됩니다.

- **옵션 A (권장)**: 이 launcher 저장소(`CYML`) 자체에서 GitHub Pages를 켭니다 (Settings →
  Pages → Deploy from branch). `tools/distro-builder/index.html`이
  `https://hanol0927.github.io/CYML/tools/distro-builder/`로 서빙됩니다. (이 도구 자체를
  호스팅하는 것과, 이 도구가 다루는 데이터를 R2에 저장하는 것은 별개입니다.)
- **옵션 B (로컬 테스트용)**: 로컬에서 `npx serve tools/distro-builder` 등으로 정적 서버를
  띄워 브라우저로 열어도 동일하게 동작합니다 (Worker/GitHub API는 인터넷에서 직접
  호출하므로 로컬 실행도 문제 없습니다).

## 시크릿/토큰 보안 관련 주의사항

- 업로드 시크릿과 GitHub 토큰은 이 페이지의 브라우저 저장소에만 남아있고, 이 도구 코드
  외에는 어디로도 전송되지 않습니다. 이 도구가 외부 CDN 스크립트를 전혀 불러오지 않는
  것도 같은 이유입니다(전부 로컬 파일).
- 그래도 이 페이지에서 실행되는 어떤 스크립트든 이론적으로 `localStorage`를 읽을 수 있으므로,
  업로드 시크릿이 유출되면 즉시 `wrangler secret put UPLOAD_SECRET`으로 값을 바꾸세요.
  GitHub PAT도 fine-grained + 짧은 만료기간을 지켜주세요.
- 다 쓴 뒤 공용 컴퓨터라면 "기억하기" 체크를 해제하고 쓰거나, 설정 패널에서 입력칸을
  비우고 다시 저장하면 삭제됩니다.

## 사용 흐름

1. "2. 서버 선택"에서 기존 서버를 고르면 폼이 자동으로 채워지고, "새 서버 만들기"를 고르면
   빈 폼으로 시작합니다.
2. 서버 정보, 화이트리스트(비우면 전체 허용), 배경화면(선택), 모드/설정 파일을 채웁니다.
3. Java 요구 버전은 마인크래프트 버전을 입력하면 자동으로 채워집니다. 특수한 경우에만
   "수동으로 지정"을 체크하세요.
4. 기존 서버를 수정 중이라면 "9. 기존 모듈" 목록에서 삭제하고 싶은 모드/설정 파일만 체크하세요.
   **로더/라이브러리 관련 핵심 모듈은 절대 체크하지 마세요** — 지우면 그 서버가 아예 실행이
   안 됩니다. 로더 버전을 올리거나 잘못된 경로로 들어간 로더/라이브러리 모듈을 고쳐야 한다면,
   "3-1. 로더" 섹션의 **"로더/라이브러리 모듈을 새로 교체합니다"** 체크박스를 켜고 새로
   생성하거나 붙여넣으세요 — 켜면 배포 시 기존 로더 소유 모듈(Fabric/Forge/Library 등)만
   전부 지워지고 새로 만든 것으로 교체됩니다(모드/설정/화이트리스트 등 나머지는 그대로 유지).
   체크하지 않으면 기존 로더 모듈은 지금처럼 절대 건드리지 않습니다.
5. "Worker에 배포"를 누르면: 새로 추가한 파일들을 R2에 업로드 → `distribution.json`을
   다시 불러와 병합(ETag 기반 동시 편집 충돌 감지) → 업로드, 순서로 진행됩니다. 진행 로그가
   화면 하단에 실시간으로 표시됩니다.

## 알아두면 좋은 제한사항

- **파일 크기**: Cloudflare Workers 요청 본문 한도(요금제에 따라 다르며 Free/Pro는
  100MiB 내외)까지 업로드할 수 있습니다 — GitHub API를 쓰던 시절의 25~30MB 한도보다
  훨씬 넉넉합니다. 90MB 넘는 파일을 추가하면 안전 마진 경고가 표시됩니다. 그보다도 큰
  파일이 필요하면 `tools/distro-worker`의 R2 멀티파트 업로드 지원이 필요한데, 아직
  구현되어 있지 않습니다.
- **동시 편집**: 이 도구는 배포 직전에 `distribution.json`을 다시 불러와 병합하고, Worker
  쪽에서 R2의 조건부 쓰기(`If-Match`/ETag)로 동시 편집 충돌을 감지해 412로 막아줍니다.
  그래도 완전한 잠금은 아니므로 한 번에 한 사람만 배포하는 걸 권장합니다.
- **MD5 해시**: `artifact.MD5` 계산은 이 도구에 내장된 순수 JS MD5 구현(`md5.js`)으로
  브라우저에서 직접 계산합니다. 처음 몇 번은 `certutil -hashfile <파일> MD5`(Windows) 같은
  외부 도구로 나온 값과 한 번 대조해보는 걸 권장합니다.
- **Forge/NeoForge 자동 생성 붙여넣기**: 위 "이 도구가 하는 일" 섹션에 적은 대로, NeoNebula
  BASE_URL 슬래시 버그에 대한 자동 감지/보정 로직이 더 이상 없습니다 — 붙여넣기 전에
  URL을 눈으로 확인하세요.
