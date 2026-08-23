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
import { implFromCode } from './minimalproxy.mjs';

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
  // F17 FIX: the upper 12 bytes of a storage word were discarded unchecked, so any uint256 that
  // happens to occupy LEGACY_SLOT was silently reinterpreted as an implementation address.
  if (!v || v.length !== 66) return null;
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(v)) return null;   // upper 12 bytes MUST be zero
  const a = '0x' + v.slice(-40);
  return /^0x0+$/.test(a) ? null : a;
};
export async function resolveImpl(rpc, chain, contract) {
  try {
    // EIP-1167 FIRST. A minimal proxy carries its implementation inside 45 bytes of runtime code and
    // puts NOTHING in the storage slots below, so the storage path returned null for every clone —
    // 53 of 60 sampled live Base strategies and all 6 KNOWN_PAYERS. Reading the code is also one call
    // instead of three, so this is both the correct order and the cheaper one.
    const code = await rpc(chain, 'eth_getCode', [contract, 'latest']).catch(() => '0x');
    const clone = implFromCode(code);
    if (clone) return clone;

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

  // F7 FIX: rows[0]/rows[2] carry allowFailure:true and their success was never checked. A CALL to
  // a codeless address SUCCEEDS with returnData "0x" (verified on Base Multicall3) and BigInt('0x')
  // throws — so the old catch turned a BROKEN MEASUREMENT into an indistinguishable "pays zero",
  // byte-identical to a genuine zero. An instrument must never report a number it did not read.
  // The second shape: rows[0] decoded but rows[2] threw → before set, after 0n → NEGATIVE delta.
  const word = (r) => (r?.success && typeof r.returnData === 'string' && r.returnData.length >= 66)
    ? BigInt(r.returnData.slice(0, 66)) : null;
  const before = word(rows[0]), after = word(rows[2]);
  if (before === null || after === null) {
    return {
      sig, ok: false,
      reason: `balance probe failed — "${token}" did not return a uint256 to Multicall3 (wrong token address for this chain, or not an ERC-20). NOT a measurement of zero.`,
    };
  }
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
 * SHARED STATE — MEASURED, not assumed (2026-07-31, Base block 49,378,134, n=40, the SAME pinned block
 * on both sides, `harvest(address)` on both sides):
 *     payers batched 38   vs   payers isolated 38
 *     total wei 7,222,070,864,315  vs  7,222,291,212,292   =  1.000x   (0.003% apart)
 *     pays-in-batch-only (phantom income): 0     top pick: the SAME strategy either way
 * The batched numbers ARE safe to rank on. An audit reported 92% phantom income and a 6.3x
 * overstatement here; that was an ARTEFACT OF ITS OWN MEASUREMENT, not a property of this function. It
 * fired 40 un-throttled isolated probes at a single public RPC, swallowed the failures in a bare
 * `catch {}`, and then read the missing entries as `?? 0n`. Re-running that exact shape: 31 of 40
 * probes threw and were scored as "pays 0 wei". DO NOT rewrite probeMany on the strength of that
 * number — and note the shape of the error, because it is the one this file is most likely to repeat:
 * A FAILED PROBE IS UNKNOWN, NEVER ZERO.
 *
 * The residual 0.003% is genuine state-sharing and is far too small to change a slot decision. What
 * still justifies re-measuring the winner alone with probeOne() before spending a slot is not
 * distortion — it is staleness, and the fact that the batch never tested the exact call you are about
 * to pay for. Treat these numbers as a SCREEN; let probeOne be the gate.
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
      out.batchesOk = (out.batchesOk || 0) + 1;
    } catch (e) {
      // MEASURED 2026-08-13: this bare `catch { continue }` is the reason the live scan reported ONE
      // payer while this exact code run locally found 228 of 234 paying $0.0707. A silently dropped
      // batch is indistinguishable from a batch of non-payers — the same "failure reads as zero" shape
      // this file's own docstring warns about four lines up, committed again one function below it.
      // The usual culprit is the Worker subrequest ceiling (SLICE_SUBREQUESTS=26): ctx.rpc THROWS once
      // spent, every remaining batch is swallowed, and the agent sees a fraction of its opportunities.
      // Record it. A caller that cannot see how much of the universe went unpriced cannot know whether
      // "the best available" means anything.
      out.batchesFailed = (out.batchesFailed || 0) + 1;
      out.unpriced = (out.unpriced || 0) + slice.length;
      out.lastError = String(e?.message || e).slice(0, 120);
      continue;
    }
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
 * THE GATE. Price ONE contract, ALONE in its own eth_call, and say whether it pays RIGHT NOW.
 *     [ balanceOf(recipient), contract.harvest(recipient), balanceOf(recipient) ]
 * Never batched with other targets — the whole point is that this is exactly the one call a relay slot
 * is about to be spent on. Costs one eth_call, free and gasless, and spends nothing.
 *
 * `recipient` doubles as the harvest argument AND the address whose balance is measured, so it should
 * be the address that will really be paid (the Safe). MEASURED 2026-07-31 across 20 Base strategies:
 * recipient=SAFE and recipient=MULTICALL3 gave byte-identical wei and zero pay/no-pay disagreements,
 * so this is robust to which one a caller passes. NOTE msg.sender is still Multicall3 either way.
 *
 * THE RETURN CONTRACT, and the reason this function exists rather than a bare delta:
 *     { measured: true,  wei }  the probe ran; `wei` is what it would pay (0n is a real, trusted zero)
 *     { measured: false, wei: 0n, reason }  the probe DID NOT RUN — an RPC failure, a rate limit, an
 *                                           unreadable balance. This is NOT a zero.
 * Callers MUST branch on `measured` before treating 0n as "does not pay". Collapsing those two states
 * is precisely the defect that produced a false 92%-phantom-income audit of probeMany above: 31 of 40
 * failed probes were recorded as zeros. A reverting harvest IS a trustworthy zero (measured:true) —
 * the contract answered. An RPC that never answered is not.
 */
export async function probeOne(rpc, chain, contract, token, recipient = MULTICALL3, sig = 'harvest(address)') {
  let callData;
  try {
    callData = sig.includes('address')
      ? new ethers.Interface([`function ${sig}`]).encodeFunctionData(sig.split('(')[0], [recipient])
      : sel(sig);
  } catch { return { contract, measured: false, wei: 0n, reason: 'encode failed' }; }

  const calls = [
    { target: token, allowFailure: true, callData: balOf(recipient) },
    { target: contract, allowFailure: true, callData },
    { target: token, allowFailure: true, callData: balOf(recipient) },
  ];
  let rows;
  try {
    const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
    [rows] = AGG.decodeFunctionResult('aggregate3', ret);
  } catch (e) { return { contract, measured: false, wei: 0n, reason: String(e.message).slice(0, 90) }; }

  // The harvest itself reverting is a real answer: it pays us nothing. Trust it.
  if (!rows?.[1]?.success) return { contract, measured: true, wei: 0n, reverted: true, sig };
  // A balance read that failed means we cannot compute a delta at all — unknown, not zero.
  if (!rows[0]?.success || !rows[2]?.success) return { contract, measured: false, wei: 0n, reason: 'balance read failed' };
  try {
    return { contract, measured: true, wei: BigInt(rows[2].returnData) - BigInt(rows[0].returnData), sig };
  } catch { return { contract, measured: false, wei: 0n, reason: 'undecodable balance' }; }
}

/**
 * Sweep every money-shaped function a contract exposes and return whichever actually pay.
 * Entirely free. This is the thing to run across thousands of contracts, forever.
 */
export async function probeContract(rpc, chain, contract, token, impl = null) {
  const found = await selectorsPresent(rpc, chain, contract, impl);
  // F13 FIX: withRecipient FIRST. Those are the forms that can pay an address the caller names —
  // harvest(address) is the only signature ZERO has ever actually been paid by — and concatenating
  // them after 40 zero-arg candidates put them permanently on the wrong side of the slice(0,14).
  const sigs = [...found.withRecipient, ...found.zeroArg];
  if (!sigs.length) return { contract, chain, exposed: 0, paying: [], verdict: 'no money-shaped function in its bytecode' };
  const results = [];
  for (const s of sigs.slice(0, 14)) results.push(await probePayout(rpc, chain, contract, s, token));
  const paying = results.filter(r => r.ok && r.pays).sort((a, b) => (BigInt(b.paid_wei) > BigInt(a.paid_wei) ? 1 : BigInt(b.paid_wei) < BigInt(a.paid_wei) ? -1 : 0));
  const callable = results.filter(r => r.ok);
  return {
    contract, chain,
    exposed: sigs.length,
    measured_token: token,   // F8: every verdict below is a statement ABOUT THIS TOKEN ONLY
    callable_now: callable.map(r => r.sig),
    paying: paying.map(r => ({ sig: r.sig, paid: r.paid, paid_wei: r.paid_wei })),
    best_wei: paying[0]?.paid_wei || '0',
    verdict: paying.length
      ? `PAYS AN ARBITRARY CALLER RIGHT NOW: ${paying[0].sig} → ${paying[0].paid} ${token}`
      : callable.length
        ? `callable but pays zero IN ${token} at this moment — NOT a claim about other tokens or native ETH (state-dependent, worth re-probing)`
        : `every money-shaped function reverts for an arbitrary caller`,
  };
}
