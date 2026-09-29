import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const stylesheet = fs.readFileSync(
  new URL('../public/pilot-redesign.css', import.meta.url),
  'utf8'
);

function matchingBlock(source, openingBraceIndex) {
  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingBraceIndex + 1, index);
    }
  }
  return null;
}

function blockAfter(source, expression) {
  const match = expression.exec(source);
  if (!match) return null;
  const openingBraceIndex = source.indexOf('{', match.index);
  return openingBraceIndex < 0 ? null : matchingBlock(source, openingBraceIndex);
}

test('360px PWA update button retains its own 44px touch target', () => {
  const narrowViewport = blockAfter(
    stylesheet,
    /@media\s*\(max-width:\s*360px\)\s*\{/
  );
  assert.ok(narrowViewport, 'expected a dedicated 360px media block');

  const updateButton = blockAfter(
    narrowViewport,
    /\.pilot-pwa-update\s+\.pilot-button\s*\{/
  );
  assert.ok(updateButton, 'expected an update-button rule inside the 360px block');
  assert.match(updateButton, /\bmin-height\s*:\s*44px\s*;/);
  assert.doesNotMatch(updateButton, /\bmin-height\s*:\s*32px\s*;/);
});
