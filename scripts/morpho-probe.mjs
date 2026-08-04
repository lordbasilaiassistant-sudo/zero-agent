// morpho-probe.mjs — verify the Kimi claim: permissionless Morpho Blue liquidations on Base,
// flash-loan funded (zero capital). Read-only. Saves scripts/morpho-probe-result.json
//
// Claims under test (each is a HYPOTHESIS until measured here):
//   H1: singleton 0xBBBB…FFCb exists on Base and has liquidate() + flashLoan() in its bytecode
//   H2: Morpho flash loans are fee-free (fee param / docs claim)
//   H3: there are liquidatable positions RIGHT NOW with a seizable bonus worth > gas
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://1rpc.io/base'];
const GQL = 'https://blue-api.morpho.org/graphql';

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function gql(query, variables) {
  const r = await fetch(GQL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}

const out = { probedAt: new Date().toISOString(), morpho: MORPHO };

// H1 — does the singleton exist, and does its dispatch table carry the functions we need?
const code = await rpc('eth_getCode', [MORPHO, 'latest']);
out.codeLen = (code.length - 2) / 2;
const selOf = (sig) => ethers.id(sig).slice(2, 10);
const SIGS = {
  'liquidate(MarketParams,address,uint256,uint256,bytes)':
    'liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)',
  'flashLoan(address,uint256,bytes)': 'flashLoan(address,uint256,bytes)',
  'position(bytes32,address)': 'position(bytes32,address)',
  'market(bytes32)': 'market(bytes32)',
  'accrueInterest(MarketParams)': 'accrueInterest((address,address,address,address,uint256))',
};
out.selectorsPresent = {};
for (const [label, sig] of Object.entries(SIGS)) out.selectorsPresent[label] = code.includes(selOf(sig));
console.log(`singleton code ${out.codeLen} bytes`);
console.log('selectors:', JSON.stringify(out.selectorsPresent, null, 1));

// H3 — live liquidatable positions on Base, ranked by seizable value
const Q = `query($chainId: Int!) {
  marketPositions(
    first: 500
    orderBy: BorrowShares
    orderDirection: Desc
    where: { chainId_in: [$chainId], healthFactor_lte: 1 }
  ) {
    items {
      user { address }
      healthFactor
      state { borrowAssetsUsd collateralUsd borrowAssets collateral }
      market {
        marketId lltv irmAddress
        loanAsset { address symbol decimals }
        collateralAsset { address symbol decimals }
        oracle { address }
      }
    }
  }
}`;
try {
  const d = await gql(Q, { chainId: 8453 });
  const items = (d.marketPositions?.items ?? []).filter(p => Number(p.state?.borrowAssetsUsd) > 0);
  out.liquidatableCount = items.length;
  out.liquidatable = items.slice(0, 15).map(p => ({
    user: p.user.address,
    hf: p.healthFactor,
    borrowUsd: p.state.borrowAssetsUsd,
    collateralUsd: p.state.collateralUsd,
    borrowAssets: p.state.borrowAssets,
    collateralRaw: p.state.collateral,
    market: p.market.marketId,
    loanAsset: p.market.loanAsset?.address,
    collateralAsset: p.market.collateralAsset?.address,
    oracle: p.market.oracle?.address,
    irm: p.market.irmAddress,
    pair: `${p.market.collateralAsset?.symbol ?? '?'}/${p.market.loanAsset?.symbol ?? '?'}`,
    lltv: p.market.lltv,
  }));
  console.log(`\nliquidatable positions on Base right now: ${items.length}`);
  for (const p of out.liquidatable) console.log(` hf=${Number(p.hf).toFixed(4)} borrow=$${Number(p.borrowUsd).toFixed(2)} coll=$${Number(p.collateralUsd).toFixed(2)} ${p.pair}`);
} catch (e) {
  out.gqlError = String(e).slice(0, 400);
  console.log('\nGraphQL failed:', out.gqlError);
}

// bonus sizing: Morpho LIF = min(1.15, 1/(1 - 0.3*(1 - lltv)))  [liquidation incentive factor]
if (out.liquidatable?.length) {
  out.liquidatable = out.liquidatable.map(p => {
    const lltv = Number(p.lltv) / 1e18;
    const lif = Math.min(1.15, 1 / (1 - 0.3 * (1 - lltv)));
    const maxSeizeUsd = Math.min(Number(p.collateralUsd), Number(p.borrowUsd) * lif);
    return { ...p, lltv_pct: (lltv * 100).toFixed(1), incentive_pct: ((lif - 1) * 100).toFixed(2),
      est_gross_bonus_usd: +(Number(p.borrowUsd) * (lif - 1)).toFixed(4), max_seize_usd: +maxSeizeUsd.toFixed(2) };
  }).sort((a, b) => b.est_gross_bonus_usd - a.est_gross_bonus_usd);
  const best = out.liquidatable[0];
  out.bestOpportunity = best;
  console.log(`\nBEST: ${best.pair} borrow $${Number(best.borrowUsd).toFixed(2)} · incentive ${best.incentive_pct}% · est gross bonus $${best.est_gross_bonus_usd}`);
  const total = out.liquidatable.reduce((s, p) => s + p.est_gross_bonus_usd, 0);
  console.log(`total est gross bonus across listed: $${total.toFixed(4)}`);
  out.totalEstBonusUsd = +total.toFixed(4);
}

writeFileSync(new URL('./morpho-probe-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nsaved -> scripts/morpho-probe-result.json');
