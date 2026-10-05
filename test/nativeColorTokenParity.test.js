import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(repositoryRoot, 'public/pilot-redesign.css'), 'utf8');
const swift = fs.readFileSync(path.join(repositoryRoot, 'mobile/ios/App/App/CoinPilotViews.swift'), 'utf8');
const rootTokens = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];

function cssColor(tokenName) {
  function resolveToken(name, visited = new Set()) {
    assert.ok(!visited.has(name), `PWA token cycle detected at --${name}`);
    visited.add(name);
    const match = rootTokens?.match(new RegExp(`--${name}:\\s*([^;]+)`));
    assert.ok(match, `PWA root semantic token --${name} must exist`);
    const value = match[1].trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
    const reference = value.match(/^var\((--[a-zA-Z0-9_-]+)\)$/);
    assert.ok(reference, `PWA root semantic token --${name} must resolve to a six-digit color`);
    return resolveToken(reference[1].slice(2), visited);
  }
  const hex = resolveToken(`sl-${tokenName}`).slice(1);
  return [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function swiftColor(tokenName) {
  const declaration = swift.match(new RegExp(`static let ${tokenName} = ([^\\n]+)`));
  assert.ok(declaration, `Swift semantic token ${tokenName} must exist`);
  if (declaration[1].trim() === 'Color.white') return [255, 255, 255];
  const match = declaration[1].match(/Color\(red:\s*(\d+)\s*\/\s*255,\s*green:\s*(\d+)\s*\/\s*255,\s*blue:\s*(\d+)\s*\/\s*255\)/);
  assert.ok(match, `Swift semantic token ${tokenName} must use an explicit 8-bit RGB mapping`);
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

test('native and PWA semantic surface/status colors remain aligned', () => {
  const tokenPairs = [
    ['paper', 'paper'],
    ['surface', 'surface'],
    ['ink', 'ink'],
    ['secondaryInk', 'muted'],
    ['line', 'line'],
    ['blue', 'blue'],
    ['green', 'green'],
    ['red', 'red'],
    ['amber', 'amber']
  ];

  for (const [swiftName, cssName] of tokenPairs) {
    assert.deepEqual(swiftColor(swiftName), cssColor(cssName), `${swiftName} must match the PWA --sl-${cssName} token`);
  }
});

test('native status-text colors meet WCAG AA contrast on the shared surface', () => {
  for (const [nativeToken, webToken] of [['ink', 'ink'], ['secondaryInk', 'muted'], ['blue', 'blue'], ['green', 'green'], ['red', 'red'], ['amber', 'amber']]) {
    for (const background of ['surface', 'paper']) {
      const nativeRatio = contrastRatio(swiftColor(nativeToken), swiftColor(background));
      const webRatio = contrastRatio(cssColor(webToken), cssColor(background));
      assert.ok(nativeRatio >= 4.5, `native ${nativeToken} on ${background} contrast is ${nativeRatio.toFixed(2)}:1, expected at least 4.5:1`);
      assert.ok(webRatio >= 4.5, `--sl-${webToken} on ${background} contrast is ${webRatio.toFixed(2)}:1, expected at least 4.5:1`);
    }
  }
});
