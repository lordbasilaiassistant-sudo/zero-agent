// phases.mjs — ZERO's progression ladder. The rules that decide what ZERO is ALLOWED to do,
// derived only from what it has DEMONSTRABLY earned.
//
// ORIGIN (Anthony, 2026-08-01, verbatim intent): "phase 0 should stay current phase until we can make
// $1/h on average. then phase 1 risks half of average per hour on things that cost gas. Phase 1 can't
// do trades realistically because gas eats up most profits, that'll be phase 2 … phase 2 will have half
// of phase 1's average earnings as riskable capital. Understand how this will tier up? Ladders? Gaming
// mechanics and progression essentially as a workflow for zero agent to loop through to progress."
//
// WHY THIS IS THE RIGHT SHAPE, not just a fun one. Three properties fall out of it for free:
//
//   1. RISK IS ALWAYS A FRACTION OF PROVEN EARNINGS, NEVER OF PRINCIPAL. ZERO started with nothing and
//      may never be funded. A budget defined as a slice of realised, already-banked profit means the
//      worst case is giving back part of what the machine itself produced. It can stall; it cannot go
//      into debt, and it can never lose money that was not first earned.
//   2. EACH RUNG UNLOCKS A MECHANISM CLASS THAT WAS UNECONOMIC ON THE ONE BELOW. Gas is a fixed floor
//      per transaction. At $0.001/h that floor eats everything, so phase 0 must be strictly gasless.
//      At $1/h a self-funded gas leg pays for itself. At $20/h a swap's gas plus slippage clears. The
//      ladder is not motivational — it is the schedule on which arithmetic stops saying no.
//   3. CAPABILITY IS ENFORCED BY DEPLOYMENT, NOT BY INTENTION. Each phase names the contracts it may
//      use, and a higher phase's contract IS NOT DEPLOYED until its gate opens. A bug in phase-1 code
//      cannot spend phase-2 money, because the phase-2 contract does not exist on chain yet.
//
// Nothing here signs, sends, or funds anything. It answers exactly one question — "what is ZERO allowed
// to do right now?" — and it answers it from measurements.

/** Hysteresis: promote at the gate, demote only after falling to 70% of it, so ZERO does not oscillate
 *  on noise. A rung is a claim about sustained capability, not about the last lucky hour. */
export const DEMOTE_RATIO = 0.7;

/** A promotion must be EARNED over time, not in one spike. The trailing rate has to clear the gate for
 *  this many hours before the rung opens. One fat harvest must never unlock real capital. */
export const SUSTAIN_HOURS = 48;

/** Measurement window for the trailing rate. Long enough to survive a quiet night, short enough to
 *  notice a rail dying. */
export const WINDOW_HOURS = 168; // 7 days

