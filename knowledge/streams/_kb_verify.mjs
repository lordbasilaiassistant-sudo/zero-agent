// Verify mined leads. For each (contract, selector) that historically paid its caller, replay the
// EXACT observed calldata as an ARBITRARY caller (Multicall3) and run the ISOLATED payment test.
// One aggregate3 per candidate. Anything that pays here is real income reachable by ZERO.
//
// Two replays per lead:
//   (a) verbatim calldata  — proves the mechanism still has value in it right now
//   (b) calldata with the observed keeper's address swapped for ZERO's Safe — proves ZERO can be the
//       named beneficiary rather than the incumbent bot.
import { rpc, probeIsolated, probeCanonical, MULTICALL3, ZERO_SAFE, pin, pinnedDec } from './_kb_lib.mjs';
import fs from 'fs';

const CHAIN = process.argv[2] || 'base';
const j = JSON.parse(fs.readFileSync(`knowledge/streams/_kb_mine_${CHAIN}.json`, 'utf8'));
await pin(CHAIN);
const BLOCK = 'latest';

const rows = j.rows.filter(r => r.selector !== '0x23b872dd' && r.selector.length === 10);
console.log(`verifying ${rows.length} leads on ${CHAIN} @${pinnedDec(CHAIN)}\n`);

const out = [];
for (const r of rows) {
  let input;
  try {
    const tx = await rpc(CHAIN, 'eth_getTransactionByHash', [r.sample]);
    input = tx?.input;
  } catch { continue; }
  if (!input || input.length < 10) continue;
  const keeperTx = await rpc(CHAIN, 'eth_getTransactionByHash', [r.sample]).catch(() => null);
  const keeper = keeperTx?.from?.toLowerCase();
  const tokens = r.tokens.map((t, i) => ({ symbol: 'T' + i, address: t }));

  // (a) verbatim
  const a = await probeIsolated(CHAIN, r.target, input, MULTICALL3, tokens, BLOCK);
  // (b) keeper -> ZERO's Safe, if the keeper address appears in the calldata
  let b = null, swapped = null;
  if (keeper && input.toLowerCase().includes(keeper.slice(2))) {
    swapped = input.toLowerCase().replaceAll(keeper.slice(2), ZERO_SAFE.slice(2).toLowerCase());
    b = await probeIsolated(CHAIN, r.target, swapped, ZERO_SAFE, tokens, BLOCK);
  }

  const aWei = a.ok && a.pays ? a.deltas.reduce((m, d) => (BigInt(d.wei) > BigInt(m.wei) ? d : m)) : null;
  const bWei = b?.ok && b.pays ? b.deltas.reduce((m, d) => (BigInt(d.wei) > BigInt(m.wei) ? d : m)) : null;
  const status = aWei ? 'PAYS-MSGSENDER' : bWei ? 'PAYS-NAMED-RECIPIENT' : (a.ok ? 'callable/0' : 'revert');
  console.log(`${r.target} ${r.selector} keepers=${r.distinctKeepers} n=${r.occurrences} gas=${r.medGas}  ${status}` +
    (aWei ? `  msgSender+=${aWei.wei} ${aWei.address}` : '') + (bWei ? `  safe+=${bWei.wei} ${bWei.address}` : '') +
    (!a.ok ? `  (${a.reason.slice(0, 50)})` : ''));
  if (aWei || bWei) out.push({
    chain: CHAIN, target: r.target, selector: r.selector, occurrences: r.occurrences,
    distinctKeepers: r.distinctKeepers, gasObserved: r.medGas, block: pinnedDec(CHAIN),
    verbatim: aWei ? { wei: aWei.wei, token: aWei.address, recipient: MULTICALL3, callData: input } : null,
    swappedToSafe: bWei ? { wei: bWei.wei, token: bWei.address, recipient: ZERO_SAFE, callData: swapped } : null,
    sampleTx: r.sample,
  });
}
out.sort((x, y) => {
  const a = BigInt(x.verbatim?.wei || x.swappedToSafe?.wei || 0), b = BigInt(y.verbatim?.wei || y.swappedToSafe?.wei || 0);
  return b > a ? 1 : -1;
});
console.log('\n=== ISOLATED PAYERS ===');
console.log(JSON.stringify(out, null, 1));
fs.writeFileSync(`knowledge/streams/_kb_verified_${CHAIN}.json`, JSON.stringify(out, null, 2));
