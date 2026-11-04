import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import DashboardServer from '../src/api/dashboardServer.js';
import { createMockTrader } from '../src/scripts/runDashboard.js';
import {
  createDashboardErrorHandler,
  redactForLog,
  scrubClientErrorText,
  scrubSecrets,
  scrubServerErrorResponses,
  securityHeadersMiddleware
} from '../src/api/httpHardening.js';

const AUTH_OFF = { DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '', DASHBOARD_BIND: '127.0.0.1', DASHBOARD_HOST: '127.0.0.1' };

async function withApp(setup, run) {
  const app = express();
  setup(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  }
}

async function withDashboard(env, run) {
  const trader = createMockTrader();
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, ...AUTH_OFF, ...env } });
  const httpServer = await dashboard.start();
  try {
    await run(`http://127.0.0.1:${httpServer.address().port}`, dashboard);
  } finally {
    const closed = dashboard.httpServer?.listening ? once(dashboard.httpServer, 'close') : Promise.resolve();
    await dashboard.stop();
    trader.stop();
    await closed;
  }
}

test('redactForLog hides credentials in nested data but keeps the field names', () => {
  const circular = { accessKey: 'AK-1' };
  circular.self = circular;
  const out = redactForLog({ headers: { authorization: 'Bearer abc.def' }, body: { secretKey: 'SK-1', token: 't', coin: 'KRW-BTC' }, list: [{ password: 'p' }], circular, tokenScope: true, note: 'sent Bearer abcdef123' });
  const text = JSON.stringify(out);
  for (const secret of ['AK-1', 'SK-1', 'abc.def', 'abcdef123']) assert.equal(text.includes(secret), false, secret);
  assert.equal(out.body.coin, 'KRW-BTC');
  assert.equal(out.body.secretKey, '[redacted]');
  assert.equal(out.tokenScope, true);
  assert.equal(out.circular.self, '[Circular]');
});

test('scrub helpers remove tokens, query secrets, internal paths and upstream URLs', () => {
  assert.equal(scrubSecrets('url?token=abc123&x=1'), 'url?token=[redacted]&x=1');
  const clientText = scrubClientErrorText("ENOENT: open '/Users/me/app/.secrets/key' via https://api.example.test/v1?a=1");
  assert.equal(clientText.includes('/Users'), false);
  assert.equal(clientText.includes('api.example.test'), false);
  assert.equal(scrubClientErrorText('시세를 확인할 수 없습니다.'), '시세를 확인할 수 없습니다.');
});

test('error handler logs no request body or key material and hides 5xx details', async () => {
  const logged = [];
  const logger = { error: (...args) => logged.push(args) };
  await withApp(app => {
    app.use(express.json({ limit: '1kb' }));
    app.post('/api/explode', () => { throw new Error('open /Users/me/.secrets failed Bearer leaked-token'); });
    app.use(createDashboardErrorHandler(logger));
  }, async base => {
    const response = await fetch(`${base}/api/explode?token=query-secret`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessKey: 'AK-SECRET', secretKey: 'SK-SECRET', coin: 'KRW-BTC' })
    });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.error, '서버에서 요청을 처리하지 못했습니다.');
    assert.equal(body.path, '/api/explode');

    const malformed = await fetch(`${base}/api/explode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"secretKey":"SK-RAW"' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.text()).includes('SK-RAW'), false);

    const tooLarge = await fetch(`${base}/api/explode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(2000) }) });
    assert.equal(tooLarge.status, 413);
  });
  const text = JSON.stringify(logged);
  for (const secret of ['AK-SECRET', 'SK-SECRET', 'SK-RAW', 'query-secret', 'leaked-token']) assert.equal(text.includes(secret), false, secret);
  assert.equal(text.includes('coin'), true);
});

test('route 5xx text is scrubbed, while 4xx text and non-error bodies pass through', async () => {
  await withApp(app => {
    app.use(scrubServerErrorResponses);
    app.get('/fail', (req, res) => res.status(500).json({ error: 'read /var/lib/coinpilot/x.json failed', holdings: [] }));
    app.get('/teapot', (req, res) => res.status(409).json({ error: 'see /Users/me for detail' }));
    app.get('/rows', (req, res) => res.status(503).json(['/Users/me']));
  }, async base => {
    const fail = await (await fetch(`${base}/fail`)).json();
    assert.deepEqual(fail, { error: 'read [path] failed', holdings: [] });
    assert.equal((await (await fetch(`${base}/teapot`)).json()).error, 'see /Users/me for detail');
    assert.deepEqual(await (await fetch(`${base}/rows`)).json(), ['/Users/me']);
  });
});

test('security headers cover pages and API; HSTS only on a secure request', async () => {
  await withApp(app => {
    app.use(securityHeadersMiddleware);
    app.get('/page', (req, res) => res.send('ok'));
    app.get('/api/x', (req, res) => res.json({}));
  }, async base => {
    const page = await fetch(`${base}/page`);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.equal(csp.includes('jsdelivr'), false);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('strict-transport-security'), null);
    assert.equal(page.headers.get('cache-control'), null);
    assert.equal((await fetch(`${base}/api/x`)).headers.get('cache-control'), 'no-store');
  });
});

test('dashboard serves hardening headers, local icons and rejects malformed market codes', async () => {
  await withDashboard({}, async base => {
    const shell = await fetch(`${base}/`);
    assert.equal(shell.headers.get('x-frame-options'), 'DENY');
    assert.equal(shell.headers.get('x-powered-by'), null);
    const html = await shell.text();
    assert.equal(/https?:\/\/(?!www\.w3\.org)[^"']*\.(css|js)/.test(html), false, 'shell must not load remote assets');
    assert.match(html, /href="\/app\/ui\/tokens\.css"/);
    assert.match(html, /<script type="module" src="\/app\/main\.js"><\/script>/);
    const icons = await fetch(`${base}/app/ui/icons.js`);
    assert.equal(icons.status, 200);
    assert.match(icons.headers.get('content-type') || '', /javascript/);
    await icons.text();

    for (const coin of ['KRW-BTC%2F..%2Fx', 'krw-btc', '%3Cscript%3E', 'KRW_BTC']) {
      const response = await fetch(`${base}/api/market/candles/${coin}`);
      assert.equal(response.status, 400, coin);
      await response.text();
    }
    const news = await fetch(`${base}/api/news/${encodeURIComponent('<img src=x>')}`);
    assert.equal(news.status, 400);
    await news.text();

    const malformed = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"token":"abc"' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.text()).includes('abc'), false);
  });
});
