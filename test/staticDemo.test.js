import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../demo/static/sim-core.js';
import { buildStaticDemo, scanBundle, transformIndexHtml, transformAppScript } from '../src/scripts/buildStaticDemo.js';

const { createDemoSim, runCostBacktest, SEED_MONEY } = globalThis.CoinPilotDemoCore;

function fixedSim() {
  let clock = Date.UTC(2026, 0, 1);
  const sim = createDemoSim({ now: () => clock });
  return { sim, advance: (ticks = 1) => { for (let i = 0; i < ticks; i += 1) { clock += 1000; sim.tick(); } } };
}

test('same seed and same actions replay an identical synthetic path', () => {
  const run = () => {
    const { sim, advance } = fixedSim();
    sim.handle('POST', '/api/paper-validation/start', {});
    advance(120);
    return JSON.stringify([sim.handle('GET', '/api/market/prices').body, sim.handle('GET', '/api/trades').body, sim.handle('GET', '/api/account').body]);
  };
  assert.equal(run(), run());
});

test('markets are labelled as examples and no real listing or venue appears', () => {
  const { sim } = fixedSim();
  const rows = sim.handle('GET', '/api/market/prices').body;
  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.match(row.coin, /^KRW-DEMO[A-Z]$/);
    assert.match(row.koreanName, /^예시코인/);
  }
  assert.equal(sim.handle('GET', '/api/status').body.mode, 'DRY_RUN');
});

test('auto trading enters and exits only while running, charging fee and slippage', () => {
  const { sim, advance } = fixedSim();
  advance(30);
  assert.equal(sim.summary().entries, 0, 'no entries before start');
  sim.handle('POST', '/api/paper-validation/start', {});
  let guard = 0;
  while (sim.summary().closed < 1 && guard < 120) { advance(); guard += 1; }
  assert.ok(sim.summary().closed >= 1, 'a position closes within two minutes of simulated ticks');
  const close = sim.handle('GET', '/api/trades').body.find(trade => trade.action === 'CLOSE');
  assert.ok(close.fee > 0);
  const kinds = new Set(sim.state.log.map(item => item.kind));
  for (const kind of ['signal', 'entry', 'exit']) assert.ok(kinds.has(kind), kind);
  sim.handle('POST', '/api/paper-validation/stop');
  const before = sim.summary().entries;
  advance(60);
  assert.equal(sim.summary().entries, before, 'stop halts entries');
});

test('crash scenario trips the loss limit, blocks new entries and keeps managing exits', () => {
  const { sim, advance } = fixedSim();
  assert.equal(sim.triggerCrash().ok, false, 'needs a running session');
  sim.handle('POST', '/api/paper-validation/start', {});
  advance(20);
  if (!sim.summary().coolingDown) assert.equal(sim.triggerCrash().ok, true);
  let guard = 0;
  while (!sim.summary().coolingDown && guard < 90) { advance(); guard += 1; }
  const tripped = sim.summary();
  assert.equal(tripped.coolingDown, true);
  assert.equal(tripped.lossCount, tripped.maxLosses);
  assert.equal(sim.handle('GET', '/api/status').body.entriesPaused, true);
  const entries = tripped.entries;
  advance(60);
  assert.equal(sim.summary().entries, entries, 'no entry while the limit holds');
  assert.ok(sim.summary().blockedEntries > 0);
  assert.equal(Object.keys(sim.state.positions).length, 0, 'open positions still exit');
});

test('manual orders validate input and cannot reach an unsupported or LIVE route', () => {
  const { sim } = fixedSim();
  const buy = body => sim.handle('POST', '/api/trade/buy', body);
  assert.equal(buy({ coin: 'KRW-BTC', amount: 10000 }).status, 400);
  assert.equal(buy({ coin: 'KRW-DEMOA', amount: 100 }).status, 400);
  assert.equal(buy({ coin: 'KRW-DEMOA', amount: 'x' }).status, 400);
  assert.equal(buy({ coin: 'KRW-DEMOA', amount: SEED_MONEY * 2 }).status, 400);
  assert.equal(buy({ coin: 'KRW-DEMOA', amount: 100000 }).status, 200);
  assert.equal(sim.handle('GET', '/api/account').body.positions.length, 1);
  assert.equal(sim.handle('POST', '/api/trade/sell', { coin: 'KRW-DEMOB', quantity: 1 }).status, 400);
  for (const route of ['/api/control/start', '/api/live-credentials', '/api/config/update', '/api/trade/execute-bundle']) {
    assert.equal(sim.handle('POST', route, {}).status, 403, route);
  }
  assert.equal(sim.handle('GET', '/api/does-not-exist').status, 404);
});

