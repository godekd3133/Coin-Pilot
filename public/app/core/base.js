/**
 * Deployment base path.
 *
 * The same shell is served at `/` (paper) and behind a reverse-proxy prefix
 * such as `/live/` (LIVE). Every request the shell makes — API, Socket.IO,
 * service worker — must stay under the prefix it was loaded from, otherwise a
 * page opened at `/live/` would silently talk to the paper server.
 */
export function appBasePath(doc = globalThis.document) {
  try {
    if (!doc?.baseURI) return '/';
    const pathname = new URL('./', doc.baseURI).pathname;
    return pathname.endsWith('/') ? pathname : `${pathname}/`;
  } catch {
    return '/';
  }
}

export const APP_BASE = appBasePath();

/** `/status` → `/api/status` at the root, `/live/api/status` behind `/live/`. */
export function apiUrl(path, base = APP_BASE) {
  return `${base}api${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Paper (`/`) and LIVE (`/live/`) share one browser origin and therefore one
 * localStorage. Keys that hold a token or an unsent order must never cross
 * between them. The root keeps its historical key names.
 */
export function scopedStorageKey(key, base = APP_BASE) {
  return base === '/' ? key : `${key}@${base}`;
}

/**
 * Paper and LIVE are two servers behind one sign-in. The other workspace's
 * shell lives at the sibling prefix (`/` ↔ `/live/`) on the same origin.
 */
export const LIVE_BASE = '/live/';
export function siblingBase(base = APP_BASE) {
  return base === LIVE_BASE ? '/' : base === '/' ? LIVE_BASE : null;
}

/** Same screen in the other workspace, so switching keeps the user's place. */
export function workspaceSwitchUrl(base = APP_BASE, hash = globalThis.location?.hash || '') {
  const target = siblingBase(base);
  if (!target) return null;
  return `${target}${/^#\/[\w/-]*$/.test(hash) ? hash : '#/home'}`;
}
