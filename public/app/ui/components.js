// Shared components. Markup builders return SafeHtml (escaped templates);
// the interactive helpers (sheet, toast, count-up) touch the DOM and are only
// used in the browser.
import { html, raw, classNames, escapeHtml } from '../core/dom.js';
import { icon } from './icons.js';
import { hasFiniteValue, won, signedWon, percent } from '../core/format.js';

export { icon };
import { sparkline, areaChart, candleChart } from './charts.js';

export { sparkline, areaChart, candleChart };

export function attrs(map = {}) {
  return raw(Object.entries(map)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => (value === true ? escapeHtml(key) : `${escapeHtml(key)}="${escapeHtml(value)}"`))
    .join(' '));
}

export function button({ label, variant = 'secondary', size, iconName, attrs: extra = {}, disabled = false, type = 'button', title } = {}) {
  return html`<button type="${type}" class="${classNames('cp-btn', `is-${variant}`, size && `is-${size}`)}" ${attrs({ ...extra, disabled, title, 'aria-disabled': disabled ? 'true' : undefined })}>${iconName ? icon(iconName, { size: 18 }) : ''}<span>${label}</span></button>`;
}

export function linkButton({ label, href, variant = 'secondary', iconName, external = false }) {
  return html`<a class="${classNames('cp-btn', `is-${variant}`)}" href="${href}" ${attrs(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>${iconName ? icon(iconName, { size: 18 }) : ''}<span>${label}</span></a>`;
}

export function card({ title, subtitle, action, body, className, id, tone, index, headingLevel = 2 } = {}) {
  const heading = title ? raw(`<h${headingLevel} class="cp-card-title">${escapeHtml(title)}</h${headingLevel}>`) : '';
  return html`<section class="${classNames('cp-card', tone && `is-${tone}`, className)}" ${attrs({ id, style: index !== undefined ? `--i:${index}` : undefined })}>
    ${title || action ? html`<header class="cp-card-head"><div class="cp-card-heading">${heading}${subtitle ? html`<p class="cp-card-sub">${subtitle}</p>` : ''}</div>${action ? html`<div class="cp-card-action">${action}</div>` : ''}</header>` : ''}
    ${body}
  </section>`;
}

export function badge(text, tone = 'neutral', { dot = false, title } = {}) {
  return html`<span class="${classNames('cp-badge', `is-${tone}`)}" ${attrs({ title })}>${dot ? html`<i class="cp-badge-dot" aria-hidden="true"></i>` : ''}${text}</span>`;
}

export function liveBadge() {
  return html`<span class="cp-badge is-live" title="실제 자금으로 거래하는 작업공간입니다"><i class="cp-badge-dot" aria-hidden="true"></i>실전</span>`;
}

export function paperBadge() {
  return html`<span class="cp-badge is-info" title="가상 자금으로 거래하는 작업공간입니다">모의</span>`;
}

/** Big amount + change. The value counts up from its last shown value (data-countup). */
export function heroValue({ label, value, key, change, changePercent, sub, formatter = 'won' }) {
  const known = hasFiniteValue(value);
  const countKey = key || label;
  const changeTone = hasFiniteValue(change) ? (Number(change) > 0 ? 'up' : Number(change) < 0 ? 'down' : '') : hasFiniteValue(changePercent) ? (Number(changePercent) > 0 ? 'up' : Number(changePercent) < 0 ? 'down' : '') : '';
  const changeParts = [
    hasFiniteValue(change) ? html`<span ${countAttrs(change, { key: `${countKey}:change`, format: 'signedWon' })}>${signedWon(change)}</span>` : null,
    hasFiniteValue(changePercent) ? html`<span>(<span ${countAttrs(changePercent, { key: `${countKey}:percent`, format: 'percent' })}>${percent(changePercent)}</span>)</span>` : null
  ].filter(Boolean);
  return html`<div class="cp-hero">
    <p class="cp-hero-label cp-reveal">${label}</p>
    <p class="cp-hero-value cp-num" ${attrs(known ? { 'data-countup': Number(value), 'data-countup-key': countKey, 'data-countup-format': formatter } : {})}>${known ? won(value) : '—'}</p>
    ${changeParts.length ? html`<p class="${classNames('cp-hero-change cp-num', changeTone && `cp-${changeTone}`)}">${changeParts.map((part, index) => html`${index ? ' ' : ''}${part}`)}</p>` : ''}
    ${sub ? html`<p class="cp-hero-sub">${sub}</p>` : ''}
  </div>`;
}

