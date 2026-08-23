// payouts.mjs — the cap-vs-realized law, enforced in code.
//
// WHY THIS EXISTS: twice a reward getter has read as dollars and paid ~nothing.
//   * Beefy `callReward()` read $615.54 → paid $0.0001 (overstatement 8,527,792x)
//   * PoolTogether `maxRewards()` read $63.24 → paid $0.00 (six consecutive draws, reward=0)
// A getter named like a reward is a CAP, A QUOTE, OR AN ACCOUNTING ARTIFACT. It is never evidence that
// a caller was paid. The only evidence is a SETTLED payout: value that actually left the contract and
// landed on somebody who called it.
//
// So: before a scarce relay slot is spent on a first-time contract, read history and answer one
// question — "has this thing ever paid an arbitrary caller, and how much?" That read is free.
//
// The test counts a payout only when value leaves the contract toward a REAL BENEFICIARY:
//   * strongest — the same address that sent the transaction in (msg.sender got paid), or
//   * accepted  — any externally-owned account (a fee recipient the caller named; Beefy's
//                 `harvest(address callFeeRecipient)` pays a named EOA, not msg.sender, so a
//                 caller-only test would wrongly call our own proven bread-and-butter route dead).
// Value moving to another CONTRACT is ignored: that is protocol plumbing, not a caller fee. Exactly
// what PoolTogether does (reserve → DrawManager → PrizePool → next draw) — it looked like a $63
// reward in a getter and is worth zero to a caller.

const SCOUT = {
  base: 'https://base.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  gnosis: 'https://gnosis.blockscout.com',
  polygon: 'https://polygon.blockscout.com',
  unichain: 'https://unichain.blockscout.com',
  'base-sepolia': 'https://base-sepolia.blockscout.com',
};

const lc = (s) => String(s || '').toLowerCase();
// F10 FIX: `Number(0) || 18` === 18 — a 0-decimal token was divided by 1e18 and read as zero
// (under-reported by 10^18). Use null checks, not falsiness, and never invent a number when there
// is no value (ERC-721 transfers carry total:{token_id} and NO total.value — this used to return
// the string "undefined" into settled_payouts).
const fmt = (raw, dec) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const D = (dec === undefined || dec === null || dec === '') ? 18 : Number(dec);
  try {
    if (!Number.isInteger(D) || D < 0 || D > 36) return null;
    const d = BigInt(10) ** BigInt(D);
    const v = BigInt(raw);
    const whole = v / d;
    const frac = D === 0 ? '' : (v % d).toString().padStart(D, '0').slice(0, 8).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch { return null; }
};

/**
 * Read settled payouts out of a contract's own history.
 * Costs zero relay slots and no capital — it is pure explorer reads.
 *
 * @returns {{verdict:'PAYS_CALLERS'|'PAYS_ZERO'|'NO_EVIDENCE', ...}}
 *   PAYS_CALLERS — at least one caller provably received value from the contract. Amounts included.
 *   PAYS_ZERO    — callers were observed calling it, and NONE of them received anything. Do not spend.
 *   NO_EVIDENCE  — nothing callable observed in recent history; unknown, treat as unproven.
 */
