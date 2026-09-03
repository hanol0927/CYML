# distro-worker (Cloudflare Worker + R2)

`distribution.json`과 서버 자산 파일(모드/설정/배경/아이콘/로더 JSON)을 서빙·업로드하는
Cloudflare Worker다. `tools/distro-builder`가 예전에 쓰던 GitHub REST API를 대체한다 —
GitHub의 Git Data API(base64-in-JSON)는 ~25-30MB가 넘는 파일 업로드가 실패했지만, 여기서는
요청 본문을 그대로 R2에 스트리밍하므로 Cloudflare Workers의 요청 본문 한도(Free/Pro
100MiB)까지 문제없이 올라간다.

## 구성

- `src/worker.js` — Worker 본체. 라우트:
  - `GET /distribution.json` — 공개, 인증 불필요
  - `PUT /distribution.json` — `Authorization: Bearer <UPLOAD_SECRET>` 필요. `If-Match`
    헤더를 보내면 R2의 조건부 쓰기로 동시 편집 충돌을 412로 감지한다.
  - `GET /files/<path>` — 공개, R2 오브젝트를 그대로 스트리밍
  - `PUT /files/<path>` — `Authorization: Bearer <UPLOAD_SECRET>` 필요, 요청 본문을
    그대로 R2에 스트리밍 (base64 인코딩 없음)

  (`/assets/<path>`가 아니라 `/files/<path>`인 이유: Cloudflare workers.dev 엣지가
  `/assets`를 예약 경로로 취급해서 Worker 코드에 도달하기 전에 1042 오류로 막습니다 —
  실제 배포 후 확인된 동작입니다.)
- `migrate.js` — 기존 GitHub(`ddumon` + 서버별 자산 저장소)의 `distribution.json`과 참조
  파일들을 이 Worker의 R2 버킷으로 1회 복사하는 스크립트. GitHub 쪽은 읽기만 하고 절대
  건드리지 않는다.

## 처음 설정하기

```bash
cd tools/distro-worker
npm install                      # wrangler만 devDependency로 설치됨
npx wrangler login                # 브라우저로 Cloudflare 계정 인증
npx wrangler r2 bucket create cyml-distro
npx wrangler secret put UPLOAD_SECRET   # 값을 입력하라는 프롬프트가 뜸 — distro-builder
                                          # 설정 패널의 "업로드 시크릿"에도 같은 값을 넣는다
npx wrangler deploy
```

배포 후 `https://cyml-distro-worker.<계정 서브도메인>.workers.dev`가 이 Worker의 기본
URL이다. 커스텀 도메인을 쓰려면 `wrangler.toml`에 `[[routes]]`를 추가하거나 Cloudflare
대시보드에서 라우트를 연결한다.

## 로컬 개발/테스트

```bash
cp .dev.vars.example .dev.vars    # 값 채우기 (커밋되지 않음)
npx wrangler dev --remote          # 실제 R2 버킷을 대상으로 로컬에서 Worker 실행
```

`--remote`를 붙이지 않으면 R2 로컬 에뮬레이션을 쓰게 되는데, 실제 배포 환경과 완전히
동일하지 않으므로 최종 확인은 `--remote`나 실제 배포본으로 하는 걸 권장한다.

## 마이그레이션 (기존 GitHub 데이터 이관)

```bash
GITHUB_DISTRO_RAW_URL=https://raw.githubusercontent.com/hanol0927/ddumon/main/distribution.json \
WORKER_BASE_URL=https://cyml-distro-worker.<계정 서브도메인>.workers.dev \
UPLOAD_SECRET=<wrangler secret put에서 설정한 값> \
node migrate.js
```

GitHub 원본은 읽기 전용으로만 접근하고 절대 수정/삭제하지 않는다. 같은 R2 key를 덮어쓰는
방식이라 몇 번을 다시 실행해도 안전하다. 실패한 파일이 있으면 그 시점에서 중단하고
`distribution.json`은 전혀 건드리지 않는다(모든 파일이 성공적으로 이관/검증된 뒤에만
마지막에 한 번 PUT).

## 알아두면 좋은 점

- 인증은 단순 공유 비밀키(`UPLOAD_SECRET`) 방식이다. 이 값이 노출되면 누구나 자산을
  덮어쓸 수 있으니 GitHub PAT과 마찬가지로 신중히 다룬다.
- 삭제 API는 없다 — `distribution.json`에서 참조를 빼는 것만으로 충분하고(GitHub 시절과
  동일한 동작), R2에 남는 고아 오브젝트 정리는 이번 범위 밖의 선택적 후속 작업이다.
- R2 단일 `put()` 한도는 5GiB라 이 프로젝트에서 다루는 파일 크기(모드 jar, 리소스팩 등)에는
  충분하다. 그보다 큰 파일이 필요해지면 R2 멀티파트 업로드가 필요한데, 이는 아직 구현되어
  있지 않다.
