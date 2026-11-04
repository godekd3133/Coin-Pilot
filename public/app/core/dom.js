// DOM helpers. `html` is an auto-escaping tagged template: every interpolated
// value is escaped unless it is a SafeHtml produced by `html`, `raw` or a
// component. Arrays are flattened, null/undefined/false render as nothing.
// The template functions are DOM-free so they can be unit-tested in Node.

export class SafeHtml {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function serialize(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(serialize).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += serialize(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Trusted markup only (static SVG icons, already-escaped strings). */
export function raw(value) {
  return new SafeHtml(value ?? '');
}

/** Joins safe fragments. */
export function join(items, separator = '') {
  return new SafeHtml((items || []).map(serialize).join(serialize(separator)));
}

export function classNames(...parts) {
  return parts.flat().filter(Boolean).join(' ');
}

/** Replaces the children of `target` with the given SafeHtml. */
export function render(target, content) {
  if (!target) return null;
  // Periodic refreshes must not collapse a disclosure the user opened.
  const openKeys = new Set();
  target.querySelectorAll?.('details[open] > summary').forEach(summary => openKeys.add(summary.textContent.trim()));
  target.innerHTML = serialize(content);
  if (openKeys.size) {
    target.querySelectorAll('details > summary').forEach(summary => {
      if (openKeys.has(summary.textContent.trim())) summary.parentElement.open = true;
    });
  }
  return target;
}

export function $(selector, scope) {
  return (scope || globalThis.document).querySelector(selector);
}

export function $$(selector, scope) {
  return Array.from((scope || globalThis.document).querySelectorAll(selector));
}

/** Delegated event listener; returns a disposer. */
export function on(target, type, selector, handler, options) {
  const listener = event => {
    const match = selector ? event.target?.closest?.(selector) : target;
    if (match && (!selector || target.contains(match))) handler(event, match);
  };
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}
