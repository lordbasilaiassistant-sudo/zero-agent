// harvest.mjs — ZERO's bread and butter: permissionless caller-reward farming, forever, for free.
//
// The mechanism: many DeFi contracts pay a fee to WHOEVER triggers a maintenance call (Beefy's
// auto-compounding strategies pay a harvest call-fee). That value is intended for an arbitrary caller.
// Gas is free via Safe's sponsored relay, so every successful call is pure profit at any size —
// a gas-paying bot must clear its own cost first; ZERO does not. That asymmetry is the whole edge.
//
// Hard discipline enforced here:
//   * eth_call simulation before EVERY relay slot (slots are scarce, simulation is free and unlimited)
//   * per-strategy cooldown (rewards accrue over time; re-harvesting immediately earns nothing)
//   * callReward() is a RANKING signal only — it overstated a real payout by ~4,300x once
import { ethers } from 'ethers';

export const HARVEST_CFG = {
  chain: 'base',
  chainId: 8453,
  relay: 'https://safe-client.safe.global/v1/chains/8453/relay',
  multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
  weth: '0x4200000000000000000000000000000000000006',
  callRewardSel: '0x97fd323d',       // callReward() — the CORRECT selector
  cooldownMs: 6 * 3600 * 1000,       // don't re-harvest the same strategy within 6h
  minAttemptGapMs: 8 * 60 * 1000,    // spread attempts so the relay budget lasts
  vaultsCacheMs: 12 * 3600 * 1000,
};

const RELAY_HEADERS = {
  'content-type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Origin: 'https://app.safe.global',
  Referer: 'https://app.safe.global/',
};

// Strategies known to revert — never waste a simulation, let alone a slot, on these.
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

export async function relayBudget(safe) {
  try {
    const r = await fetch(`${HARVEST_CFG.relay}/${safe}`, { headers: RELAY_HEADERS });
    const j = await r.json();
    return { remaining: Number(j.remaining ?? 0), limit: Number(j.limit ?? 0) };
  } catch { return { remaining: 0, limit: 0, error: true }; }
}

// ── strategy universe ────────────────────────────────────────────────────────
export async function loadStrategies(env, rpc) {
  const cached = await env.KV.get('harvest:vaults', 'json');
  if (cached && Date.now() - cached.at < HARVEST_CFG.vaultsCacheMs) return cached.list;
  const res = await fetch('https://api.beefy.finance/vaults');
  const all = await res.json();
  const list = all
    .filter(v => v.chain === 'base' && v.status === 'active' && v.strategy)
    .map(v => ({ id: v.id, strategy: ethers.getAddress(v.strategy) }));
  await env.KV.put('harvest:vaults', JSON.stringify({ at: Date.now(), list }));
  return list;
}

// callReward() across many strategies in one Multicall3 aggregate3 — ranking only, never a forecast.
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

// ── simulation: free, unlimited, and mandatory before spending a slot ─────────
export function harvestCalldata(recipient, withRecipient = true) {
  return withRecipient
    ? new ethers.Interface(['function harvest(address callFeeRecipient)']).encodeFunctionData('harvest', [recipient])
    : new ethers.Interface(['function harvest()']).encodeFunctionData('harvest', []);
}

export async function simulate(rpc, strategy, safe, recipient) {
  for (const withRecipient of [true, false]) {
    const data = harvestCalldata(recipient, withRecipient);
    try {
      await rpc(HARVEST_CFG.chain, 'eth_call', [{ to: strategy, data, from: safe }, 'latest']);
      return { ok: true, data, withRecipient };
    } catch (e) {
      const m = String(e.message || '');
      if (/insufficient|gas required/i.test(m)) return { ok: true, data, withRecipient };
    }
  }
  return { ok: false };
}

// ── execution through the free relay ─────────────────────────────────────────
export async function relayExec(env, rpc, safe, target, innerData) {
  const wallet = new ethers.Wallet(env.AGENT_PRIVATE_KEY);
  const nonceHex = await rpc(HARVEST_CFG.chain, 'eth_call', [{ to: safe, data: '0xaffed0e0' }, 'latest']);
  const tx = {
    to: target, value: 0n, data: innerData, operation: 0,
    safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress,
    nonce: BigInt(nonceHex),
  };
  const signature = await wallet.signTypedData({ chainId: HARVEST_CFG.chainId, verifyingContract: safe }, SAFE_TX_TYPES, tx);
  const exec = new ethers.Interface(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)'])
    .encodeFunctionData('execTransaction', [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signature]);

  const res = await fetch(HARVEST_CFG.relay, {
    method: 'POST', headers: RELAY_HEADERS,
    body: JSON.stringify({ version: '1.4.1', to: safe, data: exec }),
  });
  const text = await res.text();
  if (res.status !== 201) return { ok: false, status: res.status, error: text.slice(0, 200) };
  let taskId; try { taskId = JSON.parse(text).taskId; } catch { /* noop */ }
  return { ok: true, taskId };
}

