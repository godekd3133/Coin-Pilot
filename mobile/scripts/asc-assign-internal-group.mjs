#!/usr/bin/env node
// Assign the latest uploaded CoinPilot build to the internal TestFlight group.
// Uploads alone never reach testers — a build must be added to a beta group.
// Success requires a VALID build, exact group membership, and IN_BETA_TESTING.
// Already-assigned builds are confirmed through GET readback without another POST.
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BUNDLE_ID = 'com.godekd3133.coinpilot';
const INTERNAL_GROUP_NAME = 'CoinPilot Internal';
const POLL_INTERVAL_MS = 15_000;
const deadline = Date.now() + 10 * 60_000;
const envPath = join(homedir(), '.config/kbo-fans/secrets/appstoreconnect/kbo-fans-testflight.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    })
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
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('App Store Connect verification exceeded the 10-minute wait window');
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(Math.min(30_000, remaining))
  });
  if (!res.ok) {
    // Log only endpoint/status metadata, never API response bodies or credentials.
    const error = new Error(`ASC ${method} ${path} -> HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.status === 204 ? null : res.json();
}

async function allRows(path) {
  const rows = [];
  while (path) {
    const page = await asc(path);
    rows.push(...(page.data ?? []));
    if (!page.links?.next) break;
    const next = new URL(page.links.next, 'https://api.appstoreconnect.apple.com');
    if (next.origin !== 'https://api.appstoreconnect.apple.com' || !next.pathname.startsWith('/v1/')) {
      throw new Error('Unexpected App Store Connect pagination URL');
    }
    path = `${next.pathname.slice(3)}${next.search}`;
  }
  return rows;
}

async function pollDelay() {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('App Store Connect verification exceeded the 10-minute wait window');
  await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
}

const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && !/^\d+$/.test(args[0]))) {
  throw new Error('Usage: node asc-assign-internal-group.mjs [build-number]');
}
const targetVersion = args[0] || null;

const apps = await asc(`/apps?filter[bundleId]=${BUNDLE_ID}`);
const app = apps.data?.[0];
if (!app) throw new Error(`No ASC app for ${BUNDLE_ID}`);

const groups = await allRows(`/betaGroups?filter[app]=${app.id}&limit=200`);
const matchingGroups = groups.filter((group) => group.attributes?.isInternalGroup && group.attributes.name === INTERNAL_GROUP_NAME);
if (matchingGroups.length !== 1) throw new Error(`Expected exactly one internal group named ${INTERNAL_GROUP_NAME}`);
const internal = matchingGroups[0];

let build = null;
let waitingState = null;
while (Date.now() < deadline) {
  if (build) {
    build = (await asc(`/builds/${build.id}`)).data;
  } else {
    const versionFilter = targetVersion ? `&filter[version]=${targetVersion}` : '';
    const builds = await asc(`/builds?filter[app]=${app.id}${versionFilter}&sort=-uploadedDate&limit=5`);
    build = targetVersion
      ? builds.data?.find((candidate) => candidate.attributes?.version === targetVersion)
      : builds.data?.[0];
  }
  const state = build?.attributes?.processingState ?? 'NOT_YET_VISIBLE';
  if (build?.attributes?.expired) throw new Error(`Build ${build.attributes.version} has expired`);
  if (state === 'VALID') break;
  if (!['NOT_YET_VISIBLE', 'PROCESSING'].includes(state)) {
    throw new Error(`Build ${build?.attributes?.version ?? targetVersion} cannot be assigned: ${state}`);
  }
  if (waitingState !== state) {
    console.log(`Waiting for build ${build?.attributes?.version ?? targetVersion ?? 'latest'}: ${state}`);
    waitingState = state;
  }
  await pollDelay();
}
if (build?.attributes?.processingState !== 'VALID') throw new Error(`Build ${targetVersion ?? 'latest'} did not reach VALID within the wait window`);

async function isAssigned() {
  const assigned = await allRows(`/betaGroups/${internal.id}/builds?limit=200`);
  return assigned.some((candidate) => candidate.id === build.id);
}

const alreadyAssigned = await isAssigned();
console.log(`${alreadyAssigned ? 'Verifying' : 'Assigning'} build ${build.attributes.version} (VALID) -> ${internal.attributes.name}`);
if (!alreadyAssigned) {
  try {
    await asc(`/builds/${build.id}/relationships/betaGroups`, 'POST', {
      data: [{ type: 'betaGroups', id: internal.id }]
    });
  } catch (error) {
    // A duplicate race is acceptable only after exact membership is confirmed.
    if (![400, 409].includes(error.status) || !(await isAssigned())) throw error;
    console.log(`Assignment HTTP ${error.status}; exact existing membership confirmed`);
  }
}

waitingState = null;
while (Date.now() < deadline) {
  const assigned = await isAssigned();
  const details = await asc(`/builds/${build.id}/buildBetaDetail`);
  const state = details.data?.attributes?.internalBuildState ?? 'UNAVAILABLE';
  if (['EXPIRED', 'PROCESSING_EXCEPTION', 'MISSING_EXPORT_COMPLIANCE', 'IN_EXPORT_COMPLIANCE_REVIEW'].includes(state)) {
    throw new Error(`Build ${build.attributes.version} is unavailable for internal testing: ${state}`);
  }
  if (assigned && state === 'IN_BETA_TESTING') {
    console.log(`Verified: build ${build.attributes.version} VALID, group "${internal.attributes.name}", internal state ${state}`);
    process.exit(0);
  }
  const observation = `${assigned ? 'MEMBER' : 'NOT_YET_MEMBER'} / ${state}`;
  if (waitingState !== observation) {
    console.log(`Waiting for build ${build.attributes.version} testing availability: ${observation}`);
    waitingState = observation;
  }
  await pollDelay();
}
throw new Error(`Build ${build.attributes.version} group membership and IN_BETA_TESTING were not verified within the wait window`);
