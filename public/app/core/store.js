// Small observable store. State is a flat object of top-level keys; each set()
// notifies subscribers whose key list intersects the changed keys.

export function createStore(initial = {}) {
  let state = { ...initial };
  const listeners = new Set();

  function get(key) {
    return key === undefined ? state : state[key];
  }

  function set(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (!next || typeof next !== 'object') return;
    const changed = Object.keys(next).filter(key => !Object.is(state[key], next[key]));
    if (changed.length === 0) return;
    state = { ...state, ...next };
    for (const listener of [...listeners]) {
      if (!listener.keys || listener.keys.some(key => changed.includes(key))) {
        try { listener.fn(state, changed); } catch (error) { console.error('store listener failed', error); }
      }
    }
  }

  function update(key, updater) {
    set({ [key]: updater(state[key]) });
  }

  /** subscribe(fn) or subscribe(['a','b'], fn). Returns an unsubscribe function. */
  function subscribe(keysOrFn, maybeFn) {
    const listener = typeof keysOrFn === 'function'
      ? { keys: null, fn: keysOrFn }
      : { keys: [].concat(keysOrFn), fn: maybeFn };
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function select(selector) {
    return selector(state);
  }

  return { get, set, update, subscribe, select };
}
