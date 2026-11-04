/*
 * Replaces the dashboard's network boundary for the static demo. Must load
 * before auth-client.js. Nothing here can reach a backend: /api/* resolves
 * from the in-page simulator and any other non-same-origin fetch is refused.
 */
(function () {
  'use strict';

  const STATE_KEY = 'coinpilot.demo.state.v1';
  const PROGRESS_KEY = 'coinpilot.demo.progress.v1';
  const core = window.CoinPilotDemoCore;
  const seed = core.DEFAULT_SEED;

  const read = key => { try { return JSON.parse(window.localStorage.getItem(key)); } catch { return null; } };
  const write = (key, value) => { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* demo keeps running in memory */ } };

  // No service worker or push in the demo, so nothing outlives the page.
  try { delete window.Navigator.prototype.serviceWorker; } catch { /* unsupported */ }
  try { delete window.PushManager; } catch { /* unsupported */ }
  if (window.Notification) {
    try { window.Notification.requestPermission = () => Promise.resolve('denied'); } catch { /* unsupported */ }
  }

  const sim = core.createDemoSim({ seed, savedState: read(STATE_KEY) });
  const rawFetch = window.fetch.bind(window);
  const listeners = new Map();
  const uiListeners = new Set();
  let speed = 1;
  let timer = null;

  const save = () => write(STATE_KEY, sim.state);

  function dispatch(events) {
    events.forEach(([name, payload]) => (listeners.get(name) || []).slice().forEach(listener => listener(payload)));
    uiListeners.forEach(listener => listener());
  }

  function schedule() {
    window.clearInterval(timer);
    timer = window.setInterval(() => { dispatch(sim.tick()); save(); }, 1000 / speed);
  }

  function respond(status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Status': 'completed', 'X-Coin-Pilot-Demo': 'synthetic' }
    });
  }

  window.fetch = async function demoFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    const parsed = new URL(url, window.location.href);
    const method = String(init.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    if (parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/')) {
      let body;
      try { body = init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
      const result = sim.handle(method, parsed.pathname + parsed.search, body);
      save();
      dispatch(sim.drainEvents());
      return respond(result.status, result.body);
    }
    if (parsed.origin !== window.location.origin) {
      throw new TypeError('체험판은 외부 네트워크 요청을 보내지 않습니다.');
    }
    return rawFetch(input, init);
  };

  // Socket.IO stand-in. Events come from the simulator instead of a server.
  window.io = function demoIo() {
    const socket = {
      connected: true,
      on(name, listener) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(listener);
        if (name === 'connect') window.setTimeout(() => listener(), 0);
        return socket;
      },
      once(name, listener) { return socket.on(name, listener); },
      off(name, listener) {
        const bucket = listeners.get(name) || [];
        listeners.set(name, listener ? bucket.filter(item => item !== listener) : []);
        return socket;
      },
      emit() { return socket; },
      connect() { return socket; },
      disconnect() { return socket; }
    };
    return socket;
  };

  window.CoinPilotDemo = {
    sim,
    core,
    onChange(listener) { uiListeners.add(listener); },
    setSpeed(next) { speed = next; schedule(); uiListeners.forEach(listener => listener()); },
    get speed() { return speed; },
    triggerCrash() { const result = sim.triggerCrash(); save(); uiListeners.forEach(listener => listener()); return result; },
    progress: Object.assign({ intro: false, backtest: false }, read(PROGRESS_KEY)),
    saveProgress() { write(PROGRESS_KEY, this.progress); },
    resetAll() {
      window.clearInterval(timer);
      try {
        Object.keys(window.localStorage)
          .filter(key => key.startsWith('coinpilot.') || key === 'currentPilotView')
          .forEach(key => window.localStorage.removeItem(key));
      } catch { /* storage may be blocked */ }
      window.location.replace(window.location.pathname);
    }
  };

  schedule();
})();
