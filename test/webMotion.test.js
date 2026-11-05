import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// The web shell carries no decorative motion: entrance/stagger, count-up,
// pop, pulse, shimmer, hover lift and press scale read as generated UI.
test('component and shell CSS define no keyframe animation or press scale', () => {
  for (const file of ['public/app/ui/components.css', 'public/app/ui/base.css']) {
    const css = read(file);
    assert.doesNotMatch(css, /@keyframes|animation:/, `${file} animates`);
    assert.doesNotMatch(css, /scale\(/, `${file} scales on press/hover`);
    assert.doesNotMatch(css, /ease-spring/, `${file} uses a spring curve`);
  }
});

test('no gradient fills or rainbow allocation hues in components', () => {
  const css = read('public/app/ui/components.css').replace(/select\.cp-input[^\n]*/, '');
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/);
  assert.doesNotMatch(css, /#7c5cd6|#18a2b8/);
  assert.doesNotMatch(read('public/app/ui/charts.js'), /linearGradient/);
});

test('numbers are written exactly, with no roll', async () => {
  const { stat, runCountUps } = await import('../public/app/ui/components.js');
  assert.match(String(stat({ label: '실현 손익', value: '+1,000원', countup: { value: 1000, key: 'k', format: 'signedWon' } })), /data-countup="1000"/);
  const element = { dataset: { countup: '1234', countupFormat: 'plain' }, textContent: '0', matches: () => true, querySelectorAll: () => [] };
  runCountUps(element);
  assert.equal(element.textContent, '1,234');
});
