import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAPER_EXECUTION_MIN_PAIRS,
  evaluatePaperExecutionRobustnessGate
} from '../src/research/paperExecutionComparison.js';

function comparison(overrides = {}) {
  return {
    strictVsShadow: {
      pairedCount: 10,
      signFlipCount: 0,
      strictPositiveDiagnosticNegativeCount: 0,
      diagnosticPairProfit: 25,
      ...overrides
    }
  };
}

test('execution robustness gate passes only after enough positive, sign-stable pairs', () => {
  const result = evaluatePaperExecutionRobustnessGate(comparison());

  assert.equal(result.required, true);
  assert.equal(result.passed, true);
  assert.equal(result.reason, 'execution_comparison_passed');
  assert.equal(result.minimumPairs, DEFAULT_PAPER_EXECUTION_MIN_PAIRS);
  assert.equal(result.researchOnly, true);
  assert.equal(result.promoted, false);
});

test('execution robustness gate blocks insufficient pairs before judging a small positive sample', () => {
  const result = evaluatePaperExecutionRobustnessGate(comparison({
    pairedCount: 2,
    diagnosticPairProfit: 1_000
  }));

  assert.equal(result.passed, false);
  assert.equal(result.reason, 'execution_comparison_pairs_insufficient');
});

test('execution robustness gate blocks strict-positive to diagnostic-negative flips', () => {
  const result = evaluatePaperExecutionRobustnessGate(comparison({
    signFlipCount: 1,
    strictPositiveDiagnosticNegativeCount: 1
  }));

  assert.equal(result.passed, false);
  assert.equal(result.reason, 'execution_positive_to_negative_flip_detected');
});

test('execution robustness gate does not apply to strict-only sessions', () => {
  const result = evaluatePaperExecutionRobustnessGate(comparison({
    pairedCount: 0,
    signFlipCount: 3,
    diagnosticPairProfit: -100
  }), { required: false });

  assert.equal(result.required, false);
  assert.equal(result.passed, true);
  assert.equal(result.reason, 'execution_robustness_not_required');
});
