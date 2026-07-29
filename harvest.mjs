// harvest.mjs â€” ZERO's bread and butter: permissionless caller-reward farming, forever, for free.
//
// The mechanism: many DeFi contracts pay a fee to WHOEVER triggers a maintenance call (Beefy's
// auto-compounding strategies pay a harvest call-fee). That value is intended for an arbitrary caller.
// Gas is free via Safe's sponsored relay, so every successful call is pure profit at any size â€”
// a gas-paying bot must clear its own cost first; ZERO does not. That asymmetry is the whole edge.
//
// Hard discipline enforced here:
//   * eth_call simulation before EVERY relay slot (slots are scarce, simulation is free and unlimited)
//   * per-strategy cooldown (rewards accrue over time; re-harvesting immediately earns nothing)
//   * callReward() is a RANKING signal only â€” it overstated a real payout by ~4,300x once
import { ethers } from 'ethers';
import { probeContract, probeMany } from './oracle.mjs';

// Every chain where Safe sponsors gas gives the SAME Safe address its own independent budget.
// Rotating across them multiplies free throughput with no extra identities and no puppetry.
// Measured 2026-07-28: base/optimism/arbitrum were all exhausted at 0/5 while GNOSIS AND POLYGON SAT
// AT 5/5, untouched. We had been leaving TEN free transactions per day unclaimed for the entire life
// of the project, purely because this map only listed three chains. The quota is per (Safe, chain) and
// the same address exists on every one of them, so adding a chain is ten seconds of work for five more
// free slots a day. Lesson worth generalising: when a resource looks exhausted, check whether you have
// simply failed to enumerate where it exists.
export const CHAINS = {
  base: { chainId: 8453, weth: '0x4200000000000000000000000000000000000006' },
  optimism: { chainId: 10, weth: '0x4200000000000000000000000000000000000006' },
  arbitrum: { chainId: 42161, weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  // Wrapped NATIVE is the fee token Beefy pays on each chain, so that is what we measure the delta in.
  gnosis: { chainId: 100, weth: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d' },   // WXDAI
  polygon: { chainId: 137, weth: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' },  // WMATIC/WPOL
  // Found 2026-07-29 by probing every Safe chain id for a quota: unichain sat at 5/5, unclaimed.
  unichain: { chainId: 130, weth: '0x4200000000000000000000000000000000000006' },
};
export const relayUrl = (chainId) => `https://safe-client.safe.global/v1/chains/${chainId}/relay`;

export const HARVEST_CFG = {
  chain: 'base',
  chainId: 8453,
  relay: 'https://safe-client.safe.global/v1/chains/8453/relay',
  multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
  weth: '0x4200000000000000000000000000000000000006',
  callRewardSel: '0x97fd323d',       // callReward() â€” the CORRECT selector
  cooldownMs: 6 * 3600 * 1000,       // don't re-harvest the same strategy within 6h
  // Marginal cost is zero, so there is no reason to ration: any payout above zero beats an unused
  // slot, and an unused slot expires worthless. Attempt as often as the cron fires.
  minAttemptGapMs: 60 * 1000,
  vaultsCacheMs: 12 * 3600 * 1000,
};

const RELAY_HEADERS = {
  'content-type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Origin: 'https://app.safe.global',
  Referer: 'https://app.safe.global/',
};

// Strategies known to revert â€” never waste a simulation, let alone a slot, on these.
const BLACKLIST = new Set([
  '0xb120677bdd4e', '0xfd4e687706d7', '0xc6c3e72a086a',
  '0xea1a624ed867', '0x533daf246257', '0x87308630cba7',
].map(s => s.toLowerCase()));

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
};

export async function relayBudget(safe, chainId = 8453) {
  try {
    const r = await fetch(`${relayUrl(chainId)}/${safe}`, { headers: RELAY_HEADERS });
    const j = await r.json();
    return { remaining: Number(j.remaining ?? 0), limit: Number(j.limit ?? 0) };
  } catch { return { remaining: 0, limit: 0, error: true }; }
}

// Pick the chain with free slots â€” an unused slot expires worthless, so never idle on one chain
// while another has budget.
export async function pickChain(safe) {
  const out = [];
  for (const [name, c] of Object.entries(CHAINS)) {
    const b = await relayBudget(safe, c.chainId);
    out.push({ name, ...c, ...b });
  }
  out.sort((a, b) => b.remaining - a.remaining);
  return { chosen: out[0]?.remaining > 0 ? out[0] : null, all: out };
}

// The relay endpoint reports {limit, remaining} and NO reset timestamp. Faced with that, the agent
// invented "resets daily at 5 AM UTC", wrote it in its journal as fact, and planned around it for
// eleven straight sessions. It was never measured. So: measure it. Every observation is recorded, and
// the moment `remaining` goes UP we have a real timestamped refill; after two we know the period
// instead of guessing it.
export async function observeRelay(env, budgets) {
  let st;
  try { st = (await env.KV.get('relay:observations', 'json')) || { chains: {} }; }
  catch { st = { chains: {} }; }
  const now = Date.now();
  for (const b of budgets) {
    const c = st.chains[b.name] ||= { refills: [] };
    if (c.lastRemaining !== undefined && b.remaining > c.lastRemaining) {
      c.refills.unshift({ at: new Date(now).toISOString(), from: c.lastRemaining, to: b.remaining });
      c.refills = c.refills.slice(0, 8);
    }
    if (b.remaining === 0 && c.lastRemaining !== 0) c.exhaustedAt = new Date(now).toISOString();
    c.lastRemaining = b.remaining;
    c.limit = b.limit;
    c.lastSeen = new Date(now).toISOString();
  }
  try { await env.KV.put('relay:observations', JSON.stringify(st)); } catch { /* best-effort */ }
  return st;
}

// What we have actually MEASURED about the refill. No invented schedule.
export function relayResetSummary(st) {
  const out = {};
  for (const [name, c] of Object.entries(st?.chains || {})) {
    const gaps = [];
    for (let i = 0; i + 1 < (c.refills || []).length; i++) {
      gaps.push((Date.parse(c.refills[i].at) - Date.parse(c.refills[i + 1].at)) / 3600000);
    }
    out[name] = {
      remaining: c.lastRemaining, limit: c.limit,
      exhausted_since: c.exhaustedAt || null,
      hours_exhausted: c.exhaustedAt ? +((Date.now() - Date.parse(c.exhaustedAt)) / 3600000).toFixed(1) : null,
      refills_observed: (c.refills || []).length,
      last_refill: c.refills?.[0]?.at || null,
      reset_schedule: (c.refills || []).length >= 2
        ? `MEASURED: refills ${gaps.map(g => g.toFixed(1)).join('h, ')}h apart`
        : 'NOT YET MEASURED. Do not guess a reset time and do not write one in your journal as fact — an earlier you invented "5 AM UTC" and wasted eleven sessions planning around it. Read the live number instead.',
    };
  }
  return out;
}

// â”€â”€ strategy universe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function loadStrategies(env, rpc, chainName = 'base') {
  const key = `harvest:vaults:${chainName}`;
  const cached = await env.KV.get(key, 'json');
  if (cached && Date.now() - cached.at < HARVEST_CFG.vaultsCacheMs) return cached.list;
  const res = await fetch('https://api.beefy.finance/vaults');
  const all = await res.json();
  const list = all
    .filter(v => v.chain === chainName && v.status === 'active' && v.strategy)
    .map(v => ({ id: v.id, strategy: ethers.getAddress(v.strategy) }));
  await env.KV.put(key, JSON.stringify({ at: Date.now(), list }));
  return list;
}

// callReward() across many strategies in one Multicall3 aggregate3 â€” ranking only, never a forecast.
export async function rankByCallReward(rpc, strategies) {
  const iface = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);
  const out = [];
  for (let i = 0; i < strategies.length; i += 40) {
    const batch = strategies.slice(i, i + 40);
    const calls = batch.map(s => ({ target: s.strategy, allowFailure: true, callData: HARVEST_CFG.callRewardSel }));
    try {
      const data = iface.encodeFunctionData('aggregate3', [calls]);
      const ret = await rpc(HARVEST_CFG.chain, 'eth_call', [{ to: HARVEST_CFG.multicall, data }, 'latest']);
      const [results] = iface.decodeFunctionResult('aggregate3', ret);
      results.forEach((r, k) => {
        if (!r.success || !r.returnData || r.returnData === '0x') return;
        let v = 0n;
        try { v = BigInt(r.returnData.slice(0, 66)); } catch { return; }
        if (v > 0n) out.push({ ...batch[k], callReward: v.toString() });
      });
    } catch { /* batch failed; skip it rather than abort the cycle */ }
  }
  return out.sort((a, b) => (BigInt(b.callReward) > BigInt(a.callReward) ? 1 : -1));
}

