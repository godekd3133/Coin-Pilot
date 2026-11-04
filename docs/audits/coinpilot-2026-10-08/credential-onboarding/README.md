# CoinPilot API 키 연결 준비 흐름

목표 active. 실제 LIVE 서버나 키·계좌에 연결하지 않았다. 합성 /live 경로는 화면용 상태만 반환하고 인증 이외 POST를 403으로 거절한다. 실제 키 입력·등록·주문은 not-run이다.

| 단계 | 관찰·변경·검증 | 상태 |
| --- | --- | --- |
| 1. 키 없는 상태 | 긴 안내, 특정 서버 IP, 사용할 수 없는 등록 버튼과 키 입력란, 계좌 수치와 자동매매 화면이 함께 노출됨 | 수정 전 화면 캡처 |
| 2. 연결 준비 우선 | 키 등록 또는 계좌 확인이 끝나기 전에는 홈의 금융 수치·자동매매·기록을 숨겨 설정 단계에 집중 | 합성 HTTP 화면 확인 |
| 3. 보안·권한 조건 | HTTPS 또는 운영 토큰이 준비되지 않으면 키 입력란 대신 필요한 연결 조건과 연결 설정 링크 표시 | 합성 HTTP 분기와 설정 이동 확인 |
| 4. 발급 안내 | 발급·권한 정보는 접어 표시. 자산조회·주문조회·주문하기 및 서버의 외부 통신 공인 IP 안내. 특정 Lightsail/IP와 OTP 설명 제거 | source and official docs checked; eligible HTTPS rendering still unverified |
| 5. 등록 버튼 | 실거래 서버 표현으로 정리하고 입력 미완료·진행 중의 비활성 표시 추가 | source compiled; eligible HTTPS visual still unverified |

공식 근거: [Upbit API 이용 준비](https://docs.upbit.com/kr/kr/docs/api-setup), [API Key 발급](https://docs.upbit.com/kr/kr/docs/api-key). 허용 IP는 서버가 외부망 통신에 사용하는 공인 IP이며 특정 접속 주소를 고정적으로 가정하지 않는다.

Mac QA 및 iOS Simulator 빌드 성공, diff check 통과. 합성 LIVE POST 거절 확인. 실제 정상 HTTPS 등록 가능 분기의 화면, 현재 iPhone·큰 글자·VoiceOver 및 전체 완료 감사는 남아 있다.

![수정 전 키 설정](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/completion-audit/14-live-key-setup-before.png)

![수정 후 연결 준비](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/completion-audit/15-live-key-setup-after.png)

## 등록 가능한 화면의 네트워크 없는 검증

동일한 화면 소스를 복사해 Store 생성에 메모리 API 제공자를 주입한 별도 QA 앱으로 등록 가능 조건을 재현했다. Store 복사에서는 SSE를 중지하고, API 제공자는 네트워크를 호출하지 않으며 등록·변경 요청은 거절한다. 생산 코드의 TLS 검사나 인증을 우회하지 않는다.

| 단계 | 결과 | 상태 |
| --- | --- | --- |
| 1. 빈 입력 | 두 SecureField와 비활성·옅은 등록 버튼 표시 | Mac fixture 화면 확인 |
| 2. 안내 펼치기 | 발급·권한 정보는 접힌 상태로 시작하고 요청 시 표시 | Mac fixture 화면 확인 |
| 3. 더미 입력 | qa-only 값 두 개를 입력하면 등록 버튼이 활성 색상으로 바뀜 | Mac fixture 화면 확인 |
| 4. 거절 응답 | 제공자의 forbidden 응답 뒤 입력란 두 개가 비워지고 버튼 재비활성화 | Mac fixture 상태 확인 |
| 5. 정렬 | 상세 안내의 왼쪽 정렬을 입력란과 맞춤 | 현재 소스 복사 fixture 렌더 확인 |

fixture의 일부 시세 응답이 최소 형태이므로 상단에 부분 자료 경고가 나타난다. 실제 서버 접속 실패를 재현한 증거로 해석하지 않는다. 실제 HTTPS 전송·실제 키 등록·실제 주문은 not-run이다. fixture 빌드와 최종 iOS Simulator 빌드 성공.

남은 실제 iPhone의 현재 화면·키보드·안전 영역·큰 글자·VoiceOver 검증은 장치 unavailable 및 미러링 Timed Out 때문에 완료할 수 없다. 동일한 연결 차단이 여러 연속 goal turn에서 재확인됐고 잠금 상태 질문은 답변 대기 중이다. 모든 작업을 완료했다고 주장하지 않는다.

![입력 전](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/completion-audit/16-https-form-empty.png)

![더미 입력 후](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/completion-audit/18-https-form-dummy-filled.png)

![거절 후 정리](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/completion-audit/19-https-form-rejected-cleared.png)

![안내 정렬](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/completion-audit/20-https-form-guide-aligned.png)
