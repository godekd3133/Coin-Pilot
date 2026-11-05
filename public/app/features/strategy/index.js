// 전략 설정: trading parameters grouped by category, market filters,
// investment presets and automatic candidate comparison (optimisation).
// Saving: POST /config/update (parameters) + /investment-config/update
// ({investmentRatio}); presets: /investment-presets/apply; optimisation:
// /optimization/toggle | /optimization/interval | /optimization/run-now.
import { html, render } from '../../core/dom.js';
import { number, hasFiniteValue, fullDateTime } from '../../core/format.js';
import { card, kv, button, emptyState, skeleton, disclosure, attrs, badge } from '../../ui/components.js';
import { lockedNotice } from '../../ui/patterns.js';
import { toUserText } from '../../domain/text.js';

const CATEGORIES = {
  Investment: { label: '투자 규모', description: '한 번의 매매에 사용할 자금을 정합니다.', order: 0, open: true },
  Trading: { label: '매매 기준', description: '기본 매수·매도 판단 기준입니다.', order: 1 },
  Scalping: { label: '진입과 청산', description: '반등 확인, 재진입, 보유 시간 조건입니다.', order: 2, open: true },
  Risk: { label: '위험 관리', description: '시세 공백과 손실 상황에서 동작을 제한합니다.', order: 3, open: true },
  RSI: { label: 'RSI 지표', description: '과매도·과매수와 회복을 계산합니다.', order: 4 },
  MACD: { label: 'MACD 지표', description: '추세 변화 신호를 계산합니다.', order: 5 },
  '볼린저 밴드': { label: '볼린저 밴드', description: '가격 변동 범위를 계산합니다.', order: 6 },
  EMA: { label: '이동 평균', description: '짧은 흐름부터 긴 흐름까지 비교합니다.', order: 7 },
  Volume: { label: '거래량', description: '시장 거래 활동을 기준으로 삼습니다.', order: 8 }
};
const TOGGLES = [
  { key: 'marketRegimeEnabled', label: '시장 방향성 필터', description: '시장 전체 약세 시 신규 진입 차단.' },
  { key: 'requireReboundBelowOverbought', label: '반등 과매수 보호', description: '반등 매수 시 RSI 과매수면 진입 차단.' }
];
const INTERVALS = [[3600000, '1시간'], [7200000, '2시간'], [10800000, '3시간'], [21600000, '6시간'], [43200000, '12시간'], [86400000, '24시간']];