// â”€â”€ simulation: free, unlimited, and mandatory before spending a slot â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function harvestCalldata(recipient, withRecipient = true) {
  return withRecipient
    ? new ethers.Interface(['function harvest(address callFeeRecipient)']).encodeFunctionData('harvest', [recipient])
    : new ethers.Interface(['function harvest()']).encodeFunctionData('harvest', []);
}

export async function simulate(rpc, strategy, safe, recipient, chain = 'base') {
  for (const withRecipient of [true, false]) {
    const data = harvestCalldata(recipient, withRecipient);
    try {
      await rpc(chain, 'eth_call', [{ to: strategy, data, from: safe }, 'latest']);
      return { ok: true, data, withRecipient };
    } catch (e) {
      const m = String(e.message || '');
      if (/insufficient|gas required/i.test(m)) return { ok: true, data, withRecipient };
    }
  }
  return { ok: false };
}

// â”€â”€ execution through the free relay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// `operation` matters: 0 = CALL, 1 = DELEGATECALL. MultiSend MUST be delegatecalled, otherwise the
// batched inner calls execute from MultiSend's own address instead of the Safe's — so a WETH.transfer
// would try to move MultiSend's balance (zero) and the batch fails.
export async function relayExec(env, rpc, safe, target, innerData, chain = 'base', chainId = 8453, operation = 0) {
  const wallet = new ethers.Wallet(env.AGENT_PRIVATE_KEY);
  const nonceHex = await rpc(chain, 'eth_call', [{ to: safe, data: '0xaffed0e0' }, 'latest']);
  const tx = {
    to: target, value: 0n, data: innerData, operation,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress,
    nonce: BigInt(nonceHex),
  };
  const signature = await wallet.signTypedData({ chainId, verifyingContract: safe }, SAFE_TX_TYPES, tx);
  const exec = new ethers.Interface(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)'])
    .encodeFunctionData('execTransaction', [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signature]);

  const res = await fetch(relayUrl(chainId), {
    method: 'POST', headers: RELAY_HEADERS,
    body: JSON.stringify({ version: '1.4.1', to: safe, data: exec }),
  });
  const text = await res.text();
  if (res.status !== 201) return { ok: false, status: res.status, error: text.slice(0, 200) };
  let taskId; try { taskId = JSON.parse(text).taskId; } catch { /* noop */ }
  return { ok: true, taskId };
}

