import {
  createRuntimeStoragePlan,
  DEFAULT_PROJECT_ROOT,
  getStoragePathEnvironment
} from '../runtime/profileStoragePlan.js';

const pathEnvironment = getStoragePathEnvironment(process.env);
const plan = createRuntimeStoragePlan({
  contexts: [{
    name: 'current-runtime',
    cwd: process.cwd(),
    projectRoot: DEFAULT_PROJECT_ROOT,
    config: {},
    env: pathEnvironment
  }],
  projectRoot: DEFAULT_PROJECT_ROOT,
  environmentSource: 'current process.env path-variable allowlist'
});

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
