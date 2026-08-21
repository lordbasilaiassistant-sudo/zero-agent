#!/usr/bin/env node
/**
 * harvest-scan.mjs — SIMULATE THE POPULATION, NOT A WINDOW.
 *
 * WHY THIS EXISTS, and why wallet-map.mjs could never have found what this looks for.
 *
 * `wallet-map.mjs` samples recent blocks and reports which contracts paid their callers during the
 * sample. Anthony, 2026-08-21: *"you are reading a paragraph of a book and pretending its the entire
 * collection."* He is right, and the bias is worse than the sample size suggests:
 *
 *   A 300-block window is ~25 minutes. Only contracts called FREQUENTLY can appear in it. Frequently
 *   called means contested, and contested means thin margins — the gnosis result was exactly that
 *   (862 calls / 300 blocks / one operator behind 48 addresses). **The window is structurally biased
 *   toward the routes we cannot win, and structurally blind to the ones we might.** A contract that
 *   pays a caller once every 700 days is invisible to it by construction, forever.
 *
 * So this inverts the method: enumerate the POPULATION by capability, then simulate each member.
 * Beefy publishes its whole registry — 4,042 vaults, 566 active across 14 chains — and the registry
 * carries `lastHarvest`. Measured 2026-08-21 on chains ZERO can reach: **248 funded active vaults,
 * $19.67M TVL, some unharvested for 710 days.** None of those could ever have shown up in a window.
 *
 * WHAT IT REFUSES TO ASSUME. Neglect is not money and TVL is not a caller fee — the same
 * gross-vs-margin trap that made a $0.001206/call bundling number look like profit when the margin
 * was $0.000850. The only thing that settles what a caller GETS is running the call from our own
 * address and measuring what lands there, so every candidate is put through `eth_simulateV1` with
 * `traceTransfers` and graded on the value that actually arrives at ZERO — never on TVL, never on
 * how long it has been neglected.
 *
 * Ceiling, same as the map: a simulation is rung 2 (ACCEPTED/PAYS) on sponsor-probe.mjs's ladder.
 * Only a settled transaction is rung 3, and only a measured balance increase is rung 4. Nothing here
 * may be reported as income.
 *
 * Usage:
 *   node scripts/harvest-scan.mjs                          # arbitrum, TVL >= 1000
 *   node scripts/harvest-scan.mjs --chains arbitrum,optimism,base --min-tvl 5000 --limit 60
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnits } from 'ethers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZERO = '0xC94929d14435D80dd04b3206BfEA9F5dEBAbD57A';
const SIM_BALANCE = '0x21e19e0c9bab2400000';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const RPC = {
  arbitrum: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  optimism: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
  base: ['https://base-rpc.publicnode.com', 'https://base.drpc.org'],
  polygon: ['https://1rpc.io/matic'],
  // Added 2026-08-21: the only chains where measured gas x native price falls under the harvest
  // break-even AND Beefy actually has vaults. Arbitrum is 57x too dear for the same call.
  avax: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
  sonic: ['https://rpc.soniclabs.com'],
};
const LLAMA = { arbitrum: 'arbitrum', optimism: 'optimism', base: 'base', polygon: 'polygon', avax: 'avax', sonic: 'sonic' };

/* Beefy strategies expose more than one harvest shape, and which one pays the CALLER differs by
 * version. `harvest(address)` takes an explicit call-fee recipient, so it is tried first with our own
 * address — if a strategy honours it, the fee is directed to us rather than to tx.origin. */
const CANDIDATE_CALLS = [
  { sel: '0x0e5c011e', label: 'harvest(address)', data: '0x0e5c011e' + '0'.repeat(24) + ZERO.slice(2).toLowerCase() },
  { sel: '0x4641257d', label: 'harvest()', data: '0x4641257d' },
  { sel: '0xd801d946', label: 'managerHarvest()', data: '0xd801d946' },
];

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const CHAINS = (opt('chains', 'arbitrum')).split(',').map(s => s.trim()).filter(Boolean);
const MIN_TVL = Number(opt('min-tvl', 1000));
const LIMIT = Number(opt('limit', 40));

