# CoinPilot Signal Ledger — Design QA

## Comparison target

- Source visual truth: `/Users/kimminkyu/.codex/generated_images/01a089ce-7d0d-79e1-863e-765434a6db3b/exec-8532932d-395f-46ae-ad1d-2dd4aa3813d1.png`
- Source concept: selected ideation direction 2, “Signal Ledger”.
- Implementation: `http://localhost:3000/?v=2` in the Codex In-app Browser, served by the dashboard mock server.
- Primary route/state: overview → “근거 로그”, server-backed dashboard mock, `DRY_RUN`, validation report available but not promoted.
- Desktop viewport: CSS `1440 × 1024`, device scale factor `1`.
- Mobile viewport: CSS `390 × 844`, device scale factor `1`, responsive state checked at settings and overview surfaces.
- Source pixels: generated image `1440 × 1024`.
- Implementation capture: browser-rendered CUA capture at the implementation URL and the viewport above. The Codex browser surface does not expose a filesystem screenshot path; the URL is the authoritative repeatable capture target.

## Evidence checked

- The overview shows the editorial left navigation, paper/live mode switch, live-order lock banner, validation gate cards, evidence chart, trade panel, portfolio positions, activity, and risk summary.
- The trade workspace renders real mock API prices and calculates estimated quantity and fee from the selected asset.
- The market workspace renders the mock ticker list, selected market quote, candle canvas, interval controls, and trade panel.
- The validation workspace renders the real mock validation result, paper session state, optimization history, and empty backtest state.
- The settings workspace renders optimization controls, investment presets, and all server-provided parameter ranges.
- The strategy research workspace executes `/api/all-coin-scores` and renders the returned score table and filtering/sorting controls.
- Mobile state was inspected at `390 × 844`: the fixed bottom navigation, mode controls, content flow, buttons, and settings controls remain reachable without the desktop sidebar covering the screen.
- The console-visible page state did not show a fatal runtime error; `node --check public/pilot-redesign.js` and `git diff --check` passed.

## Required fidelity surfaces

### Fonts and typography

The implementation uses IBM Plex Sans KR for the technical display hierarchy and Manrope with Noto Sans KR fallback for operational UI text. This keeps Korean page titles, evidence labels, tables, and status metadata crisp and aligned with the instrument-panel direction. The compact mobile settings view was checked for wrapping; labels remain readable and inputs remain individually reachable.

### Spacing and layout rhythm

The desktop layout preserves the source’s narrow navigation rail, broad evidence workspace, and right-side execution rail. The top mode control and lock banner stay above the working surface. The mobile breakpoint collapses the sidebar to a bottom navigation and converts the two-column workspace to a vertical flow. The previously detected fixed-sidebar overlay at mobile width was corrected by explicitly resetting the desktop `top` and `min-height` constraints.

### Colors and visual tokens

The implementation uses the source direction’s ivory paper surface, ink navy typography, cobalt active controls, emerald safe states, amber attention states, and coral risk states. Actual `DRY_RUN` and non-promoted validation states are shown as attention/lock states rather than being styled as successful live readiness.

### Image quality and asset fidelity

The selected visual target contains no photographic or decorative raster imagery. The product mark is rendered as a real icon-library compass inside the brand lockup, and interface icons use the Phosphor web icon library rather than emoji, CSS drawings, or handcrafted inline SVG substitutes. Charts are data visualizations rendered from live API data on canvas, not decorative image replacements.

### Copy and content

Product copy explicitly distinguishes “모의투자”, “실제투자”, “실전 주문 잠금”, “검증 게이트”, and “판단 보조”. Validation failures and empty states are visible. No copy claims guaranteed profit or treats a recommendation as an order approval.

## Interaction and accessibility checks

- Navigation buttons change the visible page and active state.
- The paper/live control is fail-closed: with the mock server in `DRY_RUN`, clicking “실제투자” keeps live mode locked and explains why.
- Trade inputs show current price, estimated quantity, holding value, and fee; order buttons remain enabled only when the current mode and amount contract allow execution.
- Market rows select a market and refresh the quote/chart/trade panel.
- Strategy analysis loads data, updates the table, and exposes filter/sort controls.
- Validation/history and settings pages load their server-backed data on entry.
- Focus-visible outlines, semantic buttons, labelled form controls, canvas `aria-label`s, reduced-motion handling, and 44px-class mobile controls are present.