test('backtest applies costs to the same trades and is deterministic', () => {
  const costed = runCostBacktest();
  const free = runCostBacktest({ feePercent: 0, slippagePercent: 0 });
  assert.deepEqual(costed, runCostBacktest());
  assert.equal(costed.tradeCount, free.tradeCount);
  assert.equal(costed.gross.totalPnl, free.gross.totalPnl);
  assert.ok(costed.net.totalPnl < costed.gross.totalPnl);
  assert.ok(Math.abs(free.net.totalPnl - free.gross.totalPnl) < 1e-6);
  assert.ok(costed.tradeCount > 0);
  assert.equal(costed.synthetic, true);
});

test('saved state resumes where it stopped and a foreign shape falls back to a fresh run', () => {
  const { sim, advance } = fixedSim();
  sim.handle('POST', '/api/paper-validation/start', {});
  advance(40);
  const saved = JSON.parse(JSON.stringify(sim.state));
  assert.equal(createDemoSim({ savedState: saved }).state.tick, saved.tick);
  assert.equal(createDemoSim({ savedState: { version: 99 } }).state.tick, 0);
});

test('demo build isolates the bundle and leaves no external asset, service worker or venue copy', () => {
  const outParent = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-demo-'));
  try {
    const outDir = path.join(outParent, 'coin-pilot');
    const before = fs.readFileSync('public/index.html', 'utf8');
    const { bytes } = buildStaticDemo(outDir);
    assert.ok(bytes < 15 * 1024 * 1024);
    assert.equal(fs.readFileSync('public/index.html', 'utf8'), before, 'source untouched');
    assert.deepEqual(scanBundle(outDir), []);
    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.equal(/(?:src|href)="\//.test(html), false, 'all assets are relative');
    assert.equal(html.includes('rel="manifest"'), false);
    for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) assert.ok(fs.existsSync(path.join(outDir, match[1])), match[1]);
    assert.match(html, /<script type="module" src="\.\/app\/main\.js"><\/script>/);
    assert.ok(html.indexOf('./runtime.js') < html.indexOf('./auth-client.js'), 'the simulator patches fetch before the auth gate');
    const appFiles = fs.readdirSync(path.join(outDir, 'app'), { recursive: true }).filter(name => String(name).endsWith('.js'));
    assert.ok(appFiles.length >= 20, 'the whole web shell module tree is copied');
    for (const name of appFiles) {
      const source = fs.readFileSync(path.join(outDir, 'app', String(name)), 'utf8');
      assert.equal(/serviceWorker\.register\(/.test(source), false, `${name} registers a service worker`);
      assert.equal(source.includes('비트코인, BTC'), false, `${name} keeps real-listing copy`);
      assert.equal(/from '\//.test(source) || /import\('\//.test(source), false, `${name} uses an absolute module path`);
    }
    const main = fs.readFileSync(path.join(outDir, 'app', 'main.js'), 'utf8');
    assert.match(main, /demo: service worker disabled/);
  } finally {
    fs.rmSync(outParent, { recursive: true, force: true });
  }
});

test('demo transforms fail loudly when the dashboard markup they rely on moves', () => {
  assert.throws(() => transformIndexHtml('<html></html>'), /expected fragment/);
  assert.equal(transformAppScript("navigator.serviceWorker.register('/sw.js')").includes('register'), false);
});

test('scanBundle flags forbidden content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'fetch("https://api.upbit.com/v1/x"); const p = "/Users/someone/x";');
    assert.equal(scanBundle(dir).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('internal-path scan ignores relative module paths but still flags absolute host paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), "import('../features/home/index.js'); import('./home/x.js');");
    assert.deepEqual(scanBundle(dir), []);
    fs.writeFileSync(path.join(dir, 'b.js'), 'const log = "/home/deploy/coinpilot.log";');
    assert.equal(scanBundle(dir).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
