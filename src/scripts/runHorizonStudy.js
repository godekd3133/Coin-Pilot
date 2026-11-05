// 기간별(단기/스윙/중기/장기) 포트폴리오 워크포워드 연구 CLI.
//   npm run research:horizons
// 업비트 공개 시세로 거래대금 상위 코인의 60m/240m/일봉/주봉을 받아
// 슬리브별 파라미터를 학습 구간에서 고르고, 검증 구간 성과로 실거래 비중을 정한다.
// 결과: HORIZON_PARAMS_FILE (기본 .coinpilot-runtime/horizon_params.json)
// 원시 봉 캐시: HORIZON_STUDY_CACHE_FILE (기본 .coinpilot-runtime/horizon_study_candles.json)

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { envList, envNumber, envString } from '../config/envConfig.js';
import { UpbitPublicCandleLoader, TossCandleLoader, STABLECOINS } from '../portfolio/marketDataLoader.js';
import TossInvestClient from '../stock/tossInvestClient.js';
import UpbitAPI from '../api/upbit.js';
import { resolveHorizonProfiles, HORIZON_KEYS } from '../portfolio/horizonProfiles.js';
import { studySleeve, studyToOverrides } from '../portfolio/horizonStudy.js';
import { writeDurableJson } from '../runtime/durableJson.js';

dotenv.config();

const BAR_COUNTS = { '60m': 4000, '240m': 2200, '1d': 1100, '1w': 160 };
const STOCK_BENCHMARK = '069500'; // KODEX 200

export function defaultParamsFile(env = process.env, assetClass = 'coin') {
  const dir = env.COINPILOT_STATE_DIR || path.join(process.cwd(), '.coinpilot-runtime');
  if (assetClass === 'stock') return env.HORIZON_STOCK_PARAMS_FILE || path.join(dir, 'horizon_params_stock.json');
  return env.HORIZON_PARAMS_FILE || path.join(dir, 'horizon_params.json');
}

async function loadSeries(loader, markets, interval, cache) {
  const key = interval;
  cache[key] ||= {};
  const series = new Map();
  for (const market of markets) {
    if (!cache[key][market]) {
      process.stdout.write(`  ${interval} ${market} ...`);
      try {
        cache[key][market] = await loader.getBars(market, interval, BAR_COUNTS[interval]);
        process.stdout.write(` ${cache[key][market].length}봉\n`);
      } catch (error) {
        process.stdout.write(` 실패 (${error.message})\n`);
        cache[key][market] = [];
      }
    }
    // 상장 직후 종목은 지표 워밍업과 검증 구간을 채우지 못하므로 제외한다(전체 길이의 60% 미만).
    if (cache[key][market].length >= BAR_COUNTS[interval] * 0.6) series.set(market, cache[key][market]);
  }
  return series;
}

async function resolveUniverse(assetClass, loader, client, universeSize, cache) {
  let markets = envList('HORIZON_STUDY_MARKETS', []);
  if (markets.length > 0) return markets;
  if (cache.markets) return cache.markets;
  if (assetClass === 'stock') {
    const [rankings, listed] = await Promise.all([
      client.getRankings({ type: 'MARKET_TRADING_AMOUNT', duration: '1d', count: 100 }),
      client.listStockSymbols()
    ]);
    if (!(listed?.size > 0)) throw new Error('주식 종목 목록이 비어 있어 연구 대상을 정할 수 없습니다');
    // Same universe contract as the runtime: listed STOCK-type securities only.
    markets = rankings.filter(item => item?.symbol && listed.has(String(item.symbol)) && (item.currency || 'KRW') === 'KRW').map(item => item.symbol).slice(0, universeSize);
    return markets.includes(STOCK_BENCHMARK) ? markets : [STOCK_BENCHMARK, ...markets];
  }
  markets = await loader.getKrwMarketsByTurnover(universeSize);
  return markets.includes('KRW-BTC') ? markets : ['KRW-BTC', ...markets];
}

