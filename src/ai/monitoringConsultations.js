// 상담 평가·가격 관측 클러스터 — monitoringSessionService.js에서 추출.
// pending 상담의 결과 평가와 가격 관측 조회를 소유한다; 세션 상태는 service를 통해 읽는다.
import { numberOrNull, scoreAdviceOutcome, timestampMs } from './monitoringEventModel.js';

export class MonitoringConsultations {
  constructor(service) {
    this.service = service;
  }


  actualProviderResults(consultation) {
    return (Array.isArray(consultation?.results) ? consultation.results : [])
      .filter(result => result?.provider && result.provider !== 'local-brief' && result.status === 'COMPLETED' && result.advice);
  }


  findEvaluationObservation(evaluation) {
    const targetTimestamp = timestampMs(evaluation?.targetAt);
    if (targetTimestamp === null) return null;
    const coin = String(evaluation.coin || '').toUpperCase();
    return this.service.state.priceObservations.find(observation =>
      observation.coin === coin && timestampMs(observation.timestamp) !== null &&
      timestampMs(observation.timestamp) >= targetTimestamp
    ) || null;
  }


  findLatestPriceObservation(coin, atMs) {
    const normalizedCoin = String(coin || '').toUpperCase();
    if (!normalizedCoin || !Number.isFinite(atMs)) return null;
    return this.service.state.priceObservations
      .filter(observation => observation.coin === normalizedCoin)
      .filter(observation => {
        const observedAt = timestampMs(observation.timestamp);
        return observedAt !== null && observedAt <= atMs;
      })
      .sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp))[0] || null;
  }


  refreshConsultationEvaluation(consultation) {
    if (!consultation?.evaluation || consultation.status === 'RUNNING') return false;
    const evaluation = consultation.evaluation;
    if (evaluation.snapshotValid === false) {
      const reason = evaluation.reason || 'snapshot 신선도가 유효하지 않아 결과를 평가하지 않습니다.';
      if (evaluation.status !== 'NOT_EVALUABLE' || evaluation.reason !== reason) {
        evaluation.status = 'NOT_EVALUABLE';
        evaluation.reason = reason;
        evaluation.evaluatedAt = new Date().toISOString();
        return true;
      }
      return false;
    }
    const actualResults = this.service.actualProviderResults(consultation);
    if (actualResults.length === 0) {
      if (evaluation.status !== 'NOT_EVALUABLE' || evaluation.reason !== '응답이 없어 의견을 비교할 수 없습니다.') {
        evaluation.status = 'NOT_EVALUABLE';
        evaluation.reason = '응답이 없어 의견을 비교할 수 없습니다.';
        evaluation.evaluatedAt = new Date().toISOString();
        return true;
      }
      return false;
    }
    if (evaluation.baselinePrice === null || evaluation.baselinePrice <= 0 || timestampMs(evaluation.baselineAt) === null) {
      evaluation.status = 'NOT_EVALUABLE';
      evaluation.reason = '기준 가격 또는 기준 시간이 없어 미래 가격 대조를 수행할 수 없습니다.';
      evaluation.evaluatedAt = new Date().toISOString();
      return true;
    }

    if (!evaluation.decisionAt || evaluation.decisionPrice === null) {
      const completedTimestamp = timestampMs(consultation.completedAt);
      const decisionObservation = this.service.findLatestPriceObservation(evaluation.coin, completedTimestamp);
      evaluation.decisionPrice = numberOrNull(decisionObservation?.price) ?? evaluation.baselinePrice;
      evaluation.decisionAt = decisionObservation?.timestamp || evaluation.baselineAt;
      const eventTimestamp = timestampMs(evaluation.baselineAt);
      const decisionTimestamp = timestampMs(evaluation.decisionAt);
      evaluation.adviceLatencySeconds = eventTimestamp === null || decisionTimestamp === null
        ? null
        : Math.max(0, (decisionTimestamp - eventTimestamp) / 1_000);
      const targetTimestamp = timestampMs(evaluation.decisionAt);
      evaluation.targetAt = targetTimestamp === null
        ? null
        : new Date(targetTimestamp + evaluation.horizonMinutes * 60_000).toISOString();
    }

    const observation = this.service.findEvaluationObservation(evaluation);
    if (!observation) {
      evaluation.status = 'PENDING';
      return false;
    }

    const outcomePrice = numberOrNull(observation.price);
    const decisionPrice = numberOrNull(evaluation.decisionPrice);
    const priceChangePercent = outcomePrice === null || decisionPrice === null || decisionPrice === 0
      ? null
      : ((outcomePrice - decisionPrice) / decisionPrice) * 100;
    const verdicts = actualResults.map(result => ({
      source: result.provider,
      providerLabel: result.providerLabel || result.provider,
      ...scoreAdviceOutcome(result.advice, priceChangePercent, evaluation.neutralBandPercent, consultation.event?.action)
    }));
    if (consultation.consensus && consultation.consensus.providerCount > 0 && consultation.consensus.quorum === true) {
      verdicts.push({
        source: 'consensus',
        providerLabel: '종합 의견',
        ...scoreAdviceOutcome(consultation.consensus, priceChangePercent, evaluation.neutralBandPercent, consultation.event?.action)
      });
    }

    const baselineTimestamp = timestampMs(evaluation.baselineAt);
    const outcomeTimestamp = timestampMs(observation.timestamp);
    evaluation.status = 'COMPLETED';
    evaluation.outcomePrice = outcomePrice;
    evaluation.outcomeAt = observation.timestamp;
    evaluation.observedAfterMinutes = outcomeTimestamp === null || baselineTimestamp === null
      ? null
      : (outcomeTimestamp - baselineTimestamp) / 60_000;
    evaluation.priceChangePercent = priceChangePercent;
    evaluation.verdicts = verdicts;
    evaluation.reason = null;
    evaluation.evaluatedAt = new Date().toISOString();
    return true;
  }


  evaluatePendingConsultations() {
    const changedConsultations = [];
    for (const consultation of this.service.state.consultations) {
      if (consultation.evaluation?.status !== 'PENDING') continue;
      if (this.service.refreshConsultationEvaluation(consultation)) {
        changedConsultations.push(consultation);
      }
    }
    if (changedConsultations.length > 0) {
      this.service.state.updatedAt = new Date().toISOString();
      try {
        this.service.saveState();
      } catch {
        // Keep the in-memory evaluation available even when persistence is
        // temporarily unavailable; the next cycle can retry the write.
      }
      for (const consultation of changedConsultations) {
        this.service.emitUpdate('consultation', { consultation: { ...consultation } });
      }
    }
    return changedConsultations.length > 0;
  }
}
