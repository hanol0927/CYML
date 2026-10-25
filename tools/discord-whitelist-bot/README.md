# discord-whitelist-bot

특정 디스코드 채널에 마인크래프트 닉네임만 입력하면 `cyml-distro-worker`의 화이트리스트에
자동으로 등록해주는 상시 구동 봇. 슬래시 커맨드가 아니라 일반 메시지를 감지해야 해서
Cloudflare Worker 같은 서버리스 환경이 아니라 24시간 켜져 있는 PC/서버가 필요하다.

디스코드 서버(길드) 하나는 마크 서버(`SERVER_ID`) 하나에 고정 매핑된다. 여러 마크 서버를
각자 다른 디스코드 서버/채널에 연결하려면, 이 프로세스를 `.env`를 다르게 해서 여러 개
띄우면 된다.

등록은 `distribution.json`의 `whitelist` 필드만 바꾸는 것이라, [whitelist.html](../distro-builder/whitelist.html)과
동일하게 **런처 UI에서만 적용되고 마인크래프트 서버 접속 자체를 막지는 않는다.**

## 동작 방식

1. 지정한 채널(`DISCORD_CHANNEL_ID`)에 메시지가 오면 마인크래프트 닉네임 형식(영문/숫자/
   밑줄 3~16자)인지 검사
2. Mojang API(`api.mojang.com/users/profiles/minecraft/<닉네임>`)로 실제 존재하는 계정인지
   확인하고, 응답에 담긴 정확한 대소문자로 정규화
3. `GET {WORKER_BASE_URL}/distribution.json`에서 `SERVER_ID` 서버의 현재 화이트리스트를
   읽어 중복이면 중단
4. 중복이 아니면 닉네임을 추가해서 `PUT {WORKER_BASE_URL}/whitelist/<SERVER_ID>`로 저장
   (`WHITELIST_KEY`로 인증 — distro-worker의 "화이트리스트 위임 키" 체계, 자세한 권한
   모델은 [distro-worker/README.md](../distro-worker/README.md) 참고)
5. 메시지에 ✅/❌/ℹ️/⚠️ 리액션과 결과 안내 답장

메시지는 채널별로 들어오는 순서대로 하나씩만 처리하도록 직렬화되어 있어, 거의 동시에
여러 명이 등록해도 서로의 변경을 덮어쓰지 않는다. 같은 사람이 짧은 간격(기본 10초)으로
반복 입력하면 무시하고 ⏳ 리액션만 남긴다.

## 처음 설정하기

### 1. 디스코드 봇 만들기

1. https://discord.com/developers/applications 에서 새 Application 생성
2. 좌측 "Bot" 메뉴 → "Reset Token"으로 토큰 발급 (이게 `DISCORD_TOKEN`)
3. 같은 "Bot" 메뉴에서 "Privileged Gateway Intents" 중 **MESSAGE CONTENT INTENT**를 켠다
   (끄면 일반 메시지 내용을 읽을 수 없어 봇이 동작하지 않음)
4. 좌측 "OAuth2" → "URL Generator"에서 SCOPES에 `bot` 체크, BOT PERMISSIONS에
   "메시지 보내기(Send Messages)", "메시지 기록 보기(Read Message History)" 체크 →
   생성된 URL로 접속해서 원하는 디스코드 서버에 초대

### 2. 등록 채널 ID 확인

디스코드 설정 → 고급 → 개발자 모드 켜기 → 등록용 채널 우클릭 → "채널 ID 복사"
(이게 `DISCORD_CHANNEL_ID`)

### 3. 화이트리스트 위임 키 발급

`tools/distro-builder/index.html`을 열어 관리자 업로드 시크릿으로 로그인한 뒤
"1-2. 화이트리스트 키 관리"에서 새 키를 발급한다. label은 알아보기 쉽게(예: `discord-bot`),
서버는 **이 디스코드 서버에 연결할 마크 서버 하나만** 체크한다. 발급 직후에만 원문 키가
보이므로 그 자리에서 복사해둔다 (이게 `WHITELIST_KEY`).

### 4. .env 작성

```bash
cd tools/discord-whitelist-bot
cp .env.example .env
```

`.env`를 열어 `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `WHITELIST_KEY`, `SERVER_ID`
(`distribution.json`에서 연결할 서버의 `id` 값)를 채운다. `WORKER_BASE_URL`은 보통 기본값
그대로 두면 된다.

### 5. 실행

```bash
npm install
npm start
```

콘솔에 `로그인됨: ...` 이 찍히면 정상 동작 중. 24시간 켜둘 PC/서버에서 끊기지 않게
계속 실행해야 한다 (예: `pm2 start index.js --name discord-whitelist-bot` 로 재시작/백그라운드
실행 관리).

## 사용법

등록 채널에 마인크래프트 닉네임만 입력하면 끝.

```
유저: Notch
봇: ✅ "Notch"님, 화이트리스트에 등록되었습니다.
```

이미 등록된 닉네임이면 ℹ️ 리액션과 함께 안내만 하고 아무것도 바꾸지 않는다. 존재하지
않는 계정이거나 형식이 잘못되면 ❌ 리액션과 함께 이유를 답장한다.

## 참고

- 한 사람이 다른 닉네임으로 다시 등록해도 기존 등록을 자동으로 빼지는 않는다 (여러
  닉네임이 쌓일 수 있음). 필요하면 `tools/distro-builder/whitelist.html`에서 직접 정리한다.
- `WHITELIST_KEY`가 유출되면 그 키에 부여된 서버의 화이트리스트만 바꿀 수 있다 —
  `distro-builder/index.html`에서 즉시 폐기(삭제) 가능.