## Comparison history

### Pass 1 — initial implementation

- Findings: the overall layout, typography direction, mode boundary, validation banner, evidence surface, and right execution rail matched the selected direction. Two functional mismatches remained: chart empty-state text overlaid a populated canvas because the component CSS overrode the native `[hidden]` behavior; trade summary values were not written because the renderer targeted IDs while the markup used data attributes.
- Fixes: added a scoped `[hidden] { display: none !important; }` rule and changed trade summary updates to target the data attributes.
- Evidence: refreshed browser AX state showed `100,000,000원`, `0.0005`, and `25원` in the trade panel, and the chart empty-state node was no longer exposed when 93 observations were present.

### Pass 2 — responsive implementation

- Findings: at `390 × 844`, the desktop sticky sidebar retained `top: 0`, expanding to the full viewport and covering the app content.
- Fixes: mobile CSS now resets `top`, `min-height`, and `height` with scoped overrides; the browser cache was bypassed with the versioned stylesheet query.
- Evidence: mobile geometry reported the sidebar at `y=705`, `h=129`, `bottom=10` with the page content above it; the mobile screenshot showed the settings content and bottom navigation simultaneously.

### Pass 3 — interaction concurrency

- Findings: entering Strategy Research automatically requested analysis, then pressing “분석 실행” immediately could issue a second request and duplicate the success toast.
- Fixes: added per-view loading guards for analysis and news requests.
- Evidence: the strategy research page rendered the mock result table and one success state; the new guard prevents concurrent re-entry.

### Pass 4 — typography refinement

- Change: replaced the initial DM Sans + Newsreader pairing with Manrope + Noto Sans KR for operational text and Fraunces + Noto Serif KR for the editorial display hierarchy.
- Scope: brand lockup, page titles, panel titles, body copy, metadata, and financial numbers; numeric cells now use tabular-number features and tighter optical tracking.
- Evidence: browser-computed styles report `Manrope, Noto Sans KR` for the body and `Fraunces, Noto Serif KR` for page titles. Desktop `1440 × 1024` and mobile `390 × 844` captures show cleaner Korean title forms, stronger numeric alignment, and improved hierarchy without layout overflow.

### Pass 5 — release polish

- Finding: the legacy PWA mobile bar remained visible below the redesigned navigation, creating two competing navigation systems on narrow screens.
- Fix: hid the legacy `.pilot-mobile-nav` whenever the redesigned shell is mounted and reset scroll position to the top on redesigned view changes.
- Evidence: at the mobile viewport only the redesigned two-row navigation remains; switching to 시장 관찰 reports `scrollY=0`, and the legacy bar reports `display: none`.
- Regression check: desktop `1440 × 1024` keeps the left rail and execution workspace intact; full test suite remains `76/76 PASS` and browser console errors remain empty.

### Pass 6 — production runtime hardening

- Legacy runtime: the visible redesign now gates the old dashboard initializer, socket notifications, and periodic polling by the presence of `pilot-redesign-root`; hidden compatibility markup no longer creates duplicate API traffic or live notification channels.
- PWA shell: service-worker cache version `coinpilot-shell-v4` pre-caches the redesigned CSS and JavaScript shell alongside the manifest and icon.
- Network resilience: frontend API requests use a 12-second timeout and surface a Korean connection error instead of leaving loading states unresolved forever.
- Evidence: v8 browser load reports the redesigned root and overview state without new legacy initialization logs; console error/warning capture is empty; `76/76` tests pass.

### Pass 7 — page-level mockup application

Page-specific mockups were added under [docs/ui-mockups/signal-ledger](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/ui-mockups/signal-ledger/README.md) and applied to the corresponding runtime surfaces.

