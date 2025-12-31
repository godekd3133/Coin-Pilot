# 🚀 고급 코인 자동매매 시스템

업비트 거래소를 통한 완전 자동화 코인 거래 시스템입니다. 머신러닝, 백테스팅, 파라미터 최적화, 웹 대시보드 등의 고급 기능을 포함합니다.

## 📋 목차

1. [주요 기능](#주요-기능)
2. [설치](#설치)
3. [설정](#설정)
4. [사용법](#사용법)
5. [고급 기능](#고급-기능)
6. [웹 대시보드](#웹-대시보드)
7. [주의사항](#주의사항)

## ✨ 주요 기능

### 1. 차트 분석
- **RSI** (Relative Strength Index): 과매수/과매도 판단
- **MACD**: 추세 전환 신호 포착
- **볼린저 밴드**: 변동성 기반 매매 타이밍
- **이동평균선**: 골든크로스/데드크로스 감지
- **거래량 분석**: 거래량 급증 감지

### 2. 뉴스 모니터링
- 실시간 암호화폐 뉴스 수집 (CoinDesk, CoinTelegraph, Naver)
- 감성 분석을 통한 시장 심리 파악
- 긴급 뉴스 감지 (급등/급락/규제 관련)

### 3. 자동 매매
- 기술적 분석 + 뉴스 분석을 종합한 매매 결정
- 가중치 기반 점수 시스템
- 자동 손절/익절
- 포지션 관리

### 4. 🆕 백테스팅
- 과거 데이터로 전략 검증
- 수익률, 승률, 최대 낙폭, 샤프 비율 등 상세 통계
- 여러 전략 비교 분석

### 5. 🆕 파라미터 최적화
- 유전 알고리즘(Genetic Algorithm) 기반 자동 최적화
- RSI, MACD, 손절/익절 등 모든 파라미터 최적화
- 백그라운드에서 지속적으로 최적 파라미터 탐색

### 6. 🆕 다중 코인 동시 거래
- 여러 코인을 동시에 분석 및 거래
- 포트폴리오 관리 (최대 포지션 수, 할당 비율)
- 각 코인별 독립적인 전략 적용

### 7. 🆕 머신러닝 가격 예측
- Linear Regression 기반 가격 예측
- 추세 강도 분석
- 특징 추출 (Feature Engineering)

### 8. 🆕 웹 대시보드
- 실시간 계좌 정보 모니터링
- 거래 통계 및 이력 조회
- 뉴스 및 시장 심리 분석
- 시스템 시작/정지 제어

## 📦 설치

```bash
# 저장소 클론
git clone <repository-url>
cd coin-automandation

# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일을 열어 설정 수정
```

## ⚙️ 설정

`.env` 파일에서 다음 항목들을 설정하세요:

### 기본 설정
```env
# 업비트 API 키 (실전투자 시 필수)
UPBIT_ACCESS_KEY=your_access_key
UPBIT_SECRET_KEY=your_secret_key

# 거래 모드
DRY_RUN=true                  # true: 모의투자, false: 실전투자

# 단일 코인 설정
TARGET_COIN=KRW-BTC
INVESTMENT_AMOUNT=10000

# 다중 코인 설정
TARGET_COINS=KRW-BTC,KRW-ETH,KRW-XRP
MAX_POSITIONS=3               # 최대 동시 포지션 수
PORTFOLIO_ALLOCATION=0.3      # 각 코인에 최대 30% 할당
```

### 전략 파라미터
```env
# 손익 관리
STOP_LOSS_PERCENT=5           # 손절률 (%)
TAKE_PROFIT_PERCENT=10        # 익절률 (%)

# 매매 임계값
BUY_THRESHOLD=60              # 매수 점수 임계값 (0-100)
SELL_THRESHOLD=60             # 매도 점수 임계값 (0-100)

# 기술적 분석
RSI_PERIOD=14
RSI_OVERSOLD=30
RSI_OVERBOUGHT=70
```

### 대시보드
```env
ENABLE_DASHBOARD=true         # 대시보드 활성화
DASHBOARD_PORT=3000          # 대시보드 포트
```

## 🎮 사용법

### 1. 단일 코인 자동매매
```bash
npm start
# 또는
npm run dev  # 자동 재시작 모드
```

### 2. 다중 코인 자동매매
```bash
npm run multi
```

### 3. 백테스팅
```bash
npm run backtest
```

결과는 `backtest_results.json`에 저장됩니다.

### 4. 파라미터 최적화
```bash
npm run optimize
```

최적 파라미터가 `optimal_config.json`에 저장되며, 콘솔에 `.env` 파일에 적용할 값들이 출력됩니다.

### 5. 대시보드만 실행
```bash
npm run dashboard
```

브라우저에서 `http://localhost:3000`으로 접속하세요.

## 🔬 고급 기능

### 백테스팅 상세

백테스팅은 과거 데이터로 전략의 성과를 검증합니다.

**주요 지표:**
- **총 수익률**: 초기 자본 대비 수익률
- **승률**: 수익 거래 비율
- **최대 낙폭 (MDD)**: 최고점에서 최저점까지 하락률
- **샤프 비율**: 위험 대비 수익률
- **수익 팩터**: 총 수익 / 총 손실

**환경변수:**
```env
BACKTEST_DAYS=30              # 백테스팅 기간 (일)
```

### 파라미터 최적화 상세

유전 알고리즘을 사용하여 최적의 파라미터를 자동으로 찾습니다.

**작동 원리:**
1. 무작위 파라미터 조합으로 초기 개체군 생성
2. 각 개체를 백테스팅으로 평가
3. 우수한 개체 선택 및 교배
4. 변이를 통한 다양성 확보
5. 여러 세대 반복

**환경변수:**
```env
OPTIMIZATION_DAYS=60          # 최적화 학습 기간
POPULATION_SIZE=20            # 개체군 크기
GENERATIONS=10                # 세대 수
MUTATION_RATE=0.2             # 변이율
CROSSOVER_RATE=0.7            # 교배율
ELITE_SIZE=2                  # 엘리트 보존 수
```

**권장 설정:**
- 빠른 테스트: `POPULATION_SIZE=10, GENERATIONS=5`
- 정밀한 최적화: `POPULATION_SIZE=30, GENERATIONS=20`

### 머신러닝 예측

선형 회귀를 사용한 가격 예측 모델이 포함되어 있습니다.

**특징 (Features):**
- 이동평균선 (5, 10, 20일)
- 가격 변화율
- 거래량 변화율
- 변동성 (표준편차)
- 최근 추세
- 고가/저가 범위

**사용법:**
```javascript
import PricePredictor from './src/ml/pricePredictor.js';

const predictor = new PricePredictor();
await predictor.train(historicalCandles);

const prediction = predictor.predictPrice(currentCandles);
console.log(prediction);
// {
//   currentPrice: 50000000,
//   predictedPrice: 51000000,
//   direction: 'UP',
//   confidence: 75
// }
```

### 지속적 파라미터 최적화

백그라운드에서 주기적으로 파라미터를 최적화할 수 있습니다.

```javascript
import ParameterOptimizer from './src/optimization/parameterOptimizer.js';

const optimizer = new ParameterOptimizer();

// 24시간마다 최적화 실행
await optimizer.continuousOptimization(
  upbitAPI,
  'KRW-BTC',
  86400000  // 24시간
);
```

## 🌐 웹 대시보드

웹 대시보드는 실시간으로 시스템을 모니터링할 수 있습니다.

### 주요 기능

1. **시스템 상태**
   - 실행/정지 상태
   - 모드 (모의투자/실전투자)
   - 타겟 코인

2. **계좌 정보**
   - KRW 잔액
   - 현재 포지션

3. **거래 통계**
   - 총 거래 횟수
   - 승률
   - 총 손익

4. **최근 거래 내역**
   - 거래 시간
   - 매수/매도 가격
   - 손익

5. **뉴스 분석**
   - 최근 뉴스
   - 시장 심리

### API 엔드포인트

```
GET  /api/status              # 시스템 상태
GET  /api/account             # 계좌 정보
GET  /api/statistics          # 거래 통계
GET  /api/trades              # 거래 이력
GET  /api/news                # 뉴스 정보
GET  /api/logs                # 로그 조회
GET  /api/backtest/results    # 백테스팅 결과
GET  /api/optimal-config      # 최적 파라미터

POST /api/control/start       # 시스템 시작
POST /api/control/stop        # 시스템 정지
POST /api/config/update       # 설정 업데이트
```

## 📊 프로젝트 구조

```
coin-automandation/
├── src/
│   ├── api/
│   │   ├── upbit.js              # 업비트 API
│   │   └── dashboardServer.js    # 대시보드 서버
│   ├── analysis/
│   │   ├── technicalIndicators.js # 기술적 분석
│   │   └── newsMonitor.js         # 뉴스 모니터링
│   ├── strategy/
│   │   └── tradingStrategy.js     # 매매 전략
│   ├── trader/
│   │   ├── autoTrader.js          # 단일 코인 트레이더
│   │   └── multiCoinTrader.js     # 다중 코인 트레이더
│   ├── backtest/
│   │   └── backtestEngine.js      # 백테스팅 엔진
│   ├── optimization/
│   │   └── parameterOptimizer.js  # 파라미터 최적화
│   ├── ml/
│   │   └── pricePredictor.js      # 가격 예측 모델
│   ├── utils/
│   │   └── logger.js              # 로깅 시스템
│   ├── scripts/
│   │   ├── runBacktest.js         # 백테스팅 실행
│   │   ├── runOptimization.js     # 최적화 실행
│   │   └── runDashboard.js        # 대시보드 실행
│   ├── index.js                   # 단일 코인 메인
│   └── multiCoinIndex.js          # 다중 코인 메인
├── public/
│   └── index.html                 # 대시보드 UI
├── logs/                          # 로그 파일
├── .env                           # 환경변수
├── package.json
└── README.md
```

## ⚠️ 주의사항

### 실전 투자 전 필수 확인사항

1. **충분한 모의투자 기간**
   - 최소 1주일 이상 `DRY_RUN=true`로 테스트
   - 다양한 시장 상황에서 테스트

2. **백테스팅 검증**
   - 여러 기간으로 백테스팅 수행
   - 승률 60% 이상, 최대 낙폭 20% 이하 권장

3. **파라미터 최적화**
   - 과최적화(Overfitting) 주의
   - 여러 기간으로 검증

4. **리스크 관리**
   - 손절/익절 반드시 설정
   - 투자 금액 제한
   - 여유 자금으로만 투자

5. **모니터링**
   - 정기적으로 대시보드 확인
   - 로그 파일 검토
   - 이상 거래 발견 시 즉시 중지

### 법적 책임

- 이 프로그램은 교육 목적으로 제공됩니다
- 실제 거래로 인한 손실에 대해 개발자는 책임지지 않습니다
- 모든 투자 결정과 그 결과는 사용자 본인의 책임입니다

## 📝 로그 확인

모든 로그는 `logs/` 디렉토리에 저장됩니다:

- `trading-YYYY-MM-DD.log`: 일반 로그
- `error-YYYY-MM-DD.log`: 에러 로그
- `trades.log`: 거래 이력
- `performance.log`: 성과 기록
- `report-YYYY-MM-DD.txt`: 일일 리포트

## 🚀 향후 계획

- [ ] Telegram 알림 연동
- [ ] 더 고급 ML 모델 (LSTM, Transformer)
- [ ] 소셜 미디어 감성 분석
- [ ] 자동 리밸런싱
- [ ] 슬리피지 및 수수료 동적 조정

## 📞 문의

이슈나 질문이 있으시면 GitHub Issues를 이용해 주세요.

---

**행운을 빕니다! 📈💰**
