import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(mobileRoot, 'web');
const destination = path.join(mobileRoot, 'www');

await mkdir(destination, { recursive: true });
for (const entry of await readdir(source)) {
  await cp(path.join(source, entry), path.join(destination, entry), { recursive: true, force: true });
}

console.log(`Staged CoinPilot iOS shell web assets at ${destination}`);
