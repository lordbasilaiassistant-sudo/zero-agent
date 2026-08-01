// minimalproxy.mjs — read the implementation out of an EIP-1167 clone's own bytecode.
//
// WHY THIS FILE EXISTS. Every proxy resolver in ZERO looked in STORAGE (EIP-1967 slots, beacon slot,
// an `implementation()` call). A minimal proxy keeps its target nowhere near storage — the address is
// hardcoded into 45 bytes of runtime code and there is no dispatch table at all. So every resolver
// returned null, and every instrument downstream reported the contract as empty:
//
//   extractSelectors  -> 0 selectors, "no dispatch table found"
//   probeContract     -> { exposed: 0, verdict: "no money-shaped function in its bytecode" }
//   inspect()         -> { verified: false, verdict: "no source" }, returning before any eth_call
//
// MEASURED SCOPE (2026-08-01): all 6 KNOWN_PAYERS on all 3 chains are clones; 241/241 Beefy Base
// vaults and 215/241 strategies are clones — 456 addresses behind 6 implementations. With resolution,
// the same contracts yield 86-92 selectors and a paying harvest(address) on 4 of 4 tested
// (44.1e9 / 641.7e9 / 527.6e9 / 29.1e9 wei WETH to an arbitrary caller).
//
// Why it stayed invisible for so long: the live harvest loop calls clones DIRECTLY and works fine —
// a proxy forwards calls whether or not we can read it. Only DISCOVERY was blind. So ZERO kept
// earning from the six payers it already knew and was structurally unable to see any others. Nothing
// ever failed; the rail simply could not grow.
//
// Shared here rather than fixed in one place because the same gap existed independently in
// oracle.mjs, bruteforce.mjs, gasless.mjs and discover.mjs. A primitive four modules need is a
// primitive, not four patches.

/** Canonical EIP-1167: 10 bytes prologue, 20-byte impl, 15 bytes epilogue. */
const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/i;

/**
 * Vyper/0age "optimized" minimal proxy and the common push-variants. These differ in the prologue
 * but all embed the implementation as the 20 bytes following a PUSH20 (0x73) immediately before the
 * DELEGATECALL sequence `5af43d`.
 */
const PUSH20_BEFORE_DELEGATECALL = /73([0-9a-fA-F]{40})5af43d/i;

/**
 * Extract the implementation address from clone bytecode, or null if this is not a minimal proxy.
 * Pure function — no network, no state. Give it what eth_getCode returned.
 * @param {string} code runtime bytecode
 * @returns {string|null} lowercase 0x address
 */
export function implFromCode(code) {
  if (!code || code.length < 40) return null;
  const hex = code.startsWith('0x') ? code : '0x' + code;

  const exact = hex.match(EIP1167);
  if (exact) return normalise(exact[1]);

  // Only trust the loose pattern on proxy-sized bytecode. A large contract can contain a PUSH20
  // followed by those bytes by coincidence, and mistaking a real contract for a proxy would send
  // every probe to the wrong address — a worse failure than not resolving at all.
  if ((hex.length - 2) / 2 <= 64) {
    const loose = hex.match(PUSH20_BEFORE_DELEGATECALL);
    if (loose) return normalise(loose[1]);
  }
  return null;
}

function normalise(hex40) {
  const a = '0x' + hex40.toLowerCase();
  return /^0x0+$/.test(a) ? null : a;
}

/** True when this bytecode is a minimal proxy (and therefore has no dispatch table of its own). */
export function isMinimalProxy(code) {
  return implFromCode(code) !== null;
}

/**
 * Resolve a contract to the address whose bytecode actually carries the interface.
 * Tries the clone pattern FIRST (one read, no storage lookups), then falls back to whatever
 * storage-slot resolver the caller already has.
 *
 * @param {(chain:string,method:string,params:any[])=>Promise<any>} rpc
 * @param {string} chain
 * @param {string} contract
 * @param {(rpc,chain,contract)=>Promise<string|null>} [storageResolver] existing EIP-1967/beacon path
 * @returns {Promise<{impl:string|null, kind:'minimal-proxy'|'storage-proxy'|'direct', code:string}>}
 */
export async function resolveInterfaceTarget(rpc, chain, contract, storageResolver = null) {
  const code = await rpc(chain, 'eth_getCode', [contract, 'latest']).catch(() => '0x');
  const clone = implFromCode(code);
  if (clone) return { impl: clone, kind: 'minimal-proxy', code };

  if (storageResolver) {
    const a = await storageResolver(rpc, chain, contract).catch(() => null);
    if (a) return { impl: a, kind: 'storage-proxy', code };
  }
  return { impl: null, kind: 'direct', code };
}
