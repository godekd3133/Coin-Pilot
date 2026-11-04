// Resource layer: named reads with a fetcher and refresh interval. Features
// declare which resources they need; the manager reference-counts them,
// polls only active ones, pauses while the document is hidden and refreshes
// immediately when it becomes visible again.
//
// Store shape per resource (key `res:<name>`):
//   { data, error, status: 'idle'|'loading'|'ready'|'error', updatedAt, lastSuccessAt }
// A failed refresh keeps the previous data and its success time; a denied read
// (401/403) clears both so stale private data is never shown after a scope change.

export function resourceKey(name) {
  return `res:${name}`;
}

export const EMPTY_RESOURCE = Object.freeze({ data: null, error: null, status: 'idle', updatedAt: null, lastSuccessAt: null });

export function nextResourceState(previous, { ok, data, error, now }) {
  const base = previous || EMPTY_RESOURCE;
  if (ok) return { data, error: null, status: 'ready', updatedAt: now, lastSuccessAt: now };
  const denied = error?.status === 401 || error?.status === 403;
  return {
    data: denied ? null : base.data,
    error: error || new Error('unknown'),
    status: 'error',
    updatedAt: now,
    lastSuccessAt: denied ? null : base.lastSuccessAt
  };
}

export function createResourceManager({ store, api, definitions = {}, doc = globalThis.document, now = () => Date.now(), setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval }) {
  const defs = new Map(Object.entries(definitions));
  const refCounts = new Map();
  const timers = new Map();
  const inFlight = new Map();
  const params = new Map();

  const hidden = () => doc?.hidden === true;

  function define(name, definition) {
    defs.set(name, definition);
  }

  function getState(name) {
    return store.get(resourceKey(name)) || EMPTY_RESOURCE;
  }

  function setParams(name, value) {
    params.set(name, value);
    return refresh(name);
  }

  function getParams(name) {
    return params.has(name) ? params.get(name) : defs.get(name)?.defaultParams;
  }

  async function refresh(name, { force = false } = {}) {
    const def = defs.get(name);
    if (!def) throw new Error(`Unknown resource: ${name}`);
    if (inFlight.has(name) && !force) return inFlight.get(name);
    const previous = getState(name);
    if (previous.status === 'idle' || (previous.data === null && previous.status !== 'loading')) {
      store.set({ [resourceKey(name)]: { ...previous, status: 'loading' } });
    }
    const run = (async () => {
      try {
        const data = await def.fetch(api, getParams(name));
        store.set({ [resourceKey(name)]: nextResourceState(getState(name), { ok: true, data, now: now() }) });
        def.onData?.(data, { store });
        return data;
      } catch (error) {
        store.set({ [resourceKey(name)]: nextResourceState(getState(name), { ok: false, error, now: now() }) });
        return null;
      } finally {
        inFlight.delete(name);
      }
    })();
    inFlight.set(name, run);
    return run;
  }

  function schedule(name) {
    const def = defs.get(name);
    if (!def?.interval || timers.has(name)) return;
    timers.set(name, setIntervalImpl(() => {
      if (!hidden()) refresh(name);
    }, def.interval));
  }

  function unschedule(name) {
    if (!timers.has(name)) return;
    clearIntervalImpl(timers.get(name));
    timers.delete(name);
  }

  /** Activates resources; returns a release function. */
  function use(names) {
    const list = [...new Set([].concat(names || []))].filter(name => defs.has(name));
    for (const name of list) {
      const count = refCounts.get(name) || 0;
      refCounts.set(name, count + 1);
      if (count === 0) {
        schedule(name);
        const state = getState(name);
        const def = defs.get(name);
        const stale = !state.lastSuccessAt || !def.interval || now() - state.lastSuccessAt > Math.min(def.interval, 10_000);
        if (!def.manual && (state.status === 'idle' || stale)) refresh(name);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const name of list) {
        const count = (refCounts.get(name) || 1) - 1;
        if (count <= 0) { refCounts.delete(name); unschedule(name); } else refCounts.set(name, count);
      }
    };
  }

  function active() {
    return [...refCounts.keys()];
  }

  function onVisible() {
    if (!hidden()) for (const name of active()) if (!defs.get(name)?.manual) refresh(name);
  }

  doc?.addEventListener?.('visibilitychange', onVisible);

  return {
    define,
    use,
    refresh,
    refreshActive: () => Promise.all(active().filter(name => !defs.get(name)?.manual).map(name => refresh(name))),
    setParams,
    getParams,
    getState,
    active,
    has: name => defs.has(name),
    _onVisible: onVisible,
    dispose() {
      for (const name of [...timers.keys()]) unschedule(name);
      doc?.removeEventListener?.('visibilitychange', onVisible);
    }
  };
}
