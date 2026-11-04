// User-facing wording. Server and research payloads use internal terms; these
// helpers translate them into plain Korean without altering unknown text.

const INTERNAL_TERM_MAP = [
  [/재검증/g, '다시 점검'], [/검증/g, '점검'], [/승격/g, '실거래 적용'], [/게이트/g, '조건'],
  [/무효화/g, '비교에서 제외'], [/홀드아웃/g, '평가 구간'], [/연구 전용/g, '참고용'],
  [/\braw window\b/gi, '원본 데이터 구간'], [/\btraining gate\b/gi, '학습 구간 기준'],
  [/\bvariant study\b/gi, '조건별 비교 결과'], [/\bquote-history\b/gi, '호가 기록'],
  [/\bbest[- ]?level\b/gi, '1단계 호가'], [/\bfull[- ]session\b/gi, '전체 기간'],
  [/\bwalk[- ]?forward\b/gi, '구간별 점검'], [/\bpreflight\b/gi, '시작 전 점검'],
  [/\btraining\b/gi, '학습 구간'], [/\bvariant\b/gi, '조건 후보'], [/\binvalid\b/gi, '유효하지 않은'],
  [/\braw\b/gi, '원본'], [/\bwindow\b/gi, '구간'], [/\breport\b/gi, '자료'], [/\bprovider\b/gi, '의견 서비스'],
  [/\bsession\b/gi, '실행'], [/\bforward\b/gi, '추가 관찰'], [/\bledger\b/gi, '거래 기록'],
  [/\bheartbeat\b/gi, '최근 응답'], [/\borphan(?:ed)?\b/gi, '연결이 끊긴'], [/\bcounterfactual\b/gi, '가정 비교'],
  [/\bconfidence intervals?\b/gi, '신뢰 구간'], [/\bconfidence\b/gi, '신뢰도'], [/\bevidence\b/gi, '확인 자료'],
  [/\bcohort\b/gi, '비교 그룹'], [/\bdrift\b/gi, '변경'], [/\bowner\b/gi, '실행 중인 작업'], [/\bpaper\b/gi, '모의투자'],
  [/\bpromot(?:ion|ed|e)\b/gi, '실거래 적용'], [/\bwinnerShadow\b/g, '수익 상위 거래 비교'],
  [/\blooseShadow\b/g, '조건 완화 비교'], [/\bshadow\b/gi, '비교용'], [/\bloose\b/gi, '완화 조건'],
  [/\bstrict\b/gi, '기본 조건'], [/\brelaxed\b/gi, '완화 조건'], [/\bfail[- ]?closed\b/gi, '안전을 위해 중지'],
  [/\bregime\b/gi, '시장 흐름'], [/\bgate\b/gi, '조건'], [/\bbreadth\b/gi, '상승 종목 비율'],
  [/\blookback\b/gi, '기준 기간'], [/\bticker\b/gi, '시세'], [/\bbreak[- ]?even\b/gi, '손익분기점'],
  [/\btrailing\b/gi, '추적 손절'], [/\bbenchmark\b/gi, '기준 시장'], [/\bspread\b/gi, '호가 차이'],
  [/\bquote\b/gi, '호가'], [/\bdepth\b/gi, '호가 잔량'], [/\bfill\b/gi, '체결'], [/\bcost floor\b/gi, '거래 비용 하한'],
  [/\bcost\b/gi, '비용'], [/\bcoverage\b/gi, '자료 충족률'], [/\bMDD\b/g, '최대 낙폭'], [/\bPF\b/g, '수익·손실 비율'],
  [/\bP95\b/g, '95백분위'], [/\bP05\b/g, '5백분위'], [/\bsamples?\b/gi, '자료'], [/\bPASS\b/g, '통과'],
  [/\bHOLD\b/g, '보류'], [/\bWAIT\b/g, '대기'], [/\bRUNNING\b/g, '실행 중'], [/\bPAUSED\b/g, '일시정지'],
  [/\bSTOPPED\b/g, '중지'], [/\bFAILED\b/g, '실패'], [/\bCOMPLETED\b/g, '완료'],
  [/\bvolume_confirmation_failed\b/g, '거래량 확인 실패'], [/\bprice_rebound_below_threshold\b/g, '최소 반등률 미달'],
  [/\bprice_rebound_above_threshold\b/g, '과대 반등 상한 초과'], [/\bprevious_high_break_failed\b/g, '직전 고가 돌파 실패'],
  [/\bprevious_rsi_not_oversold\b/g, '직전 RSI 과매도 아님'], [/\brsi_recovery_below_threshold\b/g, 'RSI 회복폭 미달'],
  [/\bbullish_rebound_not_confirmed\b/g, '양봉 확인 반등 미확인'], [/\bclose_strength_failed\b/g, '종가 강도 부족'],
  [/\btrend_filter_failed\b/g, '추세 필터 실패'], [/\bdaily_market_stale\b/g, '일봉 자료가 오래됨'],
  [/\bdaily_market_missing\b/g, '일봉 자료 누락'], [/\bdaily_market_grid_not_contiguous\b/g, '일봉 간격 확인 필요'],
  [/\bdaily_market_latest_timestamp_mismatch\b/g, '시장별 일봉 시각 불일치']
];

