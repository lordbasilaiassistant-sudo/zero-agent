// _fa_value.mjs — answer the two questions that decide whether a measured payment is income.
//
//   1. IS IT WORTH ANYTHING?  A claim paying 10^32 units of a token nobody trades is worth $0.
//      So: does the paid token have a real pool (Uniswap V2/V3, Aerodrome) holding real WETH/USDC?
//      Pool depth is read from the chain, not from a price API that will happily quote a ghost.
//   2. CAN IT BE DONE AGAIN?  A one-off is a curiosity; a repeatable claim is an income line.
//      Evidence is historical: pull the contract's own Transfer logs and count recipients that
//      appear MORE THAN ONCE. Somebody else already ran the experiment for us.
import { ethers } from 'ethers';
import * as L from './_fa_lib.mjs';

const FACTORIES = {
  base: {
    v3: { addr: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', fees: [100, 500, 3000, 10000] },
    v2: { addr: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6' },
    aero: { addr: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' },
  },
  optimism: { v3: { addr: '0x1F98431c8aD98523631AE4a59f267346ea31F984', fees: [100, 500, 3000, 10000] }, v2: { addr: '0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf' } },
  arbitrum: { v3: { addr: '0x1F98431c8aD98523631AE4a59f267346ea31F984', fees: [100, 500, 3000, 10000] }, v2: { addr: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9' } },
  polygon: { v3: { addr: '0x1F98431c8aD98523631AE4a59f267346ea31F984', fees: [100, 500, 3000, 10000] }, v2: { addr: '0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C' } },
  gnosis: { v3: { addr: '0xe32F7dD7e3f098D518ff19A22d5f028e076489B1', fees: [100, 500, 3000, 10000] } },
  unichain: { v3: { addr: '0x1F98400000000000000000000000000000000003', fees: [100, 500, 3000, 10000] } },
};

// Marks, stated once so every number in this lane is traceable to an assumption you can change.
// These are ASSUMPTIONS, not measurements — every estUsd downstream inherits them.
export const ETH_USD = 3000;
export const POL_USD = 0.4;
const REF_USD = {};
for (const [chain, toks] of Object.entries(L.REF_TOKENS)) {
  REF_USD[chain] = {};
  for (const t of toks) {
    REF_USD[chain][t.address.toLowerCase()] =
      /USDC|DAI/i.test(t.symbol) ? 1 : /WPOL|WMATIC/i.test(t.symbol) ? POL_USD : /WXDAI/i.test(t.symbol) ? 1 : ETH_USD;
  }
}

const getPool3 = (a, b, fee) => L.sel('getPool(address,address,uint24)') + L.addrArg(a) + L.addrArg(b) + L.u256(fee);
const getPair2 = (a, b) => L.sel('getPair(address,address)') + L.addrArg(a) + L.addrArg(b);
const getPoolAero = (a, b, stable) => L.sel('getPool(address,address,bool)') + L.addrArg(a) + L.addrArg(b) + L.u256(stable ? 1 : 0);
const isZero = (a) => !a || /^0x0+$/.test(a);

/** Find any real pool pairing `token` with a quote asset, and measure the quote side's depth. */
export async function liquidityOf(chain, token) {
  const F = FACTORIES[chain];
  const quotes = (L.REF_TOKENS[chain] || []);
  if (!F) return { hasPool: false, why: 'no factory map for chain' };
  const found = [];
  for (const q of quotes) {
    if (q.address.toLowerCase() === token.toLowerCase()) continue;
    const tries = [];
    if (F.v3) for (const fee of F.v3.fees) tries.push(['v3-' + fee, F.v3.addr, getPool3(token, q.address, fee)]);
    if (F.v2) tries.push(['v2', F.v2.addr, getPair2(token, q.address)]);
    if (F.aero) { tries.push(['aero-vol', F.aero.addr, getPoolAero(token, q.address, false)]); tries.push(['aero-stb', F.aero.addr, getPoolAero(token, q.address, true)]); }
    for (const [kind, fac, data] of tries) {
      const r = await L.tryCall(chain, fac, data);
      if (!r || r.length < 66) continue;
      const pool = '0x' + r.slice(-40);
      if (isZero(pool)) continue;
      // depth = how much of the QUOTE asset actually sits in the pool. That is the only number
      // that says anything about whether the paid token can be turned into money.
      const balHex = await L.tryCall(chain, q.address, L.balOf(ethers.getAddress(pool)));
      const bal = L.dec(balHex) ?? 0n;
      if (bal > 0n) found.push({ kind, pool: ethers.getAddress(pool), quote: q.symbol, quoteWei: bal.toString(), quoteDecimals: q.decimals });
    }
  }
  if (!found.length) return { hasPool: false, why: 'no pool with any quote asset holds a non-zero balance' };
  // Rank by USD-NORMALISED depth, never by raw wei: USDC has 6 decimals and WETH 18, so comparing raw
  // integers ranks a $100 pool above a $100M one purely on decimal places. (Measured 2026-08-01: this
  // picked the wrong pool and pushed a $0.0007 payout out at $0.40 — 546x too high.)
  for (const f of found) {
    const q = Number(ethers.formatUnits(f.quoteWei, f.quoteDecimals));
    f.usd = /USD|DAI/i.test(f.quote) ? q : q * ETH_USD;
  }
  found.sort((a, b) => b.usd - a.usd);
  const best = found[0];
  return { hasPool: true, pools: found.length, best, quoteUsdApprox: best.usd, meaningful: best.usd >= 500 };
}

/** Per-claim USD, honestly: worth nothing unless the token it pays in can actually be sold. */
export async function valueOfPayment(chain, tokenAddr, symbol, wei, decimals) {
  if (symbol === 'NATIVE') {
    const eth = Number(ethers.formatUnits(wei, 18));
    return { tokenHasLiquidity: true, estUsd: eth * (chain === 'polygon' ? POL_USD : chain === 'gnosis' ? 1 : ETH_USD),
      note: 'native gas token — realisable without a swap' };
  }
  // A reference asset is priced as itself. Deriving WETH's price from a WETH/DAI pool ratio adds a
  // whole class of error (wrong pool, thin pool, stale ratio) to answer a question we already know.
  const ref = (REF_USD[chain] || {})[tokenAddr.toLowerCase()];
  if (ref !== undefined) {
    const amt = Number(ethers.formatUnits(wei, decimals ?? 18));
    return { tokenHasLiquidity: true, estUsd: amt * ref, note: `${symbol} is a reference asset — priced directly, not via a pool ratio` };
  }
  const lq = await liquidityOf(chain, tokenAddr);
  if (!lq.hasPool) return { tokenHasLiquidity: false, estUsd: 0, note: 'no pool holds a non-zero quote balance — the payout is worth $0 no matter how large the number' };
  if (!lq.meaningful) return { tokenHasLiquidity: false, estUsd: 0, liquidity: lq, note: `only ~$${lq.quoteUsdApprox.toFixed(2)} of ${lq.best.quote} in the deepest pool — not sellable in practice` };
  // With a real pool we can at least bound the value by the pool ratio.
  const poolTok = L.dec(await L.tryCall(chain, tokenAddr, L.balOf(lq.best.pool))) ?? 0n;
  if (poolTok === 0n) return { tokenHasLiquidity: true, estUsd: 0, liquidity: lq, note: 'pool holds no side of the token' };
  const amt = Number(ethers.formatUnits(wei, decimals ?? 18));
  const poolTokF = Number(ethers.formatUnits(poolTok, decimals ?? 18));
  const px = lq.quoteUsdApprox / poolTokF;             // spot, NOT executable
  const naive = amt * px;
  // Never quote spot for a size the pool cannot absorb: cap at the constant-product output.
  const exec = lq.quoteUsdApprox * (amt / (poolTokF + amt));
  return { tokenHasLiquidity: true, estUsd: Math.min(naive, exec), spotUsd: naive, liquidity: lq,
    note: 'estUsd is the constant-product output for this size, not the spot price' };
}

/**
 * Repeatability from the chain's own history: has ANY address been paid by this contract more than
 * once? That is worth more than reading a cooldown variable, because it is an outcome, not a promise.
 */
// MEASURED 2026-08-01: the free RPCs cap eth_getLogs at a 10,000-block range. Asking for more does
// not return less — it returns an error, which a silent catch turns into "no history", which reads as
// "not repeatable". So the window is walked in legal chunks instead of requested in one illegal call.
const LOG_RANGE = 9999n;
export async function repeatability(chain, contract, { chunks = 12 } = {}) {
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const head = BigInt(await L.rpc(chain, 'eth_blockNumber', []));
  const counts = new Map();
  let total = 0, scanned = 0, failed = 0;
  for (let i = 0; i < chunks; i++) {
    const to = head - LOG_RANGE * BigInt(i);
    const from = to - LOG_RANGE + 1n;
    let logs = null;
    for (const filter of [
      { address: contract, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER] },
      { fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER, '0x' + contract.slice(2).toLowerCase().padStart(64, '0')] },
    ]) {
      logs = await L.rpc(chain, 'eth_getLogs', [filter], { tries: 2 }).catch(() => null);
      if (logs) break;
    }
    if (!logs) { failed++; continue; }
    scanned += Number(LOG_RANGE);
    for (const lg of logs) {
      if (!lg.topics || lg.topics.length < 3) continue;
      const to2 = '0x' + lg.topics[2].slice(26);
      counts.set(to2, (counts.get(to2) || 0) + 1);
      total++;
    }
  }
  const repeats = [...counts.entries()].filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]);
  return {
    payouts: total, distinctRecipients: counts.size, repeatRecipients: repeats.length,
    topRepeater: repeats[0] ? { address: repeats[0][0], times: repeats[0][1] } : null,
    blocksScanned: scanned, chunksFailed: failed,
    verdict: repeats.length ? 'REPEATABLE (an address has been paid more than once)'
      : counts.size ? 'looks once-per-address (no recipient appears twice in the scanned window)'
        : failed === chunks ? 'INCONCLUSIVE — every log query failed, no history was actually read'
          : 'no payout history found in the scanned window',
  };
}

/** Read whatever per-address gate the contract exposes, for ZERO's Safe specifically. */
export async function gateState(chain, contract, who = L.ZERO_SAFE) {
  const sigs = ['hasClaimed(address)', 'claimed(address)', 'lastClaim(address)', 'lastClaimed(address)',
    'lastClaimTime(address)', 'nextClaim(address)', 'claimCount(address)', 'cooldown()', 'COOLDOWN()',
    'claimInterval()', 'waitTime()', 'lockTime()', 'claimAmount()', 'amountAllowed()', 'dripAmount()'];
  const out = {};
  for (const s of sigs) {
    const data = s.includes('address') ? L.sel(s) + L.addrArg(who) : L.sel(s);
    const r = await L.tryCall(chain, contract, data);
    if (r && r !== '0x' && r.length >= 66) out[s] = BigInt(r).toString();
  }
  return out;
}
