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

// Shell URLs are relative to the deployment prefix (`/` for paper, `/live/`
// behind the LIVE proxy), so both `icon.svg` and a legacy `/icon.svg` resolve
// against public/.
function safePublicFile(urlPath) {
  if (typeof urlPath !== 'string' || urlPath === '' || /^[a-z]+:/i.test(urlPath)) return null;
  const resolved = path.resolve(publicRoot, urlPath.replace(/^\/+/, ''));
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
  check('manifest-scope-relative', manifest.scope === './',
    `scope=${manifest.scope || 'missing'}`);
  check('manifest-start-url', manifest.start_url === './?source=pwa',
    `start_url=${manifest.start_url || 'missing'}`);
  check('manifest-id-stable', manifest.id === './?source=pwa',
    `id=${manifest.id || 'missing'}`);

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  check('manifest-icons-present', icons.length >= 3, `count=${icons.length}`);
  check('manifest-install-icons-raster',
    icons.length > 0 && icons.every(icon => icon?.type === 'image/png'),
  'install manifest uses browser-compatible raster icons');
  for (const icon of icons) {
    const file = safePublicFile(icon?.src);
    const exists = file && fs.existsSync(file) && fs.statSync(file).isFile();
    const bytes = exists ? fs.statSync(file).size : 0;
    check(`manifest-icon:${icon?.src || 'missing'}`, Boolean(exists && bytes > 0),
      exists ? `${bytes} bytes` : 'missing or outside public root');
  }

  const svgIconFile = safePublicFile('/icon.svg');
  const svgIconSource = svgIconFile && fs.existsSync(svgIconFile) ? read(svgIconFile) : '';
  check('svg-icon-explicit-square-geometry',
    /<svg\b[^>]*\bwidth=["']512["'][^>]*\bheight=["'][^>]*\bviewBox=["']0 0 512 512["']/.test(svgIconSource),
  'SVG install icon declares explicit 512x512 geometry');

  const scriptAsset = indexSource.match(/<script\s+type=["']module["']\s+src=["'](app\/main\.js)["']/)?.[1];
  const styleAssets = [...indexSource.matchAll(/<link\s+rel=["']stylesheet["']\s+href=["'](app\/ui\/[a-z]+\.css)["']/g)].map(match => match[1]);
  check('index-app-module-entry', Boolean(scriptAsset), scriptAsset || 'missing (must be relative: app/main.js)');
  check('index-app-design-tokens', styleAssets.includes('app/ui/tokens.css'), styleAssets.join(', ') || 'missing');
  check('index-no-root-absolute-assets', !/(?:href|src)=["']\/(?!\/)/.test(indexSource),
    'every shell asset is relative so a prefixed deployment loads its own server');
  check('index-mobile-web-app-capable',
    /<meta\s+name=["']mobile-web-app-capable["']\s+content=["']yes["']/i.test(indexSource),
    'Android install metadata declares mobile web app capability');
  check('index-apple-web-app-capable',
    /<meta\s+name=["']apple-mobile-web-app-capable["']\s+content=["']yes["']/i.test(indexSource),
    'iOS home-screen metadata declares standalone capability');
  check('index-apple-web-app-title',
    /<meta\s+name=["']apple-mobile-web-app-title["']\s+content=["']CoinPilot["']/i.test(indexSource),
    'iOS home-screen title is stable');
  check('index-apple-status-bar-style',
    /<meta\s+name=["']apple-mobile-web-app-status-bar-style["']\s+content=["'][^"']+["']/i.test(indexSource),
    'iOS standalone status-bar metadata is declared');
  check('index-apple-touch-icon-link',
    /<link\s+rel=["']apple-touch-icon["']\s+href=["']apple-touch-icon\.png["']/i.test(indexSource),
    'iOS home-screen raster icon is linked');

  const shellAssets = [
    '',
    'index.html',
    'manifest.webmanifest',
    'icon.svg',
    'icon-192.png',
    'icon-512.png',
    'apple-touch-icon.png',
    'auth-client.js',
    scriptAsset,
    ...styleAssets
  ].filter(Boolean);
  for (const asset of shellAssets) {
    const file = asset === '' ? indexFile : safePublicFile(asset.split('?')[0]);
    const exists = file && fs.existsSync(file) && fs.statSync(file).isFile();
    check(`shell-file:${asset || '(scope root)'}`, Boolean(exists && fs.statSync(file).size > 0),
      exists ? `${fs.statSync(file).size} bytes` : 'missing');
    check(`shell-cache:${asset || '(scope root)'}`, quotedAssetExists(serviceWorkerSource, asset),
      quotedAssetExists(serviceWorkerSource, asset) ? 'pre-cached' : 'not listed in APP_SHELL');
  }

  check('service-worker-scope-relative', /const SCOPE = new URL\(self\.registration\.scope\)\.pathname/.test(serviceWorkerSource),
    'shell paths resolve against the registration scope (paper / and LIVE /live/)');
  check('service-worker-own-shell-only', /if \(!isOwnShellPath\(url\.pathname\)\) return;/.test(serviceWorkerSource),
    'API, realtime and other prefixes on this origin are never answered from the shell cache');
  check('service-worker-cross-origin-bypass', /url\.origin\s*!==\s*self\.location\.origin\)\s*return/.test(serviceWorkerSource),
    'third-party assets keep their own response types when offline');
  check('service-worker-shell-network-first', /NETWORK_FIRST_SHELL_PATHS/.test(serviceWorkerSource) &&
    /fetch\(request\)[\s\S]*ignoreSearch: true/.test(serviceWorkerSource),
  'online shell assets refresh from the network and fall back to cache offline');
  check('service-worker-app-prefix-network-first', /NETWORK_FIRST_PREFIXES = \[at\(['"]app\/['"]\)\]/.test(serviceWorkerSource),
    'shell modules under app/ refresh from the network first');
  check('app-service-worker-registration', /navigator\.serviceWorker\.register\(`\$\{APP_BASE\}sw\.js`, \{ scope: APP_BASE \}\)/.test(read(path.join(publicRoot, 'app', 'main.js'))),
    'the web shell entry owns service worker registration');

  const valid = checks.every(item => item.passed);
  console.log(JSON.stringify({ valid, projectRoot, checks }, null, 2));
  if (!valid) process.exitCode = 1;
}

main();
