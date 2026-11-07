import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const shell = fs.readFileSync(
  new URL('../mobile/ios/App/App/CoinPilotRootView.swift', import.meta.url),
  'utf8'
);
const registry = fs.readFileSync(
  new URL('../mobile/ios/App/App/CPFeature.swift', import.meta.url),
  'utf8'
);

test('every native tab stack reserves scroll space above the translucent system tab bar', () => {
  const shellView = shell.split('struct CoinPilotShellView: View')[1]
    ?.split('struct CoinPilotFeatureScreen: View')[0] || '';
  // Tabs are generated from the registry, so the inset must be applied inside the
  // ForEach that builds each tab (one application covers every tab).
  assert.match(shellView, /ForEach\(CPFeatureRegistry\.phoneTabs\)[\s\S]*modifier\(CoinPilotTabBarContentInset\(\)\)[\s\S]*\.tabItem/);
  assert.match(shell, /struct CoinPilotTabBarContentInset: ViewModifier/);
  assert.match(shell, /safeAreaInset\(edge:\s*\.bottom,\s*spacing:\s*0\)/);
  assert.match(shell, /\.frame\(height:\s*56\)/);
  assert.match(shell, /\.accessibilityHidden\(true\)/);
});

test('the iOS tab bar is driven by the feature registry with five tabs', () => {
  const entries = [...registry.matchAll(/CPFeature\(id: "([a-z-]+)"[^\n]*surfaces: \[([^\]]*)\]/g)];
  const phoneTabs = entries.filter(([, , surfaces]) => surfaces.includes('.phoneTab')).map(([, id]) => id);
  assert.deepEqual(phoneTabs, ['home', 'activity', 'coins', 'lab', 'settings']);
  const sidebar = entries.filter(([, , surfaces]) => surfaces.includes('.sidebar')).map(([, id]) => id);
  for (const id of ['home', 'activity', 'coins', 'settings']) {
    assert.ok(sidebar.includes(id), `Mac sidebar must include ${id}`);
  }
  // Everything that left the tab bar stays reachable from 연구실 (and its Mac sidebar sections).
  const lab = entries.filter(([, , surfaces]) => surfaces.includes('.labLink')).map(([, id]) => id);
  for (const id of ['stocks', 'portfolios', 'ai-desk', 'news', 'optimization', 'presets', 'tuning',
    'research-desk', 'offline-replay', 'account-analytics']) {
    assert.ok(lab.includes(id), `연구실 must include ${id}`);
  }
});

test('a stored selection from the previous tab layout is migrated, not left blank', () => {
  assert.match(registry, /selectedFeatureKey = "coinpilot\.native\.selectedFeature\.v4"/);
  assert.match(registry, /legacySelectedFeatureKeys = \["coinpilot\.native\.selectedFeature\.v3"\]/);
  assert.match(registry, /legacyAliases: \[String: String\] = \["more": "lab"\]/);
  assert.match(shell, /CPNavigation\.migrateStoredSelection\(\)/);
});
