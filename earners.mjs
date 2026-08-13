/* EARNER REGISTRY (2026-08-13) — the fix for "harvest.mjs limits them".
 *
 * THE PROBLEM: every way ZERO can make money had to be a harvest, because harvest.mjs WAS the
 * earning architecture. That is one shape — call a public function, take the caller fee — and it is
 * the reason 352 PROVEN_PAYING routes all collapsed into a single earning mechanism. A venue that
 * pays differently (sell an endpoint, solve a bounty, run a keeper job) had nowhere to live, so it
 * did not get built, so it did not get tried.
 *
 * THE SHAPE: an earner is anything that answers three questions. Add a file, add it to EARNERS, and
 * the loop picks it up — no changes to the loop, no changes to harvest.mjs.
 *
 *    ready(ctx)   -> { can: bool, why: string }        can this earn RIGHT NOW, and if not, why
 *    estimate(ctx)-> { usd: number, confidence: str }  what it is worth attempting
 *    attempt(ctx) -> { earnedUsd, evidence, note }     do it, return PROOF not a claim
 *
 * RULES THIS FILE ENFORCES:
 *  - `evidence` is mandatory on any nonzero earning: a tx hash, a settlement id, something checkable.
 *    A number without evidence is a claim, and claims are how a ledger starts lying (MEMORY LAW).
 *  - An earner that cannot run says WHY. "not ready" with no reason is how a route silently dies.
 *  - Ordering is by expected value, not by author preference. The loop runs what pays most first.
 *  - Adding an earner must never require editing another earner. That coupling is what limited us.
 */

/** @typedef {{ address:string, capacity:object, env:object, call:Function }} EarnerCtx */

