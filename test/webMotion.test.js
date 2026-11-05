import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('motion tokens stay short and collapse under reduced motion', () => {
  const tokens = read('public/app/ui/tokens.css');
  const root = tokens.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  for (const name of ['fast', 'base', 'slow']) {
    const ms = Number(root.match(new RegExp(`--cp-motion-${name}:\\s*(\\d+)ms`))?.[1]);
    assert.ok(ms > 0 && ms <= 350, `--cp-motion-${name} is ${ms}ms`);
  }
  assert.match(tokens, /prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{[^}]*--cp-press-scale: 1/);
});

test('route, stagger, button and number motion all have a reduced-motion override', () => {
  const css = read('public/app/ui/components.css');
  for (const selector of ['.cp-content.is-route-in', '.is-entering .cp-list > *', '.is-revealing', '.is-ticking', '.cp-btn:hover']) {
    assert.ok(css.includes(selector), `${selector} styled`);
  }
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map(match => match[1]).join('\n');
  for (const selector of ['.cp-content.is-route-in', '.is-revealing', '.is-ticking', '.is-entering .cp-list > *']) {
    assert.ok(reduced.includes(selector), `${selector} reduced`);
  }
});

test('stat and hero numbers carry count-up metadata only for finite values', async () => {
  const { stat, heroValue, countAttrs } = await import('../public/app/ui/components.js');
  const tile = String(stat({ label: '실현 손익', value: '+1,000원', countup: { value: 1000, key: 'k', format: 'signedWon' } }));
  assert.match(tile, /data-countup="1000"/);
  assert.match(tile, /data-countup-format="signedWon"/);
  assert.doesNotMatch(String(stat({ label: 'x', value: '—', countup: { value: null, key: 'k' } })), /data-countup/);
  assert.doesNotMatch(String(stat({ label: 'x', value: '1' })), /data-countup/);
  assert.equal(String(countAttrs(Number.NaN, { key: 'k' })), '');
  const hero = String(heroValue({ label: '총자산', value: 100, key: 'h', change: -5, changePercent: -0.5 }));
  assert.match(hero, /data-countup="-5" data-countup-key="h:change" data-countup-format="signedWon"/);
  assert.match(hero, /data-countup-format="percent"/);
});