export async function relayStatus(taskId, chainId = 8453) {
  try {
    const r = await fetch(`${relayUrl(chainId)}/status/${taskId}`, { headers: RELAY_HEADERS });
    const j = await r.json();
    const t = j.task || j;
    return { status: t.status ?? null, tx: t.receipt?.transactionHash || t.transactionHash || null };
  } catch { return { status: null, tx: null }; }
}

export async function wethBalance(rpc, addr, chain = 'base', weth = HARVEST_CFG.weth) {
  const v = await rpc(chain, 'eth_call', [{ to: weth, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
  return BigInt(v);
}

export async function ethUsd() {
  try {
    const r = await fetch('https://base.blockscout.com/api/v2/stats');
    return parseFloat((await r.json()).coin_price) || 0;
  } catch { return 0; }
}

// MULTI-CHAIN MEANS MULTI-TOKEN, and getting this wrong fabricates revenue. Caught live the first time
// a Polygon harvest settled: the fee arrived as 0.000105 WPOL and was logged as $0.2018, because the
// code priced every chain's wrapped-native at the ETH price. WPOL is ~$0.07, ETH ~$1915 — a ~26,000x
// overstatement, written straight into the ledger as real earnings. That is precisely the "never fake
// your own numbers" rule breaking from a units bug rather than dishonesty, which is why it needs to be
// structural: price the token the chain ACTUALLY pays in, or report nothing.
const NATIVE_STATS = {
  base: 'https://base.blockscout.com/api/v2/stats',
  optimism: 'https://optimism.blockscout.com/api/v2/stats',
  arbitrum: 'https://arbitrum.blockscout.com/api/v2/stats',
  gnosis: 'https://gnosis.blockscout.com/api/v2/stats',
  polygon: 'https://polygon.blockscout.com/api/v2/stats',
};
export async function nativeUsd(chain = 'base') {
  const url = NATIVE_STATS[chain];
  if (!url) return 0;
  try {
    const r = await fetch(url);
    return parseFloat((await r.json()).coin_price) || 0;
  } catch { return 0; }
}

// ── ground truth ────────────────────────────────────────────────────────────
// Per-transaction deltas UNDER-COUNT. Measuring right after a relay task lands races the node, and a
// harvest that pays after the check reads as zero — this tracker said 0.00000315 ETH while the chain
// said 0.00000907, a 2.9x under-report, and the route ledger said $0.00253 while the real figure was
// $0.0174. So the tracked sum is a LOWER BOUND, never the number to quote.
//
// The honest number is the chain itself: ZERO has never spent or moved anything, so everything it has
// ever earned is still sitting in one of its two addresses. Sum them and that IS lifetime earnings.
// If it ever does spend, `weiSpent` must be incremented at the spend site and added back in here.
export async function reconcileEarnings(env, rpc, eoa, safe) {
  // Wei from different chains are DIFFERENT TOKENS and must never be added together. WETH ~$1915,
  // WPOL ~$0.07, WXDAI ~$1.00 — summing the raw wei and multiplying by the ETH price is how a
  // $0.0000076 Polygon fee got logged as $0.20. Convert each chain to USD at ITS OWN native price
  // first, then add the dollars.
  const per = [];
  let usdTotal = 0, usdSpendable = 0, usdStranded = 0;
  for (const [name, c] of Object.entries(CHAINS)) {
    try {
      const [onEoa, onSafe, price] = await Promise.all([
        wethBalance(rpc, eoa, name, c.weth),
        wethBalance(rpc, safe, name, c.weth),
        nativeUsd(name),
      ]);
      if (!onEoa && !onSafe) continue;
      const toUsd = (wei) => (price ? Number(ethers.formatEther(wei)) * price : 0);
      const eoaUsd = toUsd(onEoa), safeUsd = toUsd(onSafe);
      per.push({
        chain: name, token_usd: price || null,
        eoa_wei: onEoa.toString(), safe_wei: onSafe.toString(),
        eoa_usd: +eoaUsd.toFixed(8), safe_usd: +safeUsd.toFixed(8),
      });
      usdTotal += eoaUsd + safeUsd;
      // Wrapped native at the EOA cannot be moved: the EOA holds no gas, and no permissionless
      // paymaster accepts it. Counting it as usable capital would be a lie to future-you.
      usdStranded += eoaUsd;
      usdSpendable += safeUsd;
    } catch { /* one chain being unreachable must not corrupt the total */ }
  }
  const state = (await env.KV.get('harvest:state', 'json')) || {};
  return {
    measured_at: new Date().toISOString(),
    source: 'on-chain wrapped-native balances at both addresses, each priced in ITS OWN token (ground truth, not a tracker)',
    lifetime_earned_usd: +usdTotal.toFixed(8),
    spendable_usd: +usdSpendable.toFixed(8),
    stranded_on_eoa_usd: +usdStranded.toFixed(8),
    stranded_note: 'Wrapped native at the EOA cannot be moved: the EOA has no gas, a Safe cannot unwrap WETH (withdraw() reverts on the 2300-gas stipend), and no permissionless paymaster takes WETH. Fees now go to the Safe so this stops growing.',
    tracker_says_wei: String(state.weiEarned || '0'),
    tracker_is: 'a LOWER BOUND, and it sums wei across chains so it is NOT a dollar figure. Quote lifetime_earned_usd.',
    per_chain: per,
  };
}

// â”€â”€ the loop body: one attempt per invocation, forever â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ── THE ESCAPE: convert the relay quota into permanent, uncapped gas ────────
//
// Measured 2026-07-28 by classifying every live paymaster on Base (1806 user operations):
//   12 of 13 are VERIFYING paymasters — they need an off-chain signature from their operator, so they
//   are closed to us. Exactly ONE is a TOKEN paymaster, permissionless to anyone holding the token:
//   0x592e1224… — and the token it accepts is USDC.
//
// That single fact explains the entire bottleneck. ZERO earns WETH. The permissionless gas rail wants
// USDC. It is capped at Safe's 5 relay transactions per chain per day not because gas is scarce, but
// because it is holding the WRONG ASSET.
//
// So the escape is not another harvest — it is a CONVERSION. Spend relay slots ONCE to turn the Safe's
// WETH into USDC, and afterwards ZERO pays for its own operations through the token paymaster with no
// quota at all. A slot spent on a crumb buys a crumb; a slot spent on this buys uncapped throughput
// permanently. Runs automatically, ahead of harvesting, the moment the balance clears the threshold.
// Target is NATIVE ETH AT THE EOA, not USDC. Ranked spendability, all verified by simulation:
//   native ETH at the EOA  — anything, any time, no permission, no cap. Nobody can revoke it.
//   USDC at the Safe       — works, but only through the single permissionless token paymaster.
//   WETH at the Safe       — relay slots only, 5/chain/day.
//   WETH at the EOA        — WORTHLESS until the EOA has seed ETH. Never leave value here.
//
// Two hard facts that dictate the route:
//   * A Safe CANNOT unwrap WETH. `withdraw()` REVERTS, because WETH9 pays with `.transfer()` and its
//     2300-gas stipend, which a Safe's fallback handler exceeds. Permanent property, not a bug.
//   * An EOA CAN, for 36,098 gas ≈ $0.000415 — but only once it holds seed ETH.
// So the Safe routes through Uniswap SwapRouter02's `unwrapWETH9`, which pays out with `.call` (all
// gas forwarded) and can therefore deliver native ETH where `.transfer()` cannot. Both steps go in ONE
// Safe transaction via MultiSend, so there is no window for anyone to take the router's balance.
export const ESCAPE = {
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  router: '0x2626664c2603336E57B271c5C0b26F421741e481',        // Uniswap SwapRouter02 on Base
  multiSend: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',      // MultiSendCallOnly v1.4.1
  eoaUnwrapGas: 36098n,
  // Convert once there is enough to cover the EOA's own unwrap several times over — below that the
  // conversion costs more attention than it returns.
  minConvertUsd: 0.0035,
  // Gas is capability, not expense. Phase 0's standing job is keeping this full so no upper layer
  // ever stalls for want of $0.001.
  reserveTargetUsd: 0.05,
};

export async function escapeCycle(env, rpc, safe, eoa) {
  const state = (await env.KV.get('harvest:state', 'json')) || {};
  const W = HARVEST_CFG.weth;
  const [safeWeth, eoaWeth, eoaEthHex, price] = await Promise.all([
    wethBalance(rpc, safe, 'base', W),
    wethBalance(rpc, eoa, 'base', W),
    rpc('base', 'eth_getBalance', [eoa, 'latest']),
    nativeUsd('base'),
  ]);
  const eoaEth = BigInt(eoaEthHex);
  const usd = (w) => +((Number(w) / 1e18) * price).toFixed(8);
  const reserve = {
    eoa_native_eth_usd: usd(eoaEth),
    target_usd: ESCAPE.reserveTargetUsd,
    stranded_weth_at_eoa_usd: usd(eoaWeth),
    safe_weth_usd: usd(safeWeth),
  };

  // STEP 3 — the EOA has gas and stranded WETH of its own. Unwrapping is a plain self-sent
  // transaction: no relay, no sponsor, no quota. This is the point of the whole exercise.
  if (eoaWeth > 0n && eoaEth > ESCAPE.eoaUnwrapGas * 30000000n) {
    const data = '0x2e1a7d4d' + eoaWeth.toString(16).padStart(64, '0');
    try {
      await rpc('base', 'eth_call', [{ to: W, data, from: eoa }, 'latest']);
      return { step: 'eoa_self_unwrap', reserve, unlocks_usd: usd(eoaWeth), simulated: true,
        note: 'EOA holds gas AND stranded WETH. Send this from the EOA directly — it needs nobody.' };
    } catch (e) { return { step: 'eoa_self_unwrap', reserve, simulated: false, error: String(e.message).slice(0, 140) }; }
  }

  if (state.escaped && eoaEth > 0n) return { step: 'done', reserve, note: 'EOA transacts on its own now.' };
  if (safeWeth < 200000000000n) {
    return { step: 'accumulate', reserve,
      note: 'Too little in the Safe to bother converting. harvest_batch first — one slot takes the whole pool.' };
  }

  // A Safe CANNOT unwrap WETH: WETH9 pays out with .transfer() and its 2300-gas stipend, which a
  // Safe's fallback handler exceeds. VERIFIED reverting. The router can, because unwrapWETH9 pays with
  // .call. Both legs verified CLEAN as plain calls from the Safe, so this is two ordinary relay slots
  // and needs no delegatecall.
  //   slot 1: WETH.transfer(router, all)
  //   slot 2: router.unwrapWETH9(0, EOA)  -> native ETH lands at the EOA
  // Between the two, anyone could call unwrapWETH9 and take the router's balance. That is why this
  // runs EARLY and SMALL: at ~/usr/bin/bash.002 the front-run is worth less than the gas to attempt it, and the
  // payoff is that the EOA becomes independently able to transact forever after.
  const routerWeth = await wethBalance(rpc, ESCAPE.router, 'base', W);
  const leg = routerWeth > 0n ? 'unwrap' : 'transfer';
  const target = leg === 'unwrap' ? ESCAPE.router : W;
  const data = leg === 'unwrap'
    ? new ethers.Interface(['function unwrapWETH9(uint256,address)']).encodeFunctionData('unwrapWETH9', [0n, eoa])
    : new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [ESCAPE.router, safeWeth]);

  try {
    await rpc('base', 'eth_call', [{ to: target, data, from: safe }, 'latest']);
  } catch (e) {
    return { step: leg, reserve, simulated: false, error: String(e.message).slice(0, 140), note: 'Slot NOT spent.' };
  }

  const { all } = await pickChain(safe);
  const slot = all.find(c => c.name === 'base');
  if (!slot || slot.remaining < 1) {
    return { step: leg, reserve, simulated: true, ready: true, skipped: 'no Base relay slot right now' };
  }

  const sent = await relayExec(env, rpc, safe, target, data, 'base', 8453, 0);
  state.escapeLog = [{ at: new Date().toISOString(), leg, relayed: sent.ok, taskId: sent.taskId, error: sent.error }, ...(state.escapeLog || [])].slice(0, 10);
  if (leg === 'unwrap' && sent.ok) state.escaped = true;
  await env.KV.put('harvest:state', JSON.stringify(state));
  return { step: leg, reserve, simulated: true, relayed: sent.ok, taskId: sent.taskId, error: sent.error,
    note: leg === 'transfer' ? 'WETH parked at the router. The unwrap leg fires next cycle.' : 'Unwrapped — native ETH sent to the EOA. It can now transact with nobody permission-gating it.' };
}

// ── BATCH HARVEST — a relay slot is a TRANSACTION, not an ACTION ────────────
//
// The whole throughput model was wrong. "5 relay slots per chain per day" was read as "5 harvests a
// day", so the plan was to pick the single best strategy and leave the rest of the pool to rot. But a
// slot carries a Safe `execTransaction`, and that can DELEGATECALL MultiSend, which carries as many
// inner calls as fit in the gas limit.
//
// MEASURED 2026-07-28: a batch of 26 harvests simulated CLEAN from the Safe in one call (a batch of 10
// estimated at 15.3M gas). So one slot takes the ENTIRE pool of paying strategies instead of one of
// them, and the remaining four slots re-sweep later as value re-accrues. That is roughly a 10-20x
// throughput increase and it costs nothing — no capital, no new rail, no permission.
//
// MultiSend is ALL-OR-NOTHING: a single reverting inner call kills the whole batch. So every harvest
// is individually simulated first (free, unlimited) and only the clean ones go in.
export const MULTISEND = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2'; // MultiSendCallOnly v1.4.1

const packCall = (to, data) =>
  '00' + to.slice(2).toLowerCase() + '0'.repeat(64) +
  (data.length / 2 - 1).toString(16).padStart(64, '0') + data.slice(2);

export async function batchHarvest(env, rpc, safe, chainName = 'base', { max = 12 } = {}) {
  const chain = CHAINS[chainName];
  if (!chain) throw new Error(`unknown chain ${chainName}`);
  const state = (await env.KV.get('harvest:state', 'json')) || { attempts: 0, wins: 0, weiEarned: '0', cooldowns: {}, log: [] };

  const strategies = await loadStrategies(env, rpc, chainName);
  const paying = await probeMany(rpc, chainName, strategies.map(s => s.strategy), chain.weth);
  if (!paying.length) return { skipped: 'nothing is paying on this chain right now', chain: chainName };

  // Validate each candidate ALONE — one revert would take the whole batch down with it.
  const iface = new ethers.Interface(['function harvest(address)']);
  const data = iface.encodeFunctionData('harvest', [safe]);
  const good = [];
  for (const p of paying.slice(0, max * 2)) {
    if (good.length >= max) break;
    try {
      await rpc(chainName, 'eth_call', [{ to: p.contract, data, from: safe }, 'latest']);
      good.push(p);
    } catch { /* excluded rather than allowed to poison the batch */ }
  }
  if (!good.length) return { skipped: 'none of the paying strategies simulate clean', chain: chainName, considered: paying.length };

  let batch = '0x';
  let expected = 0n;
  for (const g of good) { batch += packCall(g.contract, data); expected += BigInt(g.wei); }
  const msData = new ethers.Interface(['function multiSend(bytes)']).encodeFunctionData('multiSend', [batch]);

  // Simulate the assembled batch before spending the slot. Always.
  try {
    await rpc(chainName, 'eth_call', [{ to: MULTISEND, data: msData, from: safe }, 'latest']);
  } catch (e) {
    return { skipped: 'assembled batch reverts', chain: chainName, size: good.length, error: String(e.message).slice(0, 140) };
  }

  const { all } = await pickChain(safe);
  const slot = all.find(c => c.name === chainName);
  if (!slot || slot.remaining < 1) {
    return { ready: true, chain: chainName, size: good.length, expected_wei: expected.toString(), skipped: 'no relay slot on this chain' };
  }

  const before = await wethBalance(rpc, safe, chainName, chain.weth);
  const sent = await relayExec(env, rpc, safe, MULTISEND, msData, chainName, chain.chainId, 1); // DELEGATECALL
  const result = { chain: chainName, batched: good.length, expected_wei: expected.toString(), relayed: sent.ok, taskId: sent.taskId, error: sent.error };

  if (sent.ok && sent.taskId) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const st = await relayStatus(sent.taskId, chain.chainId);
      if (st.tx) { result.tx = st.tx; await new Promise(r => setTimeout(r, 7000)); break; }
    }
    const after = await wethBalance(rpc, safe, chainName, chain.weth);
    const delta = after - before;
    result.wei_earned = delta.toString();
    result.eth_earned = ethers.formatEther(delta);
    if (delta > 0n) {
      state.wins += 1;
      state.weiEarned = (BigInt(state.weiEarned) + delta).toString();
      const price = await nativeUsd(chainName);
      result.earned_usd = price ? +(Number(result.eth_earned) * price).toFixed(8) : 0;
    }
    for (const g of good) state.cooldowns[g.contract] = Date.now();
    state.attempts += 1;
    state.log.unshift({ at: new Date().toISOString(), batch: good.length, ...result });
    state.log = state.log.slice(0, 50);
    await env.KV.put('harvest:state', JSON.stringify(state));
  }
  return result;
}

