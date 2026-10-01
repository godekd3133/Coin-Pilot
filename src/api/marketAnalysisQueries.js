// 대시보드 분석 화면의 read-model 쿼리 어셈블러. 표시 전용이며 전략 인스턴스의
// 신호 식별자를 소비하지 않는다 (자동매매와 동일한 반등 계약은
// buildTechnicalAnalysis의 순수 기술적 분석 결과로만 표시한다).
// 각 메서드는 {status, body}를 반환한다.
import { createMarketAnalysisContext } from './marketAnalysisContext.js';
import { createMarketAnalysisCoinQuery } from './marketAnalysisCoin.js';
import { createMarketAnalysisScoresQuery } from './marketAnalysisScores.js';
import { createMarketAnalysisRecommendationsQuery } from './marketAnalysisRecommendations.js';

export function createMarketAnalysisQueries({ tradingSystem, marketDataProvider }) {
  const ctx = createMarketAnalysisContext({ tradingSystem, marketDataProvider });
  return {
    coinAnalysis: createMarketAnalysisCoinQuery(ctx),
    allCoinScores: createMarketAnalysisScoresQuery(ctx),
    tradingRecommendations: createMarketAnalysisRecommendationsQuery(ctx)
  };
}
