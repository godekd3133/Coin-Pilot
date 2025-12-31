<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-green?logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/Platform-Upbit-orange" alt="Platform">
  <img src="https://img.shields.io/badge/Version-2.0.0-brightgreen" alt="Version">
</p>

<h1 align="center">Coin Pilot</h1>

<p align="center">
  <b>AI 기반 암호화폐 자동매매 시스템</b><br>
  업비트 거래소 | 멀티코인 지원 | 실시간 최적화 | 웹 대시보드
</p>

<p align="center">
  <a href="#-주요-기능">주요 기능</a> •
  <a href="#-빠른-시작">빠른 시작</a> •
  <a href="#-대시보드">대시보드</a> •
  <a href="#%EF%B8%8F-설정">설정</a> •
  <a href="#-아키텍처">아키텍처</a>
</p>

---

## Overview

**Coin Pilot**은 업비트 거래소에서 230개 이상의 KRW 마켓 코인을 자동으로 분석하고 거래하는 고급 자동매매 시스템입니다. 기술적 분석, 뉴스 감성 분석, 유전자 알고리즘 최적화를 결합하여 최적의 매매 타이밍을 찾아냅니다.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Coin Pilot v2.0                         │
├─────────────────────────────────────────────────────────────────┤
│  [Technical Analysis]  →  [Signal Generation]  →  [Execution]  │
│  [News Sentiment]      →  [Risk Management]    →  [Dashboard]  │
│  [ML Optimization]     →  [Backtesting]        →  [Reporting]  │
└─────────────────────────────────────────────────────────────────┘
```

## Features

### Core Trading
| 기능 | 설명 |
|------|------|
| **멀티코인 자동매매** | 230+ KRW 마켓 코인 동시 분석 및 거래 |
| **신호 강도 시스템** | WEAK/MEDIUM/STRONG/VERY_STRONG 4단계 신호 |
| **동적 투자금 조절** | 신호 강도에 따라 0.8x ~ 2.5x 투자금 조절 |
| **스마트 리밸런싱** | 약한 포지션 자동 교체 (쿨다운 & 수익성 체크) |

### Technical Analysis
- **RSI** (Relative Strength Index) - 과매수/과매도 판단
- **MACD** (Moving Average Convergence Divergence) - 추세 전환 감지
- **Bollinger Bands** - 변동성 기반 매매 타이밍
- **Moving Averages** - 골든/데드 크로스 감지
- **Volume Analysis** - 거래량 기반 신뢰도 측정

### AI & Optimization
| 기능 | 설명 |
|------|------|
| **유전자 알고리즘** | 자동 파라미터 최적화 (RSI, 손절/익절 등) |
| **뉴스 감성 분석** | 다중 소스 뉴스 크롤링 + AI 감성 점수화 |
| **백테스팅 엔진** | 과거 데이터로 전략 검증 (수수료/슬리피지 포함) |
| **실시간 학습** | 드라이 6시간 / 실전 24시간 주기 최적화 |

### Risk Management
- **손절/익절** - 설정 가능한 자동 청산
- **최소 보유 시간** - 10분 (수수료 손실 방지)
- **리밸런싱 쿨다운** - 5분 (과도한 거래 방지)
- **포지션 한도** - 최대 동시 포지션 수 제한

## Quick Start

### 1. 설치

```bash
git clone https://github.com/godekd3133/Coin-Pilot.git
cd Coin-Pilot
npm install
```

### 2. 환경 설정

```bash
cp .env.example .env
```

`.env` 파일 편집:
```env
# 업비트 API (https://upbit.com/mypage/open_api_management)
UPBIT_ACCESS_KEY=your_access_key
UPBIT_SECRET_KEY=your_secret_key

# 거래 모드 (true: 모의투자, false: 실전)
DRY_RUN=true

# 타겟 코인 (ALL = 전체 KRW 마켓)
TARGET_COINS=ALL
```

### 3. 실행

```bash
# 통합 시스템 실행 (자동매매 + 최적화 + 대시보드)
npm start

