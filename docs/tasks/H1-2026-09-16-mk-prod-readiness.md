# H1-2026-09-16-mk-prod-readiness

## 요약
Coin Pilot을 상용 서비스 수준의 신뢰성·보안·운영성으로 끌어올리기 위한 단계별 로드맵 수립 및 순차 실행.

## 배경
- 개인 자동매매 봇이나 모바일(LAN)에서 대시보드를 접속 중 — 최소한의 인증이 필요한 노출 상태
- CI가 사실상 비어 있고(단일 파일 `node --check`만), lint/format/config 검증/헬스 엔드포인트가 없음
- `multiCoinTrader.js` 5,414행 등 god file과 루트에 산재한 런타임 산출물이 유지보수성을 해침

## 요구사항
- [ ] 로드맵 문서 작성 (`docs/production-readiness-roadmap.md`)
- [x] Phase 0: 대시보드 보안 잠금 (토큰 인증, CORS/바인드 제한) — `507802b` 이후 구현, 테스트 20개 추가
- [x] Phase 1: CI 실질화 + eslint — CI가 Node 20/22에서 `npm run lint` + `npm test` 실행, eslint flat config 도입, engines `>=20`
- [x] Phase 2: config 스키마 단일화 — `src/config/` 스키마+로더, 부팅 fail-fast, `.env.example`↔스키마 동기화 테스트, `index.js`/`multiCoinIndex.js` createConfig 주입 마이그레이션
- [x] Phase 3: 관측성 — Logger JSONL + 비동기 파일 쓰기 큐, `/health`+`/ready` 프로브 (trader fail-closed 판정 재사용), 로그 보관 패턴 스코핑
- [ ] Phase 4: multiCoinTrader 분해 (architecture deepening)
- [ ] Phase 5: DATA_DIR 통합 + 저장소 위생
- [ ] Phase 6: Node 22 + 의존성 갱신 + Docker
- [ ] Phase 7: 커버리지/dependabot 등 지속 품질 장치

## 불변 조건 (모든 Phase 공통)
- `scalping_validation.json` 등 live-gate 산출물의 경로·계약 변경 금지
- research-only lane의 `promoted=false`/`researchOnly` 계약 유지
- fail-closed 경계(candle freshness, heartbeat, analysis gap, risk gap) 약화 금지
- DRY_RUN 기본값 유지, 실주문 경로는 명시 승인 없이 변경하지 않음

## 관련 문서
- 로드맵: `docs/production-readiness-roadmap.md`

## 브랜치
- **Parent**: `main`
- **Current**: `agent/H1-2026-09-16-mk-prod-readiness`

## 상태
- [x] 계획
- [ ] 설계
- [ ] 구현
- [ ] 리뷰
- [ ] 완료
