// Re-verify every mined lead WITH tx.origin == msg.sender (from = MULTICALL3). Splits the leads that
// "revert" into two very different buckets:
//   PERMISSIONED  — reverts either way. Genuinely closed. Dead for everyone.
//   EOA-ONLY      — pays only when tx.origin == msg.sender. Money is really there, but a Safe can
//                   never satisfy the guard (a relayed Safe tx has tx.origin = the relayer).
// Both are dead for ZERO. The distinction matters because EOA-ONLY tells the gasless lane exactly
// what a new execution path would have to buy us, and stops future sessions re-probing them.
import { rpc, probeIsolated, MULTICALL3, ZERO_SAFE, pin, pinnedDec } from './_kb_lib.mjs';
import fs from 'fs';

const CHAIN = process.argv[2] || 'base';
const j = JSON.parse(fs.readFileSync(`knowledge/streams/_kb_mine_${CHAIN}.json`, 'utf8'));
await pin(CHAIN);
const rows = j.rows.filter(r => r.selector !== '0x23b872dd' && r.selector.length === 10);
console.log(`${CHAIN} @${pinnedDec(CHAIN)} — ${rows.length} leads, probing with and without tx.origin\n`);

const out = { permissioned: [], eoaOnly: [], callableZero: [], reachable: [] };
for (const r of rows) {
  let input; try { input = (await rpc(CHAIN, 'eth_getTransactionByHash', [r.sample]))?.input; } catch { continue; }
  if (!input) continue;
  const tokens = r.tokens.map((t, i) => ({ symbol: 'T' + i, address: t }));
  const plain = await probeIsolated(CHAIN, r.target, input, MULTICALL3, tokens);
  const orig = await probeIsolated(CHAIN, r.target, input, MULTICALL3, tokens, 'latest', { origin: MULTICALL3 });
  const w = (x) => (x.ok && x.pays) ? x.deltas.reduce((m, d) => (BigInt(d.wei) > BigInt(m.wei) ? d : m)) : null;
  const a = w(plain), b = w(orig);
  const rec = { target: r.target, selector: r.selector, keepers: r.distinctKeepers, n: r.occurrences, gas: r.medGas, tx: r.sample };
  if (a) { out.reachable.push({ ...rec, wei: a.wei, token: a.address }); console.log(`REACHABLE  ${r.target} ${r.selector} +${a.wei}`); }
  else if (b) { out.eoaOnly.push({ ...rec, wei: b.wei, token: b.address }); console.log(`EOA-ONLY   ${r.target} ${r.selector} +${b.wei} ${b.address} gas=${r.medGas}`); }
  else if (plain.ok || orig.ok) out.callableZero.push(rec);
  else out.permissioned.push(rec);
}
console.log(`\nreachable-by-Safe : ${out.reachable.length}`);
console.log(`EOA-ONLY (money there, guard unsatisfiable by a Safe) : ${out.eoaOnly.length}` +
  (out.eoaOnly.length ? `  total ${out.eoaOnly.reduce((s, x) => s + BigInt(x.wei), 0n)}` : ''));
console.log(`callable but pays 0 : ${out.callableZero.length}`);
console.log(`permissioned (reverts either way) : ${out.permissioned.length}`);
fs.writeFileSync(`knowledge/streams/_kb_origin_${CHAIN}.json`, JSON.stringify({ block: pinnedDec(CHAIN), ...out }, null, 2));
