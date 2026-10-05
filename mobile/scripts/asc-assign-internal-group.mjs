#!/usr/bin/env node
// Assign the latest uploaded CoinPilot build to the internal TestFlight group.
// Uploads alone never reach testers — a build must be added to a beta group.
// Safe to re-run: assigning an already-assigned build is a no-op on ASC's side
// (POST to the relationship is idempotent; a 409-style error is tolerated).
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BUNDLE_ID = 'com.godekd3133.coinpilot';
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

async function asc(path, method = 'GET', body = null) {
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`ASC ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// 특정 빌드 번호가 주어지면 그 빌드를 배정한다 — 방금 업로드한 빌드가 ASC에
// 등록되기까지 수 분 걸리므로 나타날 때까지 폴링한다.
const targetVersion = process.argv.find((arg) => /^\d+$/.test(arg)) || null;
const POLL_LIMIT = 40; // ~10분

const apps = await asc(`/apps?filter[bundleId]=${BUNDLE_ID}`);
const app = apps.data?.[0];
if (!app) throw new Error(`No ASC app for ${BUNDLE_ID}`);

const groups = await asc(`/betaGroups?filter[app]=${app.id}`);
const internal = groups.data?.find((g) => g.attributes?.isInternalGroup);
if (!internal) throw new Error('No internal beta group found for app');

let build = null;
for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
  const builds = await asc(`/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=5`);
  build = targetVersion
    ? builds.data?.find((candidate) => candidate.attributes?.version === targetVersion)
    : builds.data?.[0];
  if (build) break;
  await new Promise((resolve) => setTimeout(resolve, 15000));
}
if (!build) {
  throw new Error(targetVersion
    ? `Build ${targetVersion} did not appear on App Store Connect within the wait window`
    : 'No builds found for app');
}

console.log(`Assigning build ${build.attributes.version} (${build.attributes.processingState}) -> ${internal.attributes.name}`);
try {
  await asc(`/builds/${build.id}/relationships/betaGroups`, 'POST', {
    data: [{ type: 'betaGroups', id: internal.id }]
  });
  console.log(`Assigned. Testers in "${internal.attributes.name}" can install build ${build.attributes.version} once it is VALID.`);
} catch (error) {
  // ASC rejects re-adding an already-assigned group; that is fine.
  console.log(`Assignment returned an error (likely already assigned): ${error.message}`);
}
