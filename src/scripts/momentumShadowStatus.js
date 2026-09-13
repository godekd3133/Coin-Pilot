import fs from 'node:fs';

/**
 * Read-only status printer for the momentum shadow books.
 * Usage: node src/scripts/momentumShadowStatus.js [dir ...]
 * Defaults to both known books. Never mutates ledgers.
 */
const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['.paper-momentum-shadow-v1', '.paper-momentum-shadow-regime'];

for (const dir of dirs) {
  let l;
  try { l = JSON.parse(fs.readFileSync(`${dir}/ledger.json`, 'utf8')); }
  catch { console.log(`${dir}: no ledger`); continue; }
  const open = Object.entries(l.positions || {});
  const realized = (l.trades || []).reduce((a, t) => a + (t.profitPercent || 0) / 100 * (t.entry?.size || 0), 0);
  console.log(`\n=== ${dir} (mode=${l.config?.mode || 'fixed'}) ===`);
  console.log(`heartbeat ${l.heartbeatAt} | cycles ${l.cycles} | balance ${Math.round(l.balance).toLocaleString()} KRW`);
  console.log(`open: ${open.map(([m, p]) => `${m.replace('KRW-', '')}@${p.entryPrice}`).join(' ') || 'none'}`);
  console.log(`closed trades: ${(l.trades || []).length} | realized ${Math.round(realized).toLocaleString()} KRW`);
  if (l.voidedEntries?.length) console.log(`voided entries: ${l.voidedEntries.length}`);
  if (l.configDrift) console.log(`config drift recorded at ${l.configDrift.changedAt}`);
  console.log(`breadth ${l.breadth ?? '-'} | gateBlocked ${l.gateBlocked ?? 0} | breadthBlocked ${l.breadthBlocked ?? 0}`);
}
