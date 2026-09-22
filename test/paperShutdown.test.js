import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeActivePaperValidation } from '../src/runtime/paperShutdown.js';

function logger() {
  return { logs: [], errors: [], log(message) { this.logs.push(message); }, error(message) { this.errors.push(message); } };
}

test('active paper evidence is finalized exactly once during shutdown', async () => {
  const output = logger();
  let calls = 0;
  const trader = {
    paperValidation: { active: true },
    async stopPaperValidationSession() {
      calls += 1;
      return { active: false, stopReason: 'stopped_cleanly' };
    }
  };

  const status = await finalizeActivePaperValidation(trader, output);

  assert.equal(calls, 1);
  assert.equal(status.active, false);
  assert.deepEqual(output.errors, []);
  assert.match(output.logs[0], /stopped_cleanly/);
});

test('inactive paper evidence does not invoke a shutdown mutation', async () => {
  const output = logger();
  let calls = 0;
  const trader = {
    paperValidation: { active: false },
    async stopPaperValidationSession() { calls += 1; }
  };

  assert.equal(await finalizeActivePaperValidation(trader, output), null);
  assert.equal(calls, 0);
  assert.deepEqual(output.logs, []);
});

test('shutdown finalization failure is contained and reported', async () => {
  const output = logger();
  const error = new Error('fixture stop failure');
  const trader = {
    paperValidation: { active: true },
    async stopPaperValidationSession() { throw error; }
  };

  const result = await finalizeActivePaperValidation(trader, output);

  assert.equal(result.error, error);
  assert.equal(output.logs.length, 0);
  assert.match(output.errors[0], /fixture stop failure/);
});