export default {
  id: 'strategy',
  resources: ['parameterRanges', 'optimalConfig', 'investmentConfig', 'presets', 'optimization', 'paper', 'status'],
  mount(root, ctx) {
    let formRendered = false;
    render(root, html`<div class="cp-page">
      <div data-slot="lock"></div>
      <div class="cp-split">
        <div class="cp-stack"><div data-slot="summary"></div><div data-slot="form"></div></div>
        <div class="cp-stack"><div data-slot="presets"></div><div data-slot="optimization"></div></div>
      </div>
    </div>`);
    const slot = name => root.querySelector(`[data-slot="${name}"]`);

    function lockReason() {
      const s = ctx.session();
      if (!s.canMutate) return s.mutationBlockedReason;
      if (s.evidenceLock?.locked) return s.evidenceLock.reason || '모의투자 실행 중에는 설정을 바꿀 수 없습니다.';
      return null;
    }

    function values() {
      const optimal = ctx.data('optimalConfig');
      const config = ctx.data('investmentConfig');
      return { ...(optimal?.parameters || {}), ...(config?.scalping || {}), investmentRatio: config?.investmentRatio ?? optimal?.parameters?.investmentRatio };
    }

    function renderSummary() {
      const config = ctx.data('investmentConfig');
      const current = values();
      render(slot('summary'), card({
        index: 0,
        title: '현재 저장된 매매 조건',
        body: config ? html`${kv([
          ['1회 투자 비율', hasFiniteValue(current.investmentRatio) ? `${(Number(current.investmentRatio) * 100).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}%` : '미제공'],
          ['동시 보유 한도', hasFiniteValue(config.maxPositions) ? `${config.maxPositions}개` : '미제공'],
          ['손절 기준', hasFiniteValue(current.stopLossPercent) ? `${current.stopLossPercent}% 하락` : '미제공'],
          ['익절 기준', hasFiniteValue(current.takeProfitPercent) ? `${current.takeProfitPercent}% 상승` : '미제공']
        ])}<p class="cp-caption" style="margin-top:8px">손절·익절은 주문 시도 기준. 실제 손익은 체결에 따라 다름.</p>` : skeleton({ lines: 3 })
      }));
    }

    function renderForm(force = false) {
      const ranges = ctx.data('parameterRanges');
      const config = ctx.data('investmentConfig');
      if (!ranges || !config) {
        const failed = ctx.resource('parameterRanges').status === 'error' || ctx.resource('investmentConfig').status === 'error';
        render(slot('form'), card({ index: 1, title: '매매 조건 변경', body: failed ? emptyState({ iconName: 'alert', title: '거래 설정 불러오기 실패', body: '서버 연결 확인 후 다시 불러오기.', action: button({ label: '다시 불러오기', attrs: { 'data-action': 'reload' } }) }) : skeleton({ lines: 6 }) }));
        return;
      }
      if (formRendered && !force) return;
      formRendered = true;
      const current = values();
      const groups = new Map();
      for (const [key, range] of Object.entries(ranges)) {
        const category = range?.category || 'Other';
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push([key, range || {}]);
      }
      const toggleRows = TOGGLES.map(item => html`<div class="cp-setting-row"><div class="cp-setting-copy"><strong>${item.label}</strong><span>${item.description}</span></div><label class="cp-switch"><input type="checkbox" aria-label="${item.label}" data-setting="${item.key}" ${attrs({ checked: config.scalping?.[item.key] === true })}><span class="cp-switch-track"></span></label></div>`);
      const groupHtml = [...groups.entries()]
        .sort(([a], [b]) => (CATEGORIES[a]?.order ?? 99) - (CATEGORIES[b]?.order ?? 99))
        .map(([category, entries]) => {
          const meta = CATEGORIES[category] || { label: '기타 설정', description: '추가 전략 조정 항목입니다.' };
          const rows = entries.map(([key, range]) => {
            const percentDisplay = key === 'investmentRatio';
            const raw = current[key] ?? range.min ?? 0;
            const display = percentDisplay ? number(raw) * 100 : raw;
            return html`<div class="cp-setting-row"><div class="cp-setting-copy"><strong>${toUserText(range.label || key)}</strong><span>${toUserText(range.description || '')}</span></div><input class="cp-input cp-num" type="number" aria-label="${toUserText(range.label || key)}" data-setting="${key}" data-display="${percentDisplay ? 'percent' : 'raw'}" ${attrs({ min: percentDisplay ? number(range.min) * 100 : range.min, max: percentDisplay ? number(range.max) * 100 : range.max, step: percentDisplay ? number(range.step) * 100 : range.step, value: display })}></div>`;
          });
          return disclosure({ summary: `${meta.label} · ${entries.length}개`, meta: meta.description, open: meta.open === true, body: html`${rows}` });
        });
      render(slot('form'), card({
        index: 1,
        title: '매매 조건 변경',
        subtitle: '다음 판단부터 반영. 실전은 변경 후 재점검 필요.',
        body: html`<form class="cp-stack" data-form="settings">
          ${disclosure({ summary: `시장 필터 · ${TOGGLES.length}개`, meta: '신규 진입을 제한하는 추가 보호', open: true, body: html`${toggleRows}` })}
          ${groupHtml}
          <div class="cp-actions">${button({ label: '다시 불러오기', attrs: { 'data-action': 'reload' } })}${button({ label: '설정 적용', variant: 'primary', type: 'submit', attrs: { 'data-lockable': '' } })}</div>
        </form>`
      }));
      syncLocks();
    }

    function renderPresets() {
      const presets = ctx.data('presets');
      render(slot('presets'), card({
        index: 2,
        title: '투자 프리셋',
        subtitle: '설정 묶음 일괄 적용.',
        body: presets === null ? skeleton({ lines: 3 }) : presets.length ? html`<div class="cp-list">${presets.map(preset => html`<button type="button" class="cp-list-row is-link" data-preset="${preset.id}" data-lockable><span class="cp-row-main"><span class="cp-row-title">${preset.name}</span><span class="cp-row-sub">${toUserText(preset.description || '')}</span></span><span class="cp-row-trailing">${badge(Number.isFinite(Number(preset.riskLevel)) ? `위험 ${preset.riskLevel}/5` : '위험 정보 없음', Number(preset.riskLevel) >= 4 ? 'danger' : Number(preset.riskLevel) >= 3 ? 'warning' : 'ok')}</span></button>`)}</div>` : emptyState({ title: '프리셋 없음' })
      }));
      syncLocks();
    }

    function renderOptimization() {
      const optimization = ctx.data('optimization');
      render(slot('optimization'), card({
        index: 3,
        title: '자동 후보 비교',
        subtitle: '주기적 설정 비교. 자동 적용 안 함.',
        body: optimization === null ? skeleton({ lines: 3 }) : html`
          <div class="cp-setting-row"><div class="cp-setting-copy"><strong>자동 비교</strong><span>다음 확인: ${fullDateTime(optimization.nextRun)}</span></div><label class="cp-switch"><input type="checkbox" aria-label="자동 후보 비교" data-opt="toggle" data-lockable ${attrs({ checked: optimization.enabled === true })}><span class="cp-switch-track"></span></label></div>
          <div class="cp-setting-row"><div class="cp-setting-copy"><strong>비교 간격</strong><span>${optimization.isRunning ? '지금 비교 중' : '대기 중'}</span></div><select class="cp-input" style="width:140px" data-opt="interval" aria-label="후보 비교 간격" data-lockable>${INTERVALS.map(([value, label]) => html`<option value="${value}" ${attrs({ selected: Number(optimization.interval) === value })}>${label}</option>`)}</select></div>
          <div class="cp-setting-row"><div class="cp-setting-copy"><strong>지금 비교</strong><span>현재 설정과 후보 결과 비교</span></div>${button({ label: '비교 시작', size: 'sm', variant: 'primary', attrs: { 'data-opt': 'run', 'data-lockable': '' } })}</div>`
      }));
      syncLocks();
    }

    function syncLocks() {
      const reason = lockReason();
      render(slot('lock'), reason ? lockedNotice(reason) : '');
      root.querySelectorAll('[data-lockable]').forEach(control => { control.disabled = Boolean(reason); });
      root.querySelectorAll('[data-form="settings"] [data-setting]').forEach(control => { control.disabled = Boolean(reason); });
    }

    function payload() {
      const result = {};
      root.querySelectorAll('[data-form="settings"] [data-setting]').forEach(input => {
        const key = input.dataset.setting;
        if (input.type === 'checkbox') result[key] = input.checked;
        else { const raw = number(input.value); result[key] = input.dataset.display === 'percent' ? raw / 100 : raw; }
      });
      return result;
    }

    async function save() {
      const reason = lockReason();
      if (reason) { ctx.ui.toast(reason, 'warning'); return; }
      const s = ctx.session();
      const ok = await ctx.confirm({ title: '설정 적용', message: s.isLive ? '실전 설정 변경 시 고정 설정 검증 리포트와 불일치 · 실전 시작 잠길 수 있음.' : '다음 판단부터 적용.', confirmLabel: '적용', live: s.isLive });
      if (!ok) return;
      const body = payload();
      const investmentRatio = body.investmentRatio;
      delete body.investmentRatio;
      const result = await ctx.control(async api => {
        await api.post('/config/update', body);
        if (investmentRatio !== undefined) await api.post('/investment-config/update', { investmentRatio });
        return { success: true, message: '설정 적용됨 · 다음 점검에서 확인.' };
      }, { failure: '설정 적용 실패', refresh: ['optimalConfig', 'investmentConfig', 'status', 'readiness'] });
      if (result) { formRendered = false; setTimeout(() => renderForm(true), 400); }
    }

    async function applyPreset(id) {
      const reason = lockReason();
      if (reason) { ctx.ui.toast(reason, 'warning'); return; }
      const preset = (ctx.data('presets') || []).find(item => item.id === id);
      if (!preset) return;
      const ok = await ctx.confirm({ title: `${preset.name} 설정 적용`, message: '현재 전략 설정이 바뀝니다.', confirmLabel: '적용', live: ctx.session().isLive });
      if (!ok) return;
      const result = await ctx.control(api => api.post('/investment-presets/apply', { presetId: id, config: preset.config }), { success: `${preset.name} 설정을 적용했습니다.`, failure: '설정을 적용하지 못했습니다', refresh: ['optimalConfig', 'investmentConfig', 'status'] });
      if (result) { formRendered = false; setTimeout(() => renderForm(true), 400); }
    }

    ctx.watch([ctx.res('investmentConfig'), ctx.res('optimalConfig')], renderSummary);
    ctx.watch([ctx.res('parameterRanges'), ctx.res('investmentConfig'), ctx.res('optimalConfig')], () => renderForm());
    ctx.watch([ctx.res('presets')], renderPresets);
    ctx.watch([ctx.res('optimization')], renderOptimization);
    ctx.watch([ctx.res('paper'), ctx.res('status'), 'auth', 'online', ctx.res('investmentConfig'), ctx.res('optimization')], syncLocks);

    ctx.on('submit', '[data-form="settings"]', event => { event.preventDefault(); save(); });
    ctx.on('click', '[data-action="reload"]', () => { formRendered = false; ['parameterRanges', 'optimalConfig', 'investmentConfig'].forEach(name => ctx.resources.refresh(name)); });
    ctx.on('click', '[data-preset]', (event, target) => applyPreset(target.dataset.preset));
    ctx.on('change', '[data-opt="toggle"]', async (event, target) => {
      const reason = lockReason();
      if (reason) { target.checked = !target.checked; ctx.ui.toast(reason, 'warning'); return; }
      await ctx.control(api => api.post('/optimization/toggle', { enabled: target.checked }), { success: '자동 후보 비교 설정을 저장했습니다.', failure: '자동 후보 비교 설정을 저장하지 못했습니다', refresh: ['optimization'] });
    });
    ctx.on('change', '[data-opt="interval"]', async (event, target) => {
      await ctx.control(api => api.post('/optimization/interval', { interval: number(target.value) }), { success: '비교 간격을 저장했습니다.', failure: '비교 간격을 저장하지 못했습니다', refresh: ['optimization'] });
    });
    ctx.on('click', '[data-opt="run"]', async () => {
      const ok = await ctx.confirm({ title: '후보 비교 시작', message: '현재 설정과 후보 결과 비교. 자동 적용 안 함.', confirmLabel: '비교 시작' });
      if (!ok) return;
      await ctx.control(api => api.post('/optimization/run-now'), { success: '설정 후보 비교를 시작했습니다.', failure: '설정 후보를 비교하지 못했습니다', refresh: ['optimization', 'optimizationHistory'] });
    });
  }
};
