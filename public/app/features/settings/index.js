// 설정: connection & token scope, workspace (모의/실전) and live-key status,
// theme, push notification delivery, app install/update and tool shortcuts.
import { scopedStorageKey } from '../../core/base.js';
import { html, render } from '../../core/dom.js';
import { relativeTime, dateTime } from '../../core/format.js';
import { card, kv, badge, button, segmented, notice, list, listRow, icon, liveBadge, paperBadge } from '../../ui/components.js';

const TOKEN_KEYS = ['coinpilot.dashboardToken', 'coinpilot.dashboardTokenScope'].map(key => scopedStorageKey(key));
const SCOPE_LABELS = { operator: '운영자 (조회·주문·설정)', read_only: '읽기 전용 (자산·손익 조회)', mobile_operator: '모바일 앱 전용' };

export default {
  id: 'settings',
  resources: ['status', 'notifications'],
  mount(root, ctx) {
    render(root, html`<div class="cp-page"><div class="cp-grid-2" data-slot="grid"></div><div data-slot="tools"></div></div>`);
    const grid = root.querySelector('[data-slot="grid"]');

    function renderPage() {
      const s = ctx.session();
      const auth = s.auth || {};
      const status = s.status;
      const notifications = ctx.data('notifications');
      const theme = ctx.store.get('theme');
      const install = ctx.store.get('installPrompt');
      const connection = auth.authRequired === false ? '토큰 없이 접속 (내부망 전용 서버)' : auth.verification === 'verified' ? SCOPE_LABELS[auth.tokenScope] || auth.tokenScope : auth.verification === 'unavailable' ? '권한 확인 실패' : auth.verification === 'missing' ? '토큰 필요' : '확인 중';
      render(grid, html`
        ${card({
          index: 0,
          title: '서버 연결',
          body: html`${kv([
            ['서버', location.host],
            ['접속 권한', connection],
            ['네트워크', s.online ? '온라인' : '오프라인'],
            ['실시간 알림', ctx.store.get('realtime')?.connected ? '연결됨' : '주기적 갱신'],
            ['서버 상태 갱신', relativeTime(ctx.resource('status').lastSuccessAt)]
          ])}
          <div class="cp-actions" style="margin-top:12px">
            ${auth.authRequired === true ? button({ label: '토큰 변경', iconName: 'key', attrs: { 'data-action': 'change-token' } }) : ''}
            ${auth.authRequired === true ? button({ label: '이 기기에서 로그아웃', iconName: 'logout', attrs: { 'data-action': 'logout' } }) : ''}
          </div>
          <p class="cp-caption" style="margin-top:8px">접속 토큰은 이 브라우저에만 저장돼요. 거래소 API 키와는 다른 값이에요.</p>`
        })}
        ${card({
          index: 1,
          title: '작업공간',
          tone: s.isLive ? 'live' : undefined,
          action: s.isLive ? liveBadge() : s.isPaper ? paperBadge() : badge('확인 중'),
          body: html`${kv([
            ['거래 모드', s.isLive ? '실전 — 실제 자금으로 주문' : s.isPaper ? '모의투자 — 가상 자금' : '확인 중'],
            ['거래소', status?.exchange ? String(status.exchange).toUpperCase() === 'UPBIT' ? '국내 원화 거래소' : status.exchange : '—'],
            ['거래소 키', status?.upbitCredentialsConfigured ? '등록됨' : s.isLive ? '등록 필요' : '모의투자에는 필요 없음'],
            ['수동 실전 준비', status?.liveManualPrepared ? '완료' : s.isLive ? '대기' : '—'],
            ['전략', status?.strategyMode === 'oversold_reaction_scalping' ? '1분봉 과매도 반등 스캘핑' : status?.strategyMode || '—'],
            ['최대 보유', status?.maxPositions ? `${status.maxPositions}개` : '—']
          ])}
          ${s.isLive && !status?.upbitCredentialsConfigured ? html`<div style="margin-top:12px">${notice({ tone: 'warning', iconName: 'key', title: '거래소 키 등록', body: '보안을 위해 거래소 키는 모바일 앱에서만 등록할 수 있어요 (HTTPS · 모바일 운영 토큰 · 서버 정지 상태). 키는 어떤 화면에서도 다시 표시되지 않아요.' })}</div>` : ''}
          <p class="cp-caption" style="margin-top:8px">모의/실전은 서버 프로필로 정해져요. 화면에서 바꿀 수 없어요.</p>`
        })}
        ${card({
          index: 2,
          title: '화면',
          body: html`<div class="cp-setting-row"><div class="cp-setting-copy"><strong>테마</strong><span>시스템 설정을 따르거나 직접 고를 수 있어요.</span></div>${segmented({ name: 'theme', label: '테마', value: theme, options: [{ value: 'system', label: '시스템' }, { value: 'light', label: '라이트' }, { value: 'dark', label: '다크' }] })}</div>
            <div class="cp-setting-row"><div class="cp-setting-copy"><strong>손익 색상</strong><span>국내 관례: <b class="cp-up">상승·수익은 빨강</b>, <b class="cp-down">하락·손실은 파랑</b></span></div></div>
            <div class="cp-setting-row"><div class="cp-setting-copy"><strong>앱으로 설치</strong><span>${install ? '홈 화면에 추가해 앱처럼 사용할 수 있어요.' : '이미 설치했거나 이 브라우저에서 지원하지 않아요. iOS는 공유 → 홈 화면에 추가를 사용하세요.'}</span></div>${install ? button({ label: '설치', size: 'sm', variant: 'primary', attrs: { 'data-action': 'install' } }) : ''}</div>`
        })}
        ${card({
          index: 3,
          title: '체결 알림',
          body: notifications ? html`${kv([
            ['푸시 발송', notifications.configured ? '설정됨' : '서버에 발송 설정 없음'],
            ['등록 기기', `${notifications.registeredDevices ?? 0}대 (모바일 앱)`],
            ['알림 기록', `${notifications.events ?? 0}건 · 대기 ${notifications.queued ?? 0} · 실패 ${notifications.failed ?? 0}`],
            ['마지막 알림', notifications.lastEventAt ? dateTime(notifications.lastEventAt) : '—']
          ])}${notifications.error ? html`<div style="margin-top:10px">${notice({ tone: 'warning', body: ctx.toUserText(notifications.error) })}</div>` : ''}<p class="cp-caption" style="margin-top:8px">체결 푸시는 모바일 앱에서 기기를 등록하면 받을 수 있어요. 웹에서는 화면 안 알림으로 표시해요.</p>`
            : html`<p class="cp-caption">${ctx.resource('notifications').status === 'error' ? '알림 상태를 불러오지 못했어요.' : '불러오는 중…'}</p>`
        })}`);
      renderTools();
    }

    function renderTools() {
      const tools = ctx.registry.tools();
      render(root.querySelector('[data-slot="tools"]'), card({
        index: 4,
        title: '도구',
        body: list(tools.map(feature => listRow({ leading: html`<span class="cp-avatar is-neutral">${icon(feature.icon, { size: 20 })}</span>`, title: feature.label, subtitle: feature.group, href: `#/${feature.id}`, trailing: icon('chevronRight', { size: 18 }) })))
      }));
    }

    ctx.watch([ctx.res('status'), ctx.res('notifications'), 'auth', 'online', 'theme', 'installPrompt', 'realtime'], renderPage);
    ctx.on('click', '[data-segment="theme"]', (event, target) => ctx.store.setTheme?.(target.dataset.value));
    ctx.on('click', '[data-action="change-token"]', () => window.coinPilotAuth?.requestLogin?.(''));
    ctx.on('click', '[data-action="logout"]', async () => {
      const ok = await ctx.confirm({ title: '이 기기에서 로그아웃할까요?', message: '저장된 접속 토큰을 지웁니다. 다시 접속하려면 토큰을 입력해야 해요.', confirmLabel: '로그아웃', tone: 'danger' });
      if (!ok) return;
      for (const key of TOKEN_KEYS) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
      location.reload();
    });
    ctx.on('click', '[data-action="install"]', async () => {
      const prompt = ctx.store.get('installPrompt');
      if (!prompt) return;
      prompt.prompt();
      try { await prompt.userChoice; } catch { /* ignore */ }
      ctx.store.set({ installPrompt: null });
    });
  }
};