export function toUserText(value) {
  let text = String(value ?? '');
  text = text.replace(/실제 provider 응답이 없어 평가할 표본이 없습니다\./gi, '응답 기록이 없어 의견 결과를 평가할 수 없습니다.');
  text = text.replace(/아직 (\d+)개 비중립 방향성\/veto 평가 표본이 필요합니다\. 현재 (\d+)개입니다\./i,
    (_match, required, current) => `매수·매도 의견이나 주문 보류 기록이 ${required}건 이상 있어야 비교할 수 있습니다. 현재 ${current}건입니다.`);
  for (const [pattern, replacement] of INTERNAL_TERM_MAP) text = text.replace(pattern, replacement);
  return text;
}

export const EXIT_REASON_LABELS = Object.freeze({
  TAKE_PROFIT: '목표 수익 도달', STOP_LOSS: '손절 기준 도달', MAX_HOLD: '보유 시간 종료', MAX_HOLD_TIME: '보유 시간 종료',
  MAX_LOSING_HOLD_TIME: '손실 상태의 보유 시간 종료', TRAILING_STOP: '고점 대비 하락 기준 도달',
  BREAK_EVEN_STOP: '손익 보호 기준 도달', MANUAL_SELL: '직접 매도', BACKTEST_END: '과거 데이터 점검 종료'
});

export function exitReasonLabel(reason) {
  return typeof reason === 'string' ? EXIT_REASON_LABELS[reason] || reason : '';
}

export function recommendationLabel(value, side) {
  switch (String(value || '').toUpperCase()) {
  case 'WATCH_CLOSELY': return side === 'buy' ? '매수 조건에 가까움' : '매도 조건에 가까움';
  case 'MONITOR': return '관찰';
  case 'CONSIDER_STOP_LOSS': return '손절 검토';
  case 'STRONG_BUY': return '강한 매수 신호';
  case 'BUY': return '매수 신호';
  case 'HOLD': return '보유';
  case 'SELL': return '매도 신호';
  case 'STRONG_SELL': return '강한 매도 신호';
  default: return '추가 확인 필요';
  }
}

export function analysisRecommendationLabel(value) {
  return ({ BUY: '매수 신호', SELL: '매도 신호', HOLD: '관망' })[String(value || '').toUpperCase()] || '확인 필요';
}

export function macdSignalLabel(value) {
  return ({ BULLISH: '상승', BEARISH: '하락', NEUTRAL: '중립' })[String(value || '').toUpperCase()] || '확인 필요';
}

export function signalText(value) {
  return toUserText(String(value || '')
    .replace(/RSI\s*극과매도/gi, 'RSI 과매도 상태가 강함')
    .replace(/\bBB\b/gi, '볼린저 밴드')
    .replace(/\b24H\b/gi, '최근 24시간'));
}

export const AI_EVENT_LABELS = Object.freeze({
  BUY_SIGNAL: '매수 신호', SELL_SIGNAL: '매도 신호', REBOUND_CANDIDATE: '반등 후보',
  BREAKING_NEWS: '속보', BUNDLE_SUGGESTION: '리밸런싱 제안', TRADE_EXECUTED: '체결 알림'
});

export function aiActionLabel(value) {
  return ({ BUY: '매수', SELL: '매도', HOLD: '보유', WAIT: '관망' })[String(value || '').toUpperCase()] || '관망';
}

export function aiProviderLabel(provider) {
  return provider === 'gpt' ? 'ChatGPT' : provider === 'claude' ? 'Claude' : '의견 서비스';
}

export function aiStatusLabel(status) {
  return ({ RUNNING: '실행 중', PAUSED: '일시정지', STOPPED: '종료', COMPLETED: '완료', DEGRADED: '부분 응답', FAILED: '실패' })[status] || toUserText(status || '확인 필요');
}

export function sentimentInfo(sentiment) {
  const overall = String(sentiment?.overall || sentiment?.label || 'neutral').toLowerCase();
  const score = Number(sentiment?.score ?? sentiment?.sentimentScore) || 0;
  if (overall.includes('positive') || overall.includes('긍정') || score > 0.15) return { key: 'positive', label: '긍정적', copy: '분석한 기사에서는 긍정 의견이 더 많습니다.' };
  if (overall.includes('negative') || overall.includes('부정') || score < -0.15) return { key: 'negative', label: '부정적', copy: '분석한 기사에서는 부정 의견이 더 많습니다.' };
  return { key: 'neutral', label: '중립', copy: '분석한 기사에서 뚜렷한 방향이 보이지 않습니다.' };
}

export function articleSentimentInfo(item) {
  const rawValue = item?.sentiment;
  const overall = typeof rawValue === 'string' ? rawValue : rawValue?.overall || rawValue?.label;
  const score = rawValue?.score ?? rawValue?.sentimentScore ?? item?.sentimentScore ?? item?.score;
  const hasScore = score !== null && score !== undefined && score !== '' && Number.isFinite(Number(score));
  if (!overall && !hasScore) return null;
  return sentimentInfo({ overall, score });
}