const post = async (url, body, ms = 40000) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    return await r.json();
  } finally { clearTimeout(t); }
};
const hexToBig = (h) => { try { return h && h !== '0x' ? BigInt(h) : 0n; } catch { return 0n; } };
const topicAddr = (t) => '0x' + (t || '').slice(26).toLowerCase();

async function rpcCall(chain, method, params) {
  for (const url of RPC[chain] || []) {
    try {
      const j = await post(url, { jsonrpc: '2.0', id: 1, method, params });
      if (j && !j.error) return j.result;
    } catch { /* next */ }
  }
  return null;
}

const priceCache = new Map();
async function priceMany(chain, tokens) {
  const keys = [...new Set(tokens)].map(t => `${LLAMA[chain]}:${t.toLowerCase()}`).filter(k => !priceCache.has(k));
  for (let i = 0; i < keys.length; i += 40) {
    try {
      const r = await fetch('https://coins.llama.fi/prices/current/' + keys.slice(i, i + 40).join(','), { signal: AbortSignal.timeout(25000) });
      const j = await r.json();
      for (const k of keys.slice(i, i + 40)) {
        const c = j.coins?.[k];
        priceCache.set(k, c && typeof c.price === 'number' ? { price: c.price, decimals: c.decimals ?? 18, symbol: c.symbol || '?' } : null);
      }
    } catch { for (const k of keys.slice(i, i + 40)) if (!priceCache.has(k)) priceCache.set(k, null); }
  }
}

/** Run one call from ZERO and total the value that actually arrives AT ZERO. */
async function simulate(chain, to, data) {
  const res = await rpcCall(chain, 'eth_simulateV1', [{
    blockStateCalls: [{ stateOverrides: { [ZERO]: { balance: SIM_BALANCE } }, calls: [{ from: ZERO, to, data, value: '0x0' }] }],
    traceTransfers: true, validation: false,
  }, 'latest']);
  const call = res?.[0]?.calls?.[0];
  if (!call) return { ok: false, reason: 'no result' };
  if (call.status !== '0x1') return { ok: false, reason: 'revert' };

  const got = [];
  for (const log of call.logs || []) {
    if ((log.topics?.[0] || '').toLowerCase() !== TRANSFER) continue;
    if ((log.topics || []).length !== 3) continue;
    if (topicAddr(log.topics[2]) !== ZERO.toLowerCase()) continue;
    const amt = hexToBig((log.data || '0x').slice(0, 66));
    if (amt > 0n) got.push({ token: log.address.toLowerCase(), raw: amt });
  }
  return { ok: true, got, gas: Number(hexToBig(call.gasUsed || '0x0')) };
}

/* ---- main ---- */
console.log('harvest-scan — enumerate the population, simulate each member\n');
const vaults = await (await fetch('https://api.beefy.finance/vaults', { signal: AbortSignal.timeout(60000) })).json();
const tvlRaw = await (await fetch('https://api.beefy.finance/tvl', { signal: AbortSignal.timeout(60000) })).json();
const tvl = {};
for (const d of Object.values(tvlRaw)) if (d && typeof d === 'object') Object.assign(tvl, d);

const now = Date.now() / 1000;
const cands = vaults
  .filter(v => v.status === 'active' && CHAINS.includes(v.chain) && v.strategy && v.lastHarvest)
  .map(v => ({ ...v, tvl: Number(tvl[v.id]) || 0, ageDays: (now - v.lastHarvest) / 86400 }))
  .filter(v => v.tvl >= MIN_TVL)
  .sort((a, b) => (b.ageDays * b.tvl) - (a.ageDays * a.tvl))
  .slice(0, LIMIT);

