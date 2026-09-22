import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import {
  assessQuoteExecutionCostCompatibility,
  finiteCompatibilityNumber,
  parseCompatibilityMarkets,
  positiveCompatibilityNumber
} from '../research/quoteExecutionCostCompatibility.js';
import {
  resolveMomentumShadowQuoteRuntimeFile
} from '../research/momentumShadowQuoteHistory.js';

dotenv.config();

const DEFAULT_MARKETS = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'];
const reportFile = path.resolve(
  process.env.MOMO_SHADOW_QUOTE_REPORT_FILE ||
    resolveMomentumShadowQuoteRuntimeFile('quote-quality.json')
);
const markets = parseCompatibilityMarkets(
  process.env.SCALP_QUOTE_COMPATIBILITY_MARKETS,
  DEFAULT_MARKETS
);
const tradingFee = finiteCompatibilityNumber(
  process.env.SCALP_VALIDATION_FEE,
  0.0005
);
const slippage = finiteCompatibilityNumber(
  process.env.SCALP_VALIDATION_SLIPPAGE,
  0.001
);
const minimumSamples = Math.max(1, Math.floor(positiveCompatibilityNumber(
  process.env.SCALP_QUOTE_COMPATIBILITY_MIN_SAMPLES,
  5
)));
const maxAgeSeconds = finiteCompatibilityNumber(
  process.env.SCALP_QUOTE_COMPATIBILITY_MAX_AGE_SECONDS,
  900
);
const outputFile = process.env.SCALP_QUOTE_COMPATIBILITY_OUTPUT_FILE
  ? path.resolve(process.env.SCALP_QUOTE_COMPATIBILITY_OUTPUT_FILE)
  : null;

function main() {
  if (!fs.existsSync(reportFile)) {
    console.error(`quote report not found: ${reportFile}`);
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch (error) {
    console.error(`quote report invalid: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const compatibility = assessQuoteExecutionCostCompatibility({
    report,
    markets,
    tradingFee,
    slippage,
    minimumSamples,
    maxAgeSeconds
  });
  const output = {
    generatedAt: new Date().toISOString(),
    reportFile,
    ...compatibility
  };

  console.log(JSON.stringify(output, null, 2));
  if (outputFile) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`saved: ${outputFile}`);
  }
  if (!compatibility.ready) process.exitCode = 1;
}

main();