export async function payoutHistory(fetcher, { chain = 'base', contract, sample = 6 }) {
  const scout = SCOUT[chain];
  if (!scout) throw new Error(`no explorer for chain "${chain}" — valid: ${Object.keys(SCOUT).join(', ')}`);
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(contract || ''))) throw new Error('contract must be a 0x address');
  const C = lc(contract);

  const txsRes = await fetcher(`${scout}/api/v2/addresses/${contract}/transactions?filter=to`);
  let txs = [];
  try { txs = JSON.parse(txsRes.text).items || []; } catch { /* empty */ }
  // Only successful state-changing calls can have paid anybody.
  const calls = txs.filter(t => t.status === 'ok' && t.method && lc(t.from?.hash) !== C);
  if (!calls.length) {
    return {
      verdict: 'NO_EVIDENCE', chain, contract,
      checked: 0,
      reason: 'no successful external calls found in recent history — nothing to learn from. Unproven, not proven-good.',
    };
  }

  const n = Math.max(1, Math.min(Number(sample) || 6, 10));
  const paid = [];
  const callers = new Set();
  let checked = 0;

  for (const t of calls.slice(0, n)) {
    checked++;
    const caller = lc(t.from?.hash);
    callers.add(caller);
    // Gather every value movement in the transaction, then decide who actually KEPT something.
    const moves = [];
    try {
      const r = await fetcher(`${scout}/api/v2/transactions/${t.hash}/token-transfers`);
      for (const x of (JSON.parse(r.text).items || [])) {
        // F14 FIX: the outer try wrapped the WHOLE loop, so one unparseable item silently discarded
        // every remaining move in the transaction — including possibly the caller's own fee.
        try {
          moves.push({
            from: lc(x.from?.hash), to: lc(x.to?.hash), toRaw: x.to?.hash,
            // F2 FIX: carry what Blockscout already tells us about the recipient — a CONTRACT that
            // only receives is a fee sink, not "a fee recipient the caller named".
            toIsContract: !!x.to?.is_contract, toName: x.to?.name || null,
            amount: fmt(x.total?.value, x.total?.decimals), token: x.token?.symbol || 'ERC20',
          });
        } catch { continue; }
      }
    } catch { /* a single tx failing to decode must not poison the verdict */ }
    try {
      const r = await fetcher(`${scout}/api/v2/transactions/${t.hash}/internal-transactions`);
      for (const x of (JSON.parse(r.text).items || [])) {
        try {
          if (!(BigInt(x.value || '0') > 0n)) continue;
          moves.push({ from: lc(x.from?.hash), to: lc(x.to?.hash), toRaw: x.to?.hash,
            toIsContract: !!x.to?.is_contract, toName: x.to?.name || null,
            amount: fmt(x.value, 18), token: 'native' });
        } catch { continue; }   // F14: per-item guard — Blockscout has returned null/""/exponent forms
      }
    } catch { /* same */ }

    // Plumbing filter: an address that BOTH sent and received inside the same transaction is a hop in
    // the protocol's own circuit, not a beneficiary. This is precisely how PoolTogether recycles its
    // reserve (PrizePool → DrawManager → PrizePool) and it must not read as a caller reward. A real
    // fee recipient only ever appears on the receiving side.
    const senders = new Set(moves.map(m => m.from));
    for (const m of moves) {
      if (m.from !== C) continue;             // value must leave the contract under test
      if (!m.to || m.to === C) continue;      // self-transfers are not payouts
      if (m.to === '0x0000000000000000000000000000000000000000') continue;   // a burn is not a payout
      if (m.amount === null) continue;        // F10: no value field (ERC-721 item) is not an amount
      if (senders.has(m.to)) continue;        // round-trip hop → plumbing
      // F2 FIX — THE HEADER COMMENT'S LAW, NOW ACTUALLY ENFORCED. The comment says value moving to
      // another CONTRACT is plumbing, but nothing implemented it: an address that ONLY receives
      // (exactly what a fee sink does) was waved through as "named-recipient". Measured:
      // beefyFeeRecipient() took 899x the caller's line and strategist() 50x, overstating what a
      // caller can obtain by ~899x on every strategy tested.
      if (m.toIsContract) continue;
      paid.push({
        tx: t.hash, method: t.method, paid_to: m.toRaw,
        beneficiary: m.to === caller ? 'caller' : 'named-recipient',
        amount: m.amount, token: m.token,
      });
    }
  }

  if (paid.length) {
    // F2 FIX: only lines the CALLER received are money we could ever have. A hardcoded strategist
    // EOA is not obtainable either, so it is reported but never used to size an expectation.
    const toCaller = paid.filter(p => p.beneficiary === 'caller');
    return {
      verdict: 'PAYS_CALLERS', chain, contract, checked,
      distinct_callers: callers.size,
      settled_payouts: paid.slice(0, 8),
      caller_obtainable: toCaller.slice(0, 8),
      size_expectation_on: toCaller.length
        ? `${toCaller[0].amount} ${toCaller[0].token}`
        : 'NOTHING — no line in this history went to the address that made the call. Every amount above went to a recipient hardcoded in the contract. DO NOT size a slot on them.',
      note: 'REAL settled payouts to the address that made the call. These amounts are evidence; a reward getter is not. Size your expectation on caller_obtainable — never on a getter, never on the hardcoded-recipient lines.',
    };
  }

  return {
    verdict: 'PAYS_ZERO', chain, contract, checked,
    distinct_callers: callers.size,
    methods_seen: [...new Set(calls.slice(0, n).map(t => t.method))].slice(0, 6),
    note: `${checked} successful calls by ${callers.size} distinct caller(s) and NOT ONE of them, nor any EOA they named, received value from this contract. Whatever its reward getters say, it does not pay callers — the value moves between the protocol's own components. DO NOT spend a relay slot here. This is the same trap as callReward() and maxRewards().`,
  };
}