export async function relayStatus(taskId) {
  try {
    const r = await fetch(`${HARVEST_CFG.relay}/status/${taskId}`, { headers: RELAY_HEADERS });
    const j = await r.json();
    const t = j.task || j;
    return { status: t.status ?? null, tx: t.receipt?.transactionHash || t.transactionHash || null };
  } catch { return { status: null, tx: null }; }
}

export async function wethBalance(rpc, addr) {
  const v = await rpc(HARVEST_CFG.chain, 'eth_call', [{ to: HARVEST_CFG.weth, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
  return BigInt(v);
}

// ── the loop body: one attempt per invocation, forever ───────────────────────
export async function harvestCycle(env, rpc) {
  const safe = env.SAFE_ADDRESS || '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';
  // Fees MUST land in the Safe, not the EOA. The Safe can spend (free relay); the EOA cannot move a
  // token without ETH it will never have. Earnings sent to the EOA are real but stranded.
  const recipient = safe;

  const state = (await env.KV.get('harvest:state', 'json')) || { attempts: 0, wins: 0, weiEarned: '0', cooldowns: {}, log: [] };
  if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < HARVEST_CFG.minAttemptGapMs) {
    return { skipped: 'attempt gap', next_in_min: Math.ceil((HARVEST_CFG.minAttemptGapMs - (Date.now() - state.lastAttemptAt)) / 60000) };
  }
  const budget = await relayBudget(safe);
  if (!budget.remaining) return { skipped: 'relay budget exhausted', budget };

  const strategies = await loadStrategies(env, rpc);
  const fresh = strategies.filter(s => {
    if (BLACKLIST.has(s.strategy.slice(0, 14).toLowerCase())) return false;
    const cd = state.cooldowns[s.strategy];
    return !cd || Date.now() - cd > HARVEST_CFG.cooldownMs;
  });
  if (!fresh.length) return { skipped: 'every strategy on cooldown', tracked: Object.keys(state.cooldowns).length };

  const ranked = await rankByCallReward(rpc, fresh.slice(0, 120));
  if (!ranked.length) return { skipped: 'no strategy reported a call reward' };

  // simulate down the ranking until one is genuinely callable
  let chosen = null;
  for (const cand of ranked.slice(0, 12)) {
    const sim = await simulate(rpc, cand.strategy, safe, recipient);
    if (sim.ok) { chosen = { ...cand, ...sim }; break; }
    state.cooldowns[cand.strategy] = Date.now(); // reverts: park it
  }
  if (!chosen) {
    state.lastAttemptAt = Date.now();
    await env.KV.put('harvest:state', JSON.stringify(state));
    return { skipped: 'nothing simulated clean', considered: ranked.length };
  }

  const before = await wethBalance(rpc, recipient);
  const sent = await relayExec(env, rpc, safe, chosen.strategy, chosen.data);
  state.attempts += 1;
  state.lastAttemptAt = Date.now();
  state.cooldowns[chosen.strategy] = Date.now();

  let result = { strategy: chosen.strategy, id: chosen.id, relayed: sent.ok, taskId: sent.taskId, error: sent.error };
  if (sent.ok && sent.taskId) {
    // Wait for inclusion AND for the node to reflect it — measuring too early reported 0 on a
    // harvest that actually paid (verified: tx 0x76a2db9b… credited after the check had returned).
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const st = await relayStatus(sent.taskId);
      if (st.tx) { result.tx = st.tx; await new Promise(r => setTimeout(r, 6000)); break; }
    }
    const after = await wethBalance(rpc, recipient);
    const delta = after - before;
    result.wei_earned = delta.toString();
    result.eth_earned = ethers.formatEther(delta);
    if (delta > 0n) {
      state.wins += 1;
      state.weiEarned = (BigInt(state.weiEarned) + delta).toString();
    }
  }
  state.log.unshift({ at: new Date().toISOString(), ...result });
  state.log = state.log.slice(0, 50);
  await env.KV.put('harvest:state', JSON.stringify(state));

  // Mirror real earnings into the agent's own ledger so its worldview stays true.
  if (result.wei_earned && BigInt(result.wei_earned) > 0n) {
    try {
      const db = JSON.parse((await env.KV.get('state:routes')) || '{"routes":{}}');
      const r = db.routes['beefy-harvest-caller-fees'] ||= { attempts: 0, successes: 0, blocked: 0, earned_usd: 0, notes: [] };
      r.attempts += 1; r.successes += 1;
      r.last = { at: new Date().toISOString(), outcome: 'success' };
      r.notes.unshift(`autoharvest ${chosen.id}: +${result.eth_earned} WETH (tx ${result.tx || 'pending'})`);
      r.notes = r.notes.slice(0, 5);
      await env.KV.put('state:routes', JSON.stringify(db, null, 2));
    } catch { /* bookkeeping must never break the loop */ }
  }
  return { ...result, budget_before: budget, totals: { attempts: state.attempts, wins: state.wins, weiEarned: state.weiEarned } };
}