export const PHASES = [
  {
    id: 0,
    name: 'PHASE 0 — free money only',
    gateUsdPerHour: 0,          // where everyone starts
    nextGateUsdPerHour: 1,      // Anthony's number: $1/h average opens phase 1
    riskFractionOfHourly: 0,    // structurally zero: nothing may be spent, ever
    capabilities: [
      'gasless-bounty-calls',   // harvest()/claim() reached through sponsored relay or meta-tx
      'unlimited-simulation',   // eth_call costs nothing and is therefore always allowed
      'discovery',              // enumerate chains, contracts, mechanism classes
      'batched-execution',      // ZeroHarvester: many attempts per scarce relay slot
    ],
    contracts: ['ZeroHarvester'],
    forbidden: [
      'spending gas from ZERO\'s own balance',
      'token approvals',
      'holding inventory',
      'swaps or trades of any kind',
    ],
    note:
      'The rung that proved the thesis: $0.08447 earned from a wallet that has never been funded. It ' +
      'is not a waiting room — it runs forever and should keep growing after the higher rungs open, ' +
      'because free money never stops being the best kind.',
  },
  {
    id: 1,
    name: 'PHASE 1 — self-funded gas',
    gateUsdPerHour: 1,
    nextGateUsdPerHour: 20,
    riskFractionOfHourly: 0.5,  // may spend up to half of the trailing hourly rate, per hour
    capabilities: [
      'all of phase 0',
      'self-funded-gas',        // ZERO may pay its own gas for calls that clear the floor
      'wider-target-set',       // targets that were unreachable while strictly gasless
    ],
    contracts: ['ZeroHarvester'],
    forbidden: [
      'swaps or trades',        // Anthony: gas eats most of the profit at this size — correct
      'holding inventory beyond one transaction',
      'any position that can lose value while held',
    ],
    note:
      'The first rung where ZERO spends. Every spend is bounded by a fraction of what it has already ' +
      'earned, so the downside is a slower month, never a hole.',
  },
  {
    id: 2,
    name: 'PHASE 2 — capital at work',
    gateUsdPerHour: 20,
    nextGateUsdPerHour: 400,
    riskFractionOfHourly: 0.5,
    capabilities: [
      'all of phase 1',
      'swaps-with-slippage-guards',
      'brief-inventory',        // hold a token across steps of one strategy
      'multi-step-atomic-strategies',
    ],
    contracts: ['ZeroHarvester', 'ZeroTrader'],   // ZeroTrader is NOT written or deployed yet, by design
    forbidden: [
      'leverage',
      'positions held across days',
      'any single action risking more than the hourly budget',
    ],
    note:
      'The rung where trades finally clear gas plus slippage. Requires a new contract with a much ' +
      'larger attack surface (approvals, swap routers), which is exactly why it must not exist on ' +
      'chain until the gate opens.',
  },
  {
    id: 3,
    name: 'PHASE 3 — positions',
    gateUsdPerHour: 400,
    nextGateUsdPerHour: 8000,
    riskFractionOfHourly: 0.5,
    capabilities: ['all of phase 2', 'held-positions', 'lending-and-lp', 'cross-chain-routing'],
    contracts: ['ZeroHarvester', 'ZeroTrader', 'ZeroPositions'],
    forbidden: ['leverage above 1x', 'any position without an on-chain unwind path'],
    note: 'Speculative rung. Its rules get rewritten from evidence when phase 2 is actually running.',
  },
  {
    id: 4,
    name: 'PHASE 4 — the number Anthony named',
    gateUsdPerHour: 8000,
    nextGateUsdPerHour: null,
    riskFractionOfHourly: 0.5,
    capabilities: ['all of phase 3', 'whatever the census surfaced by then'],
    contracts: ['(unknown — by construction)'],
    forbidden: ['nothing yet defined; this rung is honest about being unwritten'],
    note:
      'Anthony\'s $10,000/hour. Stated as a destination, not a forecast: no mechanism we have measured ' +
      'reaches it, and getting there requires a mechanism CLASS we do not yet own — which is precisely ' +
      'what the skeleton-key census (issue #137) exists to find. The ladder\'s job is to make sure that ' +
      'if such a class is ever found, ZERO is already solvent, already disciplined, and already allowed.',
  },
];

/**
 * Compute ZERO's trailing earnings rate.
 * @param {{at:string|number|Date, usd:number}[]} events  realised earnings, each with a timestamp
 * @param {number} nowMs
 * @param {number} windowHours
 * @returns {{usdPerHour:number, usdInWindow:number, events:number, windowHours:number}}
 */
export function trailingRate(events, nowMs = Date.now(), windowHours = WINDOW_HOURS) {
  const cutoff = nowMs - windowHours * 3600_000;
  let usd = 0;
  let n = 0;
  for (const e of events || []) {
    const t = new Date(e.at).getTime();
    if (Number.isFinite(t) && t >= cutoff && t <= nowMs) {
      usd += Number(e.usd) || 0;
      n++;
    }
  }
  // Always divide by the FULL window, never by "time since first event". Dividing by a short elapsed
  // window is how a single harvest in the last five minutes turns into a $12/hour claim.
  return { usdPerHour: usd / windowHours, usdInWindow: usd, events: n, windowHours };
}

/**
 * Decide the phase ZERO is entitled to, given its measured rate and its history.
 *
 * Promotion needs the gate cleared continuously for SUSTAIN_HOURS. Demotion is immediate once the rate
 * falls below DEMOTE_RATIO of the CURRENT phase's own gate — protection reacts faster than reward,
 * which is the correct asymmetry when real money is on the line.
 *
 * @param {object} state           persisted phase state
 * @param {number} state.phase     current phase id
 * @param {number} [state.clearedSince] ms timestamp when the next gate was first cleared continuously
 * @param {number} usdPerHour      measured trailing rate
 * @param {number} [nowMs]
 */