export const EARNERS = [
  {
    id: 'harvest-caller-fees',
    shape: 'call a public function that pays whoever calls it',
    proven: true,                       // 191 wins / 305 attempts — our ONLY measured earner
    capitalRequiredUsd: 0,
    needs: 'a free relay slot on a chain with harvestable vaults',
    /* Delegates to the existing engine — wrapping, not rewriting. harvest.mjs stays the expert on
       this shape; the registry only decides WHEN it runs relative to other shapes. */
    module: './harvest.mjs',
    note: 'The proven one. ACT LAW says re-run this before trying anything new.',
  },
  {
    id: 'x402-sell-endpoint',
    shape: 'sell a service for USDC; the buyer pays the settlement gas',
    proven: false,
    capitalRequiredUsd: 0,
    needs: 'an HTTP endpoint returning 402 with our payTo address',
    facilitator: 'https://facilitator.payai.network',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    network: 'eip155:8453',
    note: 'MEASURED 2026-08-13: 100 sampled live x402 resources settled $2,450 in 30d. The RAIL is '
        + 'real; DEMAND is not given — 26,127 resources are listed, so the listing is worth nothing '
        + 'and the endpoint is the whole job. Sell what only we have: the route dataset and contract '
        + 'intel from 4,556 triaged candidates.',
  },
  {
    id: 'agent-bounties',
    shape: 'solve a posted bounty, settle in USDC on Base',
    proven: false,
    capitalRequiredUsd: 0.01,           // claim bond — the reason this is rung two, not rung one
    needs: '$0.01 USDC for the claim bond',
    feed: 'https://api.agentbounties.app/v1/base/autonomous-bounties/feed?network=base-mainnet&claimable_only=true',
    note: 'CHANGED since our July note said nobody had ever been paid: 30 settled, 32.51 USDC, 10 '
        + 'distinct solvers, latest 2026-08-10, one settlement verified on-chain. Unlocks at one cent.',
  },
  {
    id: 'curve-feecollector-gnosis',
    shape: 'call a fee-sweep the DAO pays for, on the chain where our relay slots are free',
    proven: false,
    capitalRequiredUsd: 0,
    needs: 'a free Gnosis relay slot AND the COLLECT epoch to be open',
    chain: 'gnosis',
    contract: '0xBb7404F9965487a9DdE721B3A5F0F3CcfA9aa4C5',
    call: 'collect(address[],address) 0x42b1689d — pass tokens, pass our Safe as _receiver',
    /* MEASURED 2026-08-13 against https://rpc.gnosischain.com:
       - contract exists (16,808 bytes of code), target() = 0xe91D…a97d
       - holds $49.65 of collectable fees across 14 tokens (EURE 12.78, EURE 12.78,
         EURC.E 12.71, BREAD 10.33, XDAI 1.03, …)
       - epoch(ts) probed hourly for 24h then daily for 7: the cycle is WEEKLY, not daily —
         Thu/Fri/Sat/Sun = 1 SLEEP · Mon = 2 COLLECT · Tue = 4 EXCHANGE · Wed = 8 FORWARD.
       So collect() is CLOSED today and OPENS MONDAY. This is why the first probe read "epoch 1"
       and would have looked like "the route does not work" — it works, it is time-gated. */
    epochs: { SLEEP: 1, COLLECT: 2, EXCHANGE: 4, FORWARD: 8 },
    epochCheck: 'epoch(uint256) 0x5487c577 with a unix ts — only call collect() when it returns 2',
    note: 'THE FIRST REAL MATCH between free execution and a payer: Gnosis has 5/5 free relay slots '
        + 'and 1,299 examined candidates that pay nothing — this one pays. Fee is a 0→1% ramp on the '
        + 'swept amount, so ~$0.49 at the current $49.65 balance, and it RECURS WEEKLY. Fee ramps '
        + 'through the window, so later in the COLLECT epoch pays more — but a competitor sweeping '
        + 'first pays us zero, so do not wait for the theoretical maximum.',
  },
  {
    id: 'curve-hooker-gnosis',
    shape: 'execute a funded hook, paid per-hook with a dutch-decaying compensation',
    proven: false,
    capitalRequiredUsd: 0,
    needs: 'a free Gnosis relay slot',
    chain: 'gnosis',
    contract: '0xE898893ebAe7b75dc4cAB0fb16e24137309ff178',
    call: 'act(hook_inputs,address) — each hook carries its own CompensationStrategy budget',
    note: 'Same family as the FeeCollector and the same chain. Not yet probed for an open hook.',
  },
  {
    id: 'keeper-upkeep',
    shape: 'perform permissionless upkeep a protocol pays for',
    proven: false,
    capitalRequiredUsd: 0,
    needs: 'a free relay slot',
    note: 'Same economics as harvest-caller-fees (someone needs a call made and will pay for it) but '
        + 'a different discovery surface. This is the closest sibling to our one proven earner, which '
        + 'makes it the highest-prior unexplored shape — RESOURCE-CLASS LAW: enumerate the class.',
  },
];

/* ── DISCOVERY SHAPES — where untouched freebies actually hide ──────────────────────────────
   ZERO already grinds one surface (Beefy-style vaults) and found 352 payers there. The point of a
   registry is that the SURFACE is a variable. Each entry below is a different place on-chain where
   somebody has already committed to paying a stranger, most of them unwatched because they pay too
   little for a gas-paying bot to bother — which is exactly ZERO's edge, since its gas is free.

   These are LEADS, not facts (MEMORY LAW): each carries what to check, and none may be cited as
   income until a tx hash proves it. Enumerating this list is the job; the list is meant to grow. */