/**
 * data-countup attributes for a number that should roll from its last shown
 * value. format: won | signedWon | percent | plain. Non-finite values add nothing.
 */
export function countAttrs(value, { key, format = 'won' } = {}) {
  if (!hasFiniteValue(value) || !key) return attrs({});
  return attrs({ 'data-countup': Number(value), 'data-countup-key': key, 'data-countup-format': format });
}

/** stat({ countup: { value, key, format } }) makes the tile's number roll on change. */
export function stat({ label, value, tone, sub, mono = true, countup }) {
  return html`<div class="cp-stat"><dt class="cp-stat-label">${label}</dt><dd class="${classNames('cp-stat-value', mono && 'cp-num', tone && `cp-${tone}`)}" ${countup ? countAttrs(countup.value, countup) : attrs({})}>${value}</dd>${sub ? html`<dd class="cp-stat-sub">${sub}</dd>` : ''}</div>`;
}

export function statGrid(items, { columns } = {}) {
  return html`<dl class="cp-stat-grid" ${attrs({ style: columns ? `--cols:${columns}` : undefined })}>${(items || []).filter(Boolean).map(item => stat(item))}</dl>`;
}

export function avatar(text, { tone = 'blue' } = {}) {
  const letters = String(text || '?').replace(/^KRW-/, '').slice(0, 3);
  return html`<span class="${classNames('cp-avatar', `is-${tone}`)}" aria-hidden="true">${letters}</span>`;
}

export function listRow({ leading, title, subtitle, value, valueSub, valueTone, trailing, href, attrs: extra = {}, as = 'div' }) {
  const inner = html`${leading ? html`<span class="cp-row-leading">${leading}</span>` : ''}
    <span class="cp-row-main"><span class="cp-row-title">${title}</span>${subtitle ? html`<span class="cp-row-sub">${subtitle}</span>` : ''}</span>
    ${value !== undefined || valueSub ? html`<span class="cp-row-value"><span class="${classNames('cp-num', valueTone && `cp-${valueTone}`)}">${value ?? ''}</span>${valueSub ? html`<span class="${classNames('cp-row-value-sub cp-num', valueTone && `cp-${valueTone}`)}">${valueSub}</span>` : ''}</span>` : ''}
    ${trailing ? html`<span class="cp-row-trailing">${trailing}</span>` : ''}`;
  if (href) return html`<a class="cp-list-row is-link" href="${href}" ${attrs(extra)}>${inner}</a>`;
  if (as === 'button') return html`<button type="button" class="cp-list-row is-link" ${attrs(extra)}>${inner}</button>`;
  return html`<div class="cp-list-row" ${attrs(extra)}>${inner}</div>`;
}

export function list(rows, { empty } = {}) {
  const items = (rows || []).filter(Boolean);
  if (!items.length) return empty || '';
  return html`<div class="cp-list">${items}</div>`;
}

export function segmented({ name, options, value, label }) {
  return html`<div class="cp-segmented" role="radiogroup" ${attrs({ 'aria-label': label, 'data-segmented': name })}>${options.map(option => html`<button type="button" role="radio" class="cp-seg" ${attrs({ 'aria-checked': String(option.value === value), 'data-value': option.value, 'data-segment': name, disabled: option.disabled })}>${option.label}</button>`)}</div>`;
}

