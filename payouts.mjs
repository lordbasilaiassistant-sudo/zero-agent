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
//   * strongest — the same address that sent the transaction in (msg.sender got paid), even if that
//                 sender is a Safe (a contract). Skipping `to.is_contract` unconditionally called our
//                 own harvest rail PAYS_ZERO the moment keepers (and ZERO) took fees at a smart account.
//   * accepted  — an address the caller NAMED in calldata (`harvest(callFeeRecipient)`). That recipient
//                 is often a Safe. Protocol fee sinks (beefyFeeRecipient, PrizePool, …) are NOT in
//                 calldata and stay plumbing.
// Value moving to another CONTRACT the caller did not name is ignored: that is protocol plumbing.
// Exactly what PoolTogether does (reserve → DrawManager → PrizePool → next draw).
//
// ⚠️ A FAILED EXPLORER READ IS NOT PAYS_ZERO. Empty bodies and HTTP 500s used to decode as "we saw
// calls and nobody got paid" and prospect.mjs retired the candidate. Unmeasured ≠ proven-zero.

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
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

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

/** Pull 20-byte addresses out of ABI-encoded calldata (skip the 4-byte selector). */
export function addressesFromInput(raw) {
  const s = String(raw || '').replace(/^0x/i, '');
  const out = [];
  for (let i = 8; i + 64 <= s.length; i += 64) {
    const word = s.slice(i, i + 64);
    if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) continue;
    const a = '0x' + word.slice(24);
    if (a !== ZERO_ADDR) out.push(a);
  }
  return out;
}

export function namedFromTx(t) {
  const out = [];
  const params = t?.decoded_input?.parameters;
  if (Array.isArray(params)) {
    for (const p of params) {
      const v = p?.value;
      if (typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v) && lc(v) !== ZERO_ADDR) out.push(v);
    }
  }
  out.push(...addressesFromInput(t?.raw_input || t?.hex || t?.input));
  return out;
}

/**
 * Grade value movements for one call. Pure — the explorer I/O lives in payoutHistory so this can
 * be tested offline against the defects that actually fired.
 */
export function collectPayouts({ contract, caller, moves, named = [] }) {
  const C = lc(contract);
  const callerLc = lc(caller);
  const namedSet = new Set((named || []).map(lc));
  const senders = new Set((moves || []).map(m => lc(m.from)));
  const paid = [];
  for (const m of moves || []) {
    const from = lc(m.from);
    const to = lc(m.to);
    if (from !== C) continue;
    if (!to || to === C) continue;
    if (to === ZERO_ADDR) continue;
    if (m.amount === null) continue;
    if (senders.has(to)) continue;
    const toCaller = to === callerLc;
    const namedByCaller = namedSet.has(to);
    if (m.toIsContract && !toCaller && !namedByCaller) continue;
    paid.push({
      paid_to: m.toRaw || m.to,
      beneficiary: toCaller ? 'caller' : 'named-recipient',
      amount: m.amount, token: m.token,
    });
  }
  return paid;
}

function readJson(res, label) {
  const status = res?.status;
  if (typeof status === 'number' && (status < 200 || status >= 300)) {
    return { ok: false, error: `${label} http ${status}` };
  }
  try {
    return { ok: true, json: JSON.parse(res.text) };
  } catch {
    return { ok: false, error: `${label} unparseable body` };
  }
}

function moveFromToken(x) {
  return {
    from: lc(x.from?.hash), to: lc(x.to?.hash), toRaw: x.to?.hash,
    toIsContract: !!x.to?.is_contract, toName: x.to?.name || null,
    amount: fmt(x.total?.value, x.total?.decimals), token: x.token?.symbol || 'ERC20',
  };
}
function moveFromInternal(x) {
  if (!(BigInt(x.value || '0') > 0n)) return null;
  return {
    from: lc(x.from?.hash), to: lc(x.to?.hash), toRaw: x.to?.hash,
    toIsContract: !!x.to?.is_contract, toName: x.to?.name || null,
    amount: fmt(x.value, 18), token: 'native',
  };
}

