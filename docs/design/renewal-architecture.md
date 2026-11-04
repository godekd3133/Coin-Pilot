# CoinPilot 2.0 리뉴얼 — 정보구조·디자인 시스템·클라이언트 아키텍처

이 문서는 웹(PWA)과 iOS/Mac 네이티브 앱을 함께 새로 짜기 위한 기준이다. 두 클라이언트는
같은 정보구조(IA), 같은 디자인 토큰, 같은 서버 API 계약을 공유한다. 기존 대시보드
(`public/index.html` + `pilot-redesign.*`)는 `/classic`에서 계속 동작하며, 아직 옮기지 않은
고급 도구(AI 의견, 리서치, 튜닝, 최적화, 뉴스 등)는 새 셸에서 그쪽으로 연결한다.

## 1. 원칙

1. **기능 = 폴더 하나 + 등록 한 줄.** 새 자산군·새 화면을 추가할 때 셸·라우터·내비를 수정하지
   않는다. 기능 레지스트리(feature registry)에 항목 하나를 추가하면 내비, 라우팅, 지연 로딩이
   따라온다.
2. **데이터 계층과 화면 분리.** 화면은 API를 직접 부르지 않는다. 웹은 `core/api.js` + `core/store.js`,
   네이티브는 `CoinPilotStore`(및 기능별 extension) 를 통해서만 데이터를 읽고 쓴다.
3. **디자인 토큰 단일 출처.** 색·간격·반경·타이포·모션은 토큰으로만 쓴다. 웹 `public/app/ui/tokens.css`
   와 네이티브 `DesignSystem/CPTokens.swift`의 색 값은 테스트(`test/nativeColorTokenParity.test.js`)로 동기화를 강제한다.
4. **안전 계약은 그대로.** 주문은 기존 엔드포인트와 기존 멱등성/확인 절차를 그대로 쓴다. 새 셸이
   주문 계약을 재현할 수 없으면 해당 흐름은 `/classic`으로 연결한다. 실전(LIVE) 화면에는 항상
   실전 표시를 명확히 한다.
5. **빌드 단계 없음(웹).** 네이티브 ES 모듈 + CSS만 사용한다. 외부 CDN 금지(자체 호스팅).
6. **브랜드 독립.** 특정 회사의 브랜드·에셋·명칭을 쓰지 않는다. "차분한 금융 앱" 톤의 자체 디자인.

## 2. 정보구조 (IA)

| 탭 | id | 내용 |
|---|---|---|
| 홈 | `home` | 총자산(코인+주식+포트폴리오), 오늘 손익, 자산 구성 바, 엔진 상태(스캘퍼·주식·기간별 포트폴리오 실행 여부), 최근 체결 5건, 주의 알림 |
| 코인 | `coins` | 보유 코인, 시장 목록(검색·정렬), 코인 상세(가격·캔들·지표), 자동매매(스캘핑) 시작/정지와 상태 |
| 주식 | `stocks` | 모의/실전 주식 트레이더 상태, 보유 종목, 장 운영 상태(개장·마감 정리), 시작/정지, 모의 초기화 |
| 포트폴리오 | `portfolios` | 기간별 슬리브(단기·스윙·중기·장기) × 자산(코인·주식): 비중, 보유, 성과, 연구 검증 결과(통과/실패, OOS 수익, 최악 낙폭), 시작/정지 |
| 활동 | `activity` | 체결·주문 내역(코인·주식·포트폴리오 통합 필터), 대기 주문, 알림 |
| 설정 | `settings` | 서버/토큰, 모의·실전 작업공간, 실전 키 등록 상태, 테마, 고급 도구(→ `/classic`) |

- 모바일(iOS·좁은 웹): 하단 탭 5개 = 홈 · 코인 · 주식 · 포트폴리오 · 더보기(활동·설정·고급 도구).
- 데스크톱(Mac·넓은 웹 ≥ 960px): 왼쪽 사이드바에 6개 탭 전부 + 하단에 작업공간 표시(모의/실전).

