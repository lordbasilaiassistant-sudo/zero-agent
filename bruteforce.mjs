// bruteforce.mjs — test EVERY function on EVERY contract, and keep whatever pays.
//
// The dictionary approach in oracle.mjs only probes ~50 function names somebody thought of in advance.
// That is a guess about where money is. This does not guess: it reads the contract's own dispatch
// table out of the bytecode and probes EVERY function the contract actually has.
//
// HOW THE SELECTORS ARE RECOVERED. solc compiles a function dispatcher as a chain of
//     PUSH4 <selector> ; EQ ; PUSH2 <dest> ; JUMPI
// so every externally callable selector appears in the runtime bytecode as the 4 bytes after a PUSH4
// (0x63) opcode. Scanning for that recovers the complete external interface of ANY contract —
// unverified, unnamed, no ABI, no explorer, no source. The dispatch table cannot lie and cannot hide.
//
// WHY IT IS AFFORDABLE. Naively this is contracts x functions x 3 balance reads = tens of thousands of
// eth_calls. Instead one Multicall3 aggregate3 carries the WHOLE contract:
//     [ bal, fn1, bal, fn2, bal, fn3, ... ]
// every call runs sequentially inside a single eth_call, and the delta between consecutive balance
// reads is what that function paid. One request prices an entire contract. Free, unlimited, no gas, no
// capital, no permission — and it works on contracts nobody has ever called.
//
// CAVEAT, stated honestly: inside one aggregate3 the calls share state, so fn2 executes after fn1's
// effects. That is fine for SCREENING (we only need "did anything pay") but the amounts can differ
// from an isolated call, so every hit is re-measured on its own before it is believed or acted on.
import { ethers } from 'ethers';
import { implFromCode } from './minimalproxy.mjs';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const AGG = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
]);
const balOf = (a) => '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0');

// Selectors that are certainly reads or standard token plumbing — probing them wastes budget and can
// never pay a caller. Everything else gets probed, including functions we have never heard of.
const SKIP = new Set([
  '0x06fdde03', '0x95d89b41', '0x313ce567', '0x18160ddd', '0x70a08231', '0xdd62ed3e',
  '0x01ffc9a7', '0x8da5cb5b', '0x5c60da1b', '0x3644e515', '0x54fd4d50', '0xc45a0155',
  '0x0dfe1681', '0xd21220a7', '0x38d52e0f', '0x7dc0d1d0', '0xfc0c546a', '0x17d7de7c',
  '0xa9059cbb', '0x23b872dd', '0x095ea7b3', '0x40c10f19', '0x42966c68',
]);

/** Recover every external selector from runtime bytecode. No ABI, no source, no explorer. */
export function extractSelectors(code) {
  const out = new Set();
  if (!code || code.length < 10) return [];
  const hex = code.startsWith('0x') ? code.slice(2) : code;
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) !== '63') continue;         // PUSH4
    const s = '0x' + hex.slice(i + 2, i + 10).toLowerCase();
    if (/^0x0{8}$/.test(s)) continue;                    // true all-zero padding only — gas-golfed
                                                         // keepers mine selectors starting 0000 and
                                                         // the old /^0x0{4,}/ discarded those too
    if (SKIP.has(s)) continue;
    out.add(s);
  }
  return [...out];
}

const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const word = (v) => { if (!v || v.length < 42) return null; const a = '0x' + v.slice(-40); return /^0x0+$/.test(a) ? null : a; };

/** A proxy's own bytecode has no dispatch table — resolve the implementation or find nothing.
 *  The sentence above was true and the function did not honour it for the commonest proxy of all:
 *  an EIP-1167 clone stores its target in CODE, not storage, so every storage lookup here returned
 *  null and extractSelectors then reported 0 selectors / "no dispatch table found". Measured: 456 of
 *  ZERO's addresses are clones behind 6 implementations, including all 6 KNOWN_PAYERS. Resolving them
 *  yields 86-92 selectors and a paying harvest(address) on 4 of 4 tested. */
export async function implOf(rpc, chain, c) {
  try {
    const code = await rpc(chain, 'eth_getCode', [c, 'latest']).catch(() => '0x');
    const clone = implFromCode(code);
    if (clone) return clone;

    const a = word(await rpc(chain, 'eth_getStorageAt', [c, IMPL_SLOT, 'latest']).catch(() => null));
    if (a) return a;
    // D16 FIX: a beacon that does not answer implementation() (some use childImplementation())
    // used to return null and never fall through to asking the contract directly.
    const b = word(await rpc(chain, 'eth_getStorageAt', [c, BEACON_SLOT, 'latest']).catch(() => null));
    for (const [to, sel] of [[b, '0x5c60da1b'], [b, '0xda525716'], [c, '0x5c60da1b']]) {
      if (!to) continue;
      const a2 = word(await rpc(chain, 'eth_call', [{ to, data: sel }, 'latest']).catch(() => null));
      if (a2) return a2;
    }
    return null;
  } catch { return null; }
}

