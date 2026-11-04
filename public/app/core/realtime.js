// Realtime events → store. Uses the Socket.IO client wrapped by auth-client.js
// (it defers the connection until the token scope is verified and attaches
// the token). Each server event maps to resource refreshes and/or a store
// key, so screens only ever read from the store.

export const REALTIME_EVENTS = {
  'auto-trade': { refresh: ['account', 'trades', 'status', 'today', 'pnl'], toast: payload => {
    const trade = payload?.trade || payload;
    const coin = String(trade?.coin || '').replace(/^[A-Z]+-/, '') || '자동';
    return { message: `${coin} ${trade?.type === 'SELL' ? '매도' : '매수'} 체결 알림`, tone: trade?.type === 'SELL' ? 'warning' : 'success' };
  } },
  'new-signal': { store: 'lastSignal', toast: payload => payload?.type === 'bundle' && payload?.bundle
    ? { message: `리밸런싱 제안: ${payload.bundle.summary || '새 묶음 제안'}`, tone: 'info', route: 'trade' }
    : { message: '새 신호가 도착했습니다.', tone: 'info' } },
  'breaking-news': { store: 'lastBreakingNews', toast: news => ({ message: `속보: ${news?.title || '새로운 뉴스'}`, tone: 'warning', route: 'news' }) },
  'ai-monitoring-event': { store: 'aiEvent', pick: data => data?.event },
  'ai-consultation': { store: 'aiConsultation', pick: data => data?.consultation },
  'ai-session-update': { store: 'aiSession', pick: data => data?.session }
};

export function connectRealtime({ store, resources, toast = () => {}, io = globalThis.window?.io }) {
  if (typeof io !== 'function') {
    store.set({ realtime: { connected: false, available: false } });
    return () => {};
  }
  let socket;
  try {
    socket = io();
  } catch {
    store.set({ realtime: { connected: false, available: false } });
    return () => {};
  }
  store.set({ realtime: { connected: false, available: true } });
  socket.on('connect', () => store.set({ realtime: { connected: true, available: true } }));
  socket.on('disconnect', () => store.set({ realtime: { connected: false, available: true } }));

  for (const [name, rule] of Object.entries(REALTIME_EVENTS)) {
    socket.on(name, payload => {
      const value = rule.pick ? rule.pick(payload) : payload;
      if (rule.pick && !value) return;
      if (rule.store) store.set({ [rule.store]: { value, at: Date.now() } });
      for (const resource of rule.refresh || []) if (resources.has(resource)) resources.refresh(resource);
      const message = rule.toast?.(payload);
      if (message) toast(message.message, message.tone, message.route ? { route: message.route } : undefined);
    });
  }
  return () => { try { socket.disconnect?.(); } catch { /* ignore */ } };
}
