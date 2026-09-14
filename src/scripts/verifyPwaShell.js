import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const publicRoot = path.join(projectRoot, 'public');
const manifestFile = path.join(publicRoot, 'manifest.webmanifest');
const indexFile = path.join(publicRoot, 'index.html');
const serviceWorkerFile = path.join(publicRoot, 'sw.js');

const checks = [];

function check(id, passed, detail) {
  checks.push({ id, passed: Boolean(passed), detail });
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function safePublicFile(urlPath) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/')) return null;
  const resolved = path.resolve(publicRoot, urlPath.slice(1));
  const relative = path.relative(publicRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function quotedAssetExists(source, asset) {
  const escaped = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"]${escaped}['"]`).test(source);
}

function main() {
  let manifest;
  let indexSource;
  let serviceWorkerSource;
  try {
    manifest = JSON.parse(read(manifestFile));
    indexSource = read(indexFile);
    serviceWorkerSource = read(serviceWorkerFile);
  } catch (error) {
    check('pwa-files-readable', false, error.message);
    return;
  }

  check('manifest-display-standalone', manifest.display === 'standalone',
    `display=${manifest.display || 'missing'}`);
  check('manifest-scope-root', manifest.scope === '/',
    `scope=${manifest.scope || 'missing'}`);
  check('manifest-start-url', manifest.start_url === '/?source=pwa',
    `start_url=${manifest.start_url || 'missing'}`);

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  check('manifest-icons-present', icons.length >= 3, `count=${icons.length}`);
  for (const icon of icons) {
    const file = safePublicFile(icon?.src);
    const exists = file && fs.existsSync(file) && fs.statSync(file).isFile();
    const bytes = exists ? fs.statSync(file).size : 0;
    check(`manifest-icon:${icon?.src || 'missing'}`, Boolean(exists && bytes > 0),
      exists ? `${bytes} bytes` : 'missing or outside public root');
  }

  const scriptAsset = indexSource.match(/<script\s+src=["'](\/pilot-redesign\.js\?v=[^"']+)["']/)?.[1];
  const styleAsset = indexSource.match(/<link\s+rel=["']stylesheet["']\s+href=["'](\/pilot-redesign\.css\?v=[^"']+)["']/)?.[1];
  check('index-redesign-script-version', Boolean(scriptAsset), scriptAsset || 'missing');
  check('index-redesign-style-version', Boolean(styleAsset), styleAsset || 'missing');

  const shellAssets = [
    '/',
    '/index.html',
    '/manifest.webmanifest',
    '/icon.svg',
    '/icon-192.png',
    '/icon-512.png',
    '/apple-touch-icon.png',
    scriptAsset,
    styleAsset
  ].filter(Boolean);
  for (const asset of shellAssets) {
    const file = asset === '/' ? indexFile : safePublicFile(asset.split('?')[0]);
    const exists = file && fs.existsSync(file) && fs.statSync(file).isFile();
    check(`shell-file:${asset}`, Boolean(exists && fs.statSync(file).size > 0),
      exists ? `${fs.statSync(file).size} bytes` : 'missing');
    check(`shell-cache:${asset}`, quotedAssetExists(serviceWorkerSource, asset),
      quotedAssetExists(serviceWorkerSource, asset) ? 'pre-cached' : 'not listed in APP_SHELL');
  }

  check('service-worker-api-bypass', /url\.pathname\.startsWith\(['"]\/api\//.test(serviceWorkerSource),
    'dynamic API state is not served from the shell cache');
  check('redesign-service-worker-registration', /navigator\.serviceWorker\.register\(['"]\/sw\.js['"]\)/.test(read(path.join(publicRoot, 'pilot-redesign.js'))),
    'redesign owns service worker registration');

  const valid = checks.every(item => item.passed);
  console.log(JSON.stringify({ valid, projectRoot, checks }, null, 2));
  if (!valid) process.exitCode = 1;
}

main();
