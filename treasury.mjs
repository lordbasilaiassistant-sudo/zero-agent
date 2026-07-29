// treasury.mjs — every chain is a tributary; ONE chain is the reservoir.
//
// THE ARCHITECTURE. ZERO harvests on five chains because free relay slots are per (Safe, chain) and
// unused slots expire worthless. But earnings scattered across five chains are not capital — they are
// five piles too small to do anything with, and that becomes the bottleneck the moment a later phase
// needs size. So: harvest EVERYWHERE, accumulate LOCALLY, and sweep into ONE home chain.
//
// WHY BASE IS HOME (measured 2026-07-28, not assumed):
//   metric                     base        optimism     verdict
//   USDC depth                 $4,189M     $160M        26x  — where capital actually is
//   agent economy (4337 ops)   2,541       19           134x — where machine payments happen
//   txs/block                  171         28           6x   — where funds are moving
//   harvestable targets        241         72           3.3x — even phase 0 is denser here
//   tx cost (250k gas)         $0.002879   $0.000481    optimism 6x cheaper
//
// Optimism wins exactly one axis: gas cost. That is a PHASE-0 constraint and it evaporates as the
// balance grows — at $1,000 nobody cares about $0.003 a transaction. Liquidity depth and agent-economy
// density are PHASE-2 constraints and they only compound. Choosing the cheap-gas chain would be
// optimising for the phase we are trying to leave. Base also already holds ZERO's identity: its smart
// account, its x402 storefront, and the only permissionless token paymaster we could find anywhere.
//
// THE BOTTLENECK THIS PREVENTS: arriving at phase 2 with $40 spread over five chains in $8 pieces,
// none of them large enough to bridge economically, is the same trap as the stranded WETH — value that
// exists but cannot act. Consolidation has to be a standing rule from the start, not a later cleanup.
import { CHAINS, wethBalance, nativeUsd } from './harvest.mjs';

export const HOME = 'base';

// Sweeping costs a bridge fee. Below a threshold the fee eats the transfer, so a tributary must
// ACCUMULATE, not dribble. Fee is the realistic fast-bridge cost; we only move when it is a small
// fraction of the amount.
export const SWEEP = {
  bridgeFeeUsd: 0.08,
  maxFeeFraction: 0.05,   // never let the bridge take more than 5% — so sweep at >= $1.60
  get thresholdUsd() { return this.bridgeFeeUsd / this.maxFeeFraction; },
};

/**
 * Where does everything sit, and what should move? Read-only planning — it never moves funds itself.
 */
export async function treasuryPlan(rpc, eoa, safe) {
  const tributaries = [];
  let homeUsd = 0, totalUsd = 0, sweepableUsd = 0;

  for (const [name, c] of Object.entries(CHAINS)) {
    try {
      const [onSafe, onEoa, price] = await Promise.all([
        wethBalance(rpc, safe, name, c.weth),
        wethBalance(rpc, eoa, name, c.weth),
        nativeUsd(name),
      ]);
      const safeUsd = price ? Number(onSafe) / 1e18 * price : 0;
      const eoaUsd = price ? Number(onEoa) / 1e18 * price : 0;
      totalUsd += safeUsd + eoaUsd;
      if (name === HOME) { homeUsd += safeUsd + eoaUsd; continue; }

      const ready = safeUsd >= SWEEP.thresholdUsd;
      if (ready) sweepableUsd += safeUsd;
      tributaries.push({
        chain: name,
        spendable_usd: +safeUsd.toFixed(8),
        stranded_at_eoa_usd: +eoaUsd.toFixed(8),
        sweep_ready: ready,
        pct_of_threshold: +((safeUsd / SWEEP.thresholdUsd) * 100).toFixed(2),
        action: ready
          ? `SWEEP to ${HOME} — the bridge fee is now under ${SWEEP.maxFeeFraction * 100}% of the amount`
          : `accumulate — needs $${(SWEEP.thresholdUsd - safeUsd).toFixed(4)} more before a bridge is economic`,
      });
    } catch { /* an unreachable chain must not break the plan */ }
  }

  return {
    home: HOME,
    home_usd: +homeUsd.toFixed(8),
    total_across_all_chains_usd: +totalUsd.toFixed(8),
    sweep_threshold_usd: SWEEP.thresholdUsd,
    sweepable_now_usd: +sweepableUsd.toFixed(8),
    tributaries: tributaries.sort((a, b) => b.spendable_usd - a.spendable_usd),
    policy: [
      `HARVEST on all ${Object.keys(CHAINS).length} chains — free relay slots are per (Safe, chain) and an unused slot expires worthless.`,
      `SPEND FREE SLOTS where gas is EXPENSIVE (arbitrum $0.0097, base $0.0029): a sponsored slot is worth exactly the gas it saves, so it is worth 20x more on arbitrum than on optimism. That is also where the uncontested band is widest, because more payouts are negative-EV for gas-paying bots.`,
      `HOLD SELF-FUNDED RESERVE where gas is CHEAP: optimism buys 2,077 txs per dollar vs base's 347.`,
      `CONSOLIDATE everything into ${HOME}, because that is where phase 2 has to happen — 26x the stablecoin depth and 134x the agent-payment activity of the nearest L2.`,
      `Sweep only above $${SWEEP.thresholdUsd}; below that the bridge fee eats the transfer. Accumulate locally until then.`,
    ],
    bottleneck_warning: totalUsd > 0 && homeUsd / totalUsd < 0.5
      ? `Only ${((homeUsd / totalUsd) * 100).toFixed(0)}% of holdings are on ${HOME}. Value spread thin across chains cannot act — it is the same trap as stranded WETH. Direct new fees to ${HOME} where the choice exists.`
      : null,
  };
}
