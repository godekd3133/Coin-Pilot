import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoots = ['src', 'mobile/scripts'];

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(?:mjs|js)$/.test(entry.name) ? [fullPath] : [];
  });
}

test('public Upbit endpoint literals stay behind UpbitAPI except report provenance metadata', () => {
  const matches = runtimeRoots.flatMap(root => sourceFiles(path.join(repositoryRoot, root)))
    .filter(file => fs.readFileSync(file, 'utf8').includes('api.upbit.com'))
    .map(file => path.relative(repositoryRoot, file))
    .sort();

  assert.deepEqual(matches, [
    'src/api/upbit.js',
    'src/scripts/analyzePaperExitPathReplay.js'
  ]);

  const replaySource = fs.readFileSync(
    path.join(repositoryRoot, 'src/scripts/analyzePaperExitPathReplay.js'),
    'utf8'
  );
  assert.match(replaySource, /source:\s*\{[\s\S]*endpoint:\s*MINUTE_CANDLE_URL/);
  assert.doesNotMatch(replaySource, /\baxios\b|\bfetch\s*\(/);
});
