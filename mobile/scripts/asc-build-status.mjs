#!/usr/bin/env node
// Query App Store Connect for the latest CoinPilot build processing status.
// Uses the account-level ASC API key from kbo-fans-testflight.env
// (ASC_ISSUER_ID / ASC_KEY_ID / ASC_KEY_PATH) and a manually signed ES256 JWT.
//
// Usage: node scripts/asc-build-status.mjs [--watch]
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BUNDLE_ID = 'com.godekd3133.coinpilot';
const watch = process.argv.includes('--watch');

const envPath = join(homedir(), '.config/kbo-fans/secrets/appstoreconnect/kbo-fans-testflight.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.split('=', 2).map((s) => s.trim()))
);
const { ASC_ISSUER_ID, ASC_KEY_ID, ASC_KEY_PATH } = env;
if (!ASC_ISSUER_ID || !ASC_KEY_ID || !ASC_KEY_PATH) {
  console.error('ASC_ISSUER_ID / ASC_KEY_ID / ASC_KEY_PATH required in', envPath);
  process.exit(1);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function jwt() {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
  const signer = createSign('sha256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign({ key: readFileSync(ASC_KEY_PATH), dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${sig.toString('base64url')}`;
}

async function asc(path) {
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    headers: { Authorization: `Bearer ${jwt()}` }
  });
  if (!res.ok) throw new Error(`ASC ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function latest() {
  const apps = await asc(`/apps?filter[bundleId]=${BUNDLE_ID}`);
  const app = apps.data?.[0];
  if (!app) throw new Error(`No ASC app for ${BUNDLE_ID}`);
  const builds = await asc(`/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=3&fields[builds]=version,uploadedDate,processingState,expired`);
  return builds.data.map((b) => ({
    version: `${app.attributes?.name ?? 'App'} build ${b.attributes.version}`,
    uploaded: b.attributes.uploadedDate,
    state: b.attributes.processingState,
    expired: b.attributes.expired
  }));
}

const rows = await latest();
for (const r of rows) {
  console.log(`${r.version} · ${r.state} · uploaded ${r.uploaded}${r.expired ? ' · EXPIRED' : ''}`);
}
if (watch && rows[0]?.state === 'PROCESSING') {
  console.log('…processing; polling every 60s (Ctrl-C to stop)');
  const timer = setInterval(async () => {
    try {
      const [top] = await latest();
      console.log(`  ${new Date().toISOString()} → ${top.state}`);
      if (top.state !== 'PROCESSING') { clearInterval(timer); console.log(`Final: ${top.state}`); }
    } catch (e) { console.log(`  poll error: ${e.message}`); }
  }, 60_000);
}
