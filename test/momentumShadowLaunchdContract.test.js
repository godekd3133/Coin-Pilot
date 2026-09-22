import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quotePlist = path.join(projectRoot, 'ops', 'launchd', 'com.coinpilot.momentum-shadow.quotes.plist');

function plistInteger(source, key) {
  const match = source.match(new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`));
  return match ? Number(match[1]) : null;
}

test('quote launchd schedule leaves slack below the 15-minute freshness guard', () => {
  const source = fs.readFileSync(quotePlist, 'utf8');
  const scheduleSeconds = plistInteger(source, 'StartInterval');
  const freshnessSeconds = 15 * 60;

  assert.equal(scheduleSeconds, 10 * 60);
  assert.ok(scheduleSeconds > 0);
  assert.ok(scheduleSeconds < freshnessSeconds);
  assert.match(source, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(source, /<key>MOMO_SHADOW_QUOTE_SAMPLES<\/key>\s*<string>5<\/string>/);
  assert.match(source, /<key>MOMO_SHADOW_QUOTE_MAX_SPREAD_PERCENT<\/key>\s*<string>0\.5<\/string>/);
});