export function allocationBar(items, { label = '자산 구성' } = {}) {
  const rows = (items || []).filter(item => Number(item.value) > 0);
  const total = rows.reduce((sum, item) => sum + Number(item.value), 0);
  if (!rows.length || total <= 0) return html`<div class="cp-alloc is-empty"></div>`;
  return html`<div class="cp-alloc" role="img" aria-label="${label}: ${rows.map(item => `${item.label} ${((item.value / total) * 100).toFixed(1)}%`).join(', ')}">
    <div class="cp-alloc-bar">${rows.map((item, index) => html`<span class="${classNames('cp-alloc-seg', `c${index % 6}`)}" style="flex-basis:${((item.value / total) * 100).toFixed(3)}%"></span>`)}</div>
    <ul class="cp-alloc-legend">${rows.map((item, index) => html`<li><i class="${classNames('cp-alloc-dot', `c${index % 6}`)}"></i><span>${item.label}</span><b class="cp-num">${((item.value / total) * 100).toFixed(1)}%</b></li>`)}</ul>
  </div>`;
}

export function skeleton({ lines = 3, hero = false } = {}) {
  return html`<div class="cp-skeleton-block" aria-hidden="true">${hero ? html`<span class="cp-skel is-hero"></span>` : ''}${Array.from({ length: lines }, (_, index) => html`<span class="cp-skel" style="width:${[92, 76, 84, 64, 88][index % 5]}%"></span>`)}</div>`;
}

export function emptyState({ iconName = 'info', title, body, action }) {
  return html`<div class="cp-empty">${icon(iconName, { size: 28 })}<strong>${title}</strong>${body ? html`<p>${body}</p>` : ''}${action || ''}</div>`;
}

export function notice({ tone = 'info', title, body, action, iconName }) {
  const glyph = iconName || (tone === 'danger' ? 'alert' : tone === 'warning' ? 'alert' : tone === 'ok' ? 'check' : 'info');
  return html`<div class="${classNames('cp-notice', `is-${tone}`)}" role="${tone === 'danger' ? 'alert' : 'status'}">${icon(glyph, { size: 20 })}<div class="cp-notice-body">${title ? html`<strong>${title}</strong>` : ''}${body ? html`<p>${body}</p>` : ''}</div>${action ? html`<div class="cp-notice-action">${action}</div>` : ''}</div>`;
}

export function engineStatus({ name, running, stateLabel, tone, detail, meta, actions, live = false }) {
  const resolvedTone = tone || (running ? 'ok' : 'neutral');
  return html`<div class="cp-engine">
    <div class="cp-engine-head"><span class="${classNames('cp-engine-dot', `is-${resolvedTone}`, running && 'is-pulsing')}" aria-hidden="true"></span><strong>${name}</strong>${live ? liveBadge() : ''}<span class="cp-engine-state">${badge(stateLabel || (running ? '실행 중' : '정지'), resolvedTone)}</span></div>
    ${detail ? html`<p class="cp-engine-detail">${detail}</p>` : ''}
    ${meta ? html`<p class="cp-engine-meta">${meta}</p>` : ''}
    ${actions ? html`<div class="cp-engine-actions">${actions}</div>` : ''}
  </div>`;
}

export function field({ label, hint, input, id }) {
  return html`<label class="cp-field" ${attrs({ for: id })}><span class="cp-field-label">${label}${hint ? html`<span class="cp-field-hint">${hint}</span>` : ''}</span>${input}</label>`;
}

export function disclosure({ summary, body, open = false, meta }) {
  return html`<details class="cp-disclosure" ${attrs({ open })}><summary><span>${summary}</span>${meta ? html`<span class="cp-caption">${meta}</span>` : ''}${icon('chevronRight', { size: 18 })}</summary><div class="cp-disclosure-body">${body}</div></details>`;
}