| Page | Mockup | Desktop marker | Mobile marker | Horizontal overflow |
| --- | --- | --- | --- | --- |
| 거래 실행 | `trade.png` | trade order panel | same order panel | none |
| 포트폴리오 | `portfolio.png` | portfolio chart | wallet/holdings flow | none |
| 시장 관찰 | `market.png` | candle chart | chart/list flow | none |
| 전략 연구 | `strategy.png` | advisory note + analysis table | stacked research flow | none |
| 뉴스 센터 | `news.png` | sentiment + context panel | context panel below feed | none |
| 환경 설정 | `settings.png` | change-impact panel | impact panel below form | none |
| 검증 기록 | `history.png` | promotion warning | paper evidence flow | none |
| AI 자문 | `ai-advisory.png` | advisory-only policy + two-column desk | stacked provider/event flow | none |

Browser verification at `1280 × 720` confirmed all eight pages activated the expected page marker and had no horizontal overflow. The same eight-page pass at `390 × 844` confirmed no horizontal overflow, a single redesigned mobile navigation, and a fixed navigation height of `129px`.

### Pass 8 — cross-page evidence cleanliness

- Finding: a success toast from Strategy Research could remain visible while moving through the following page captures, visually contaminating the next page’s evidence surface.
- Fix: page navigation now clears transient toasts before activating the next page.
- Evidence: page-transition matrix reports `toastCount=0` on News, Settings, Validation, and AI pages after leaving Strategy Research; console errors remain empty.

### Pass 9 — real entrypoint staging smoke

- The actual `src/index.js` entrypoint was run with `DRY_RUN=true` on port `3101` using the new isolated `dashboard:staging` runner.
- The staging browser received real public market/candle/account responses and reported `API 연결됨` across all eight pages.
- Desktop and mobile page matrices retained no horizontal overflow; live mode remained locked.
- The staging runner passed empty API key values to its child process, redacted credentials from structured startup logging, and stored runtime state under a timestamped `.staging-runtime/` directory.
- The user root `dry_portfolio.json` was restored from pre-staging trade history evidence and verified at `21 holdings`, `8,986.691 KRW`, and `updatedAt=2026-01-02T01:46:47.233Z` after staging and test runs.
- The safe command and boundaries are documented in [docs/runtime/staging-smoke.md](/Users/kimminkyu/Bagelcode/Repository_Personal/coin-automandation/docs/runtime/staging-smoke.md).

### Pass 10 — title typography correction

- Finding: the page-title `Fraunces` + `Noto Serif KR` pairing rendered `근거 로그` as a literary serif, which conflicted with the operational chart/table surface and the rest of the Korean UI.
- Fix: removed the serif font import, added IBM Plex Sans KR, and moved the display token to a bold technical sans with a tighter but less ornamental tracking. Brand, page titles, sidebar notes, news context titles, settings impact titles, and footer display text now share the corrected token.
- Evidence: browser-computed styles report `IBM Plex Sans KR` at `700` for all nine page titles (`overview`, `trade`, `portfolio`, `market`, `analysis`, `ai`, `news`, `settings`, `history`); the mobile preview shows the `근거 로그` title without serif forms or clipping; all page transitions report no horizontal overflow. `npm test` remains `76/76 PASS`, `node --check public/pilot-redesign.js`, and `git diff --check` pass.

## Open questions / accepted deviations

- The mock server has no positions, so the implementation correctly shows an empty position state rather than inventing holdings from the visual reference. A production account with holdings will populate the same table and allocation components.
- The source concept’s right trade ticket is visually disabled because live validation is incomplete; the implementation preserves that safety behavior and provides a working paper-trade path when the server is in `DRY_RUN`.
- The in-app browser returned the implementation screenshot in-memory rather than as a filesystem artifact; the implementation URL and exact viewport are recorded for repeatable capture.

## Follow-up polish

- Add a server-provided display name/avatar contract if multi-operator identity is introduced.
- Add a small data-density control for users who need more rows on the desktop research tables.
- Consider a dedicated chart library only if later product requirements need crosshair/zoom persistence beyond the current canvas charts.

## Final result

passed