## 3. 디자인 토큰

### 색 (light / dark)

| 토큰 | Light | Dark | 용도 |
|---|---|---|---|
| paper | `#f2f4f6` | `#101114` | 앱 배경 |
| surface | `#ffffff` | `#1b1c21` | 카드 |
| surface2 | `#f7f8fa` | `#24252b` | 카드 안 보조 영역, 입력 |
| ink | `#191f28` | `#f2f4f6` | 본문 |
| muted | `#66707f` | `#9aa1ac` | 보조 텍스트 (AA 4.5:1 이상) |
| line | `#e5e8eb` | `#2e2f36` | 구분선 |
| blue (accent) | `#1b64da` | `#5a9dff` | 주 버튼, 링크, 선택 |
| green | `#027648` | `#34c98a` | 정상·완료 상태 |
| red | `#a51926` | `#ff7b7b` | 위험·오류·실전 경고 |
| amber | `#96590a` | `#f1b552` | 주의 |
| up | `#d2283c` | `#ff6b7a` | **가격 상승/수익** (국내 관례: 빨강) |
| down | `#1b64da` | `#5a9dff` | **가격 하락/손실** (국내 관례: 파랑) |

수익/손실 숫자는 반드시 `up`/`down`을 쓴다. 상태(정상·오류)는 `green`/`red`를 쓴다. 두 의미를 섞지 않는다.

### 간격·반경·타이포·모션

- 간격: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 48
- 반경: sm 10 · md 14 · lg 20 · xl 28 · pill 999
- 타이포(px / weight): display 34/700(총자산), title 22/700, headline 17/600, body 15/400, caption 13/500, micro 11/600. 숫자는 `tabular-nums`.
- 모션: fast 140ms, base 260ms, slow 420ms. ease-out `cubic-bezier(0.22,1,0.36,1)`, spring `cubic-bezier(0.34,1.36,0.64,1)`. 누름 scale 0.97.
  `prefers-reduced-motion`/Reduce Motion이면 이동·확대 애니메이션 없이 짧은 페이드만.
- 그림자: 카드는 그림자 대신 surface/paper 대비로 구분. 떠 있는 요소(시트·토스트)만 그림자.

## 4. 공통 컴포넌트 (웹·네이티브 동일한 이름과 역할)

| 컴포넌트 | 역할 |
|---|---|
| `Card` | 흰 라운드 카드, 선택적 제목·우측 액션 |
| `HeroValue` | 큰 금액 + 변동(up/down) + 카운트업 |
| `StatGrid` / `Stat` | 라벨·값 지표 타일 |
| `ListRow` | 아바타/아이콘 · 제목·부제 · 우측 값·변동 |
| `Segmented` | 2~4개 선택 (모의/실전, 코인/주식, 기간) |
| `Badge` | 상태 칩 (실행 중·정지·검증 통과·실전 등) |
| `EngineStatus` | 엔진 이름 + 실행 상태 + 마지막 실행 + 시작/정지 |
| `AllocationBar` | 자산/슬리브 비중 막대 |
| `Sparkline` / `AreaChart` | 자산 추이·가격 |
| `Sheet` | 하단 시트(모바일)·모달(데스크톱), 확인 단계 |
| `Toast` | 결과 알림 |
| `Skeleton` | 첫 로딩 자리 |
| `EmptyState` | 데이터 없음 + 다음 행동 |
| `Notice` | 경고/정보 배너 (실전, 검증 실패, 데이터 지연) |

## 5. 웹 아키텍처 (`public/app/`)