/**
 * Price EVERY function on a contract. One eth_call per ~25 functions.
 * Returns whichever moved value toward an arbitrary caller.
 */
export async function bruteforceContract(rpc, chain, contract, token, { argShapes = true, batch = 25 } = {}) {
  const impl = await implOf(rpc, chain, contract);
  const codes = await Promise.all([
    rpc(chain, 'eth_getCode', [contract, 'latest']).catch(() => '0x'),
    impl ? rpc(chain, 'eth_getCode', [impl, 'latest']).catch(() => '0x') : Promise.resolve('0x'),
  ]);
  const sels = [...new Set([...extractSelectors(codes[0]), ...extractSelectors(codes[1])])];
  if (!sels.length) return { contract, chain, functions: 0, hits: [], verdict: 'no dispatch table found (is it a proxy we could not resolve?)' };

  // Two argument shapes cover almost every maintenance function in the wild: takes nothing, or takes
  // one address telling it who to pay. Point the second at the measuring address.
  const variants = [];
  for (const s of sels) {
    variants.push({ sel: s, data: s, shape: '()' });
    if (argShapes) variants.push({ sel: s, data: s + MULTICALL3.slice(2).toLowerCase().padStart(64, '0'), shape: '(address)' });
  }

  const hits = [];
  for (let i = 0; i < variants.length; i += batch) {
    const slice = variants.slice(i, i + batch);
    const calls = [{ target: token, allowFailure: true, callData: balOf(MULTICALL3) }];
    for (const v of slice) {
      calls.push({ target: contract, allowFailure: true, callData: v.data });
      calls.push({ target: token, allowFailure: true, callData: balOf(MULTICALL3) });
    }
    let rows;
    try {
      const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
      [rows] = AGG.decodeFunctionResult('aggregate3', ret);
    } catch { continue; }

    for (let k = 0; k < slice.length; k++) {
      const call = rows[1 + k * 2], after = rows[2 + k * 2], before = rows[k * 2];
      if (!call?.success || !after?.success || !before?.success) continue;
      let d = 0n;
      try { d = BigInt(after.returnData) - BigInt(before.returnData); } catch { continue; }
      if (d > 0n) hits.push({ ...slice[k], wei: d.toString() });
    }
  }

  // Screening shares state across the batch, so re-measure each hit ALONE before believing it.
  // D10 FIX: `hits` is in bytecode order — slicing the first 8 BEFORE ranking dropped the biggest
  // payer whenever it sat past index 8, which becomes likely now that clone resolution raises probe
  // counts to ~178 per contract. Rank first, then cut.
  const threeWay = (a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : BigInt(b.wei) < BigInt(a.wei) ? -1 : 0);
  const ranked = [...hits].sort(threeWay);
  const confirmed = [];
  for (const hit of ranked.slice(0, 8)) {
    const calls = [
      { target: token, allowFailure: true, callData: balOf(MULTICALL3) },
      { target: contract, allowFailure: true, callData: hit.data },
      { target: token, allowFailure: true, callData: balOf(MULTICALL3) },
    ];
    try {
      const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
      const [r] = AGG.decodeFunctionResult('aggregate3', ret);
      if (!r[1].success) continue;
      const d = BigInt(r[2].returnData) - BigInt(r[0].returnData);
      if (d > 0n) confirmed.push({ selector: hit.sel, shape: hit.shape, wei: d.toString(), eth: ethers.formatEther(d) });
    } catch { /* drop it rather than trust the batched number */ }
  }
  confirmed.sort(threeWay);

  return {
    contract, chain, implementation: impl,
    functions: sels.length,
    probed: variants.length,
    screened_hits: hits.length,
    hits: confirmed,
    best_wei: confirmed[0]?.wei || '0',
    verdict: confirmed.length
      ? `PAYS: ${confirmed[0].selector}${confirmed[0].shape} → ${confirmed[0].eth}`
      // D11 FIX: the null verdict claimed a general result while ONE hardcoded token was measured.
      // A strategy paying its caller in USDC/AERO/OP/native read as "pays nothing at all".
      : `no function on this contract paid MULTICALL3 in ${token} at head — NOT a claim about other tokens, native ETH, or another block`,
  };
}

/** Sweep a universe of contracts and return everything that pays, ranked. */
export async function sweep(rpc, chain, contracts, token, { onProgress = null } = {}) {
  const found = [];
  let n = 0;
  for (const c of contracts) {
    try {
      const r = await bruteforceContract(rpc, chain, c, token);
      if (r.hits.length) found.push({ contract: c, ...r.hits[0], functions: r.functions });
    } catch { /* one bad contract must never stop the sweep */ }
    if (onProgress) onProgress(++n, contracts.length, found.length);
  }
  found.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : BigInt(b.wei) < BigInt(a.wei) ? -1 : 0));
  return found;
}
