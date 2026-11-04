// Original line icons (24px grid, 1.8 stroke, currentColor). Static markup only.
import { raw } from '../core/dom.js';

const PATHS = {
  home: '<path d="M3.5 10.5 12 3.8l8.5 6.7"/><path d="M5.5 9v10.2c0 .4.3.8.8.8h4v-6h3.4v6h4c.5 0 .8-.4.8-.8V9"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 8.5h3.6a2 2 0 0 1 0 4H9.5h4.1a2 2 0 0 1 0 4H9.5zM10.8 7v1.5M10.8 16.5V18"/>',
  chart: '<path d="M4 19.5h16"/><path d="M5.5 15.5l4-4.5 3.5 3 5.5-6.5"/><path d="M15.5 7.5h3v3"/>',
  layers: '<path d="m12 3.8 8.5 4.6L12 13 3.5 8.4z"/><path d="m3.5 12.2 8.5 4.6 8.5-4.6"/><path d="m3.5 16 8.5 4.6 8.5-4.6"/>',
  list: '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><circle cx="4.8" cy="6.5" r=".9"/><circle cx="4.8" cy="12" r=".9"/><circle cx="4.8" cy="17.5" r=".9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/>',
  swap: '<path d="M6.5 8.5h12l-3.5-3.5"/><path d="M17.5 15.5h-12l3.5 3.5"/>',
  wallet: '<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 9.5h17"/><path d="M16 14h1.5"/><path d="M6 6 15.5 3.5l1 2.5"/>',
  shield: '<path d="M12 3.5 19 6v5.5c0 4.4-2.9 7.6-7 9-4.1-1.4-7-4.6-7-9V6z"/><path d="m8.8 12 2.2 2.2 4.2-4.4"/>',
  sliders: '<path d="M5 4v6M5 14v6M12 4v3M12 11v9M19 4v9M19 17v3"/><path d="M3 12h4M10 9h4M17 15h4"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>',
  spark: '<path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14l-6.7-2 6.7-2z"/>',
  news: '<rect x="3.5" y="5" width="13" height="14" rx="2"/><path d="M16.5 9h2.5a1.5 1.5 0 0 1 1.5 1.5V17a2 2 0 0 1-2 2h-2"/><path d="M7 9h6M7 12.5h6M7 16h3.5"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  arrowRight: '<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>',
  chevronRight: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  chevronLeft: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4.5 4.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  monitor: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M9 20h6M12 16v4"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  logout: '<path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14"/><path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5"/>',
  external: '<path d="M13.5 4.5h6v6"/><path d="M19.5 4.5 11 13"/><path d="M17.5 13.5v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 6 6.5h4.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2"/>',
  server: '<rect x="4" y="4.5" width="16" height="6.5" rx="1.8"/><rect x="4" y="13" width="16" height="6.5" rx="1.8"/><path d="M7.5 7.8h.1M7.5 16.2h.1"/>',
  bolt: '<path d="M13 3.5 5.5 13.5H12l-1 7 7.5-10H12z"/>'
};

export function iconSvg(name, { size = 24, label } = {}) {
  const body = PATHS[name] || PATHS.info;
  const a11y = label ? `role="img" aria-label="${label.replace(/"/g, '&quot;')}"` : 'aria-hidden="true" focusable="false"';
  return `<svg class="cp-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${body}</svg>`;
}

export function icon(name, options) {
  return raw(iconSvg(name, options));
}

export const ICON_NAMES = Object.keys(PATHS);
