# Coin Pilot

업비트 거래소용 암호화폐 자동매매 시스템입니다. 기술적 분석과 뉴스 감성 분석을 결합하여 매매 신호를 생성하고, 유전자 알고리즘으로 파라미터를 자동 최적화합니다.

## 주요 기능

- 230개 이상의 KRW 마켓 코인 동시 분석 및 거래
- RSI, MACD, 볼린저 밴드 등 기술적 지표 분석
- 다중 소스 뉴스 크롤링 및 감성 분석
- 유전자 알고리즘 기반 파라미터 자동 최적화
- 백테스팅 엔진 (수수료, 슬리피지 시뮬레이션 포함)
- 실시간 웹 대시보드
- 모의투자 / 실전투자 모드 지원

## 설치

```bash
git clone https://github.com/godekd3133/Coin-Pilot.git
cd Coin-Pilot
npm install
```

## 설정

```bash
cp .env.example .env
```

`.env` 파일을 열어서 업비트 API 키를 입력합니다:

```env
UPBIT_ACCESS_KEY=your_access_key
UPBIT_SECRET_KEY=your_secret_key
DRY_RUN=true
TARGET_COINS=ALL
```

API 키는 [업비트 Open API 관리](https://upbit.com/mypage/open_api_management)에서 발급받을 수 있습니다.

## 실행

```bash
# 전체 시스템 실행 (자동매매 + 최적화 + 대시보드)
npm start

# 개별 실행
npm run dashboard    # 대시보드만
npm run backtest     # 백테스팅만
npm run optimize     # 최적화만
```

대시보드는 http://localhost:3000 에서 확인할 수 있습니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DRY_RUN` | true | 모의투자 모드 |
| `DRY_RUN_SEED_MONEY` | 10000000 | 시드머니 (원) |
| `TARGET_COINS` | ALL | 타겟 코인 (쉼표 구분 또는 ALL) |
| `MAX_POSITIONS` | 1000 | 최대 동시 포지션 수 |
| `STOP_LOSS_PERCENT` | 5 | 손절률 (%) |
| `TAKE_PROFIT_PERCENT` | 10 | 익절률 (%) |
| `RSI_PERIOD` | 14 | RSI 기간 |
| `RSI_OVERSOLD` | 30 | RSI 과매도 기준 |
| `RSI_OVERBOUGHT` | 70 | RSI 과매수 기준 |
| `BUY_THRESHOLD` | 55 | 매수 신호 임계값 |
| `SELL_THRESHOLD` | 55 | 매도 신호 임계값 |

## 프로젝트 구조

```
src/
├── index.js                 # 메인 엔트리
├── api/
│   ├── upbit.js             # 업비트 API 클라이언트
│   ├── dashboardServer.js   # Express + Socket.io 서버
│   └── routes/              # API 라우트
├── analysis/
│   ├── technicalIndicators.js  # 기술적 분석
│   └── newsMonitor.js          # 뉴스 감성 분석
├── strategy/
│   └── tradingStrategy.js   # 매매 전략
├── trader/
│   ├── autoTrader.js        # 단일 코인 트레이더
│   └── multiCoinTrader.js   # 멀티코인 트레이더
├── backtest/
│   └── backtestEngine.js    # 백테스팅 엔진
└── optimization/
    └── parameterOptimizer.js # 유전자 알고리즘 최적화
```

## 거래 수수료

모든 거래에 0.05% 수수료가 적용됩니다. 리밸런싱의 경우 매도 + 매수로 왕복 0.1%가 발생합니다.

## 주의사항

- 실전 투자 전 최소 1주일 이상 모의투자로 테스트하세요
- 백테스팅 승률 60% 이상, 최대 낙폭 20% 이하를 권장합니다
- API 키 발급 시 출금 권한은 제외하세요
- 투자 가능한 금액만 사용하세요

## 면책 조항

이 소프트웨어는 교육 및 연구 목적으로 제공됩니다. 암호화폐 거래는 높은 위험을 수반하며, 투자 손실이 발생할 수 있습니다. 투자 결정은 전적으로 사용자의 책임이며, 개발자는 어떠한 손실에 대해서도 책임지지 않습니다.

## 라이선스

MIT License
