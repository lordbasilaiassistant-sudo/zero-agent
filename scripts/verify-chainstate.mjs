// verify-chainstate.mjs — prove readChainState's numbers against INDEPENDENT direct RPC reads.
//
// A 200 is not evidence and neither is a render. This hits public RPC endpoints directly, re-derives
// the balances by hand, and asserts they agree with what chainstate.mjs published. It also forces a
// read failure on one chain to prove the honest path: a failed read must be EXCLUDED from every total
// and named in unreadable[], never counted as $0.
import { readChainState } from '../chainstate.mjs';
import { LIVE_EOA, SMART_ACCOUNT } from '../shop.mjs';

const RPC = {
  base: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  optimism: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
  arbitrum: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
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

const EOA = process.env.ZERO_EOA || LIVE_EOA;
const SAFE = process.env.ZERO_SAFE || SMART_ACCOUNT;

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };

// Resolve the real EOA from the live worker so we are not asserting against a guessed address.
let eoa = EOA, safe = SAFE;
try {
  const live = await (await fetch('https://zero-agent.broke2built.workers.dev/', { headers: { accept: 'application/json' } })).json();
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
// Tolerance is wide on purpose: the two runs re-price independently (blockscout vs llama fallback
// can disagree by a few %) AND the agent is LIVE — its cron can move balances between the runs.
check('the failed chain is removed from holdings, not zeroed into it',
  delta > 0 && delta > opContribution * 0.8 && delta < opContribution * 1.25,
  `holdings dropped by ${delta.toFixed(8)}, optimism was worth ${opContribution.toFixed(8)}`);
check('no USD figure for the failed chain survives in per_chain',
  ['safe_wrapped_usd', 'eoa_wrapped_usd', 'safe_native_usd', 'eoa_native_usd', 'usdc_usd']
    .every(k => opRow?.[k] === undefined),
  JSON.stringify(opRow));

console.log('\n── the PARTIAL-failure path: a chain that half-reads keeps its measured stages ──');
// The real incident this pins (2026-08-24): base rate-limited ONLY the wrapped-native eth_call while
// eth_getBalance answered fine — and the old whole-chain exclusion dropped $0.45 of measured native
// ETH from every total. Here eth_call fails for optimism but everything else goes through.
const partialRpc = (chain, method, params) => {
  if (chain === 'optimism' && method === 'eth_call') return Promise.reject(new Error('simulated rate limit on eth_call'));
  return rpc(chain, method, params);
};
const cs3 = await readChainState(partialRpc, eoa, safe);
const op3 = cs3.per_chain.find(p => p.chain === 'optimism');
check('the half-read chain is marked read:partial', op3?.read === 'partial', JSON.stringify(op3));
check('its MEASURED eoa_native survives (wei present)', typeof op3?.eoa_native_wei === 'string' && /^\d+$/.test(op3.eoa_native_wei), JSON.stringify(op3));
check('its MEASURED eoa_native_usd is counted, not nulled', typeof op3?.eoa_native_usd === 'number' && op3.eoa_native_usd >= 0, JSON.stringify(op3));
check('its FAILED wrapped stage is named, not zeroed', op3?.safe_wrapped_usd === null && Array.isArray(op3?.missing_stages) && op3.missing_stages.length > 0, JSON.stringify(op3));
check('the partial chain appears in unreadable[] with stage "partial"', cs3.unreadable.some(u => u.chain === 'optimism' && u.stage === 'partial'), JSON.stringify(cs3.unreadable));
check('chains_partial counts exactly one', cs3.chains_partial === 1, String(cs3.chains_partial));
check('read_note explains the partial semantics', /partial/i.test(cs3.read_note), cs3.read_note);
check('native_liquid includes the partially-read chain when the EOA holds native there',
  BigInt(op3.eoa_native_wei) === 0n || cs3.native_liquid_usd > 0,
  `eoa_native=${op3.eoa_native_wei} native_liquid=$${cs3.native_liquid_usd}`);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
