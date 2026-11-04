// Feature registry: the single list that drives navigation, routing and lazy
// loading. Adding a screen = a folder under features/ + one entry here.
//
// Entry fields:
//   id       unique route id (`#/<id>`)
//   label    Korean nav label
//   icon     icon name from ui/icons.js
//   nav      'primary' (tab bar + sidebar), 'secondary' (sidebar + 더보기),
//            'tool' (sidebar tools group + 더보기), 'hidden' (route only)
//   mobile   true to place in the 5-slot mobile tab bar
//   group    더보기 section label
//   order    sort key within its nav slot
//   loader   () => import('../features/<id>/index.js')

const REQUIRED = ['id', 'label', 'icon', 'nav', 'loader'];
const NAV_KINDS = new Set(['primary', 'secondary', 'tool', 'hidden']);

export function createRegistry(entries = []) {
  const features = new Map();

  function register(entry) {
    for (const field of REQUIRED) {
      if (entry?.[field] === undefined || entry[field] === null || entry[field] === '') {
        throw new Error(`feature registry entry is missing "${field}"`);
      }
    }
    if (!/^[a-z][a-z0-9-]*$/.test(entry.id)) throw new Error(`invalid feature id: ${entry.id}`);
    if (!NAV_KINDS.has(entry.nav)) throw new Error(`invalid nav kind for ${entry.id}: ${entry.nav}`);
    if (typeof entry.loader !== 'function') throw new Error(`feature ${entry.id} loader must be a function`);
    if (features.has(entry.id)) throw new Error(`duplicate feature id: ${entry.id}`);
    features.set(entry.id, Object.freeze({ order: 100, group: '도구', mobile: false, ...entry }));
    return api;
  }

  const sorted = list => [...list].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'ko'));

  const api = {
    register,
    get: id => features.get(id) || null,
    has: id => features.has(id),
    all: () => sorted(features.values()),
    byNav: kind => sorted([...features.values()].filter(feature => feature.nav === kind)),
    /** Sidebar (≥960px): primary + secondary in order. */
    sidebar: () => sorted([...features.values()].filter(feature => feature.nav === 'primary' || feature.nav === 'secondary')),
    tools: () => sorted([...features.values()].filter(feature => feature.nav === 'tool')),
    /** Mobile tab bar: features flagged mobile (max 4) + the 더보기 slot. */
    mobileTabs: () => sorted([...features.values()].filter(feature => feature.mobile)).slice(0, 4),
    /** Everything reachable from 더보기 on mobile. */
    moreItems: () => sorted([...features.values()].filter(feature => !feature.mobile && feature.nav !== 'hidden' && feature.id !== 'more'))
  };

  entries.forEach(register);
  return api;
}

// The application's features. Keep this list as the only place that knows
// about feature folders.
export const FEATURES = [
  { id: 'home', label: '홈', icon: 'home', nav: 'primary', mobile: true, order: 10, loader: () => import('../features/home/index.js') },
  { id: 'coins', label: '코인', icon: 'coin', nav: 'primary', mobile: true, order: 20, loader: () => import('../features/coins/index.js') },
  { id: 'stocks', label: '주식', icon: 'chart', nav: 'primary', mobile: true, order: 30, loader: () => import('../features/stocks/index.js') },
  { id: 'portfolios', label: '포트폴리오', icon: 'layers', nav: 'primary', mobile: true, order: 40, loader: () => import('../features/portfolios/index.js') },
  { id: 'activity', label: '활동', icon: 'list', nav: 'secondary', group: '내 계좌', order: 50, loader: () => import('../features/activity/index.js') },
  { id: 'settings', label: '설정', icon: 'gear', nav: 'secondary', group: '앱', order: 60, loader: () => import('../features/settings/index.js') },
  { id: 'trade', label: '주문하기', icon: 'swap', nav: 'tool', group: '내 계좌', order: 70, loader: () => import('../features/trade/index.js') },
  { id: 'wallet', label: '모의 지갑', icon: 'wallet', nav: 'tool', group: '내 계좌', order: 75, loader: () => import('../features/wallet/index.js') },
  { id: 'research', label: '점검·검증', icon: 'shield', nav: 'tool', group: '전략', order: 80, loader: () => import('../features/research/index.js') },
  { id: 'strategy', label: '전략 설정', icon: 'sliders', nav: 'tool', group: '전략', order: 85, loader: () => import('../features/strategy/index.js') },
  { id: 'analysis', label: '시장 분석', icon: 'pulse', nav: 'tool', group: '분석', order: 90, loader: () => import('../features/analysis/index.js') },
  { id: 'ai', label: 'AI 의견', icon: 'spark', nav: 'tool', group: '분석', order: 95, loader: () => import('../features/ai/index.js') },
  { id: 'news', label: '뉴스', icon: 'news', nav: 'tool', group: '분석', order: 100, loader: () => import('../features/news/index.js') },
  { id: 'more', label: '더보기', icon: 'grid', nav: 'hidden', order: 999, loader: () => import('../features/more/index.js') }
];

export function createDefaultRegistry() {
  return createRegistry(FEATURES);
}
