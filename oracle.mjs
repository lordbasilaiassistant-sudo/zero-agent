// oracle.mjs — measure what a function WOULD pay a caller, without spending anything at all.
//
// THE TRICK. `Multicall3.aggregate3` executes a batch of calls with MULTICALL ITSELF as msg.sender,
// and returns every return value. So inside ONE free `eth_call` we can batch:
//
//     [ balanceOf(multicall), target.someFunction(), balanceOf(multicall) ]
//
// and the delta between those two balance reads IS the fee that function pays its caller. No gas, no
// relay slot, no capital, no permission, and it works on any contract and any function on any chain.
// eth_call is free and unlimited, so this can be run across thousands of contracts forever.
//
// WHY THIS MATTERS MORE THAN IT SOUNDS. Every reward getter has lied to us — `callReward()` read
// $615.54 and paid $0.0001; `maxRewards()` read $63.24 and paid $0.00. `payout_history` fixed that by
// reading SETTLED payouts, but history only exists for contracts somebody has already called. This
// works on contracts NOBODY has ever called — it simulates the settlement itself. That is the only
// way to price a mechanism before anyone has proven it, which is exactly where an undiscovered route
// would be hiding.
//
// LIMITS, stated honestly: msg.sender is Multicall3, so this measures what a function pays an
// ARBITRARY caller — which is the thing we actually want to know. A function that pays only a
// whitelisted keeper will revert or pay zero here, correctly. A function that pays a NAMED recipient
// argument needs that argument set to the multicall address to be measured; `probeWithRecipient`
// does that. State-dependent payouts (an auction that has not opened) read as zero right now and may
// be worth re-probing later — zero here means "zero AT THIS MOMENT", not "never".
import { ethers } from 'ethers';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Zero-argument, money-shaped functions. Solidity puts every external selector in the dispatch table,
// so we can check presence with one eth_getCode and never need an ABI or verified source.
export const ZERO_ARG_FNS = [
  'harvest()', 'claim()', 'claimRewards()', 'claimFees()', 'collectFees()', 'collect()',
  'compound()', 'poke()', 'sync()', 'skim()', 'update()', 'accrue()', 'checkpoint()',
  'settle()', 'finalize()', 'trigger()', 'process()', 'distribute()', 'rebalance()',
  'tend()', 'work()', 'kick()', 'crank()', 'gulp()', 'refresh()', 'sweep()', 'flush()',
  'release()', 'redeem()', 'payout()', 'disburse()', 'award()', 'resolve()', 'rollover()',
  'burnFees()', 'withdrawFees()', 'harvestRewards()', 'claimReward()', 'ping()', 'touch()',
];
// Same shapes, but they let the caller NAME who gets paid — so we point them at the measuring address.
export const RECIPIENT_FNS = [
  'harvest(address)', 'claim(address)', 'collect(address)', 'compound(address)',
  'claimFees(address)', 'distribute(address)', 'settle(address)', 'finalize(address)',
  'claimRewards(address)', 'payout(address)', 'redeem(address)', 'sweep(address)',
];

const sel = (sig) => ethers.id(sig).slice(0, 10);
const AGG = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
]);
const balOf = (addr) => '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0');

/**
 * Which of our money-shaped selectors does this contract actually expose?
 * One eth_getCode. Works on UNVERIFIED contracts — the dispatch table cannot hide.
 */
// Resolve the implementation OURSELVES rather than trusting the caller to pass it. The control test
// failed the first time precisely because it did not: three Beefy strategies we have really been paid
// by all read as "no money-shaped function", since a BeaconProxy's own bytecode contains no
// selectors. That is the third time today this exact trap has fired, so the resolution lives inside
// the primitive now and cannot be forgotten at a call site.
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const LEGACY_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const addrWord = (v) => {
  if (!v || v.length < 42) return null;
  const a = '0x' + v.slice(-40);
  return /^0x0+$/.test(a) ? null : a;
};
export async function resolveImpl(rpc, chain, contract) {
  try {
    for (const s of [IMPL_SLOT, LEGACY_SLOT]) {
      const a = addrWord(await rpc(chain, 'eth_getStorageAt', [contract, s, 'latest']).catch(() => null));
      if (a) return a;
    }
    const beacon = addrWord(await rpc(chain, 'eth_getStorageAt', [contract, BEACON_SLOT, 'latest']).catch(() => null));
    if (beacon) {
      const a = addrWord(await rpc(chain, 'eth_call', [{ to: beacon, data: '0x5c60da1b' }, 'latest']).catch(() => null));
      if (a) return a;
    }
    return addrWord(await rpc(chain, 'eth_call', [{ to: contract, data: '0x5c60da1b' }, 'latest']).catch(() => null));
  } catch { return null; }
}

export async function selectorsPresent(rpc, chain, contract, impl = null) {
  const target = impl || await resolveImpl(rpc, chain, contract);
  const codes = await Promise.all([
    rpc(chain, 'eth_getCode', [contract, 'latest']).catch(() => '0x'),
    target ? rpc(chain, 'eth_getCode', [target, 'latest']).catch(() => '0x') : Promise.resolve('0x'),
  ]);
  const hay = codes.join('').toLowerCase();
  if (hay.length < 6) return { zeroArg: [], withRecipient: [] };
  return {
    zeroArg: ZERO_ARG_FNS.filter(f => hay.includes(sel(f).slice(2))),
    withRecipient: RECIPIENT_FNS.filter(f => hay.includes(sel(f).slice(2))),
  };
}

