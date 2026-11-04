/*
 * Static demo overlay: permanent disclosure, guided journey, cost comparison
 * panel and the disabled LIVE explanation. It only reads the dashboard's DOM
 * and clicks its real controls, so the journey exercises the shipped UI.
 */
(function () {
  'use strict';
  // The web shell has no LIVE toggle (mode is a server profile); the guard below stays as defence in depth.

  const demo = window.CoinPilotDemo;
  const LIVE_REASON = '체험판에는 거래소 키도 주문 전송 경로도 없어 실전으로 전환할 수 없습니다. 실제 제품의 실전 전환은 별도 점검과 운영자 확인을 거칩니다.';
  const won = value => `${Math.round(value).toLocaleString('ko-KR')}원`;
  const signedWon = value => `${value > 0 ? '+' : ''}${won(value)}`;
  const pct = value => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const bar = document.createElement('div');
  bar.id = 'demo-bar';
  bar.innerHTML = `
    <p><strong>체험판 · 합성 데이터</strong><span>실제 거래소·계좌와 연결되지 않으며, 투자 권유나 수익 보장이 아닙니다.</span></p>
    <div class="demo-bar-actions">
      <button type="button" id="demo-guide-toggle" aria-expanded="true" aria-controls="demo-guide">안내</button>
      <button type="button" id="demo-reset">처음부터 다시 하기</button>
    </div>`;
  document.body.prepend(bar);
  document.body.classList.add('demo-mode');

  const guide = document.createElement('aside');
  guide.id = 'demo-guide';
  guide.setAttribute('aria-label', '체험 안내');
  document.body.append(guide);

  let collapsed = window.matchMedia('(max-width: 720px)').matches;
  let pendingRender = false;

  // The web shell routes by hash (#/home, #/research, #/activity …).
  function goView(view) {
    if (window.location.hash !== `#/${view}`) window.location.hash = `#/${view}`;
  }

  function focusTarget(selector) {
    const target = document.querySelector(selector);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
    target.classList.add('demo-highlight');
    window.setTimeout(() => target.classList.remove('demo-highlight'), 2400);
  }

  function steps() {
    const s = demo.sim.summary();
    return [
      { id: 'intro', done: demo.progress.intro, title: '첫 화면 이해', body: '가상 자금 1,000만 원으로 시작합니다. 시세는 난수로 만든 값이고 1초가 1분처럼 흐릅니다. 총 자산과 지금 확인할 일 카드를 먼저 보세요.', action: '이해했어요', run() { demo.progress.intro = true; demo.saveProgress(); render(); } },
      { id: 'start', done: s.started, title: '모의 자동매매 시작', body: '주문 전 점검 화면의 모의투자 실행 칸에서 시작합니다. 수동 모의 주문은 자동매매가 멈춰 있을 때 거래 화면에서 해 볼 수 있습니다.', action: '시작 버튼으로 이동', run() { goView('research'); window.setTimeout(() => focusTarget('[data-paper="start"]'), 400); } },
      { id: 'observe', done: s.closed > 0, title: '신호와 진입·청산 관찰', body: '아래 기록에 신호, 모의 진입, 청산이 쌓입니다. 거래 기록 화면에서 건별로 볼 수 있습니다.', action: '거래 기록 보기', run() { goView('activity'); } },
      { id: 'risk', done: s.trips > 0, title: '손실 한도로 신규 진입 중지', body: `연속 손실 ${s.maxLosses}회에 닿으면 신호가 나와도 새로 진입하지 않습니다. 합성 급락을 일으켜 확인해 보세요.`, action: s.active && !s.coolingDown ? '합성 급락 일으키기' : null, run() { const result = demo.triggerCrash(); if (!result.ok) note(result.message); else { note('합성 급락 중입니다. 손절이 쌓이는지 지켜보세요.'); goView('home'); } } },
      { id: 'backtest', done: demo.progress.backtest, title: '백테스트 비용 비교', body: '같은 거래를 수수료·슬리피지 전후로 나란히 봅니다. 비용 가정을 바꿔 다시 계산할 수 있습니다.', action: '비용 비교로 이동', run() { goView('research'); window.setTimeout(() => focusTarget('#demo-backtest'), 400); } }
    ];
  }

  let noteText = '';
  function note(text) { noteText = text; render(); }

  const LOG_LABEL = { signal: '신호', entry: '진입', exit: '청산', risk: '위험', blocked: '차단', info: '안내' };

  guide.innerHTML = `
    <button type="button" class="demo-guide-head" data-demo-collapse><span data-demo-slot="head"></span><span data-demo-slot="caret" aria-hidden="true"></span></button>
    <div class="demo-guide-body">
      <div data-demo-slot="step"></div>
      <div class="demo-status"><span data-demo-slot="status"></span>
        <div class="demo-speed" role="group" aria-label="시뮬레이션 속도">${[1, 5].map(value => `<button type="button" data-demo-speed="${value}">×${value}</button>`).join('')}</div>
      </div>
      <ul class="demo-log" aria-label="최근 시뮬레이션 기록" data-demo-slot="log"></ul>
    </div>`;
  const slot = name => guide.querySelector(`[data-demo-slot="${name}"]`);
  // Each slot is rewritten only when its text changed, so a tick landing
  // between mouse down and up cannot swallow a click on a guide button.
  function setSlot(name, html) {
    const element = slot(name);
    if (element.dataset.demoHtml === html) return;
    element.dataset.demoHtml = html;
    element.innerHTML = html;
  }

  function render() {
    pendingRender = false;
    const list = steps();
    const summary = demo.sim.summary();
    const doneCount = list.filter(step => step.done).length;
    const current = list.find(step => !step.done);
    document.getElementById('demo-guide-toggle').setAttribute('aria-expanded', String(!collapsed));
    guide.classList.toggle('is-collapsed', collapsed);
    guide.querySelector('[data-demo-collapse]').setAttribute('aria-expanded', String(!collapsed));
    setSlot('head', `체험 ${doneCount}/${list.length}${current ? ` · 다음: ${esc(current.title)}` : ' · 완료'}`);
    setSlot('caret', collapsed ? '▴' : '▾');
    const stepHtml = current
      ? `<div class="demo-current" data-demo-step="${current.id}"><strong>${list.indexOf(current) + 1}. ${esc(current.title)}</strong><p>${esc(current.body)}</p>${current.action ? `<button type="button" class="demo-primary" data-demo-run="${current.id}">${esc(current.action)}</button>` : ''}</div>`
      : '<div class="demo-current"><strong>다섯 단계를 모두 해 봤습니다</strong><p>합성 데이터로 만든 결과이므로 전략 성과의 근거로 쓰지 않습니다. 처음부터 다시 하기로 언제든 되돌릴 수 있습니다.</p></div>';
    setSlot('step', `${stepHtml}${noteText ? `<p class="demo-note" role="status">${esc(noteText)}</p>` : ''}`);
    setSlot('status', esc(summary.coolingDown
      ? `신규 진입 중지 · 차단 ${summary.blockedEntries}회 · 재개까지 ${Math.ceil(summary.cooldownTicksRemaining / demo.speed)}초`
      : summary.regime === 'crash' ? `합성 급락 중 · 연속 손실 ${summary.lossCount}/${summary.maxLosses}`
        : summary.active ? `실행 중 · 청산 ${summary.closed}회 · 연속 손실 ${summary.lossCount}/${summary.maxLosses}` : '자동매매 멈춤'));
    setSlot('log', summary.log.length ? summary.log.slice(0, 3).map(item => `<li data-kind="${esc(item.kind)}"><b>${LOG_LABEL[item.kind] || '안내'}</b>${esc(item.text)}</li>`).join('') : '<li>아직 기록이 없습니다.</li>');
    guide.querySelectorAll('[data-demo-speed]').forEach(button => button.setAttribute('aria-pressed', String(demo.speed === Number(button.dataset.demoSpeed))));
  }

  function scheduleRender() {
    if (pendingRender) return;
    pendingRender = true;
    window.requestAnimationFrame(render);
  }

  guide.addEventListener('click', event => {
    if (event.target.closest('[data-demo-collapse]')) { collapsed = !collapsed; render(); return; }
    const speedButton = event.target.closest('[data-demo-speed]');
    if (speedButton) { demo.setSpeed(Number(speedButton.dataset.demoSpeed)); render(); return; }
    const runButton = event.target.closest('[data-demo-run]');
    if (runButton) {
      noteText = '';
      steps().find(step => step.id === runButton.dataset.demoRun)?.run();
      if (window.matchMedia('(max-width: 720px)').matches && runButton.dataset.demoRun !== 'intro') { collapsed = true; }
      render();
    }
  });
  document.getElementById('demo-guide-toggle').addEventListener('click', () => { collapsed = !collapsed; render(); });
  document.getElementById('demo-reset').addEventListener('click', () => demo.resetAll());
  demo.onChange(scheduleRender);

  // ------------------------------------------------------ disabled LIVE path
  document.addEventListener('click', event => {
    const liveButton = event.target.closest('[data-pilot-mode="live"]');
    if (!liveButton) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    note(LIVE_REASON);
    collapsed = false;
    render();
  }, true);

  function lockLiveControls() {
    document.querySelectorAll('[data-pilot-mode="live"]').forEach(button => {
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('title', LIVE_REASON);
      if (!button.dataset.demoLocked) {
        button.dataset.demoLocked = 'true';
        button.insertAdjacentHTML('beforeend', '<span class="demo-visually-hidden"> (체험판에서는 사용할 수 없음)</span>');
      }
    });
  }

  // ----------------------------------------------- backtest cost comparison
  function mountBacktest() {
    if (document.getElementById('demo-backtest')) return;
    // Mounted beside (not inside) the research columns, which re-render on every poll.
    if (!window.location.hash.startsWith('#/research')) return;
    const anchor = document.querySelector('#cp-app .cp-page > .cp-split');
    if (!anchor) return;
    anchor.insertAdjacentHTML('afterend', `
      <section class="cp-card" id="demo-backtest" aria-labelledby="demo-backtest-title">
        <div class="cp-card-head"><div class="cp-card-heading"><h2 class="cp-card-title" id="demo-backtest-title">백테스트 비용 비교</h2><p class="cp-card-sub">시드 고정 합성 시세 · 수익성 근거가 아닙니다</p></div></div>
        <form id="demo-backtest-form" class="demo-backtest-form">
          <label>수수료(편도 %)<input id="demo-fee" name="fee" type="number" inputmode="decimal" min="0" max="2" step="0.01" value="${(demo.core.FEE_RATE * 100).toFixed(2)}"></label>
          <label>슬리피지(편도 %)<input id="demo-slip" name="slip" type="number" inputmode="decimal" min="0" max="2" step="0.01" value="${(demo.core.SLIPPAGE_RATE * 100).toFixed(2)}"></label>
          <button type="submit" class="cp-btn is-primary" id="demo-backtest-run">비교 실행</button>
        </form>
        <div id="demo-backtest-result" aria-live="polite"><p class="cp-caption">비교 실행을 누르면 같은 거래의 비용 전후 결과가 나옵니다.</p></div>
      </section>`);
    document.getElementById('demo-backtest-form').addEventListener('submit', event => {
      event.preventDefault();
      const fee = Number(document.getElementById('demo-fee').value);
      const slip = Number(document.getElementById('demo-slip').value);
      const target = document.getElementById('demo-backtest-result');
      if (!Number.isFinite(fee) || !Number.isFinite(slip) || fee < 0 || slip < 0 || fee > 2 || slip > 2) {
        target.innerHTML = '<p class="cp-caption" role="alert">수수료와 슬리피지는 0에서 2 사이로 입력해 주세요.</p>';
        return;
      }
      target.innerHTML = renderBacktest(demo.core.runCostBacktest({ feePercent: fee, slippagePercent: slip }));
      demo.progress.backtest = true;
      demo.saveProgress();
      render();
    });
  }

  function curveSvg(curve) {
    const values = curve.flatMap(point => [point.gross, point.net]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const path = key => curve.map((point, index) => `${index ? 'L' : 'M'}${((index / (curve.length - 1)) * 600).toFixed(1)} ${(150 - ((point[key] - min) / span) * 140 - 5).toFixed(1)}`).join(' ');
    const baseY = (150 - ((demo.core.SEED_MONEY - min) / span) * 140 - 5).toFixed(1);
    return `<svg class="demo-curve" viewBox="0 0 600 150" preserveAspectRatio="none" role="img" aria-label="비용 전후 가상 자산 곡선. 표의 수치와 같은 자료입니다.">
      <line x1="0" x2="600" y1="${baseY}" y2="${baseY}" class="demo-curve-base"/><path d="${path('gross')}" class="demo-curve-gross"/><path d="${path('net')}" class="demo-curve-net"/></svg>
      <p class="demo-curve-legend"><span class="is-gross">비용 전</span><span class="is-net">비용 후</span><span class="is-base">시작 금액</span></p>`;
  }

  function renderBacktest(result) {
    const pf = value => (value === null ? '-' : value.toFixed(2));
    return `
      <div class="demo-table-wrap"><table class="demo-table"><caption class="demo-visually-hidden">수수료와 슬리피지 전후 비교</caption>
        <thead><tr><th scope="col">항목</th><th scope="col">비용 전</th><th scope="col">비용 후</th></tr></thead>
        <tbody>
          <tr><th scope="row">가상 손익</th><td>${signedWon(result.gross.totalPnl)}</td><td>${signedWon(result.net.totalPnl)}</td></tr>
          <tr><th scope="row">시작 금액 대비</th><td>${pct(result.gross.returnPercent)}</td><td>${pct(result.net.returnPercent)}</td></tr>
          <tr><th scope="row">이긴 거래 비율</th><td>${result.gross.winRatePercent.toFixed(1)}%</td><td>${result.net.winRatePercent.toFixed(1)}%</td></tr>
          <tr><th scope="row">이익/손실 비율</th><td>${pf(result.gross.profitFactor)}</td><td>${pf(result.net.profitFactor)}</td></tr>
        </tbody></table></div>
      ${curveSvg(result.curve)}
      <p class="demo-inline-note">같은 ${result.tradeCount.toLocaleString('ko-KR')}건에 편도 수수료 ${result.feePercent.toFixed(2)}%, 슬리피지 ${result.slippagePercent.toFixed(2)}%를 적용하니 비용 합계가 ${won(result.costTotal)}입니다. 난수로 만든 시세에 단순화한 규칙을 돌린 결과라 실제 시장의 수익성과 무관합니다.</p>`;
  }

  // The dashboard renders asynchronously; re-apply the overlay after it does.
  const observer = new MutationObserver(() => { lockLiveControls(); mountBacktest(); });
  const appRoot = document.getElementById('cp-app');
  if (appRoot) observer.observe(appRoot, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => window.setTimeout(mountBacktest, 300));
  window.addEventListener('DOMContentLoaded', () => { lockLiveControls(); mountBacktest(); render(); });
  window.setInterval(() => { lockLiveControls(); mountBacktest(); }, 2000);
  render();
})();
