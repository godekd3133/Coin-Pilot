// 시장 분석: technical signal scores for the top markets (/all-coin-scores).
// Reference only — opening a detail never places an order.
import { html, render } from '../../core/dom.js';
import { price, percent, tone, fullDateTime, number, hasFiniteValue, symbolOf } from '../../core/format.js';
import { card, button, emptyState, skeleton, statGrid, list, listRow, avatar, badge, icon, kv } from '../../ui/components.js';
import { analysisRecommendationLabel, macdSignalLabel, toUserText } from '../../domain/text.js';
import { marketDisplayName } from '../../domain/records.js';
import { coinPositions } from '../../domain/portfolio.js';

const FILTERS = [['all', '전체'], ['BUY', '매수'], ['SELL', '매도'], ['HOLD', '관망']];
const SORTS = [['score', '총점'], ['buy', '매수 점수'], ['sell', '매도 점수'], ['volume', '거래대금'], ['change', '변동률']];

export default {
  id: 'analysis',
  resources: ['account'],
  mount(root, ctx) {
    const view = { filter: 'all', sort: 'score' };
    ctx.use(['analysis']);
    render(root, html`<div class="cp-page">
      ${card({ index: 0, title: '전체 코인 신호', subtitle: '기술지표 요약 · 자동매매 조건과 별개', action: button({ label: '분석 실행', variant: 'primary', iconName: 'play', attrs: { 'data-action': 'run' } }), body: html`
        <div data-slot="summary"></div>
        <div class="cp-toolbar" style="margin:12px 0">
          <select class="cp-input" data-input="filter" aria-label="판정 필터">${FILTERS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select>
          <select class="cp-input" data-input="sort" aria-label="정렬">${SORTS.map(([value, label]) => html`<option value="${value}">${label}순</option>`)}</select>
        </div>
        <div data-slot="rows"></div>` })}
    </div>`);
    const slot = name => root.querySelector(`[data-slot="${name}"]`);

    function renderData() {
      const state = ctx.resource('analysis');
      const result = state.data;
      const coins = Array.isArray(result?.coins) ? result.coins : [];
      const runButton = root.querySelector('[data-action="run"]');
      if (runButton) { runButton.disabled = state.status === 'loading'; runButton.querySelector('span').textContent = state.status === 'loading' ? '분석 중…' : '분석 실행'; }
      if (!result) {
        render(slot('summary'), '');
        render(slot('rows'), state.status === 'loading' ? skeleton({ lines: 6 }) : state.status === 'error' ? emptyState({ iconName: 'alert', title: '분석 불러오기 실패', body: toUserText(state.error?.message || '') }) : emptyState({ iconName: 'pulse', title: '분석 결과 없음', body: '거래대금 상위 시장 RSI·MACD·볼린저·거래량 점수.' }));
        return;
      }
      render(slot('summary'), html`${statGrid([
        { label: '분석한 종목', value: result.totalAnalyzed ?? coins.length },
        { label: '매수 판정', value: coins.filter(item => item.recommendation === 'BUY').length, tone: 'up' },
        { label: '매도 판정', value: coins.filter(item => item.recommendation === 'SELL').length, tone: 'down' },
        { label: '강한 신호', value: coins.filter(item => ['STRONG', 'VERY_STRONG'].includes(item.signalStrength)).length }
      ])}<p class="cp-caption" style="margin-top:8px">${hasFiniteValue(Date.parse(result.timestamp || '')) ? `${fullDateTime(result.timestamp)} 분석` : '분석 시각 미제공'} · 현재 시세와 다를 수 있음</p>`);
      const by = {
        buy: (a, b) => number(b.buyScore) - number(a.buyScore), sell: (a, b) => number(b.sellScore) - number(a.sellScore),
        volume: (a, b) => number(b.volume24h) - number(a.volume24h), change: (a, b) => number(b.change24h) - number(a.change24h),
        score: (a, b) => number(b.totalScore) - number(a.totalScore)
      };
      const rows = coins.filter(item => view.filter === 'all' || item.recommendation === view.filter).sort(by[view.sort] || by.score).slice(0, 80);
      render(slot('rows'), list(rows.map(item => listRow({
        as: 'button',
        attrs: { 'data-coin': item.coin },
        leading: avatar(item.symbol || symbolOf(item.coin), { tone: item.recommendation === 'BUY' ? 'red' : item.recommendation === 'SELL' ? 'blue' : 'neutral' }),
        title: html`${marketDisplayName({ coin: item.coin })} ${badge(analysisRecommendationLabel(item.recommendation), item.recommendation === 'BUY' ? 'up' : item.recommendation === 'SELL' ? 'down' : 'neutral')}`,
        subtitle: `RSI ${hasFiniteValue(item.indicators?.rsi) ? Number(item.indicators.rsi).toFixed(1) : '—'} · MACD ${macdSignalLabel(item.indicators?.macdSignal)} · ${toUserText(item.signals?.[0] || '상세 이유 미제공')}`,
        value: `${hasFiniteValue(item.totalScore) ? Number(item.totalScore).toFixed(0) : '—'}점`,
        valueSub: hasFiniteValue(item.change24h) ? percent(item.change24h) : '',
        valueTone: tone(item.change24h)
      })), { empty: emptyState({ iconName: 'search', title: view.filter !== 'all' ? '해당 판정 종목 없음' : '조건에 맞는 신호 없음' }) }));
    }

    function openDetail(coin) {
      const item = ctx.data('analysis')?.coins?.find(row => row.coin === coin);
      if (!item) return;
      const owned = Number(coinPositions(ctx.session().account).find(row => row.coin === coin)?.amount) > 0;
      const reviewSide = item.recommendation === 'BUY' ? 'buy' : item.recommendation === 'SELL' && owned ? 'sell' : null;
      const signals = (item.signals || []).filter(value => typeof value === 'string');
      const sheet = ctx.ui.openSheet({
        title: `${marketDisplayName({ coin })} 분석`,
        content: String(html`${kv([
          ['판정', analysisRecommendationLabel(item.recommendation)],
          ['현재가', `${price(item.currentPrice)}원`],
          ['24시간 변동', percent(item.change24h)],
          ['총점 / 매수 / 매도', `${number(item.totalScore).toFixed(0)} / ${number(item.buyScore).toFixed(0)} / ${number(item.sellScore).toFixed(0)}`],
          ['신호 강도', toUserText(item.signalStrength || '—')]
        ])}${signals.length ? html`<ul class="cp-caption" style="padding-left:18px">${signals.map(value => html`<li>${toUserText(value)}</li>`)}</ul>` : html`<p class="cp-caption">판단 이유 없음</p>`}
          <p class="cp-caption">${icon('info', { size: 14 })} 기술지표 요약 · 참고용, 주문 없음.${item.recommendation === 'SELL' && !owned ? ' 보유 수량 없음 · 매도 검토 불가.' : ''}</p>`),
        footer: `<a class="cp-btn is-secondary" href="#/coins/${encodeURIComponent(coin)}">현재 시세 보기</a>${reviewSide ? `<a class="cp-btn ${reviewSide === 'buy' ? 'is-up' : 'is-down'}" href="#/trade?coin=${encodeURIComponent(coin)}&side=${reviewSide}">${reviewSide === 'sell' ? '보유 자산 매도 검토' : '매수 금액 검토'}</a>` : ''}`
      });
      sheet.root.querySelectorAll('a').forEach(link => link.addEventListener('click', () => sheet.close()));
    }

    ctx.watch([ctx.res('analysis')], renderData);
    ctx.on('click', '[data-action="run"]', () => ctx.resources.refresh('analysis'));
    ctx.on('change', '[data-input="filter"]', (event, target) => { view.filter = target.value; renderData(); });
    ctx.on('change', '[data-input="sort"]', (event, target) => { view.sort = target.value; renderData(); });
    ctx.on('click', '[data-coin]', (event, target) => openDetail(target.dataset.coin));
  }
};
