---
name: coinpilot-testflight-release
description: CoinPilot iOS 앱을 TestFlight에 올리는 원샷 릴리스 절차. "테스트플라이트 올려", "iOS 빌드 배포", "앱 업로드" 요청 시 사용. ASC 자격·아카이브·업로드·빌드 상태 확인을 한 번에 처리한다.
---

# CoinPilot TestFlight Release

`mobile/scripts/testflight-upload.sh`가 bump → archive → export → upload를 한 번에 처리한다. 사용자에게 Apple 계정 비밀번호/2FA를 요구하지 않는다 — ASC API 키로 인증한다.

## 사전 조건 (이 머신에서 검증됨)

- Xcode 로그인 없이 CLI만으로 동작 — `-exportArchive`의 `-authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID` 사용
- ASC API 자격 파일: `~/.config/kbo-fans/secrets/appstoreconnect/kbo-fans-testflight.env`
  - `ASC_ISSUER_ID`, `ASC_KEY_ID`, `ASC_KEY_PATH` (키 파일은 동일 디렉터리의 `AuthKey_*.p8`)
  - 계정 수준 키라 이 저장소뿐 아니라 팀 내 다른 앱에도 재사용 가능
- 키체인: `Apple Distribution: MIN KYU KIM (A23ZPKGMW9)` 인증서 + 팀 프로비저닝 프로필 (자동 서명)
- `DEVELOPMENT_TEAM=A23ZPKGMW9`, bundle `com.godekd3133.coinpilot`, deployment target iOS 15

## 실행

```sh
cd mobile
npm run ios:testflight          # bump → archive → export → upload (한 번에)
npm run asc:build-status        # 업로드 후 빌드 상태 조회
npm run asc:build-status -- --watch   # PROCESSING 끝날 때까지 60초 폴링
```

직접 실행하려면 `bash mobile/scripts/testflight-upload.sh`.

### 빌드 변수 (Info.plist 주입)

- `COINPILOT_DATA_MODE` — `server`(기본) / `bundled-preview` / `bundled-market`
- `COINPILOT_PAPER_SERVER` — 기본 `https://52.78.156.161` (번들 페이퍼 서버 기본값)
- `COINPILOT_LIVE_SERVER` — 기본 `https://52.78.156.161/live`
- `COINPILOT_DEFAULT_TOKEN` — 설정 안 하면 앱이 첫 실행에서 토큰을 묻는다. **실제 운영 토큰을 바이너리에 박지 않는다** — 공유된 TestFlight 빌드에서 추출 가능하기 때문
- `KEEP_IPA=1` — 익스포트된 IPA를 `mobile/artifacts/testflight/`에 보존

## 주의점 (실측 기반)

- **`exportArchive destination=upload`가 `Failed to Use Accounts`로 실패할 때** — Xcode GUI 계정 세션이 CLI에서 안 쓰이는 상태다. 세 세션(`ASC_*` 인증 인자)을 추가하면 된다. `-allowProvisioningUpdates`는 CLI 인증과 무관하게 그대로 둬도 된다.
- `CURRENT_PROJECT_VERSION`은 Debug/Release 두 섹션을 같이 올려야 한다 — 스크립트가 처리.
- 같은 (version, build) 재업로드는 거절된다 — bump는 필수.
- Archive는 development 인증서로 서명되고, export 시 App Store 프로필로 재서명된다 — 정상 동작.
- 업로드 직후 `/v1/builds`에 바로 안 나타날 수 있다 — 수 분 후 PROCESSING → VALID. VALID가 되면 내부 테스터는 리뷰 없이 설치 가능.
- `usesNonExemptEncryption` — 이 앱은 URLSession HTTPS만 쓰므로 비면제 암호화 아님(`false`). ASC가 물으면 기존 답변(No) 재사용.
- Worktree가 더러워도 빌드에는 현재 파일이 쓰인다 — 아카이브 시점의 working tree 기준. 릴리스 전에 의도한 변경이 커밋/보존됐는지 확인.

## 검증

- `npm run asc:build-status` — 최근 3개 빌드의 version/state/uploaded 표시
- 업로드 성공 문구: `Upload succeeded.` + `** EXPORT SUCCEEDED **`
- ASC 웹 확인: https://appstoreconnect.apple.com → CoinPilot → TestFlight

## 과거 기록

- 2026-09-29: build 5/6/7 업로드 (이전 세션들)
- 2026-10-01: build 8 업로드 — 이 스크립트/스킬 정립된 날