console.log(`population: ${vaults.length} vaults · ${vaults.filter(v => v.status === 'active').length} active`);
console.log(`candidates: ${cands.length} on [${CHAINS.join(', ')}] with TVL >= $${MIN_TVL}, ranked by neglect x TVL\n`);

const rows = [];
let i = 0, unmeasurable = 0;
for (const v of cands) {
  i++;
  let best = null;
  for (const c of CANDIDATE_CALLS) {
    const r = await simulate(v.chain, v.strategy, c.data);
    if (r.ok && r.got.length) { best = { ...r, via: c.label }; break; }
    if (r.ok && !best) best = { ...r, via: c.label };   // executes but pays nothing
  }
  /* A chain whose RPC cannot simulate produces no result for EVERY candidate, and that must never
   * be reported as "nothing pays here". Measured 2026-08-21: five public avalanche endpoints
   * support neither eth_simulateV1 nor debug_traceCall, and the first run of this script printed
   * avax as 0-paying when it had in fact measured nothing at all. */
  if (!best) { unmeasurable++; process.stdout.write('?'); continue; }

  await priceMany(v.chain, best.got.map(g => g.token));
  let usd = 0; const detail = [];
  for (const g of best.got) {
    const p = priceCache.get(`${LLAMA[v.chain]}:${g.token}`);
    if (p) { const val = Number(formatUnits(g.raw, p.decimals)) * p.price; usd += val; detail.push(`${p.symbol} $${val.toFixed(6)}`); }
    else detail.push(`${g.token.slice(0, 10)}… UNPRICED`);
  }
  rows.push({ chain: v.chain, id: v.id, name: v.name, strategy: v.strategy, tvl: v.tvl,
              ageDays: +v.ageDays.toFixed(1), via: best.via, pays_usd: +usd.toFixed(6),
              gas: best.gas, tokens: detail, unpriced: best.got.length !== detail.filter(d => !d.includes('UNPRICED')).length });
  process.stdout.write(usd > 0 ? '$' : '.');
}
console.log('\n');

const payers = rows.filter(r => r.pays_usd > 0).sort((a, b) => b.pays_usd - a.pays_usd);
console.log(`simulated ${rows.length} strategies · ${payers.length} pay ZERO something`);
if (unmeasurable) {
  console.log(`\u26a0 ${unmeasurable} candidate(s) UNMEASURABLE - the RPC returned no simulation result.`);
  console.log('  That is a fact about the endpoint, not about the contract, and it is NOT a zero.');
}
console.log('');
if (payers.length) {
  console.log('=== SIMULATED CALLER FEE, PAID TO OUR OWN ADDRESS ===');
  for (const r of payers.slice(0, 25)) {
    console.log(` $${String(r.pays_usd).padStart(11)} · ${r.via.padEnd(17)} · ${r.chain.padEnd(9)} ${r.name.slice(0, 22).padEnd(22)} · TVL $${String(Math.round(r.tvl)).padStart(9)} · ${String(r.ageDays).padStart(6)}d idle · gas ${r.gas}`);
    console.log(`      ${r.tokens.join(', ')}  ${r.strategy}`);
  }
} else {
  console.log('No simulated caller fee on any candidate. That is a measurement about the POPULATION,');
  console.log('not about one window — and it is the honest answer if it holds across chains.');
}

writeFileSync(path.join(HERE, 'harvest-scan-result.json'), JSON.stringify({
  probedAt: new Date().toISOString(), chains: CHAINS, minTvl: MIN_TVL,
  population: vaults.length, active: vaults.filter(v => v.status === 'active').length,
  simulated: rows.length, paying: payers.length,
  ceiling: 'rung 2 — simulated only. A settled tx is rung 3; a measured balance increase is rung 4. Never report as income.',
  rows,
}, null, 1));
console.log(`\nsaved -> scripts/harvest-scan-result.json`);