export function kv(rows) {
  return html`<dl class="cp-kv">${(rows || []).filter(Boolean).map(([key, value]) => html`<div><dt>${key}</dt><dd>${value}</dd></div>`)}</dl>`;
}

/* ------------------------------------------------------------------ DOM */

export function prefersReducedMotion() {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true; } catch { return false; }
}

const countMemory = new Map();
const countRuns = new WeakMap();
const formatters = {
  won: value => won(value),
  signedWon: value => signedWon(Math.round(value)),
  percent: value => percent(value),
  plain: value => Math.round(value).toLocaleString('ko-KR')
};

/**
 * Count-up for [data-countup] elements from the last value shown for the same
 * key. A new run on the same element replaces the previous one, so a data
 * refresh mid-roll never leaves a stale frame behind. The final text is always
 * the exact formatted target.
 */
export function runCountUps(root, { duration = 560 } = {}) {
  if (!root?.querySelectorAll) return;
  const elements = [...(root.matches?.('[data-countup]') ? [root] : []), ...root.querySelectorAll('[data-countup]')];
  for (const element of elements) {
    const target = Number(element.dataset.countup);
    const key = element.dataset.countupKey || '';
    const format = formatters[element.dataset.countupFormat] || formatters.won;
    if (!Number.isFinite(target)) continue;
    const running = countRuns.get(element);
    if (running && running.target === target) continue;
    const from = countMemory.has(key) ? countMemory.get(key) : target * 0.96;
    countMemory.set(key, target);
    const token = { target };
    countRuns.set(element, token);
    if (prefersReducedMotion() || from === target || typeof requestAnimationFrame !== 'function') {
      element.textContent = format(target);
      continue;
    }
    element.classList.remove('is-ticking');
    void element.offsetWidth;
    element.classList.add('is-ticking');
    const start = performance.now();
    const ease = t => 1 - (1 - t) ** 3;
    const frame = now => {
      if (!element.isConnected || countRuns.get(element) !== token) return;
      const t = Math.min(1, (now - start) / duration);
      element.textContent = format(from + (target - from) * ease(t));
      if (t < 1) requestAnimationFrame(frame);
      else { element.textContent = format(target); countRuns.delete(element); element.classList.remove('is-ticking'); }
    };
    requestAnimationFrame(frame);
  }
}

/**
 * Re-runs count-ups for numbers a feature re-renders after a data refresh, so
 * P&L and totals roll from the previous value without each screen wiring it.
 * Returns a disconnect function.
 */
export function observeCountUps(root) {
  if (!root || typeof MutationObserver !== 'function') return () => {};
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) runCountUps(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}

let toastHost = null;
export function toast(message, tone = 'info', { route, duration = 4200 } = {}) {
  if (typeof document === 'undefined') return;
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'cp-toasts';
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const item = document.createElement(route ? 'a' : 'div');
  item.className = `cp-toast is-${tone}`;
  if (route) item.href = `#/${route}`;
  item.innerHTML = `${icon(tone === 'success' ? 'check' : tone === 'error' || tone === 'warning' ? 'alert' : 'info', { size: 18 })}<span>${escapeHtml(message)}</span>`;
  toastHost.appendChild(item);
  while (toastHost.children.length > 3) toastHost.firstElementChild.remove();
  const remove = () => { item.classList.add('is-leaving'); setTimeout(() => item.remove(), 220); };
  setTimeout(remove, duration);
  item.addEventListener('click', remove);
}

/**
 * Bottom sheet (mobile) / dialog (desktop). Traps focus, closes on Escape or
 * scrim tap, restores focus. Returns { root, close }.
 */