```
public/app/
├── index.html            # 새 셸 (서버가 `/`에서 제공, 기존은 `/classic`)
├── main.js               # 부트스트랩: 인증 확인 → store 초기화 → router 시작
├── core/
│   ├── api.js            # fetch 래퍼(토큰, 타임아웃, 에러 정규화), 엔드포인트 함수
│   ├── store.js          # 작은 관찰 가능 store (get/set/subscribe/select)
│   ├── resources.js      # 리소스 정의(키, fetcher, 갱신 주기) + 폴링/가시성 기반 갱신
│   ├── realtime.js       # /api/stream(SSE) 또는 Socket.io 이벤트 → store 반영
│   ├── router.js         # 해시 라우터, 기능 지연 로딩(import()), 진입/이탈 생명주기
│   ├── registry.js       # 기능 레지스트리 (id, label, icon, route, nav 위치, loader)
│   ├── format.js         # 원화·퍼센트·수량·상대시간 포맷
│   └── dom.js            # html 태그드 템플릿(자동 이스케이프), 마운트 헬퍼
├── ui/
│   ├── tokens.css        # 위 토큰 (light/dark, data-theme 수동 지정 지원)
│   ├── base.css          # 리셋, 타이포, 레이아웃(셸·사이드바·탭바)
│   ├── components.css    # 컴포넌트 스타일
│   └── components.js     # 컴포넌트 함수 (DOM 반환)
└── features/
    ├── home/index.js
    ├── coins/index.js  (+ detail.js 등)
    ├── stocks/index.js
    ├── portfolios/index.js
    ├── activity/index.js
    └── settings/index.js
```

기능 모듈 계약:

```js
export default {
  id: 'stocks',
  resources: ['stocksStatus'],          // 진입 시 활성화할 리소스
  mount(root, ctx) { /* ctx: { store, api, router, ui, format } */ return () => {/* unmount */}; }
};
```

## 6. 네이티브 아키텍처 (`mobile/ios/App/App/`)

```
App/
├── CoinPilotRootView.swift         # 셸: 탭(iOS) / 사이드바(Mac), 작업공간
├── DesignSystem/
│   ├── CPTokens.swift              # 색·간격·반경·타이포·모션 토큰
│   ├── CPComponents.swift          # Card, HeroValue, Stat, ListRow, Badge, Notice …
│   ├── CPCharts.swift              # Sparkline, AreaChart, AllocationBar
│   └── CPMotion.swift              # Press 스타일, 등장 애니메이션, 카운트업, Skeleton
├── Features/
│   ├── Home/ Coins/ Stocks/ Portfolios/ Activity/ Settings/ More/
│   └── (기존 고급 화면: AI, Research, Optimization, Tuning, News … 는 More 아래로 이동)
├── Data/
│   ├── CoinPilotStore.swift        # 기존 store (점진 분리)
│   ├── CoinPilotStore+Stocks.swift # 주식 상태 모델·조회·제어
│   └── CoinPilotStore+Horizons.swift
└── CPFeature.swift                 # 기능 레지스트리 (탭 순서·아이콘·라벨·뷰 빌더)
```

## 7. 서버 계약 (새 화면이 쓰는 엔드포인트)

- `GET /api/status`, `GET /api/account`, `GET /api/positions`, `GET /api/cumulative-pnl`, 기존 체결/히스토리 API
- `GET /api/stocks/status`, `POST /api/stocks/:mode/start|stop`, `POST /api/stocks/paper/reset`
- `GET /api/horizons/status`, `POST /api/horizons/:asset/start|stop`
- `POST /api/control/start|stop` (코인 스캘퍼)

## 8. 확장 시나리오 (검증 기준)

- **새 자산군(예: 해외주식) 추가:** `features/overseas/` + 레지스트리 1줄 + 리소스 1개. 셸 수정 없음.
- **새 포트폴리오 슬리브 추가:** 서버 `horizonProfiles`에 추가하면 포트폴리오 화면은 응답의 슬리브 목록을 그대로 그린다(하드코딩 금지).
- **새 테마/브랜드 색:** 토큰 파일 두 개만 수정, 패리티 테스트가 불일치를 잡는다.
