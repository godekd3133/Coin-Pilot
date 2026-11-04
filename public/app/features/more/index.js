// 더보기 (mobile): every non-tab destination from the registry, grouped.
import { html, render } from '../../core/dom.js';
import { card, icon } from '../../ui/components.js';

const DESCRIPTIONS = {
  activity: '체결·주문 기록과 대기 요청', settings: '연결, 작업공간, 테마, 알림', trade: '직접·조건 주문과 리밸런싱',
  wallet: '모의 계좌 입출금·초기화', research: '실전 점검, 모의투자 실행 기록', strategy: '매매 조건·프리셋·후보 비교',
  analysis: '전체 코인 신호 점수', ai: '신호 알림과 AI 의견', news: '코인 뉴스와 분위기'
};

export default {
  id: 'more',
  resources: [],
  mount(root, ctx) {
    const items = ctx.registry.moreItems();
    const groups = [...new Set(items.map(item => item.group))];
    render(root, html`<div class="cp-page">${groups.map((group, index) => card({
      index,
      title: group,
      body: html`<div class="cp-more-grid">${items.filter(item => item.group === group).map(item => html`<a class="cp-more-item" href="#/${item.id}">${icon(item.icon, { size: 24 })}<strong>${item.label}</strong><span>${DESCRIPTIONS[item.id] || ''}</span></a>`)}</div>`
    }))}</div>`);
  }
};