export async function harvestCycle(env, rpc) {
  const safe = env.SAFE_ADDRESS || '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';
  // Fees MUST land in the Safe, not the EOA. The Safe can spend (free relay); the EOA cannot move a
  // token without ETH it will never have. Earnings sent to the EOA are real but stranded.
  const recipient = safe;

  const state = (await env.KV.get('harvest:state', 'json')) || { attempts: 0, wins: 0, weiEarned: '0', cooldowns: {}, log: [] };
  if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < HARVEST_CFG.minAttemptGapMs) {
    return { skipped: 'attempt gap', next_in_min: Math.ceil((HARVEST_CFG.minAttemptGapMs - (Date.now() - state.lastAttemptAt)) / 60000) };
  }
  const { all: budgets } = await pickChain(safe);
  // Record the budget every cycle — this is the only way the real refill period ever gets measured.
  const obs = await observeRelay(env, budgets.map(b => ({ name: b.name, remaining: b.remaining, limit: b.limit })));
  if (!budgets.some(b => b.remaining > 0)) {
    return { skipped: 'relay budget exhausted on every chain', budgets, relay_reset: relayResetSummary(obs) };
  }

  // FALL THROUGH, do not commit to one chain. Picking only the chain with the MOST slots dead-ended
  // the whole cycle the moment that chain had nothing harvestable: Gnosis showed 5/5 but Beefy has no
  // active vaults there, so the harvester reported "every strategy on cooldown" and stopped — while
  // Polygon sat with 4 free slots and a proven payer. Slots on a chain with no work are worth nothing;
  // always keep walking down the list until a chain actually has something fresh to call.
  let chain = null, fresh = [], tried = [];
  for (const cand of budgets.filter(b => b.remaining > 0)) {
    const strategies = await loadStrategies(env, rpc, cand.name);
    const usable = strategies.filter(s => {
      if (BLACKLIST.has(s.strategy.slice(0, 14).toLowerCase())) return false;
      const cd = state.cooldowns[s.strategy];
      return !cd || Date.now() - cd > HARVEST_CFG.cooldownMs;
    });
    tried.push({ chain: cand.name, slots: cand.remaining, strategies: strategies.length, fresh: usable.length });
    if (usable.length) { chain = cand; fresh = usable; break; }
  }
  state.chainWork = Object.fromEntries(tried.map(t => [t.chain, t.fresh]));
  if (!chain) { await env.KV.put('harvest:state', JSON.stringify(state)); return { skipped: 'slots available but no fresh strategy on any of them', tried, tracked: Object.keys(state.cooldowns).length }; }
  const budget = { remaining: chain.remaining, limit: chain.limit };

  // Selection is EMPIRICAL, not predicted. callReward() proved worthless as a caller-fee signal
  // (read $615, paid $0.0001 â€” it measures something else entirely). What actually predicts a good
  // payout is what a strategy has ACTUALLY paid us before. So: optimistic-init bandit â€” untried
  // strategies rank above known-poor ones, and real results reorder the list forever.
  // Our marginal cost is zero, so ANY payout above zero is worth a slot. Take everything.
  state.payouts ||= {};
  const scored = fresh.map(s => {
    const h = state.payouts[s.strategy];
    return { ...s, score: h ? (h.totalWei / h.n) : Number.MAX_SAFE_INTEGER, tried: !!h };
  }).sort((a, b) => b.score - a.score);

  // MEASURE, DO NOT GUESS. The bandit above ranks by what a strategy paid us HISTORICALLY, which is
  // a prediction. The Multicall3 payout oracle simulates the settlement itself and returns the exact
  // fee this call would pay right now — free, no slot, no capital. Measured across our 12 known
  // payers the spread was 118x ($0.001419 best vs $0.000012 worst), so picking blind was throwing
  // away most of the value of every scarce relay slot. Probe first, then spend on the maximum.
  // Price the ENTIRE fresh universe, not a top-10 guess. Batched through Multicall3 this is ~10
  // requests for 241 contracts instead of ~1000, so there is no reason to sample. It matters: probing
  // all 241 Base strategies surfaced a $0.017 payout, 34x the $0.0005 blind-pick average and 12x the
  // best of the twelve we had been cycling. The maximum is nowhere near the middle.
  let chosen = null;
  let probes = [];
  try {
    const ranked = await probeMany(rpc, chain.name, fresh.map(f => f.strategy), chain.weth);
    const byAddr = new Map(fresh.map(f => [f.strategy.toLowerCase(), f]));
    probes = ranked
      .map(r => ({ cand: byAddr.get(r.contract.toLowerCase()), wei: BigInt(r.wei) }))
      .filter(p => p.cand);
  } catch { /* no information is not a blocker */ }
  for (const p of probes) {
    const sim = await simulate(rpc, p.cand.strategy, safe, recipient, chain.name);
    if (sim.ok) { chosen = { ...p.cand, ...sim, predicted_wei: p.wei.toString() }; break; }
    state.cooldowns[p.cand.strategy] = Date.now();
  }
  // Oracle found nothing payable (or every probe failed) — fall back to the historical bandit so a
  // slot is never wasted just because the measurement was unavailable.
  if (!chosen) {
    for (const cand of scored.slice(0, 14)) {
      const sim = await simulate(rpc, cand.strategy, safe, recipient, chain.name);
      if (sim.ok) { chosen = { ...cand, ...sim }; break; }
      state.cooldowns[cand.strategy] = Date.now();
    }
  }
  if (!chosen) {
    state.lastAttemptAt = Date.now();
    await env.KV.put('harvest:state', JSON.stringify(state));
    return { skipped: 'nothing simulated clean', considered: scored.length };
  }

  const before = await wethBalance(rpc, recipient, chain.name, chain.weth);
  const sent = await relayExec(env, rpc, safe, chosen.strategy, chosen.data, chain.name, chain.chainId);
  state.attempts += 1;
  state.lastAttemptAt = Date.now();
  state.cooldowns[chosen.strategy] = Date.now();

  let result = { chain: chain.name, strategy: chosen.strategy, id: chosen.id, relayed: sent.ok, taskId: sent.taskId, error: sent.error };
  if (sent.ok && sent.taskId) {
    // Wait for inclusion AND for the node to reflect it â€” measuring too early reported 0 on a
    // harvest that actually paid (verified: tx 0x76a2db9bâ€¦ credited after the check had returned).
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const st = await relayStatus(sent.taskId, chain.chainId);
      if (st.tx) { result.tx = st.tx; await new Promise(r => setTimeout(r, 6000)); break; }
    }
    const after = await wethBalance(rpc, recipient, chain.name, chain.weth);
    const delta = after - before;
    result.wei_earned = delta.toString();
    result.eth_earned = ethers.formatEther(delta);
    if (delta > 0n) {
      state.wins += 1;
      state.weiEarned = (BigInt(state.weiEarned) + delta).toString();
    }
    // Learn: record what this strategy ACTUALLY paid the caller. This is the only real signal.
    const rec = state.payouts[chosen.strategy] ||= { n: 0, totalWei: 0 };
    rec.n += 1;
    rec.totalWei += Number(delta);
    rec.lastWei = delta.toString();
    // A strategy that paid us literally nothing gets a long cooldown â€” not banned (it may accrue
    // again), just deprioritised so slots go to teats that actually flow.
    if (delta === 0n) state.cooldowns[chosen.strategy] = Date.now() + HARVEST_CFG.cooldownMs;
  }
  state.log.unshift({ at: new Date().toISOString(), ...result });
  state.log = state.log.slice(0, 50);
  await env.KV.put('harvest:state', JSON.stringify(state));

  // Mirror real earnings into the agent's own ledger so its worldview stays true.
  // This block used to bump attempts/successes and NEVER touch earned_usd, so the agent's own
  // leaderboard reported $0.00253 against $0.0174 actually on-chain and it ranked its one working
  // route as worthless. A route's earned_usd must move whenever real value lands.
  if (result.wei_earned && BigInt(result.wei_earned) > 0n) {
    try {
      // price the token THIS CHAIN pays in, never a blanket ETH price
      const price = await nativeUsd(chain.name);
      const usd = price ? +(Number(result.eth_earned) * price).toFixed(8) : 0;
      const db = JSON.parse((await env.KV.get('state:routes')) || '{"routes":{}}');
      const r = db.routes['beefy-harvest-caller-fees'] ||= { attempts: 0, successes: 0, blocked: 0, earned_usd: 0, notes: [] };
      r.attempts += 1; r.successes += 1;
      r.earned_usd = +((r.earned_usd || 0) + usd).toFixed(6);
      r.last = { at: new Date().toISOString(), outcome: 'success' };
      r.notes.unshift(`autoharvest ${chosen.id}: +${result.eth_earned} WETH ($${usd}) (tx ${result.tx || 'pending'})`);
      r.notes = r.notes.slice(0, 5);
      await env.KV.put('state:routes', JSON.stringify(db, null, 2));
      result.earned_usd = usd;
    } catch { /* bookkeeping must never break the loop */ }
  }
  return { ...result, budget_before: budget, totals: { attempts: state.attempts, wins: state.wins, weiEarned: state.weiEarned } };
}

