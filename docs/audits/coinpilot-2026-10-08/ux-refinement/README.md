# CoinPilot 사용자 흐름 개선 검증

2026-10-08. 네이티브 SwiftUI 앱의 정보 밀도, 행동 순서, 상태 표현을 개선했다. 이번 작업의 구현 파일은 `mobile/ios/App/App/CoinPilotViews.swift`다. 서버의 실거래 시작 조건, 주문 검증, 인증 정책은 이 작업에서 변경하지 않았다. 작업 도중 다른 작업의 서버 변경이 함께 존재했으므로 아래 검증을 운영 서버의 검증으로 해석하면 안 된다.

## 관찰과 계획

현재 실행한 앱의 화면을 먼저 캡처했다. 홈의 정상 상태 안내가 자산 그래프를 아래로 밀었고, 주문 화면에서 직접 주문과 조건 주문, 자동매매, 제안 기능을 모두 펼쳐 놓았다. 자산과 거래 행은 여러 값을 점으로 이어 붙였다. 예시 모드에서도 서버 권한 오류와 변경할 수 없는 튜닝 영역을 보여주었다.

목표는 자산과 행동을 먼저 보여주고, 판단에 필요한 제한 사항은 남기며, 상세 기준은 사용자가 펼쳐 볼 수 있도록 만드는 것이었다. 직접 주문과 조건 주문을 선택하는 구조로 바꾸고, 미확정 주문은 입력 영역보다 위에 배치했다. 실제 자금, 오래된 시세, 기록 누락, 권한 제한, 주문 잠금과 확인 단계는 유지했다.

## 화면별 결과

| 단계 | 흐름 | 확인 결과 | 화면 근거 |
| --- | --- | --- | --- |
| 1 | 최초 연결 | 홍보성 설명과 장식 이미지 제거. 사용할 계좌, 서버 주소, 연결 행동에 집중. 잘못된 주소가 요청 전 검증에 걸림. 실제 토큰 로그인은 미검증. | after-connection.png, after-connection-validation.png |
| 2 | 홈 | 정상 상태의 반복 제안 제거. 자산, 바로가기, 자산 기록이 먼저 보임. 주의가 필요한 상태에는 기존 안내 유지. | before-home.png, after-home.png, after-iphone-home.png |
| 3 | 직접 주문과 조건 주문 | 주문 방법을 선택해서 한 화면씩 사용. 예시 가격을 실제 시세로 표시하지 않음. 예시 주문 잠금 유지. 분석·종목 교체와 모의 자금 관리는 서버 모드에서 펼쳐 확인. | before-order.png, after-order.png, after-conditional-order.png |
| 4 | 자산 | 종목, 수량, 가격 정보를 공간과 행으로 구분. 반복 예시 배지 제거. 평가 손익과 자산 배분 유지. | before-assets.png, after-assets.png |
| 5 | 시장 | 정상 체결 시각의 종목별 반복 제거. 목록의 자료 기준과 상세 시각, 오래된 시세 경고 유지. ETH 검색 시 이더리움 1건 표시. | after-market.png, after-market-search.png |
| 6 | 거래 내역 | 조회 거래 수와 기록된 실현 손익 분리. 매수·매도를 배지로 표시. 집계 기준을 펼쳐 확인. 매수 필터 1건은 손익을 0으로 만들지 않고 미제공으로 표시. 오늘 0건에서 필터 초기화하면 전체 3건으로 복귀. | before-activity.png, after-activity.png, after-activity-buy.png, after-activity-basis.png, after-activity-empty.png |
| 7 | 더보기와 설정 | 메뉴에서 명백한 반복 설명 축소. 예시 모드의 사용할 수 없는 서버 기능과 권한 오류 제거. 실제 AI 자문 기능은 시장 자문으로 이름과 아이콘 정리. 기능 안의 AI 출처와 한계 설명 유지. | before-settings.png, after-settings.png |
| 8 | 자동매매 시작·중지와 미확정 주문 | 상태와 제어 버튼을 앞에 배치하고 연결·저장 기록을 운용 상세로 이동. 실제 주문 발생 가능성과 중지 후 위험 감시 안내, 확인 대화상자 및 서버 보호 조건 유지. 실제 서버 시작·중지는 미실행. | 소스 검토, 기존 Store 테스트 |

## 레이아웃

보조 상태와 수치는 `MetadataLine`으로 표시한다. 문자열의 구분자는 화면에 렌더링하지 않고 독립된 텍스트와 간격으로 표현한다. 가로 공간이 부족하면 세로로 배치하며 iOS 15에는 세로 배치 대안을 제공한다. 일반 문장 속 한국어 가운데점은 어휘 구분에 사용될 수 있다. 카드의 넓은 그림자는 얇은 테두리로 정리했고, 연결 버튼의 macOS 기본 테두리가 중첩되는 부분을 제거했다.

## 검증 범위

- macOS 예시 프로필 빌드와 iOS 15 배포 대상의 arm64 iPhone Simulator 예시 프로필 빌드.
- 기존 CoinPilotStore 테스트 62개 시나리오 통과.
- 기존 CoinPilotUsefulness 테스트 3개 시나리오 통과.
- 네이티브 macOS 앱에서 탭 이동, 금액 선택, 직접/조건 주문 전환, 시장 검색, 거래 필터, 집계 기준 펼침, 빈 결과에서 필터 초기화 확인.
- iPhone 17e 시뮬레이터에서 홈 렌더링 확인. 최초 로딩 중 빈 캡처는 거절하고 안정적으로 렌더링된 화면으로 교체했다.
- 최초 연결 화면은 컴파일된 앱의 복사본에 별도 번들 ID와 빈 서버·토큰 설정을 넣은 격리 프로필로 확인했다. 잘못된 주소만 입력했고 실제 서버에 연결하지 않았다.
- 예시 자료는 허구의 고정 데이터다. 실제 계좌, 체결, 정산, 거래 성능의 증거가 아니다.

접근성 트리에서 주요 제어의 이름과 상태를 확인했다. 수치의 미제공 값을 실현 손익 0원으로 대체하지 않았다. 이 검증은 VoiceOver의 전체 읽기 순서, 최대 글자 크기, 실물 iPhone, 실제 서버 토큰 로그인, LIVE 시작·중지·주문, 운영 배포 또는 TestFlight 확인을 대체하지 않는다.

변경 전·후 캡처는 이 디렉터리에 있다. 최종 검사 결과와 소스 해시는 `verification.json`에 보관한다.

## 확인한 화면

### 1. 최초 연결

![1. 최초 연결](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/ux-refinement/after-connection.png)

### 2. 홈

![2. 홈](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/ux-refinement/after-home.png)

### 3. 직접 주문

![3. 직접 주문](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/ux-refinement/after-order.png)

### 3. 조건 주문

![3. 조건 주문](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/ux-refinement/after-conditional-order.png)

### 4. 자산

![4. 자산](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/ux-refinement/after-assets.png)

### 5. 시장

![5. 시장](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/ux-refinement/after-market.png)

### 6. 거래 내역

![6. 거래 내역](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/ux-refinement/after-activity.png)

### 7. 설정

![7. 설정](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/audits/coinpilot-2026-10-08/ux-refinement/after-settings.png)
