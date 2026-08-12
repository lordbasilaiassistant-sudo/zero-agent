// verify-chainstate.mjs — prove readChainState's numbers against INDEPENDENT direct RPC reads.
//
// A 200 is not evidence and neither is a render. This hits public RPC endpoints directly, re-derives
// the balances by hand, and asserts they agree with what chainstate.mjs published. It also forces a
// read failure on one chain to prove the honest path: a failed read must be EXCLUDED from every total
// and named in unreadable[], never counted as $0.
import { readChainState } from '../chainstate.mjs';

const RPC = {
  base: ['https://base.publicnode.com', 'https://mainnet.base.org'],
  optimism: ['https://optimism.publicnode.com', 'https://mainnet.optimism.io'],
  arbitrum: ['https://arbitrum-one.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  polygon: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
  gnosis: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com'],
  unichain: ['https://unichain-rpc.publicnode.com', 'https://mainnet.unichain.org'],
};

let id = 0;
async function rpc(chain, method, params) {
  const urls = RPC[chain];
  if (!urls) throw new Error(`no RPC configured for ${chain}`);
  let last;
  for (const u of urls) {
    try {
      const r = await fetch(u, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      });
      const j = await r.json();
      if (j.error) { last = new Error(`${j.error.message}`); continue; }
      if (j.result === undefined) { last = new Error('no result'); continue; }
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error('all upstreams failed');
}

const EOA = process.env.ZERO_EOA || '0x5062B6D0D25B37E4c0b3A6b1B6F0A0F4a45B0dB9';
const SAFE = process.env.ZERO_SAFE || '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };

// Resolve the real EOA from the live worker so we are not asserting against a guessed address.
let eoa = EOA, safe = SAFE;
try {
  const live = await (await fetch('https://zero-agent.broke2builtai.com/', { headers: { accept: 'application/json' } })).json();
  if (live.wallet) eoa = live.wallet;
  if (live.smart_account) safe = live.smart_account;
  console.log(`addresses from the live worker: EOA ${eoa} · Safe ${safe}`);
} catch { console.log(`live worker unreachable, using defaults: ${eoa}`); }

console.log('\n── readChainState, all six chains ──');
const cs = await readChainState(rpc, eoa, safe);
console.log(`  holdings $${cs.holdings_usd} · relay-spendable $${cs.relay_spendable_usd} · native-liquid $${cs.native_liquid_usd} · usdc $${cs.usdc_usd}`);
console.log(`  ${cs.read_note}`);
for (const p of cs.per_chain) {
  console.log(`   ${p.chain.padEnd(9)} ${p.read.padEnd(7)} ${p.read === 'ok'
    ? `token $${p.token_usd} · safe wrapped ${p.safe_wrapped_wei} · eoa native ${p.eoa_native_wei} · usdc $${p.usdc_usd}`
    : p.error}`);
}

console.log('\n── independent direct RPC cross-check (gate: at least two chains) ──');
const balanceOf = (chain, token, addr) =>
  rpc(chain, 'eth_call', [{ to: token, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
const WRAPPED = {
  base: '0x4200000000000000000000000000000000000006',
  optimism: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
};
let crossChecked = 0;
for (const chain of ['base', 'optimism', 'arbitrum']) {
  const row = cs.per_chain.find(p => p.chain === chain);
  if (!row || row.read !== 'ok') { console.log(`  SKIP  ${chain} — chainstate reported read '${row?.read}', nothing to cross-check`); continue; }
  try {
    const [wrapped, native] = await Promise.all([
      balanceOf(chain, WRAPPED[chain], safe),
      rpc(chain, 'eth_getBalance', [eoa, 'latest']),
    ]);
    check(`${chain}: safe wrapped balance matches a direct balanceOf`, BigInt(wrapped).toString() === row.safe_wrapped_wei,
      `direct ${BigInt(wrapped)} vs published ${row.safe_wrapped_wei}`);
    check(`${chain}: EOA native balance matches a direct eth_getBalance`, BigInt(native).toString() === row.eoa_native_wei,
      `direct ${BigInt(native)} vs published ${row.eoa_native_wei}`);
    crossChecked++;
  } catch (e) { console.log(`  SKIP  ${chain} — direct read failed: ${e.message}`); }
}
check(`cross-checked at least two chains against direct RPC`, crossChecked >= 2, `only ${crossChecked}`);

console.log('\n── the honest-failure path: a chain that cannot be read is EXCLUDED, never zeroed ──');
const brokenRpc = (chain, method, params) => {
  if (chain === 'optimism') return Promise.reject(new Error('simulated upstream 429'));
  return rpc(chain, method, params);
};
const cs2 = await readChainState(brokenRpc, eoa, safe);
const opRow = cs2.per_chain.find(p => p.chain === 'optimism');
check('the failed chain is marked read:failed', opRow?.read === 'failed', JSON.stringify(opRow));
check('the failed chain appears in unreadable[]', cs2.unreadable.some(u => u.chain === 'optimism'));
check('the failed chain carries its error text', /429/.test(opRow?.error || ''), opRow?.error);
check('chains_read_ok dropped by exactly one', cs2.chains_read_ok === cs.chains_read_ok - 1,
  `${cs2.chains_read_ok} vs ${cs.chains_read_ok}`);
check('read_note announces the total is a lower bound', /lower bound/.test(cs2.read_note));
// The two runs happen seconds apart and re-price independently, so the ETH price drifts between them.
// Comparing to 1e-6 was asserting that a live price feed does not move — a test bug, not a code bug.
// The real invariants are structural: the failed chain's value is GONE from the total (not zeroed into
// it), and no USD figure for it survives anywhere.
const op = cs.per_chain.find(p => p.chain === 'optimism') || {};
const opContribution = (op.safe_wrapped_usd || 0) + (op.eoa_wrapped_usd || 0)
  + (op.safe_native_usd || 0) + (op.eoa_native_usd || 0) + (op.usdc_usd || 0);
const delta = cs.holdings_usd - cs2.holdings_usd;
check('the failed chain is removed from holdings, not zeroed into it',
  delta > 0 && Math.abs(delta - opContribution) < Math.max(1e-6, opContribution * 0.02),
  `holdings dropped by ${delta.toFixed(8)}, optimism was worth ${opContribution.toFixed(8)} (2% price-drift tolerance)`);
check('no USD figure for the failed chain survives in per_chain',
  ['safe_wrapped_usd', 'eoa_wrapped_usd', 'safe_native_usd', 'eoa_native_usd', 'usdc_usd']
    .every(k => opRow?.[k] === undefined),
  JSON.stringify(opRow));

console.log(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
