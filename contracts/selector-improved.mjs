// selector-improved.mjs — a better `extractSelectors` for ZERO's bruteforce.mjs, and the measurement
// that shaped it. Proposed patch; ZERO's source is not modified here.
//
// THE INVESTIGATION, AND HOW IT CHANGED ITS OWN CONCLUSION.
//
// ZERO recovers a contract's external interface by scanning runtime bytecode for PUSH4 (0x63) and
// taking the next four bytes (bruteforce.mjs:41). The scan steps one byte at a time and never walks
// the instruction stream, so a 0x63 inside another PUSH's immediate data — a constant, an address, a
// hash, the trailing CBOR metadata — is mistaken for an opcode and yields a function that does not
// exist. I hit precisely this defect earlier tonight in a bytecode test of my own, where a naive scan
// "found" DELEGATECALL, CREATE and CREATE2 in a contract containing none of them (all three were
// inside the 51-byte metadata trailer). So I expected to find the same bug here and fix it the same
// way: walk opcodes, step over PUSH immediates, done.
//
// MEASURED (contracts/selector-audit.mjs, real Base contracts, verified ABIs as ground truth):
//
//   contract              naive   opcode-aware   real fns found by EACH
//   StrategyRewardPool      89         80              48  /  48
//   Multicall3              21         16              10  /  10
//   WETH9                    4          2               2  /   2
//   ------------------------------------------------------------------
//   totals                 114         98        IDENTICAL RECALL, 16 fewer probes (14%)
//
// A CORRECTION I HAD TO MAKE TO MYSELF, RECORDED BECAUSE IT IS THE WHOLE LESSON. My audit first
// printed "strict MISSED 6 real selectors", and I wrote a confident rationale on top of it about
// linear walks desynchronising on optimiser jump tables and recall mattering more than precision for
// a free-probe agent. It was wrong. The audit compared the strict set against the verified ABI without
// checking whether the naive set contained those selectors either — it does not. Six Multicall3
// functions (0xd0707b67, 0xc2e047ff, 0x841a9d42, 0x966c523e, 0x3997d064, +1) and one on
// StrategyRewardPool are simply not recoverable by PUSH4 scanning AT ALL, by either method, because
// their dispatch does not emit a PUSH4 literal. Both methods find exactly the same real functions.
// The "regression" was an artefact of the measuring instrument, not a property of the thing measured.
//
// So the honest result is the plain one: opcode-aware + metadata-strip is a STRICT improvement — same
// recall, 14% fewer wasted probes — and the elaborate precision-vs-recall tradeoff I reasoned about
// never existed.
//
// WHY THIS STILL SHIPS AS RANKING RATHER THAN FILTERING. Three contracts is a small sample, and the
// desync failure mode I described is real in principle even though it did not occur here. The cost
// asymmetry is genuine and extreme: a false positive costs one slot inside a free Multicall3
// aggregate3, while a false negative hides an income source forever. Given that asymmetry, keeping the
// superset and merely ORDERING it captures the full 14% saving in practice (probe high-confidence
// first, stop when budget runs out) while making it impossible to lose a function to a walker bug on
// some contract shape not in the sample. Measured on this sample the confidence-0 tier was 0% real
// across all three contracts — 16 selectors, not one of them a genuine function.

const SKIP = new Set([
  '0x06fdde03', '0x95d89b41', '0x313ce567', '0x18160ddd', '0x70a08231', '0xdd62ed3e',
  '0x01ffc9a7', '0x8da5cb5b', '0x5c60da1b', '0x3644e515', '0x54fd4d50', '0xc45a0155',
  '0x0dfe1681', '0xd21220a7', '0x38d52e0f', '0x7dc0d1d0', '0xfc0c546a', '0x17d7de7c',
  '0xa9059cbb', '0x23b872dd', '0x095ea7b3', '0x40c10f19', '0x42966c68',
]);

/** Strip solc's CBOR metadata trailer; its final two bytes carry its own length. */
function stripMetadata(bytes) {
  if (bytes.length < 3) return bytes;
  const len = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  const end = bytes.length - 2 - len;
  if (end > 0 && end < bytes.length && (bytes[end] === 0xa2 || bytes[end] === 0xa3)) return bytes.subarray(0, end);
  return bytes;
}

/** Offsets that are genuine instruction boundaries on a linear walk. Best-effort: desynchronises on
 *  optimiser data blobs, which is exactly why it ranks rather than filters. */
function boundaryOffsets(bytes) {
  const set = new Set();
  let i = 0;
  while (i < bytes.length) {
    set.add(i);
    const op = bytes[i];
    i += op >= 0x60 && op <= 0x7f ? op - 0x5f + 1 : 1;
  }
  return set;
}

/**
 * Recover every external selector, ranked by how likely it is to be real.
 *
 * Coverage is identical to ZERO's current scan (nothing is dropped). What is added is a confidence
 * tier per selector, so a probe budget is spent on the plausible ones first:
 *
 *   2 = at an instruction boundary, inside the code region      (almost certainly a real function)
 *   1 = at an instruction boundary, but inside the metadata blob (very unlikely; metadata is data)
 *   0 = not at any boundary the walk found                       (phantom, OR a real selector the
 *                                                                 walk desynchronised past — both
 *                                                                 happen, so it is probed, just last)
 *
 * @returns {{selector:string, confidence:0|1|2}[]} sorted by confidence, then by selector
 */
export function extractSelectorsRanked(code) {
  if (!code || code.length < 10) return [];
  const bytes = Buffer.from(code.replace(/^0x/, ''), 'hex');
  const codeOnly = stripMetadata(bytes);
  const boundaries = boundaryOffsets(codeOnly);

  const seen = new Map(); // selector -> best confidence
  for (let i = 0; i + 5 <= bytes.length; i++) {
    if (bytes[i] !== 0x63) continue;
    const sel = '0x' + bytes.subarray(i + 1, i + 5).toString('hex');
    if (/^0x0{4,}/.test(sel) || SKIP.has(sel)) continue;

    const inCode = i < codeOnly.length;
    const conf = boundaries.has(i) ? (inCode ? 2 : 1) : 0;
    if (!seen.has(sel) || seen.get(sel) < conf) seen.set(sel, conf);
  }

  return [...seen.entries()]
    .map(([selector, confidence]) => ({ selector, confidence }))
    .sort((a, b) => b.confidence - a.confidence || a.selector.localeCompare(b.selector));
}

/** Drop-in for the current call site: same superset, now in probe-first order. */
export function extractSelectors(code) {
  return extractSelectorsRanked(code).map((x) => x.selector);
}