/**
 * THE MEASUREMENT. Simulate calling `sig` on `contract` and report the exact token amount that would
 * land on an arbitrary caller. Costs one eth_call. Spends nothing.
 */
export async function probePayout(rpc, chain, contract, sig, token) {
  const takesRecipient = sig.includes('address');
  let callData;
  try {
    callData = takesRecipient
      ? new ethers.Interface([`function ${sig}`]).encodeFunctionData(sig.split('(')[0], [MULTICALL3])
      : sel(sig);
  } catch { return { sig, ok: false, reason: 'encode failed' }; }

  const calls = [
    { target: token, allowFailure: true, callData: balOf(MULTICALL3) },
    { target: contract, allowFailure: true, callData },
    { target: token, allowFailure: true, callData: balOf(MULTICALL3) },
  ];
  let ret;
  try {
    ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
  } catch (e) { return { sig, ok: false, reason: String(e.message).slice(0, 80) }; }

  let rows;
  try { [rows] = AGG.decodeFunctionResult('aggregate3', ret); }
  catch { return { sig, ok: false, reason: 'decode failed' }; }
  if (!rows?.[1]?.success) return { sig, ok: false, reason: 'call reverts for an arbitrary caller' };

  let before = 0n, after = 0n;
  try { before = BigInt(rows[0].returnData); after = BigInt(rows[2].returnData); } catch { /* keep zeros */ }
  const delta = after - before;
  return {
    sig, ok: true, callable: true,
    paid_wei: delta.toString(),
    paid: ethers.formatEther(delta),
    pays: delta > 0n,
  };
}

/**
 * Price MANY CONTRACTS in ONE eth_call. The batch is
 *     [ bal, c1.fn, bal, c2.fn, bal, c3.fn, bal, ... ]
 * so each contract's payout is the delta across its own pair of balance reads. This is what makes
 * "probe everything before spending" affordable inside a Worker: 241 contracts price out in ~10
 * requests instead of ~1000, and the whole thing still costs nothing.
 *
 * Shares state across the batch like any aggregate3, so treat the numbers as a RANKING and re-measure
 * the winner alone (probePayout) before acting on the amount.
 */
export async function probeMany(rpc, chain, contracts, token, sig = 'harvest(address)', per = 30) {
  const iface = new ethers.Interface([`function ${sig}`]);
  const data = sig.includes('address')
    ? iface.encodeFunctionData(sig.split('(')[0], [MULTICALL3])
    : sel(sig);
  const out = [];
  for (let i = 0; i < contracts.length; i += per) {
    const slice = contracts.slice(i, i + per);
    const calls = [{ target: token, allowFailure: true, callData: balOf(MULTICALL3) }];
    for (const c of slice) {
      calls.push({ target: c, allowFailure: true, callData: data });
      calls.push({ target: token, allowFailure: true, callData: balOf(MULTICALL3) });
    }
    let rows;
    try {
      const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
      [rows] = AGG.decodeFunctionResult('aggregate3', ret);
    } catch { continue; }
    for (let k = 0; k < slice.length; k++) {
      const before = rows[k * 2], call = rows[1 + k * 2], after = rows[2 + k * 2];
      if (!call?.success || !before?.success || !after?.success) continue;
      try {
        const d = BigInt(after.returnData) - BigInt(before.returnData);
        if (d > 0n) out.push({ contract: slice[k], wei: d.toString(), sig });
      } catch { /* skip undecodable */ }
    }
  }
  return out.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1));
}

/**
 * Sweep every money-shaped function a contract exposes and return whichever actually pay.
 * Entirely free. This is the thing to run across thousands of contracts, forever.
 */
export async function probeContract(rpc, chain, contract, token, impl = null) {
  const found = await selectorsPresent(rpc, chain, contract, impl);
  const sigs = [...found.zeroArg, ...found.withRecipient];
  if (!sigs.length) return { contract, chain, exposed: 0, paying: [], verdict: 'no money-shaped function in its bytecode' };
  const results = [];
  for (const s of sigs.slice(0, 14)) results.push(await probePayout(rpc, chain, contract, s, token));
  const paying = results.filter(r => r.ok && r.pays).sort((a, b) => (BigInt(b.paid_wei) > BigInt(a.paid_wei) ? 1 : -1));
  const callable = results.filter(r => r.ok);
  return {
    contract, chain,
    exposed: sigs.length,
    callable_now: callable.map(r => r.sig),
    paying: paying.map(r => ({ sig: r.sig, paid: r.paid, paid_wei: r.paid_wei })),
    best_wei: paying[0]?.paid_wei || '0',
    verdict: paying.length
      ? `PAYS AN ARBITRARY CALLER RIGHT NOW: ${paying[0].sig} → ${paying[0].paid}`
      : callable.length ? 'callable but pays zero at this moment (state-dependent — worth re-probing)'
        : 'every money-shaped function reverts for an arbitrary caller',
  };
}