export function openSheet({ title, content, footer, tone, onClose, labelledBy } = {}) {
  const previousFocus = document.activeElement;
  const host = document.createElement('div');
  host.className = 'cp-sheet-host';
  const titleId = labelledBy || `cp-sheet-title-${Math.random().toString(36).slice(2)}`;
  host.innerHTML = `<div class="cp-sheet-scrim" data-sheet-close></div><div class="cp-sheet ${tone ? `is-${tone}` : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}"><div class="cp-sheet-grip" aria-hidden="true"></div><header class="cp-sheet-head"><h2 id="${titleId}" class="cp-sheet-title">${escapeHtml(title || '')}</h2><button type="button" class="cp-icon-btn" data-sheet-close aria-label="닫기">${icon('close', { size: 20 })}</button></header><div class="cp-sheet-body"></div><footer class="cp-sheet-foot"></footer></div>`;
  const body = host.querySelector('.cp-sheet-body');
  const foot = host.querySelector('.cp-sheet-foot');
  body.innerHTML = String(content ?? '');
  if (footer) foot.innerHTML = String(footer); else foot.remove();
  document.body.appendChild(host);
  document.body.classList.add('cp-sheet-open');
  requestAnimationFrame(() => host.classList.add('is-open'));
  let closed = false;
  const focusables = () => [...host.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(element => !element.disabled && element.offsetParent !== null);
  const keydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  function close(result) {
    if (closed) return;
    closed = true;
    host.classList.remove('is-open');
    host.classList.add('is-closing');
    document.removeEventListener('keydown', keydown, true);
    setTimeout(() => {
      host.remove();
      if (!document.querySelector('.cp-sheet-host')) document.body.classList.remove('cp-sheet-open');
      previousFocus?.focus?.({ preventScroll: true });
    }, prefersReducedMotion() ? 0 : 260);
    onClose?.(result);
  }
  host.addEventListener('click', event => {
    const closer = event.target.closest('[data-sheet-close]');
    if (closer && (closer.classList.contains('cp-sheet-scrim') ? event.target === closer : true)) close();
  });
  document.addEventListener('keydown', keydown, true);
  setTimeout(() => (host.querySelector('[data-autofocus]') || focusables()[1] || focusables()[0])?.focus({ preventScroll: true }), 40);
  return { root: host, body, close };
}

/** Confirmation step. Resolves true only on the explicit confirm button. */
export function confirmSheet({ title, message, details = [], confirmLabel = '확인', cancelLabel = '취소', tone = 'primary', live = false }) {
  return new Promise(resolve => {
    let settled = false;
    const content = html`${live ? html`<div class="cp-live-strip">${icon('alert', { size: 18 })}<span>실전 계좌 · 실제 자금이 사용됩니다</span></div>` : ''}
      ${message ? html`<p class="cp-sheet-message">${message}</p>` : ''}
      ${details.length ? kv(details) : ''}`;
    const footer = html`<button type="button" class="cp-btn is-secondary" data-sheet-cancel>${cancelLabel}</button><button type="button" class="${classNames('cp-btn', tone === 'danger' ? 'is-danger' : 'is-primary')}" data-sheet-confirm data-autofocus>${confirmLabel}</button>`;
    const sheet = openSheet({ title, content, footer, tone: live ? 'live' : undefined, onClose: () => { if (!settled) { settled = true; resolve(false); } } });
    sheet.root.querySelector('[data-sheet-cancel]').addEventListener('click', () => sheet.close());
    sheet.root.querySelector('[data-sheet-confirm]').addEventListener('click', () => { settled = true; resolve(true); sheet.close(); });
  });
}

/** Sheet with a small form. fields: [{name,label,type,value,min,step,hint,options}]. Resolves values or null. */
export function formSheet({ title, message, fields = [], confirmLabel = '확인', tone = 'primary', validate }) {
  return new Promise(resolve => {
    let settled = false;
    const content = html`${message ? html`<p class="cp-sheet-message">${message}</p>` : ''}<form class="cp-form" data-sheet-form novalidate>${fields.map((item, index) => field({
      label: item.label,
      hint: item.hint,
      id: `cp-sheet-field-${index}`,
      input: item.type === 'select'
        ? html`<select class="cp-input" id="cp-sheet-field-${index}" name="${item.name}">${item.options.map(option => html`<option value="${option.value}" ${attrs({ selected: option.value === item.value })}>${option.label}</option>`)}</select>`
        : html`<input class="cp-input cp-num" id="cp-sheet-field-${index}" name="${item.name}" ${attrs({ type: item.type || 'text', value: item.value, min: item.min, step: item.step, inputmode: item.type === 'number' ? 'numeric' : undefined, 'data-autofocus': index === 0 ? true : undefined, autocomplete: 'off' })}>`
    }))}<p class="cp-form-error" data-sheet-error role="alert"></p></form>`;
    const footer = html`<button type="button" class="cp-btn is-secondary" data-sheet-cancel>취소</button><button type="button" class="${classNames('cp-btn', tone === 'danger' ? 'is-danger' : 'is-primary')}" data-sheet-confirm>${confirmLabel}</button>`;
    const sheet = openSheet({ title, content, footer, onClose: () => { if (!settled) { settled = true; resolve(null); } } });
    const form = sheet.root.querySelector('[data-sheet-form]');
    const submit = event => {
      event?.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      const error = validate?.(values);
      if (error) { sheet.root.querySelector('[data-sheet-error]').textContent = error; return; }
      settled = true;
      resolve(values);
      sheet.close();
    };
    form.addEventListener('submit', submit);
    sheet.root.querySelector('[data-sheet-cancel]').addEventListener('click', () => sheet.close());
    sheet.root.querySelector('[data-sheet-confirm]').addEventListener('click', submit);
  });
}

const ENTRANCE_CARD_CAP = 8;
const ENTRANCE_ROW_CAP = 8;
let entranceTimer = null;

/**
 * Marks a mount root so its cards, list rows and stat tiles play the staggered
 * entrance once. Indexes are capped so long screens never wait on the tail;
 * explicit --i values from card({ index }) win. Reduce Motion skips it.
 */
export function playEntrance(root) {
  if (!root || prefersReducedMotion()) return;
  let cardIndex = 0;
  for (const cardElement of root.querySelectorAll('.cp-card, .cp-enter')) {
    if (cardElement.closest('.cp-sheet')) continue;
    if (!cardElement.style.getPropertyValue('--i')) cardElement.style.setProperty('--i', String(Math.min(cardIndex, ENTRANCE_CARD_CAP)));
    cardIndex += 1;
  }
  for (const group of root.querySelectorAll('.cp-list, .cp-stat-grid')) {
    let rowIndex = 0;
    for (const row of group.children) {
      row.style.setProperty('--j', String(Math.min(rowIndex, ENTRANCE_ROW_CAP)));
      rowIndex += 1;
    }
  }
  root.classList.remove('is-entering', 'is-route-in');
  void root.offsetWidth;
  root.classList.add('is-entering', 'is-route-in');
  clearTimeout(entranceTimer);
  entranceTimer = setTimeout(() => root.classList.remove('is-entering', 'is-route-in'), 1100);
}

/** Replays a short text reveal on an element whose text just changed. */
export function revealText(element, text) {
  if (!element) return;
  if (element.textContent === text) return;
  element.textContent = text;
  if (prefersReducedMotion()) return;
  element.classList.remove('is-revealing');
  void element.offsetWidth;
  element.classList.add('is-revealing');
}

export const ui = {
  attrs, button, linkButton, card, badge, liveBadge, paperBadge, heroValue, stat, statGrid, avatar, listRow, list,
  segmented, allocationBar, sparkline, areaChart, candleChart, skeleton, emptyState, notice, engineStatus, field, disclosure, kv, icon,
  toast, openSheet, confirmSheet, formSheet, runCountUps, observeCountUps, playEntrance, revealText, countAttrs, prefersReducedMotion
};

export default ui;