async function main() {
  const assetClass = envString('HORIZON_STUDY_ASSET', 'coin');
  const stateDir = process.env.COINPILOT_STATE_DIR || path.join(process.cwd(), '.coinpilot-runtime');
  const cacheFile = envString('HORIZON_STUDY_CACHE_FILE', path.join(stateDir, `horizon_study_candles_${assetClass}.json`));
  const paramsFile = defaultParamsFile(process.env, assetClass);
  const universeSize = Math.max(5, Math.floor(envNumber('HORIZON_STUDY_UNIVERSE_SIZE', 30)));
  let client = null;
  let loader;
  if (assetClass === 'stock') {
    client = new TossInvestClient({
      clientId: envString('TOSS_CLIENT_ID', ''),
      clientSecret: envString('TOSS_CLIENT_SECRET', ''),
      accountSeq: process.env.TOSS_ACCOUNT_SEQ || null
    });
    if (!client.credentialsConfigured) throw new Error('주식 연구에는 TOSS_CLIENT_ID/TOSS_CLIENT_SECRET이 필요합니다.');
    loader = new TossCandleLoader({ client });
  } else {
    loader = new UpbitPublicCandleLoader({ upbit: new UpbitAPI('', '') });
  }
  const benchmark = assetClass === 'stock' ? STOCK_BENCHMARK : 'KRW-BTC';

  let cache = {};
  // 캐시는 하루가 지나면 새로 받는다(주간 자동 재연구가 최신 데이터를 쓰도록).
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < 24 * 3600 * 1000) {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    console.log(`📂 봉 캐시 사용: ${cacheFile}`);
  }
  let markets = await resolveUniverse(assetClass, loader, client, universeSize, cache);
  markets = markets.filter(market => !STABLECOINS.has(String(market).split('-')[1]));
  cache.markets = markets;
  console.log(`🔬 ${assetClass === 'stock' ? '주식' : '코인'} 연구 대상 ${markets.length}개: ${markets.join(', ')}`);

  const profiles = resolveHorizonProfiles(assetClass);
  const results = [];
  // Sleeves the runtime does not trade are not studied: the disabled short
  // sleeve alone took ~14 minutes of shared Upbit budget on the paper host.
  const enabledSleeves = envList('HORIZON_SLEEVES', []);
  for (const key of HORIZON_KEYS) {
    const profile = profiles[key];
    if (enabledSleeves.length > 0 && !enabledSleeves.includes(key)) {
      results.push({ horizon: key, error: 'sleeve_not_enabled', passed: false });
      console.log(`\n⏭️  ${profile.label}: HORIZON_SLEEVES에 없어 연구를 건너뜁니다.`);
      continue;
    }
    console.log(`\n📥 ${profile.label} (${profile.interval}) 데이터`);
    const series = await loadSeries(loader, markets, profile.interval, cache);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    console.log(`🧪 ${profile.label} 그리드 탐색...`);
    const started = Date.now();
    const result = studySleeve(series, profile, { assetClass, benchmark });
    result.elapsedMs = Date.now() - started;
    results.push(result);
    if (result.error) {
      console.log(`  ⚠️ ${result.error}`);
      continue;
    }
    for (const fold of result.foldResults) {
      if (!fold.test) { console.log(`  fold ~${fold.testEnd.slice(0, 10)}: 거래 부족으로 후보 없음`); continue; }
      console.log(`  fold ~${fold.testEnd.slice(0, 10)}: 검증 ${fold.test.totalReturnPercent}% (MDD ${fold.test.maxDrawdownPercent}%, 거래 ${fold.test.trades}, 승률 ${fold.test.winRatePercent}%) · 보유 ${fold.buyAndHoldPercent}% · BTC ${fold.benchmarkPercent}% · ${JSON.stringify(fold.chosenParams)}`);
    }
    console.log(`  OOS 합산: ${result.outOfSample.compoundedReturnPercent}% / 거래 ${result.outOfSample.trades} / 손실없는 fold ${result.outOfSample.nonNegativeFolds}/${result.outOfSample.folds} / 최악 MDD ${result.outOfSample.worstFoldDrawdownPercent}%`);
    console.log(`  실거래 파라미터: ${JSON.stringify(result.chosenParams)}`);
    if (result.overfitting) {
      const o = result.overfitting;
      console.log(`  과적합 진단(report-only): 후보 ${o.trials} · DSR ${o.dsr ?? 'n/a'} · PBO ${o.pbo ?? `n/a (${o.pboReason})`}${o.wouldFailGate ? ' · ⚠️ 장래 게이트 기준 미달' : ''}`);
    }
    console.log(`  판정: ${result.passed ? '✅ 실거래 편입' : '⛔ 비활성 (워크포워드 검증 미통과)'}`);
  }

  const overrides = studyToOverrides(results, profiles);
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    assetClass,
    source: assetClass === 'stock' ? 'tossinvest' : 'upbit_public',
    markets,
    method: 'expanding_walk_forward_3fold',
    caveats: [
      '현재 거래대금 상위 종목으로 과거를 검증하므로 생존 편향이 있습니다.',
      '과거 성과는 미래 수익을 보장하지 않습니다.'
    ],
    overrides,
    results
  };
  writeDurableJson(paramsFile, report);
  console.log(`\n💾 파라미터 저장: ${paramsFile}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch(error => {
    console.error('❌ 연구 실패:', error);
    process.exitCode = 1;
  });
}