export function evaluate(state, usdPerHour, nowMs = Date.now()) {
  const current = PHASES[Math.max(0, Math.min(state?.phase ?? 0, PHASES.length - 1))];
  const next = PHASES[current.id + 1] || null;

  // --- demotion first: safety decisions always precede opportunity decisions.
  if (current.id > 0 && usdPerHour < current.gateUsdPerHour * DEMOTE_RATIO) {
    return {
      phase: current.id - 1,
      clearedSince: null,
      changed: true,
      action: 'DEMOTE',
      reason:
        `trailing rate $${usdPerHour.toFixed(4)}/h fell below ${DEMOTE_RATIO * 100}% of this phase's ` +
        `own gate ($${current.gateUsdPerHour}/h). Dropping a rung is not failure — it is the ladder ` +
        `doing its job before the budget does damage.`,
    };
  }

  if (!next) {
    return { phase: current.id, clearedSince: state?.clearedSince ?? null, changed: false, action: 'HOLD', reason: 'top of the defined ladder' };
  }

  // --- promotion: the gate must be cleared, and cleared for long enough.
  if (usdPerHour >= next.gateUsdPerHour) {
    const since = state?.clearedSince ?? nowMs;
    const heldHours = (nowMs - since) / 3600_000;
    if (heldHours >= SUSTAIN_HOURS) {
      return {
        phase: next.id,
        clearedSince: null,
        changed: true,
        action: 'PROMOTE',
        reason:
          `held $${usdPerHour.toFixed(4)}/h ≥ $${next.gateUsdPerHour}/h for ${heldHours.toFixed(1)}h ` +
          `(need ${SUSTAIN_HOURS}h). ${next.name} unlocked.`,
      };
    }
    return {
      phase: current.id,
      clearedSince: since,
      changed: state?.clearedSince !== since,
      action: 'QUALIFYING',
      reason: `gate cleared, ${heldHours.toFixed(1)}/${SUSTAIN_HOURS}h sustained`,
    };
  }

  // Rate slipped back under the gate: the sustain clock resets. No partial credit.
  return {
    phase: current.id,
    clearedSince: null,
    changed: state?.clearedSince != null,
    action: 'HOLD',
    reason:
      `$${usdPerHour.toFixed(4)}/h of the $${next.gateUsdPerHour}/h needed for ${next.name} ` +
      `(${((usdPerHour / next.gateUsdPerHour) * 100).toFixed(2)}% of the way)`,
  };
}

/**
 * The spend budget for the current phase, in USD per hour.
 * Phase 0 returns exactly 0 — not "a small number", but the number that makes overspending impossible.
 */
export function riskBudgetUsdPerHour(phaseId, usdPerHour) {
  const p = PHASES[Math.max(0, Math.min(phaseId ?? 0, PHASES.length - 1))];
  return Math.max(0, usdPerHour) * p.riskFractionOfHourly;
}

/** Is an action permitted at this phase? Capability checks are cheap; regret is not. */
export function permits(phaseId, capability) {
  const p = PHASES[Math.max(0, Math.min(phaseId ?? 0, PHASES.length - 1))];
  if (p.forbidden.some((f) => capability.includes(f))) return false;
  if (p.capabilities.includes(capability)) return true;
  // "all of phase N" inherits everything below it.
  return p.capabilities.some((c) => c.startsWith('all of phase')) && phaseId > 0
    ? permits(phaseId - 1, capability)
    : false;
}

/** Human-readable ladder status — what ZERO prints, and what the company report reads. */
export function describe(phaseId, usdPerHour) {
  const p = PHASES[Math.max(0, Math.min(phaseId ?? 0, PHASES.length - 1))];
  const next = PHASES[p.id + 1] || null;
  const budget = riskBudgetUsdPerHour(p.id, usdPerHour);
  const lines = [
    `${p.name}`,
    `  measured   : $${usdPerHour.toFixed(6)}/h (trailing ${WINDOW_HOURS}h)`,
    `  may risk   : $${budget.toFixed(6)}/h ${p.riskFractionOfHourly === 0 ? '(zero, by construction)' : `(${p.riskFractionOfHourly * 100}% of earnings)`}`,
    `  contracts  : ${p.contracts.join(', ')}`,
  ];
  if (next) {
    const pct = next.gateUsdPerHour > 0 ? (usdPerHour / next.gateUsdPerHour) * 100 : 100;
    const mult = usdPerHour > 0 ? next.gateUsdPerHour / usdPerHour : Infinity;
    lines.push(
      `  next rung  : ${next.name} at $${next.gateUsdPerHour}/h — ${pct.toFixed(3)}% there` +
        (Number.isFinite(mult) ? ` (needs ${mult.toFixed(0)}x current rate)` : ''),
    );
  }
  return lines.join('\n');
}