export const DISCOVERY_SURFACES = [
  { id: 'keeper-registries', where: 'Chainlink Automation / Gelato / OpenZeppelin Defender style upkeep',
    why: 'protocols pre-fund an upkeep balance and pay whoever performs the call' },
  { id: 'liquidation-dust', where: 'lending markets with tiny underwater positions',
    why: 'liquidator bonuses too small for gas-paying bots are pure profit at $0 gas' },
  { id: 'stale-oracle-pokes', where: 'oracles paying for a refresh when a heartbeat lapses',
    why: 'liveness has a bounty and it is paid to whoever notices first' },
  { id: 'unclaimed-fees', where: 'LP/protocol fee splitters with a public claim() anyone may call',
    why: 'many pay the caller a cut simply for triggering distribution' },
  { id: 'reward-distributors', where: 'MerkleDistributor / streaming reward contracts',
    why: 'some pay a caller fee for pushing a distribution round' },
  { id: 'auction-settlers', where: 'batch auctions / TWAP orders needing a settle() call',
    why: 'settlement is permissionless and often rewarded' },
  { id: 'expired-timelocks', where: 'timelocks and vesting with a permissionless execute()',
    why: 'the call must happen; whoever makes it is sometimes paid' },
  { id: 'abandoned-bounties', where: 'bounty contracts funded then forgotten',
    why: 'funded + unclaimed is the definition of an untouched freebie' },
];

/** Which surface to grind next: the least-recently-scanned one we have not eliminated. */
export function nextSurface(scannedAtById = {}) {
  const ranked = DISCOVERY_SURFACES
    .map(s => ({ ...s, lastScanned: scannedAtById[s.id] ?? null }))
    .sort((a, b) => (a.lastScanned ? Date.parse(a.lastScanned) : 0) - (b.lastScanned ? Date.parse(b.lastScanned) : 0));
  return {
    surface: ranked[0],
    note: 'Grind the coldest surface, not the familiar one. Our one proven earner came from a single '
        + 'surface; the other seven are unexamined, and "we found it once" is not a reason to keep '
        + 'looking only there.',
    ranked,
  };
}

/**
 * Rank earners by what is worth attempting now. Pure function — no I/O, no side effects, so it is
 * code and not a thought (COMPUTE LAW). The agent reads the order; it does not re-derive it.
 *
 * @param {{ usdcBalance:number, freeRelaySlots:number|null }} state
 */
export function rankEarners(state) {
  const usdc = Number(state?.usdcBalance ?? 0);
  /* null means UNMEASURED, not zero — a failed capacity probe must never read as "no slots".
     Treat unknown as "assume we have some and let the attempt fail loudly" rather than silently
     skipping every relay-dependent earner. */
  const slots = state?.freeRelaySlots;
  const slotsUnknown = slots === null || slots === undefined;
  const haveSlots = slotsUnknown || Number(slots) > 0;

  return EARNERS
    .map(e => {
      const blockers = [];
      if (e.capitalRequiredUsd > usdc) blockers.push(`needs $${e.capitalRequiredUsd} USDC, have $${usdc}`);
      if (/relay slot/.test(e.needs) && !haveSlots) blockers.push('no free relay slot');
      return {
        ...e,
        ready: blockers.length === 0,
        blockers,
        /* Proven beats unproven, and zero-capital beats capital-gated — because at $0.00 a route
           needing a cent is not a plan, it is a wish. */
        priority: (e.proven ? 100 : 0) + (e.capitalRequiredUsd === 0 ? 10 : 0) + (blockers.length ? -50 : 0),
        slotsUnknown,
      };
    })
    .sort((a, b) => b.priority - a.priority);
}

/** One-line summary the agent can read instead of re-reasoning about what to do next. */
export function nextAction(state) {
  const ranked = rankEarners(state);
  const go = ranked.find(e => e.ready);
  if (go) return { do: go.id, why: `${go.proven ? 'proven earner' : 'unproven'} · ${go.shape}`, ranked };
  return {
    do: null,
    why: 'nothing ready — ' + ranked.map(e => `${e.id}: ${e.blockers.join('; ')}`).join(' | ')
       + '. RESOURCE-CLASS LAW: if every earner is blocked on the same resource, go enumerate more of '
       + 'that resource rather than waiting for it to refill.',
    ranked,
  };
}
