import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_NODE_RELEASES = Object.freeze([
  Object.freeze({ major: 24, minimumMinor: 21 })
]);

function parseNodeVersion(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

export function isSupportedNodeVersion(version) {
  const parsed = parseNodeVersion(version);
  if (!parsed || parsed.some(value => !Number.isSafeInteger(value))) return false;
  const [major, minor] = parsed;
  const release = SUPPORTED_NODE_RELEASES.find(candidate => candidate.major === major);
  return Boolean(release && minor >= release.minimumMinor);
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  if (isSupportedNodeVersion(version)) return true;
  const supported = SUPPORTED_NODE_RELEASES
    .map(({ major, minimumMinor }) => minimumMinor === 0
      ? `${major}.x`
      : `${major}.${minimumMinor}+ (${major}.x)`)
    .join(' or ');
  const error = new Error(
    `CoinPilot supports Node.js ${supported}; found ${String(version || 'unknown')}.`
  );
  error.code = 'COINPILOT_NODE_VERSION_UNSUPPORTED';
  error.supportedReleases = supported;
  error.actualVersion = String(version || 'unknown');
  throw error;
}

export function verifyNodeRuntime({ version = process.versions.node, output = console } = {}) {
  try {
    assertSupportedNodeVersion(version);
    output.log(`CoinPilot Node.js runtime: ${version}`);
    return true;
  } catch (error) {
    output.error(error.message);
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (!verifyNodeRuntime()) process.exitCode = 1;
}
