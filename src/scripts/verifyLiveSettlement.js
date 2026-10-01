#!/usr/bin/env node
/**
 * 실계좌 왕복 결제 증명 스크립트.
 *
 * 기본 동작은 조회 전용 프로브(계좌 잔액만 읽음)이며, 실제 주문은
 * `--confirm-real-money` 플래그와 `--amount <krw>`(5,000~20,000)가
 * 함께 주어질 때만 실행한다. 매수 시장가 → 체결 대기 → 계좌 재조회 →
 * 전량 매도 시장가 → 체결 대기 → 계좌 재조회 순서로 진행하고, 각 주문에
 * 재기동용 identifier(UUID)를 붙인다. 결과는 live-settlement-proof-<ts>.json
 * 증거 파일로 남는다.
 *
 * 사용 예:
 *   node src/scripts/verifyLiveSettlement.js                     # 계좌 조회만
 *   node src/scripts/verifyLiveSettlement.js --coin KRW-XRP \
 *     --amount 5100 --confirm-real-money
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import UpbitAPI from '../api/upbit.js';

dotenv.config();

const MIN_ORDER_KRW = 5_000;
const MAX_PROOF_AMOUNT_KRW = 20_000;
const FILL_WAIT_MS = 30_000;

function parseArgs(argv) {
  const args = { coin: 'KRW-XRP', amount: null, confirmRealMoney: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--coin') args.coin = String(argv[++i] || '').toUpperCase();
    else if (argv[i] === '--amount') args.amount = Number(argv[++i]);
    else if (argv[i] === '--confirm-real-money') args.confirmRealMoney = true;
  }
  return args;
}

function summarizeAccounts(accounts, coinSymbol) {
  const krw = accounts.find(a => a.currency === 'KRW');
  const asset = accounts.find(a => a.currency === coinSymbol);
  return {
    krwBalance: krw ? Number(krw.balance) : null,
    assetBalance: asset ? Number(asset.balance) : 0,
    assetAvgBuyPrice: asset ? Number(asset.avg_buy_price) || null : null,
    assetLocked: asset ? Number(asset.locked) || 0 : 0
  };
}

function projectFill(order) {
  return {
    uuid: order?.uuid || null,
    identifier: order?.identifier || null,
    state: order?.state || null,
    side: order?.side || null,
    ordType: order?.ord_type || null,
    market: order?.market || null,
    executedVolume: Number(order?.executed_volume) || 0,
    remainingVolume: order?.remaining_volume !== undefined && order?.remaining_volume !== null
      ? Number(order.remaining_volume) : null,
    averagePrice: order?.avg_price !== undefined && order?.avg_price !== null
      ? Number(order.avg_price) : null,
    paidFee: Number(order?.paid_fee) || 0,
    tradesCount: Number(order?.trades_count) || 0
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accessKey = process.env.UPBIT_ACCESS_KEY || '';
  const secretKey = process.env.UPBIT_SECRET_KEY || '';
  if (!accessKey || !secretKey) {
    console.error('❌ UPBIT_ACCESS_KEY/UPBIT_SECRET_KEY가 필요합니다 (.env 또는 환경변수).');
    process.exit(2);
  }

  const upbit = new UpbitAPI(accessKey, secretKey);
  const coinSymbol = args.coin.split('-')[1];
  const proof = {
    schema: 'coinpilot.live-settlement-proof.v1',
    coin: args.coin,
    amount: args.amount,
    startedAt: new Date().toISOString(),
    steps: []
  };
  const record = (step, data) => {
    proof.steps.push({ step, at: new Date().toISOString(), ...data });
    console.log(`• ${step}:`, JSON.stringify(data));
  };

  // 1. 계좌 조회 프로브 (항상 실행 — 키/권한/IP 화이트리스트 검증)
  const before = summarizeAccounts(await upbit.getAccounts(), coinSymbol);
  proof.before = before;
  record('accounts_readback_before', before);

  if (!args.confirmRealMoney) {
    console.log('\n✅ 계좌 조회 성공 — 키/권한/IP 화이트리스트가 유효합니다.');
    console.log('실제 왕복 증명은 --coin KRW-XXX --amount <krw> --confirm-real-money 를 지정해 실행하세요.');
    proof.mode = 'probe_only';
    return proof;
  }

  // 2. 실주문 가드
  if (!Number.isFinite(args.amount) || args.amount < MIN_ORDER_KRW || args.amount > MAX_PROOF_AMOUNT_KRW) {
    throw new Error(`--amount는 ${MIN_ORDER_KRW}~${MAX_PROOF_AMOUNT_KRW} KRW 범위여야 합니다.`);
  }
  // 업비트 시장가 매수(price)는 주문액 + 0.05% 수수료를 별도로 차감한다.
  const requiredKrw = args.amount * 1.0005;
  if (before.krwBalance === null || before.krwBalance < requiredKrw) {
    throw new Error(`KRW 잔액(${before.krwBalance})이 증명 금액+수수료(${requiredKrw})보다 부족합니다.`);
  }

  // 3. 매수 → 체결 확인 → 정산 readback
  const buyIntentId = crypto.randomUUID();
  record('order_intent_buy', { identifier: buyIntentId, side: 'bid', ordType: 'price', amount: args.amount });
  const buyResult = await upbit.order(args.coin, 'bid', null, args.amount, 'price', buyIntentId);
  if (buyResult?.success !== true || !buyResult.data?.uuid) {
    throw new Error(`매수 주문이 거부됐습니다: ${JSON.stringify(buyResult?.error || buyResult)}`);
  }
  const buyFill = await upbit.waitForOrderFill(buyResult.data.uuid, FILL_WAIT_MS);
  proof.buy = { requested: args.amount, order: projectFill(buyFill.order), filled: buyFill.filled === true };
  if (!buyFill.filled) throw new Error(`매수 미체결/대기 초과 — uuid ${buyResult.data.uuid}, identifier ${buyIntentId} 로 수동 확인 필요`);
  record('fill_observed_buy', proof.buy.order);

  const afterBuy = summarizeAccounts(await upbit.getAccounts(), coinSymbol);
  proof.afterBuy = afterBuy;
  record('settlement_readback_after_buy', afterBuy);
  if (!(afterBuy.assetBalance > 0)) throw new Error('매수 체결 후 자산 잔액이 보이지 않습니다 — 수동 확인 필요');

  // 4. 전량 매도 → 체결 확인 → 정산 readback
  const sellVolume = afterBuy.assetBalance;
  const sellIntentId = crypto.randomUUID();
  record('order_intent_sell', { identifier: sellIntentId, side: 'ask', ordType: 'market', volume: sellVolume });
  const sellResult = await upbit.order(args.coin, 'ask', sellVolume, null, 'market', sellIntentId);
  if (sellResult?.success !== true || !sellResult.data?.uuid) {
    proof.sellDispatchFailed = sellResult?.error || sellResult;
    throw new Error(`매도 주문이 거부됐습니다: ${JSON.stringify(sellResult?.error || sellResult)} — 남은 ${coinSymbol} ${sellVolume} 을 수동 매도하세요`);
  }
  const sellFill = await upbit.waitForOrderFill(sellResult.data.uuid, FILL_WAIT_MS);
  proof.sell = { requested: sellVolume, order: projectFill(sellFill.order), filled: sellFill.filled === true };
  if (!sellFill.filled) {
    throw new Error(`매도 미체결/대기 초과 — uuid ${sellResult.data.uuid}, identifier ${sellIntentId}. 남은 수량을 수동 확인하세요`);
  }
  record('fill_observed_sell', proof.sell.order);

  const after = summarizeAccounts(await upbit.getAccounts(), coinSymbol);
  proof.after = after;
  record('settlement_readback_after_sell', after);

  // 5. 실현 손익
  proof.realizedPnlKrw = Number.isFinite(after.krwBalance) && Number.isFinite(before.krwBalance)
    ? Math.round((after.krwBalance - before.krwBalance) * 100) / 100
    : null;
  proof.settlementVerified = proof.realizedPnlKrw !== null;
  proof.completedAt = new Date().toISOString();
  proof.success = proof.buy.filled && proof.sell.filled && proof.settlementVerified;

  const file = path.resolve(`live-settlement-proof-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log(`\n${proof.success ? '✅' : '❌'} 실계좌 왕복 증명 ${proof.success ? '완료' : '실패'} — 실현손익 ${proof.realizedPnlKrw} KRW → ${file}`);
  if (!proof.success) process.exit(1);
  return proof;
}

main().catch(error => {
  console.error(`\n❌ 실결제 증명 실패: ${error.message}`);
  console.error('미해결 주문은 업비트 계좌의 identifier로 수동 확인하세요.');
  process.exit(1);
});