/**
 * Read settled payouts out of a contract's own history.
 * Costs zero relay slots and no capital — it is pure explorer reads.
 *
 * @returns {{verdict:'PAYS_CALLERS'|'PAYS_ZERO'|'NO_EVIDENCE', ...}}
 *   PAYS_CALLERS — at least one caller provably received value from the contract. Amounts included.
 *   PAYS_ZERO    — callers were observed calling it, transfers decoded, and NONE of them received anything. Do not spend.
 *   NO_EVIDENCE  — nothing callable observed in recent history; unknown, treat as unproven.
 * Throws if the explorer read failed — a 500 is not a zero.
 */
export async function payoutHistory(fetcher, { chain = 'base', contract, sample = 6 }) {
  const scout = SCOUT[chain];
  if (!scout) throw new Error(`no explorer for chain "${chain}" — valid: ${Object.keys(SCOUT).join(', ')}`);
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(contract || ''))) throw new Error('contract must be a 0x address');
  const C = lc(contract);

  const txsRes = await fetcher(`${scout}/api/v2/addresses/${contract}/transactions?filter=to`);
  const txsBody = readJson(txsRes, 'transactions');
  if (!txsBody.ok) throw new Error(`explorer read failed (${txsBody.error}) — unmeasured, not PAYS_ZERO`);
  const txs = txsBody.json.items || [];
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
  let decoded = 0;
  const readErrors = [];

  for (const t of calls.slice(0, n)) {
    checked++;
    const caller = lc(t.from?.hash);
    callers.add(caller);
    const named = namedFromTx(t);
    const moves = [];
    let tokenOk = false, internOk = false;

    const tokenRes = await fetcher(`${scout}/api/v2/transactions/${t.hash}/token-transfers`);
    const tokenBody = readJson(tokenRes, 'token-transfers');
    if (tokenBody.ok) {
      tokenOk = true;
      for (const x of (tokenBody.json.items || [])) {
        try { moves.push(moveFromToken(x)); } catch { continue; }
      }
    } else {
      readErrors.push(`${t.hash.slice(0, 10)} ${tokenBody.error}`);
    }

    const internRes = await fetcher(`${scout}/api/v2/transactions/${t.hash}/internal-transactions`);
    const internBody = readJson(internRes, 'internal-transactions');
    if (internBody.ok) {
      internOk = true;
      for (const x of (internBody.json.items || [])) {
        try { const m = moveFromInternal(x); if (m) moves.push(m); } catch { continue; }
      }
    } else {
      readErrors.push(`${t.hash.slice(0, 10)} ${internBody.error}`);
    }

    if (!(tokenOk || internOk)) continue;
    const rows = collectPayouts({ contract: C, caller, moves, named });
    if (rows.length) {
      decoded++;
      for (const row of rows) paid.push({ tx: t.hash, method: t.method, ...row });
      continue;
    }
    // An empty token-transfer list is evidence of zero. A missing token-transfer list is not —
    // Beefy pays WETH, so a 500 on that endpoint plus an empty internal list used to read PAYS_ZERO.
    if (tokenOk) decoded++;
  }

  if (decoded === 0) {
    throw new Error(`explorer read failed on every sampled tx (${readErrors.slice(0, 3).join('; ') || 'no bodies'}) — unmeasured, not PAYS_ZERO`);
  }

  if (paid.length) {
    const toCaller = paid.filter(p => p.beneficiary === 'caller');
    return {
      verdict: 'PAYS_CALLERS', chain, contract, checked, decoded,
      distinct_callers: callers.size,
      settled_payouts: paid.slice(0, 8),
      caller_obtainable: toCaller.slice(0, 8),
      size_expectation_on: toCaller.length
        ? `${toCaller[0].amount} ${toCaller[0].token}`
        : 'NOTHING — no line in this history went to the address that made the call. Every amount above went to a recipient the caller named (often a Safe). DO NOT size a slot on protocol fee-sink lines.',
      note: 'REAL settled payouts. Size your expectation on caller_obtainable — never on a getter, never on hardcoded protocol sinks.',
    };
  }

  return {
    verdict: 'PAYS_ZERO', chain, contract, checked, decoded,
    distinct_callers: callers.size,
    methods_seen: [...new Set(calls.slice(0, n).map(t => t.method))].slice(0, 6),
    note: `${decoded} successful calls had their transfers decoded and NOT ONE caller, nor any address they named, received value from this contract. Whatever its reward getters say, it does not pay callers — the value moves between the protocol's own components. DO NOT spend a relay slot here. This is the same trap as callReward() and maxRewards().`,
  };
}
