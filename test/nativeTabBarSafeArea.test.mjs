import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const views = fs.readFileSync(
  new URL('../mobile/ios/App/App/CoinPilotViews.swift', import.meta.url),
  'utf8'
);

test('all native tab stacks reserve scroll space above the translucent system tab bar', () => {
  const tabView = views.split('private struct CoinPilotTabView: View')[1]
    ?.split('private var refreshToolbar: some ToolbarContent')[0] || '';
  const tabContentInsetApplications = tabView.match(/modifier\(CoinPilotTabBarContentInset\(\)\)/g) || [];

  assert.equal(tabContentInsetApplications.length, 5);
  assert.match(views, /private struct CoinPilotTabBarContentInset: ViewModifier/);
  assert.match(views, /safeAreaInset\(edge:\s*\.bottom,\s*spacing:\s*0\)/);
  assert.match(views, /\.frame\(height:\s*56\)/);
  assert.match(views, /\.accessibilityHidden\(true\)/);
});
