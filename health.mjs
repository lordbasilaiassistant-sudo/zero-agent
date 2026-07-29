// health.mjs — is ZERO actually working, or has it quietly stopped?
//
// This exists because "quietly stopped" is the failure mode that actually happens, and it is
// invisible unless something explicitly looks for it. Real examples from this project:
//   * 12 consecutive sessions ended at the round limit having earned nothing and written nothing.
//     Every dashboard read "running". Nothing was running that mattered.
//   * Gnosis and Polygon sat at a full 5/5 relay budget for the entire life of the project while the
//     agent reported itself blocked on exhausted slots. Idle capacity looks identical to no capacity
//     unless you measure the difference.
//   * 39 sessions reported broke:true while holding money.
//
// So the dashboard must not answer "is it up". It must answer "is it PROGRESSING, and if not, which
// specific lever is stuck". Every state below names the lever and the action.
//
// Stall is defined against the things that can actually move: money in, capacity used, backlog
// shrinking, sessions producing something new.

export const STALL = {
  earningStaleHours: 12,     // no new money in this long, with capacity free, is a stall
  barrenSessionsAlarm: 3,    // sessions in a row that added nothing new
  idleSlotAlarm: 3,          // free relay slots sitting unspent
};

export function diagnose({ earnings, relay, prospect, meta, harvest }) {
  const now = Date.now();
  const signals = [];

  // ── capacity: free slots that nobody is spending is the cheapest possible waste ──
  // FREE is not the same as USABLE, and conflating them overstates capacity. Gnosis sits at a full
  // 5/5 but Beefy has zero active vaults there, so those five slots cannot be spent on a harvest —
  // reporting "8 free slots" when only 3 can actually be used is the same species of overstatement as
  // pricing WPOL as ETH. Report both, and drive the diagnosis off the usable number.
  const work = harvest?.chainWork || null;
  const chains = (relay?.chains || []).map(c => ({
    ...c,
    work: work ? (work[c.name] ?? null) : null,
    usable: work && work[c.name] === 0 ? 0 : (c.remaining || 0),
  }));
  const freeSlots = chains.reduce((n, c) => n + (c.remaining || 0), 0);
  const usableSlots = chains.reduce((n, c) => n + (c.usable || 0), 0);
  const totalSlots = chains.reduce((n, c) => n + (c.limit || 0), 0);
  const idleChains = chains.filter(c => (c.usable || 0) > 0);
  const deadChains = chains.filter(c => (c.remaining || 0) > 0 && c.work === 0);

  // ── money: when did value last actually arrive? ──
  const lastWin = (harvest?.log || []).find(l => l.wei_earned && BigInt(l.wei_earned || '0') > 0n);
  const hoursSinceEarning = lastWin ? (now - Date.parse(lastWin.at)) / 3600000 : null;

  // ── backlog: is the prospector still chewing, or has it finished/died? ──
  const queued = prospect?.grind?.still_queued ?? null;
  const proven = prospect?.grind?.PROVEN_PAYING ?? 0;
  const lastProspect = prospect?.grind?.last ? (now - Date.parse(prospect.grind.last)) / 3600000 : null;

  // ── sessions: are they producing anything new? ──
  const barren = Number(meta?.barrenStreak || 0);
  const lastSession = meta?.lastSession ? (now - Date.parse(meta.lastSession)) / 3600000 : null;

  let state = 'EARNING';
  let headline = 'Working. Money is arriving and capacity is being spent.';
  let action = null;

  if (usableSlots >= STALL.idleSlotAlarm && hoursSinceEarning !== null && hoursSinceEarning > 1) {
    state = 'IDLE CAPACITY';
    headline = `${freeSlots} free relay slots are sitting unspent on ${idleChains.map(c => c.name).join(', ')}.`;
    action = 'Slots expire worthless. Spend them on a proven payer, or on the WETH→ETH conversion if the Safe is above threshold.';
    signals.push('idle-capacity');
  }
  if (usableSlots === 0 && totalSlots > 0) {
    state = 'CAPACITY EXHAUSTED';
    headline = freeSlots > 0 ? `${freeSlots} slots are free but ALL of them are on chains with nothing harvestable (${deadChains.map(c => c.name).join(', ')}).` : 'Every relay slot on every configured chain is spent.';
    action = 'Not a wall — a prompt to ENUMERATE. Gnosis and Polygon were found sitting at 5/5 exactly this way. Check whether another sponsored chain exists that is not yet configured, or use a permissionless paymaster.';
    signals.push('no-capacity');
  }
  if (hoursSinceEarning !== null && hoursSinceEarning > STALL.earningStaleHours) {
    state = 'STALLED';
    headline = `No value has arrived in ${hoursSinceEarning.toFixed(1)} hours.`;
    action = usableSlots > 0
      ? 'Capacity IS available, so the block is target selection, not gas. Work the proven-paying queue.'
      : 'No capacity and no income. Find another sponsor or another chain — enumerate, do not wait.';
    signals.push('no-income');
  }
  if (barren >= STALL.barrenSessionsAlarm) {
    state = 'STALLED';
    headline = `${barren} sessions in a row produced nothing new.`;
    action = 'The agent is re-deriving instead of acting. It needs a NEW action class, not another attempt at the same one — push it at the frontier hypotheses or an untested contract family.';
    signals.push('barren-sessions');
  }
  if (lastProspect !== null && lastProspect > 2 && queued > 0) {
    signals.push('prospector-stopped');
    if (state === 'EARNING') {
      state = 'DEGRADED';
      headline = `Prospector has not run in ${lastProspect.toFixed(1)}h with ${queued} candidates still queued.`;
      action = 'The automatic triage loop is the thing that finds new streams. Check the cron.';
    }
  }
  if (lastSession !== null && lastSession > 2) {
    signals.push('sessions-stopped');
    if (state === 'EARNING') {
      state = 'DEGRADED';
      headline = `No agent session has completed in ${lastSession.toFixed(1)} hours.`;
      action = 'Check the Worker cron and the GLM key.';
    }
  }
  if (state === 'EARNING' && hoursSinceEarning === null) {
    state = 'NO INCOME YET';
    headline = 'Nothing has ever been earned.';
    action = 'Work the proven-paying queue.';
  }

  // What would move the needle most, right now — one thing, named.
  const nextMove = usableSlots > 0 && proven > 0
    ? `Spend a free slot on one of the ${proven} contracts already proven to pay callers.`
    : usableSlots > 0
      ? 'Capacity is free but nothing is proven to pay yet — run the prospector queue down.'
      : queued > 0
        ? `No capacity. ${queued} candidates still to triage (free, needs no slots) — keep grinding while waiting.`
        : 'No capacity and an empty queue — expand: another chain, another sponsor, another mechanism class.';

  return {
    state,
    headline,
    action,
    signals,
    next_move: nextMove,
    capacity: { free: freeSlots, usable: usableSlots, total: totalSlots, chains, dead_chains: deadChains.map(c => c.name) },
    hours_since_earning: hoursSinceEarning === null ? null : +hoursSinceEarning.toFixed(2),
    barren_streak: barren,
    hours_since_session: lastSession === null ? null : +lastSession.toFixed(2),
    queue_remaining: queued,
    proven_payers: proven,
  };
}