# 대시보드 접속
open http://localhost:3000
```

## Dashboard

웹 대시보드에서 실시간으로 시스템을 모니터링하고 제어할 수 있습니다.

### 주요 화면

| 섹션 | 기능 |
|------|------|
| **포트폴리오** | 보유 코인, 평가금액, 수익률 |
| **거래 현황** | 실시간 매수/매도 내역 |
| **코인 분석** | 기술적 지표, 뉴스 감성, 신호 강도 |
| **최적화 이력** | 파라미터 변화 추이, 백테스트 결과 |
| **설정** | 손절/익절, 투자비율 실시간 조정 |

### API 엔드포인트

```
GET  /api/status          - 시스템 상태
GET  /api/account         - 계좌 정보
GET  /api/positions       - 보유 포지션
GET  /api/coin-analysis   - 코인별 분석 결과
POST /api/trade/execute   - 수동 거래 실행
POST /api/control/start   - 자동매매 시작
POST /api/control/stop    - 자동매매 중지
```

## Configuration

### 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DRY_RUN` | `true` | 모의투자 모드 |
| `DRY_RUN_SEED_MONEY` | `10000000` | 시드머니 (1000만원) |
| `TARGET_COINS` | `ALL` | 타겟 코인 목록 |
| `MAX_POSITIONS` | `1000` | 최대 동시 포지션 |
| `STOP_LOSS_PERCENT` | `5` | 손절률 (%) |
| `TAKE_PROFIT_PERCENT` | `10` | 익절률 (%) |
| `RSI_PERIOD` | `14` | RSI 기간 |
| `RSI_OVERSOLD` | `30` | RSI 과매도 기준 |
| `RSI_OVERBOUGHT` | `70` | RSI 과매수 기준 |
| `BUY_THRESHOLD` | `55` | 매수 신호 임계값 |
| `SELL_THRESHOLD` | `55` | 매도 신호 임계값 |

### 거래 수수료

모든 거래에 **0.05%** 수수료가 적용됩니다:
- 매수: 투자금의 0.05% 차감 후 코인 구매
- 매도: 매도금액의 0.05% 차감 후 KRW 입금
- 리밸런싱: 왕복 0.1% (매도 + 매수)

## Architecture

```
coin-pilot/
├── src/
│   ├── index.js                 # 메인 엔트리 (통합 시스템)
│   ├── api/
│   │   ├── upbit.js             # 업비트 API 클라이언트
│   │   ├── dashboardServer.js   # Express + Socket.io 서버
│   │   └── routes/              # API 라우트 모듈
│   ├── analysis/
│   │   ├── technicalIndicators.js  # 기술적 분석
│   │   └── newsMonitor.js          # 뉴스 감성 분석
│   ├── strategy/
│   │   └── tradingStrategy.js   # 매매 전략 + 신호 강도
│   ├── trader/
│   │   ├── autoTrader.js        # 단일 코인 트레이더
│   │   └── multiCoinTrader.js   # 멀티코인 트레이더
│   ├── backtest/
│   │   └── backtestEngine.js    # 백테스팅 엔진
│   ├── optimization/
│   │   └── parameterOptimizer.js # 유전자 알고리즘 최적화
│   └── utils/
│       └── logger.js            # 로깅 시스템
├── public/
│   └── index.html               # 웹 대시보드 UI
├── .env.example                 # 환경변수 템플릿
└── package.json
```

### 데이터 플로우

```
[Market Data] → [Technical Analysis] ─┐
                                      ├→ [Signal Generation] → [Order Execution]
[News Data]   → [Sentiment Analysis] ─┘         ↓
                                         [Risk Management]
                                               ↓
[Backtest]    → [Parameter Optimizer] → [Strategy Update]
```

## Commands

```bash
# 통합 시스템 (권장)
npm start              # 자동매매 + 최적화 + 대시보드

# 개별 실행
npm run dashboard      # 대시보드만
npm run backtest       # 백테스팅만
npm run optimize       # 최적화만

# 개발 모드
npm run dev            # 파일 변경 감지 + 자동 재시작
```

## Important Notes

### 실전 투자 전 체크리스트

- [ ] 최소 1주일 이상 모의투자 테스트
- [ ] 백테스팅 승률 60% 이상 확인
- [ ] 최대 낙폭(MDD) 20% 이하 확인
- [ ] 손절/익절 설정 완료
- [ ] 투자 가능 금액만 사용
- [ ] API 키 권한 최소화 (출금 권한 제외)

### 면책 조항

> **이 소프트웨어는 교육 및 연구 목적으로 제공됩니다.**
> 암호화폐 거래는 높은 위험을 수반하며, 투자 손실이 발생할 수 있습니다.
> 투자 결정은 전적으로 사용자의 책임이며, 개발자는 어떠한 손실에 대해서도 책임지지 않습니다.

## License

MIT License - 자유롭게 사용, 수정, 배포 가능

---

<p align="center">
  Made with ❤️ for crypto traders
</p>
