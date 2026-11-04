#!/usr/bin/env node
/*
 * Builds the serverless Coin Pilot demo from the real dashboard frontend.
 *   npm run demo:build                       -> ../../linked-me/public/demos/coin-pilot
 *   npm run demo:build -- /some/output/dir   -> custom location
 * Only public/ and demo/static/ feed the bundle, and both are read-only here.
 * The build fails if the output contains a forbidden pattern.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const publicDir = path.join(repoRoot, 'public');
const demoDir = path.join(repoRoot, 'demo', 'static');
const defaultOutDir = path.join(repoRoot, '..', '..', 'linked-me', 'public', 'demos', 'coin-pilot');
const SERVICE_WORKER_CALL = /navigator\.serviceWorker\.register\('\/sw\.js'\)/g;
const DISABLED_SERVICE_WORKER = 'Promise.reject(new Error("demo: service worker disabled"))';

export const FORBIDDEN_PATTERNS = [
  [/cdn\.jsdelivr|unpkg\.com|cdnjs|fonts\.googleapis/i, 'external CDN'],
  [/api\.upbit\.com|api\.binance|sg-api\.upbit/i, 'exchange endpoint'],
  // Absolute host paths only: a relative module path such as ../features/home/ is not one.
  [/(?<![\w.])\/Users\/|(?<![\w.])\/home\/[a-z]|\/var\/lib\/coinpilot/i, 'internal path'],
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}\b/, 'host:port literal'],
  [/\bUPBIT_(ACCESS|SECRET)_KEY\s*=\s*\S+/, 'credential assignment'],
  [/eyJ[A-Za-z0-9_-]{20,}\./, 'JWT-like token'],
  [/serviceWorker\.register\(/, 'active service worker registration']
];

function replaceRequired(source, pattern, replacement, label) {
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`Demo build: expected fragment not found (${label}). The dashboard markup changed.`);
  return next;
}

export function transformIndexHtml(source) {
  let html = source;
  html = replaceRequired(html, /<link rel="manifest"[^>]*>\s*/, '', 'manifest');
  html = replaceRequired(html, /<link rel="apple-touch-icon"[^>]*>\s*/, '', 'touch icon');
  html = replaceRequired(html, /href="\/icon\.svg"/, 'href="./icon.svg"', 'favicon');
  html = replaceRequired(html, /href="\/app\/ui\/tokens\.css"/, 'href="./app/ui/tokens.css"', 'design tokens');
  html = html.replace(/href="\/app\/ui\/([a-z]+\.css)"/g, 'href="./app/ui/$1"');
  html = replaceRequired(html, /<script src="\/socket\.io\/socket\.io\.js"><\/script>/, '<script src="./sim-core.js"></script>\n    <script src="./runtime.js"></script>', 'socket script');
  html = replaceRequired(html, /<script src="\/auth-client\.js[^"]*"><\/script>/, '<script src="./auth-client.js"></script>', 'auth client');
  html = replaceRequired(html, /<script type="module" src="\/app\/main\.js"><\/script>/, '<script type="module" src="./app/main.js"></script>\n    <script src="./demo-ui.js"></script>', 'app entry');
  html = replaceRequired(html, /<title>[^<]*<\/title>/, '<title>Coin Pilot 체험판 (합성 데이터)</title>', 'title');
  html = replaceRequired(html, '</head>', `    <meta name="robots" content="noindex">
    <meta name="description" content="Coin Pilot 대시보드를 합성 데이터로 만져 보는 체험판. 실제 거래소와 연결되지 않으며 투자 권유가 아닙니다.">
    <link rel="stylesheet" href="./demo.css">
    <script>if (!location.pathname.endsWith('/') && !location.pathname.endsWith('.html')) location.replace(location.pathname + '/' + location.search + location.hash);</script>
</head>`, 'head');
  return html.replace(SERVICE_WORKER_CALL, DISABLED_SERVICE_WORKER);
}

// Copy that would describe a real venue or a real validation decision is swapped
// here, in the demo copy only, so public/ keeps its production wording.
const DEMO_COPY = [
  ['업비트 원화 시장', '예시 합성 시장'],
  ['종목 검색 (비트코인, BTC, 005930)', '종목 검색 (예시코인, DEMOA)'],
  ['이름·심볼 검색 (비트코인, BTC)', '이름·심볼 검색 (예시코인, DEMOA)'],
  ['성과 검증 없이 자동매매를 시작할 수 있습니다.', '체험판은 합성 데이터로만 돌아가므로 전략 성과를 검증하지 않습니다.'],
  ['성과 검증은 선택 사항', '체험판: 성과 검증 대상 아님']
];

/** Applied to every web-shell module copied into the demo. */
export function transformAppScript(source) {
  let script = source.replace(SERVICE_WORKER_CALL, DISABLED_SERVICE_WORKER);
  for (const [from, to] of DEMO_COPY) script = script.split(from).join(to);
  return script;
}

/** @deprecated kept for callers of the previous single-bundle build. */
export const transformRedesignScript = transformAppScript;

function copyAppTree(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isDirectory()) copyAppTree(from, to);
    else if (entry.name.endsWith('.js')) fs.writeFileSync(to, transformAppScript(fs.readFileSync(from, 'utf8')));
    else fs.copyFileSync(from, to);
  }
}

export function scanBundle(dir) {
  const findings = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { findings.push(...scanBundle(full)); continue; }
    if (!/\.(html|js|css|svg|json|txt)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const [pattern, label] of FORBIDDEN_PATTERNS) {
      const match = text.match(pattern);
      if (match) findings.push(`${entry.name}: ${label}: ${match[0].slice(0, 60)}`);
    }
  }
  return findings;
}

export function buildStaticDemo(outDir) {
  if (!fs.existsSync(path.dirname(outDir))) throw new Error(`Output parent does not exist: ${path.dirname(outDir)}`);
  if (path.resolve(outDir).startsWith(`${repoRoot}${path.sep}`)) throw new Error('Refusing to build inside the repository.');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const read = name => fs.readFileSync(path.join(publicDir, name), 'utf8');
  fs.writeFileSync(path.join(outDir, 'index.html'), transformIndexHtml(read('index.html')));
  copyAppTree(path.join(publicDir, 'app'), path.join(outDir, 'app'));
  for (const name of ['auth-client.js', 'icon.svg']) fs.copyFileSync(path.join(publicDir, name), path.join(outDir, name));
  for (const [from, to] of [['sim-core.js', 'sim-core.js'], ['runtime.js', 'runtime.js'], ['ui.js', 'demo-ui.js'], ['demo.css', 'demo.css']]) fs.copyFileSync(path.join(demoDir, from), path.join(outDir, to));
  const findings = scanBundle(outDir);
  if (findings.length) throw new Error(`Forbidden content in demo bundle:\n${findings.join('\n')}`);
  const sizeOf = dir => fs.readdirSync(dir, { withFileTypes: true })
    .reduce((sum, entry) => sum + (entry.isDirectory() ? sizeOf(path.join(dir, entry.name)) : fs.statSync(path.join(dir, entry.name)).size), 0);
  const bytes = sizeOf(outDir);
  return { outDir, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outDir, bytes } = buildStaticDemo(path.resolve(process.argv[2] || defaultOutDir));
  console.log(`Coin Pilot demo built: ${outDir} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
}
