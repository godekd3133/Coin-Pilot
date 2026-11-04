import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The web shell (public/app/ui/tokens.css, --cp-*) and the native design system
// (mobile/ios/App/App/DesignSystem/CPTokens.swift, CPColor) must use the same
// semantic colours in light and dark mode. See docs/design/renewal-architecture.md §3.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(repositoryRoot, 'public/app/ui/tokens.css'), 'utf8');
const swift = fs.readFileSync(path.join(repositoryRoot, 'mobile/ios/App/App/DesignSystem/CPTokens.swift'), 'utf8');

const rootTokens = css.match(/(?:^|\n):root\s*\{([\s\S]*?)\n\}/)?.[1];
const darkTokens = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1];

// [Swift CPColor name, CSS --cp-* name]
const TOKEN_PAIRS = [
  ['paper', 'paper'],
  ['surface', 'surface'],
  ['surface2', 'surface2'],
  ['ink', 'ink'],
  ['secondaryInk', 'muted'],
  ['line', 'line'],
  ['blue', 'blue'],
  ['green', 'green'],
  ['red', 'red'],
  ['amber', 'amber'],
  ['up', 'up'],
  ['down', 'down']
];

function hexToRgb(hex) {
  const value = hex.slice(1);
  return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function cssColor(tokenName, block = rootTokens, label = ':root') {
  assert.ok(block, `tokens.css must define a ${label} block`);
  const match = block.match(new RegExp(`--cp-${tokenName}:\\s*([^;]+);`));
  assert.ok(match, `web token --cp-${tokenName} must exist in ${label}`);
  const value = match[1].trim();
  assert.match(value, /^#[0-9a-fA-F]{6}$/, `--cp-${tokenName} in ${label} must be a six-digit hex colour`);
  return hexToRgb(value);
}

function swiftDeclaration(tokenName) {
  const declaration = swift.match(new RegExp(`static let ${tokenName} = ([^\\n]+)`));
  assert.ok(declaration, `Swift CPColor.${tokenName} must exist`);
  return declaration[1];
}

function swiftColor(tokenName) {
  const match = swiftDeclaration(tokenName)
    .match(/Color\(red:\s*(\d+)\s*\/\s*255,\s*green:\s*(\d+)\s*\/\s*255,\s*blue:\s*(\d+)\s*\/\s*255\)/);
  assert.ok(match, `Swift CPColor.${tokenName} must use an explicit 8-bit RGB mapping`);
  return match.slice(1).map(Number);
}

function swiftDarkColor(tokenName) {
  const match = swiftDeclaration(tokenName).match(/\.cpDark\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/);
  assert.ok(match, `Swift CPColor.${tokenName} must declare its dark value with .cpDark(r, g, b)`);
  return match.slice(1).map(Number);
}

function relativeLuminance([red, green, blue]) {
  const linear = [red, green, blue].map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(first, second) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('native and web light semantic colours remain aligned (including up/down)', () => {
  for (const [swiftName, cssName] of TOKEN_PAIRS) {
    assert.deepEqual(swiftColor(swiftName), cssColor(cssName), `CPColor.${swiftName} must match --cp-${cssName}`);
  }
});

test('native and web dark semantic colours remain aligned', () => {
  for (const [swiftName, cssName] of TOKEN_PAIRS) {
    assert.deepEqual(
      swiftDarkColor(swiftName),
      cssColor(cssName, darkTokens, ':root[data-theme="dark"]'),
      `CPColor.${swiftName} dark value must match the dark --cp-${cssName}`
    );
  }
});

test('Korean P&L convention: up is red-dominant, down is blue-dominant', () => {
  const [upRed, , upBlue] = swiftColor('up');
  const [downRed, , downBlue] = swiftColor('down');
  assert.ok(upRed > upBlue, 'CPColor.up (rise/profit) must be a red hue');
  assert.ok(downBlue > downRed, 'CPColor.down (fall/loss) must be a blue hue');
});

test('native status-text colours meet WCAG AA contrast on the shared surface', () => {
  // P&L numbers (up/down) render inside cards, so they are held to AA on the
  // card surface; status/body text must also pass on the paper background.
  const textTokens = [
    ['ink', 'ink', ['surface', 'paper']], ['secondaryInk', 'muted', ['surface', 'paper']],
    ['blue', 'blue', ['surface', 'paper']], ['green', 'green', ['surface', 'paper']],
    ['red', 'red', ['surface', 'paper']], ['amber', 'amber', ['surface', 'paper']],
    ['up', 'up', ['surface', 'paper']], ['down', 'down', ['surface', 'paper']]
  ];
  for (const [nativeToken, webToken, backgrounds] of textTokens) {
    for (const nativeBackground of backgrounds) {
      const webBackground = nativeBackground;
      const nativeRatio = contrastRatio(swiftColor(nativeToken), swiftColor(nativeBackground));
      const webRatio = contrastRatio(cssColor(webToken), cssColor(webBackground));
      assert.ok(nativeRatio >= 4.5, `native ${nativeToken} on ${nativeBackground} contrast is ${nativeRatio.toFixed(2)}:1, expected at least 4.5:1`);
      assert.ok(webRatio >= 4.5, `--cp-${webToken} on ${webBackground} contrast is ${webRatio.toFixed(2)}:1, expected at least 4.5:1`);
    }
  }
});
