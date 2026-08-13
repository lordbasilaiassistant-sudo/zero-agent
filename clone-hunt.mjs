/* CLONE-FAMILY HUNTER — widen the payer pool beyond any vendor's published list.
 *
 * WHY THIS IS THE ONLY REMAINING WIDENING LEVER IN THE HARVEST LANE:
 * batchHarvest already prices every strategy Beefy publishes (347 across six chains, 234 on Base),
 * ranks by simulated payout and fills each relay slot from the top. That part is correct and needs
 * no fixing. But the candidate list is bounded by ONE VENDOR'S API. Anything that clones the same
 * strategy implementation exposes the same `harvest(address)` and pays the same caller fee — and is
 * invisible to us if Beefy never listed it.
 *
 * EIP-1167 makes this enumerable rather than researchable. A minimal proxy is 45 bytes:
 *     363d3d373d3d3d363d73 <20-byte implementation> 5af43d82803e903d91602b57fd5bf3
 * The implementation address sits at a FIXED OFFSET, so any address's code tells you, in one
 * eth_getCode, whether it is a clone and of what. No ABI, no source, no explorer, no guessing.
 *
 * So: learn the implementations behind strategies that have ACTUALLY PAID US, then sweep live
 * contracts for other clones of those same implementations. Each hit is a candidate payer with a
 * pre-verified interface — discovery becomes enumeration.
 *
 * Cost: eth_getCode + eth_call only. No gas, no relay quota, no risk. Simulation is our abundant
 * resource (~5-15k calls/min measured); relay slots are the scarce one. Spending unlimited free
 * calls to raise the EV of 180 paid slots is the correct trade.
 */

const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;

/** Extract the implementation address from a minimal-proxy runtime, or null. */
export function implementationOf(code) {
  const m = EIP1167.exec((code || '').trim());
  return m ? '0x' + m[1].toLowerCase() : null;
}

/**
 * Learn which implementations sit behind a set of known-good payers.
 * Non-clones are kept too — a directly-deployed strategy is still a valid implementation to match on.
 */
export async function learnImplementations(rpc, chain, knownPayers) {
  const impls = new Map();   // impl -> count of known payers using it
  for (const addr of knownPayers) {
    try {
      const code = await rpc(chain, 'eth_getCode', [addr, 'latest']);
      const impl = implementationOf(code);
      const key = impl || addr.toLowerCase();   // direct deploy: the strategy IS the implementation
      impls.set(key, (impls.get(key) || 0) + 1);
    } catch { /* one unreadable address must not abort the sweep */ }
  }
  return impls;
}

/**
 * Sweep candidate addresses for clones of the learned implementations.
 * @returns {Promise<Array<{addr:string, impl:string, knownFamily:boolean}>>}
 */
export async function findClones(rpc, chain, candidates, knownImpls) {
  const found = [];
  for (const addr of candidates) {
    let code;
    try { code = await rpc(chain, 'eth_getCode', [addr, 'latest']); } catch { continue; }
    const impl = implementationOf(code);
    if (!impl) continue;
    found.push({ addr: addr.toLowerCase(), impl, knownFamily: knownImpls.has(impl) });
  }
  return found;
}

/**
 * The only question that matters about a candidate: does calling it from OUR address pay US?
 *
 * A clone of a paying implementation is a STRONG PRIOR, never proof — the clone may be paused,
 * empty, or gated by its own storage. So each is simulated with the real payout probe before it is
 * allowed anywhere near a relay slot. This is the same discipline that separated a genuine
 * permissionless route from a private arb bot earlier: simulate FROM ZERO'S OWN ADDRESS, because a
 * gated function reverts for us and a public one does not.
 */
export async function verifyPayers(probeMany, rpc, chain, addrs, token) {
  if (!addrs.length) return [];
  const paying = await probeMany(rpc, chain, addrs, token);
  return paying;   // probeMany returns only strictly-positive deltas, already sorted descending
}

/**
 * Full pass: learn from known payers, sweep candidates, verify by simulation, return NEW payers
 * that the vendor list does not contain.
 */
export async function cloneHunt({ rpc, probeMany, chain, knownPayers, candidates, token }) {
  const impls = await learnImplementations(rpc, chain, knownPayers);
  const clones = await findClones(rpc, chain, candidates, impls);

  const knownSet = new Set(knownPayers.map(a => a.toLowerCase()));
  const fresh = clones.filter(c => c.knownFamily && !knownSet.has(c.addr)).map(c => c.addr);

  const paying = await verifyPayers(probeMany, rpc, chain, fresh, token);

  return {
    at: new Date().toISOString(),
    chain,
    implementations_learned: impls.size,
    candidates_swept: candidates.length,
    clones_found: clones.length,
    clones_of_known_families: clones.filter(c => c.knownFamily).length,
    new_addresses_tested: fresh.length,
    NEW_PAYERS: paying,
    note: paying.length
      ? `${paying.length} payer(s) outside the vendor list — each already simulated to a positive delta.`
      : 'no new payers this pass. That is a real answer: the vendor list may already cover this family.',
  };
}
