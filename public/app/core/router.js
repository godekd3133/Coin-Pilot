// Hash router with lazy feature loading and an enter/leave lifecycle.
// Routes: #/<featureId>[/<param>...][?query]. Unknown ids fall back to the
// default route. Only the latest navigation may mount (stale loads are dropped).

export function parseHash(hash, defaultId = 'home') {
  const value = String(hash || '').replace(/^#!?/, '');
  const [pathPart, queryPart = ''] = value.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  return { id: segments[0] || defaultId, params: segments.slice(1), query };
}

export function buildHash(id, params = [], query = {}) {
  const path = [id, ...params].map(part => encodeURIComponent(String(part))).join('/');
  const search = new URLSearchParams(query).toString();
  return `#/${path}${search ? `?${search}` : ''}`;
}

/** Validates a feature module's default export against the contract. */
export function validateFeatureModule(feature, expectedId) {
  if (!feature || typeof feature !== 'object') throw new Error(`feature ${expectedId} has no default export`);
  if (feature.id !== expectedId) throw new Error(`feature id mismatch: registry ${expectedId}, module ${feature.id}`);
  if (typeof feature.mount !== 'function') throw new Error(`feature ${expectedId} must export mount(root, ctx)`);
  if (feature.resources !== undefined && !Array.isArray(feature.resources)) throw new Error(`feature ${expectedId} resources must be an array`);
  return feature;
}

export function createRouter({ registry, defaultId = 'home', getRoot, createContext, resources, onRouteChange = () => {}, onError = () => {}, win = globalThis.window }) {
  let current = null; // { id, params, query, dispose, release, feature }
  let sequence = 0;
  const moduleCache = new Map();

  async function loadFeature(entry) {
    if (!moduleCache.has(entry.id)) {
      moduleCache.set(entry.id, Promise.resolve(entry.loader()).then(mod => validateFeatureModule(mod?.default || mod, entry.id)).catch(error => {
        moduleCache.delete(entry.id);
        throw error;
      }));
    }
    return moduleCache.get(entry.id);
  }

  function teardown() {
    if (!current) return;
    try { current.dispose?.(); } catch (error) { console.error('feature unmount failed', error); }
    try { current.release?.(); } catch { /* ignore */ }
    current = null;
  }

  async function resolve(hash = win?.location?.hash) {
    const route = parseHash(hash, defaultId);
    const entry = registry.get(route.id) || registry.get(defaultId);
    const effective = entry.id === route.id ? route : { id: entry.id, params: [], query: {} };
    const token = ++sequence;

    // Same feature, different params: let the feature handle it if it can.
    if (current && current.id === effective.id && typeof current.feature?.update === 'function') {
      current.params = effective.params;
      current.query = effective.query;
      current.feature.update(effective, current.ctx);
      onRouteChange(effective, entry);
      return effective;
    }

    onRouteChange(effective, entry, { loading: true });
    let feature;
    try {
      feature = await loadFeature(entry);
    } catch (error) {
      if (token !== sequence) return null;
      teardown();
      onError(error, entry);
      return null;
    }
    if (token !== sequence) return null;

    teardown();
    const root = getRoot();
    const release = resources?.use(feature.resources || []) || (() => {});
    const ctx = createContext({ route: effective, entry, root });
    let dispose = null;
    try {
      dispose = feature.mount(root, ctx) || null;
    } catch (error) {
      release();
      onError(error, entry);
      return null;
    }
    current = { id: effective.id, params: effective.params, query: effective.query, dispose: () => { ctx.dispose?.(); if (typeof dispose === 'function') dispose(); }, release, feature, ctx };
    onRouteChange(effective, entry, { loading: false });
    return effective;
  }

  function navigate(id, params = [], query = {}) {
    const hash = buildHash(id, params, query);
    if (win?.location?.hash === hash) return resolve(hash);
    win.location.hash = hash;
    return null;
  }

  function start() {
    win?.addEventListener?.('hashchange', () => resolve());
    return resolve();
  }

  return {
    start,
    resolve,
    navigate,
    current: () => (current ? { id: current.id, params: current.params, query: current.query } : null),
    prefetch: id => { const entry = registry.get(id); return entry ? loadFeature(entry).catch(() => null) : null; },
    stop: teardown
  };
}
