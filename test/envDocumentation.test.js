import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = 'src';
const ENV_EXAMPLE = '.env.example';

// Process-level envs that are universal platform conventions rather than
// CoinPilot configuration and therefore never belong in .env.example.
const PLATFORM_ENVS = new Set([
  'NODE_ENV',
  'PATH',
  'HOME',
  'PWD',
  'LANG',
  'SHELL',
  'USER',
  'TERM',
  'TMPDIR'
]);

const ACCESS_PATTERNS = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
  // Resolver functions take `env = process.env`; uppercase reads on that
  // parameter are environment reads.
  /\benv\.([A-Z_][A-Z0-9_]*)/g,
  // Env helper calls that receive the variable name as a string literal.
  /(?:numericEnv|listEnv|envNumber|envFlag|booleanEnv|stringEnv|csvEnv)\(\s*(?:env\s*,\s*)?['"]([A-Z_][A-Z0-9_]*)['"]/g
];

function collectSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(entryPath));
    else if (/\.js$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

test('src에서 소비하는 모든 env는 .env.example에 문서화되어 있다', () => {
  const consumed = new Map();
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of ACCESS_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        if (!consumed.has(match[1])) consumed.set(match[1], new Set());
        consumed.get(match[1]).add(file);
      }
    }
  }

  const documented = new Set(
    [...fs.readFileSync(ENV_EXAMPLE, 'utf8').matchAll(/\b([A-Z_][A-Z0-9_]{2,})\b/g)]
      .map(match => match[1])
  );

  const undocumented = [...consumed.keys()]
    .filter(name => !PLATFORM_ENVS.has(name) && !documented.has(name))
    .sort();

  assert.deepEqual(
    undocumented.map(name => `${name} (${[...consumed.get(name)].join(', ')})`),
    []
  );
});
