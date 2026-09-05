// surface-ledger.mjs — the structural cure for grinding the familiar surface (2026-09-05).
//
// WHY THIS FILE EXISTS. earners.mjs already carried the right instruction — "Grind the coldest
// surface, not the familiar one... 'we found it once' is not a reason to keep looking only there" —
// and on 2026-09-05 an entire session was spent inside ONE surface anyway (unclaimed-fees: harvest
// fees, claim fees, Curve fee sweeps), which is the same surface ZERO has ground 24/7 for 1,004
// sessions and 372 known payers. The instruction was read and ignored, twice, by the same agent that
// was editing the file containing it.
//
// So the instruction is not the control surface. This project's own doctrine already says why:
// CAPABILITY IS ENFORCED BY DEPLOYMENT, NOT BY INTENTION (phases.mjs). A rule that depends on the
// agent choosing to obey it is decoration. This makes the choice unavailable instead.
//
// THE FAILURE MODE IT BLOCKS, stated precisely so the guard can be aimed at it. The pull toward
// harvest is not laziness — it is that harvest is the ONLY surface with a proven earner, so it is the
// only one that returns hits quickly. Fast positive feedback reads as progress. But the feedback is
// fast BECAUSE the seam is worked out: a sweep there reliably returns "368 routes paying now" and
// reliably returns zero that clear the gate. Response rate gets mistaken for yield.
//
// TWO RULES, both aimed at that specific confusion:
//
//   1. EFFORT IS NOT EVIDENCE. A surface's record counts SETTLED DOLLARS and TX HASHES, never scans,
//      never candidates found, never "approaches tried". Those are all things the agent can generate
//      at will, which makes them exactly the wrong scoreboard — on 2026-09-05 the agent reported an
//      approach count back to its operator as though it were a deliverable.
//   2. NO SECONDS UNTIL EVERYONE HAS EATEN. While any surface is UNTRIED, a tried surface cannot be
//      returned as the next one to grind. This is the rule that would actually have stopped the
//      session, because it removes the option rather than advising against it.
//
// Pure functions, no I/O. The caller owns persistence.

/** A surface that has been scanned this many times with a real sample and still settled $0 is done. */
export const EXHAUST_SCANS = 3;
export const EXHAUST_MIN_CONTRACTS = 200;

/**
 * @typedef {{scans:number, contracts:number, payersFound:number, settledUsd:number,
 *            txHashes:string[], firstAt:string|null, lastAt:string|null}} SurfaceRecord
 */

export function emptyRecord() {
  return { scans: 0, contracts: 0, payersFound: 0, settledUsd: 0, txHashes: [], firstAt: null, lastAt: null };
}

/**
 * Record a scan. NOTE what is and is not accepted: `settledUsd` may only be advanced by passing
 * `txHashes`, because a dollar with no transaction behind it is a claim, not income (MEMORY LAW).
 */
export function recordScan(ledger, id, { contracts = 0, payersFound = 0, settledUsd = 0, txHashes = [], at = new Date().toISOString() } = {}) {
  const next = { ...(ledger || {}) };
  const r = { ...emptyRecord(), ...(next[id] || {}) };
  r.scans += 1;
  r.contracts += Number(contracts) || 0;
  r.payersFound += Number(payersFound) || 0;
  const hashes = (txHashes || []).filter((h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h));
  // A settled figure without a tx hash is refused outright rather than quietly zeroed, so the
  // caller cannot accidentally book optimism as income.
  if (Number(settledUsd) > 0 && !hashes.length) {
    throw new Error(`surface-ledger: settledUsd ${settledUsd} for "${id}" has no tx hash — evidence or it is a hypothesis`);
  }
  r.settledUsd += Number(settledUsd) || 0;
  r.txHashes = [...new Set([...(r.txHashes || []), ...hashes])];
  r.firstAt = r.firstAt || at;
  r.lastAt = at;
  next[id] = r;
  return next;
}

/** UNTRIED · OPEN (tried, still worth returning to) · EXHAUSTED (really looked, really paid nothing). */
export function surfaceVerdict(rec) {
  const r = { ...emptyRecord(), ...(rec || {}) };
  if (r.scans === 0) return 'UNTRIED';
  if (r.settledUsd > 0) return 'OPEN';
  if (r.scans >= EXHAUST_SCANS && r.contracts >= EXHAUST_MIN_CONTRACTS) return 'EXHAUSTED';
  return 'OPEN';
}

/**
 * Which surface may be worked next.
 *
 * THE GATE: while ANY surface is UNTRIED, only an UNTRIED surface may be returned. This is the whole
 * point of the file. It is not a preference or a ranking nudge — a tried surface is not an available
 * answer, so "just one more sweep of the familiar one" cannot be chosen.
 *
 * @param {{id:string}[]} surfaces  the catalogue (earners.mjs DISCOVERY_SURFACES)
 * @param {Record<string,SurfaceRecord>} ledger
 */
export function nextSurface(surfaces, ledger = {}) {
  const rows = (surfaces || []).map((s) => {
    const rec = { ...emptyRecord(), ...(ledger[s.id] || {}) };
    return { ...s, ...rec, verdict: surfaceVerdict(rec) };
  });
  const untried = rows.filter((r) => r.verdict === 'UNTRIED');
  const eligible = untried.length ? untried : rows.filter((r) => r.verdict !== 'EXHAUSTED');
  // Among eligible, coldest first: fewest scans, then oldest touch.
  eligible.sort((a, b) => (a.scans - b.scans) || (Date.parse(a.lastAt || 0) - Date.parse(b.lastAt || 0)));
  return {
    surface: eligible[0] || null,
    gate: untried.length
      ? `${untried.length} surface(s) never tried — a tried surface is NOT an available answer until they are`
      : 'every surface has been tried at least once; returning the coldest non-exhausted one',
    blocked: untried.length ? rows.filter((r) => r.verdict !== 'UNTRIED').map((r) => r.id) : [],
    rows,
  };
}

/**
 * The only honest scoreboard. Deliberately does NOT expose scans or approach counts as a headline —
 * an agent reporting "40 approaches tried" is reporting its own effort, which it can manufacture, and
 * on 2026-09-05 that is exactly what happened.
 */
export function scoreboard(surfaces, ledger = {}) {
  const rows = (surfaces || []).map((s) => {
    const rec = { ...emptyRecord(), ...(ledger[s.id] || {}) };
    return { id: s.id, verdict: surfaceVerdict(rec), settledUsd: +(rec.settledUsd || 0).toFixed(6), txs: (rec.txHashes || []).length, scans: rec.scans };
  });
  const settled = rows.reduce((t, r) => t + r.settledUsd, 0);
  const txs = rows.reduce((t, r) => t + r.txs, 0);
  return {
    settled_usd: +settled.toFixed(6),
    settled_txs: txs,
    surfaces_untried: rows.filter((r) => r.verdict === 'UNTRIED').length,
    surfaces_exhausted: rows.filter((r) => r.verdict === 'EXHAUSTED').length,
    rows,
    reading: txs === 0
      ? 'ZERO settled transactions from surface work. Scans are not income; a session with many scans '
        + 'and no tx hash produced nothing, however much was measured.'
      : `${txs} settled transaction(s) across the surfaces.`,
  };
}
