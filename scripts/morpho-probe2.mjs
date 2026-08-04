// morpho-probe2.mjs — the decisive test on Morpho Blue liquidations (Base).
// Fixes probe1's math error: liquidation profit is capped by SEIZABLE COLLATERAL, not by debt.
//   profit_usd = min(borrowUsd, collateralUsd / LIF) * (LIF - 1)
// Then answers the question that actually decides it: CAN THE SEIZED COLLATERAL BE SOLD?
// 155 positions sitting liquidatable is a market verdict — verify whether it's "unsellable
// collateral" (real wall) or "too small for gas-paying bots" (our niche, since our gas is prepaid).
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://1rpc.io/base'];
const GQL = 'https://blue-api.morpho.org/graphql';
const QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a'; // Uniswap v3 QuoterV2 on Base
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 160));
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function gql(query, variables) {
  const r = await fetch(GQL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

const Q = `query($chainId: Int!) {
  marketPositions(first: 500, orderBy: Collateral, orderDirection: Desc,
    where: { chainId_in: [$chainId], healthFactor_lte: 1 }) {
    items {
      user { address } healthFactor
      state { borrowAssetsUsd collateralUsd borrowAssets collateral }
      market { marketId lltv
        loanAsset { address symbol decimals }
        collateralAsset { address symbol decimals } }
    }
  }
}`;

const d = await gql(Q, { chainId: 8453 });
const raw = (d.marketPositions?.items ?? []);
const out = { probedAt: new Date().toISOString(), totalLiquidatable: raw.length };

const rows = raw.map(p => {
  const lltv = Number(p.market.lltv) / 1e18;
  const lif = Math.min(1.15, 1 / (1 - 0.3 * (1 - lltv)));
  const borrowUsd = Number(p.state?.borrowAssetsUsd ?? 0);
  const collUsd = Number(p.state?.collateralUsd ?? 0);
  const repayableUsd = Math.min(borrowUsd, collUsd / lif);
  return {
    user: p.user.address, hf: Number(p.healthFactor),
    pair: `${p.market.collateralAsset?.symbol ?? '?'}/${p.market.loanAsset?.symbol ?? '?'}`,
    collateralAsset: p.market.collateralAsset?.address, collateralSymbol: p.market.collateralAsset?.symbol,
    collateralDecimals: p.market.collateralAsset?.decimals,
    loanAsset: p.market.loanAsset?.address, loanSymbol: p.market.loanAsset?.symbol,
    borrowUsd, collUsd, lif: +lif.toFixed(4),
    profitUsd: +(repayableUsd * (lif - 1)).toFixed(4),
    repayUsd: +repayableUsd.toFixed(2),
    collateralRaw: p.state?.collateral,
  };
}).filter(r => r.collUsd > 0.01).sort((a, b) => b.profitUsd - a.profitUsd);

out.withRealCollateral = rows.length;
out.top = rows.slice(0, 12);
console.log(`${raw.length} liquidatable · ${rows.length} with collateral > $0.01\n`);
console.log('CORRECTED profit (capped by seizable collateral):');
for (const r of rows.slice(0, 12)) {
  console.log(` $${r.profitUsd.toFixed(4)} profit | repay $${r.repayUsd} | ${r.pair} | coll $${r.collUsd.toFixed(2)} | hf ${r.hf.toFixed(3)}`);
}

// ── the decisive leg: can the seized collateral actually be SOLD for the loan asset? ──
// Quote the exact size we would seize, via Uniswap v3 QuoterV2 (exactInputSingle) across fee tiers.
const quoterIface = new ethers.Interface([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
]);
const FEES = [100, 500, 3000, 10000];

async function bestQuote(tokenIn, tokenOut, amountIn) {
  let best = 0n, bestFee = null;
  for (const fee of FEES) {
    try {
      const data = quoterIface.encodeFunctionData('quoteExactInputSingle', [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }]);
      const res = await rpc('eth_call', [{ to: QUOTER, data }, 'latest']);
      if (res && res !== '0x') {
        const amt = quoterIface.decodeFunctionResult('quoteExactInputSingle', res)[0];
        if (amt > best) { best = amt; bestFee = fee; }
      }
    } catch { /* no pool at this tier */ }
  }
  return { out: best, fee: bestFee };
}

console.log('\nSELLABILITY of the collateral we would seize (Uniswap v3 on Base):');
out.sellability = [];
for (const r of rows.slice(0, 8)) {
  if (!r.collateralAsset || !r.loanAsset) continue;
  // amount of collateral we would seize = repayUsd * LIF worth, expressed in collateral units
  const collDec = r.collateralDecimals ?? 18;
  const seizeUsd = r.repayUsd * r.lif;
  const unitPrice = r.collUsd / (Number(r.collateralRaw) / 10 ** collDec); // usd per collateral token
  const seizeTokens = unitPrice > 0 ? seizeUsd / unitPrice : 0;
  const amountIn = BigInt(Math.floor(seizeTokens * 10 ** collDec));
  if (amountIn <= 0n) continue;
  const direct = await bestQuote(r.collateralAsset, r.loanAsset, amountIn);
  const viaWeth = r.loanAsset.toLowerCase() !== WETH.toLowerCase()
    ? await bestQuote(r.collateralAsset, WETH, amountIn) : { out: 0n, fee: null };
  const loanDec = 6; // usdc-ish default; only used for a rough usd read on stable loans
  const proceedsUsd = direct.out > 0n
    ? Number(direct.out) / 10 ** (r.loanSymbol === 'WETH' ? 18 : loanDec) * (r.loanSymbol === 'WETH' ? unitPriceOfWeth() : 1)
    : 0;
  const row = {
    pair: r.pair, seize_usd_oracle: +seizeUsd.toFixed(2), repay_usd: r.repayUsd,
    direct_quote_raw: direct.out.toString(), direct_fee_tier: direct.fee,
    weth_route_raw: viaWeth.out.toString(),
    sellable: direct.out > 0n || viaWeth.out > 0n,
    real_proceeds_usd_est: +proceedsUsd.toFixed(2),
    verdict: (direct.out === 0n && viaWeth.out === 0n) ? 'NO DEX ROUTE — collateral unsellable, this is why bots skip it'
      : proceedsUsd > r.repayUsd ? 'PROFITABLE at quoted price' : 'quote below repay — oracle price is not the market price',
  };
  out.sellability.push(row);
  console.log(` ${row.pair}: seize $${row.seize_usd_oracle} (oracle) · dex proceeds ~$${row.real_proceeds_usd_est} · ${row.verdict}`);
}
function unitPriceOfWeth() { return 0; } // not needed for the stable-loan rows we care about

writeFileSync(new URL('./morpho-probe2-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nsaved -> scripts/morpho-probe2-result.json');
