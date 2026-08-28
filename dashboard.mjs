// dashboard.mjs — REFERENCE ONLY. The Worker serves dashboard2.mjs (worker.mjs import).
// Do not import this file for `/`. render-check and the public page use dashboard2.
//
// ART DIRECTION: a life-support monitor for an entity born with nothing. Void black, one signal-green
// accent, and an ECG whose amplitude IS the mission progress.
//
// The premise changed, so the page changes with it. The trace used to be a FLATLINE, because the
// balance was zero and the honest picture was a dead patient. On 2026-07-28 it earned. It has a
// heartbeat now, driven by real SETTLED harvest events — still tiny, still honest, no longer flat.
// That is the whole project in one graphic, and it must never be faked: no settled harvests, no beats.
//
// The operator's real question is not "is it up" but "is it STALLED and do I need to push it". So the
// diagnosis is the loudest element after the hero, it names the stuck lever, and it always ends on one
// concrete next move.
//
// ── THE ONE RULE THIS FILE ENFORCES (rewritten 2026-08-12) ──────────────────────────────────────────
// EVERY FIGURE CARRIES ITS PROVENANCE, RENDERED, NOT IMPLIED.
//   MEASURED       read from chain/RPC in THIS request               solid --sig left rule
//   FROZEN         a measurement taken on a stated date, not re-read --sig-dim rule + the date
//   DERIVED        arithmetic over MEASURED inputs; names its inputs hairline --dim rule
//   SELF-REPORTED  a value the GLM model typed into a tool call      --warn rule
//   UNREADABLE     a read was attempted and FAILED this request      --bad rule, renders —, never totalled
//   FORECAST       an extrapolation (refill ETA)                     dashed --warn outline
// Two consequences, both non-negotiable:
//   1. A FAILED READ MAY NEVER RENDER AS $0.000000. CLAUDE.md:120-122 names this trap and says it had
//      already fired twice; it was firing a third time, in public, on this page.
//   2. If a figure cannot be computed honestly, the page prints THE REASON, not a proxy. There is no
//      flattering substitute anywhere on this page — see the $/day tile, which refuses out loud.
//
// Chain hues are the validated categorical set for THIS surface (#0b0d0f, dark). The original five
// passed six checks. The sixth (unichain, #a06be8) was NOT allowed to inherit those numbers — the
// checks were re-run from scratch on 2026-08-12 with a CIEDE2000 + Viénot-1999 dichromat script, and
// these are the measured results, not a claim:
//   the bar set by the existing five  L∈[53.6,61] · chroma ≥47.3 · normal-vision ΔE00 ≥21.1 ·
//                                     worst-CVD ΔE00 ≥1.7 · contrast ≥4.93:1
//   unichain #a06be8                  L 55.9 · chroma 72.4 · nearest normal ΔE00 22.7 (vs base) ·
//                                     worst CVD ΔE00 2.7 (protanopia, vs base) · contrast 5.34:1 → PASS
// Rejected on the same run, recorded so nobody re-proposes them: #8b6ff0 (ΔE00 18.0 vs base),
// #7d6ef5 (15.9), #8f7ae8 (protan ΔE00 0.4 — indistinguishable from base for protanopes).
// Two more, measured because a concurrent session proposed one and a search produced the other:
//   #aa6ab0 — FAILS this bar: chroma 45.7 (floor 47.3) and normal-vision ΔE00 15.5 against gnosis
//             (floor 21.1). It is genuinely BETTER than the chosen hue on CVD separation (9.1 vs 2.7),
//             so this is a real trade-off and not a mistake on their part — it optimises the axis this
//             palette is weakest on, at the cost of the axis it is strongest on.
//   #a455ff — passes all six and beats the chosen hue on BOTH separations (25.2 / 3.3), and is still
//             rejected: chroma 96.4 against a family that runs 47.3–70.8. It is a neon violet next to
//             five muted hues. The checks are a FLOOR, not a target, and a hue can clear every number
//             while leaving the set it belongs to — which is the metric eating the thing it proxied for.
// If the palette is ever re-tuned deliberately, CVD separation is the axis to fix, and fixing it
// properly means moving more than one hue.
// HONEST CAVEAT, because the number deserves it: the palette's worst-CVD floor of 1.7 is LOW (it is set
// by the existing optimism/gnosis pair under tritanopia). The sixth hue clears the existing bar; it does
// not fix it. That is why every coloured mark on this page is ALSO directly labelled — identity is never
// colour-alone, which is the property that actually carries the accessibility load here.

const CHAINS_CONFIGURED = ['base', 'optimism', 'arbitrum', 'gnosis', 'polygon', 'unichain'];

// Wrapped-native fee token per chain. A polygon row's WPOL and a base row's WETH are DIFFERENT ASSETS
// and rendering them in the same unlabelled column is how a $0.0000076 fee once got logged as $0.20
// (harvest.mjs documents that 26,000x units bug). Every token amount on this page prints its symbol.
const CHAIN_TOKEN = {
  base: 'WETH', optimism: 'WETH', arbitrum: 'WETH', unichain: 'WETH', polygon: 'WPOL', gnosis: 'WXDAI',
};

const HUE = {
  base: '#3987e5', optimism: '#d95926', arbitrum: '#199e70',
  polygon: '#c98500', gnosis: '#d55181', unichain: '#a06be8',
};

const PROV = {
  MEASURED: { cls: 'measured', label: 'measured' },
  FROZEN: { cls: 'frozen', label: 'frozen' },
  DERIVED: { cls: 'derived', label: 'derived' },
  'SELF-REPORTED': { cls: 'self', label: 'self-reported' },
  UNREADABLE: { cls: 'unreadable', label: 'unreadable' },
  FORECAST: { cls: 'forecast', label: 'forecast' },
};

/**
 * A figure and how it was obtained. `value === null` ALWAYS means "not measured", never "zero" —
 * so a caller can never accidentally render a failed read as $0.00. A null value forces UNREADABLE
 * and requires a reason, which is the whole mechanism.
 */
function fig(kind, value, extra = {}) {
  const v = (typeof value === 'number' && Number.isFinite(value)) ? value : null;
  const k = v === null && kind !== 'UNREADABLE' && kind !== 'FORECAST' ? 'UNREADABLE' : kind;
  return { kind: k, value: v, ...extra };
}

const escHtml = (s) => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

// D11 — PRECISION MUST NOT EXCEED RESOLUTION. The old page printed toFixed(6): microdollars, off a
// price feed whose own spread moved the 4th decimal inside a single request (eth_usd 1888.99 vs
// token_usd 1891.92, same response). Six decimals asserted a precision nothing upstream possesses.
const money = (n, dp = 4) => '$' + Number(n).toFixed(dp);

// payouts.mjs:38 sliced the fraction to 8 digits, so a real 7,630,305,288-wei WETH caller fee rendered
// as the string "0" under a header asserting a payment. These are nano-ETH payouts; fixed decimals are
// below the resolution of the entire business. Significant figures instead, scientific below 1e-6.
function sig(n, digits = 4) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a < 1e-6) return v.toExponential(Math.max(0, digits - 1));
  return String(Number(v.toPrecision(digits)));
}

const scoutUrl = (c) => `https://${c}.blockscout.com`;

// ── the model ───────────────────────────────────────────────────────────────
// Everything the page prints is computed HERE, as data, so selftest.mjs can assert invariants over it
// deterministically instead of anyone eyeballing a rendered page. `buildModel` is the contract; the
// HTML below is only a projection of it.
export function buildModel(data) {
  const h = data.health || {};
  const b = data.balances || {};
  const cap = h.capacity?.chains || [];

  // ── THREE PAYLOAD SHAPES ARE IN THE WILD AND THIS FUNCTION MUST SURVIVE ALL OF THEM ──────────────
  // For a window after any deploy, the same code serves: (1) the CURRENT shape, (2) the CORRECTED shape
  // (native ETH at the EOA under `spendable_liquid_native_eth_on_base_usd`, a real `null` token_usd for
  // an unpriced chain, `holdings_breakdown`, `unpriced_chains`), and (3) an empty or degraded payload
  // when an upstream read failed. This page is the only public face of a system that transacts, so a
  // render throw is an outage. Nothing below may throw, and nothing may reach the HTML as the literal
  // string "undefined" or "NaN".
  //
  // WHAT IS DELIBERATELY NOT READ, on either shape: `spendable_usd` and `lifetime_earned_usd`. Both
  // have meant two different things across builds — `spendable_usd` was Safe-wrapped (relay-only) and
  // is now native ETH; `lifetime_earned_usd` was holdings in one place and a ledger sum in another. A
  // key whose meaning changed is exactly what must NOT be silently consumed, so this page consumes only
  // names that have meant one thing: it prefers explicit new keys, then unambiguous ones, then says so.
  const brk = (b.holdings_breakdown && typeof b.holdings_breakdown === 'object') ? b.holdings_breakdown : {};

  // ── read status. A total whose denominator can silently change is not a total. ──
  const norm = (u) => (typeof u === 'string'
    ? { chain: (u.split(/[\s:]/)[0] || 'unknown'), error: u }
    : { chain: u?.chain || 'unknown', error: u?.error || u?.reason || u?.note || 'read failed' });
  const unreadRaw = [
    ...(Array.isArray(b.unreadable) ? b.unreadable : []),
    ...(Array.isArray(data.chain_reads?.unreadable) ? data.chain_reads.unreadable : []),
    ...(Array.isArray(b.read_errors) ? b.read_errors : []),
  ].map(norm);
  // An UNPRICED chain is a distinct failure and deserves distinct words: the balance was read fine, the
  // PRICE was not, so the value is real and simply not expressible in dollars. It is excluded from every
  // dollar figure — excluded, never zeroed.
  const unpriced = (Array.isArray(b.unpriced_chains) ? b.unpriced_chains : []).map(u => ({
    ...norm(u), unpriced: true,
    error: (typeof u === 'string' ? u : (u?.error || u?.reason)) || 'balance read ok, price read failed — value is real but not expressible in dollars',
  }));
  const seen = new Set();
  const unreadable = [...unreadRaw, ...unpriced].filter(u => (seen.has(u.chain + u.error) ? false : seen.add(u.chain + u.error)));

  // ⚠️ THE TRAP, ONE LEVEL DEEPER THAN THE PAGE. `treasuryPlan` computes `price ? usd : 0`, so a chain
  // whose PRICE read failed arrives here as a clean `spendable_usd: 0` — indistinguishable from a chain
  // that holds nothing. Caught live on 2026-08-12: polygon's price feed failed while the Safe held
  // 137,891,921,968,616,923 wei of WPOL, and this page rendered "polygon $0.0000". That is the exact
  // defect this whole rewrite exists to kill, arriving through a field the page did not write.
  // So the page keeps its own list of chains it may not print a dollar figure for, and it wins over any
  // upstream number, because a zero that came from a failed read is not a measurement.
  const unpricedChains = [...new Set([
    ...unreadable.map(u => u.chain),
    ...(Array.isArray(b.all_chains_priced) ? b.all_chains_priced.filter(c => c && c.token_usd === null).map(c => c.chain) : []),
  ].filter(Boolean))];

  const readOk = num(b.chains_read_ok) ?? num(data.chain_reads?.chains_read_ok);
  const configured = num(b.chains_configured) ?? num(data.chain_reads?.chains_configured) ?? CHAINS_CONFIGURED.length;
  const readNote = readOk === null
    ? (unreadable.length
      ? `${unreadable.length} chain read${unreadable.length === 1 ? '' : 's'} failed; this build does not publish a total chain count`
      : 'this worker build does not publish per-chain read status')
    : `read ${readOk} of ${configured} chains`;

  // ── the ledger, split by who produced each number (P0.4/P0.5) ──
  // NOT retroactively edited. The classification is a RULE and the rule is printed on the page:
  //   beefy-harvest-caller-fees  → code-measured (harvest.mjs writes it from a measured balance delta)
  //   base-harvest-batch-* / manual-* / self-funded-*  → model-reported (worker.mjs:131 documents that
  //   the model invented those ids and typed the dollar figure into a route_log tool call)
  const routes = data.routes || {};
  let measuredUsd = 0, selfUsd = 0;
  const selfIds = [], measuredIds = [];
  for (const [id, r] of Object.entries(routes)) {
    const explicit = r?.provenance;
    const m = Number(r?.earned_usd_measured);
    const s = Number(r?.earned_usd_reported);
    const legacy = Number(r?.earned_usd) || 0;
    if (Number.isFinite(m) && m > 0) { measuredUsd += m; measuredIds.push(id); }
    if (Number.isFinite(s) && s > 0) { selfUsd += s; selfIds.push(id); }
    if (!Number.isFinite(m) && !Number.isFinite(s) && legacy > 0) {
      const isMeasured = explicit === 'code-measured'
        || (!explicit && /^beefy-(harvest-caller-fees|batch-)/.test(id));
      if (isMeasured) { measuredUsd += legacy; measuredIds.push(id); }
      else { selfUsd += legacy; selfIds.push(id); }
    }
  }
  measuredUsd = +measuredUsd.toFixed(6);
  selfUsd = +selfUsd.toFixed(6);

  // chain floor: nobody funds this wallet, so everything it holds was earned. That makes holdings a
  // LOWER BOUND on lifetime earnings, and it is currently HIGHER than the ledger — which means the
  // ledger is under-covering, and the page says so rather than picking whichever number flatters.
  const published = data.lifetime_earned && typeof data.lifetime_earned === 'object' ? data.lifetime_earned : null;
  // Each of these reads the explicit new key first, then the corrected key, then an unambiguous legacy
  // one, and prints its own absence rather than substituting a neighbour. `?? ` chains on num() are
  // safe: num() returns null for undefined, NaN, '' and objects.
  const holdings = num(b.holdings_usd) ?? num(b.total_holdings_usd) ?? num(b.all_chains_usd)
    ?? num(data.treasury?.total_across_all_chains_usd);
  const usdcUsd = num(b.usdc_usd) ?? num(brk.usdc_usd) ?? num(b.base_usdc);
  // DOCTRINE §11b's metric: native ETH the EOA holds. The corrected build names it in full; ours names
  // it native_liquid_usd. Both are unambiguous, so both are safe to read.
  const nativeLiquid = num(b.native_liquid_usd) ?? num(b.spendable_liquid_native_eth_on_base_usd)
    ?? num(brk.spendable_native_eth_on_base_usd);
  const chainFloor = published ? num(published.chain_floor_usd)
    : (holdings === null ? null : holdings + (usdcUsd || 0) + (nativeLiquid || 0));

  const lifetime = {
    measured: fig('MEASURED', published ? num(published.measured_usd) : measuredUsd, {
      inputs: 'route ledger, entries written by code from a measured balance delta',
      ids: measuredIds,
    }),
    self: fig('SELF-REPORTED', published ? num(published.self_reported_usd) : selfUsd, {
      inputs: 'route ledger, earned_usd typed by the model into a route_log tool call',
      ids: selfIds,
    }),
    floor: fig(chainFloor === null ? 'UNREADABLE' : (published ? 'MEASURED' : 'DERIVED'), chainFloor, {
      inputs: 'wrapped-native holdings + USDC + native ETH, all chains, each priced in its own token',
      reason: chainFloor === null ? 'no chain read succeeded this request' : undefined,
    }),
  };

  // ── DOCTRINE 11b: the scoreboard is SPENDABLE LIQUID NATIVE ETH, $0 → $1.00 ──
  // "Not total holdings. Not wrapped. Not 'in the Safe pending a relay slot'." (DOCTRINE.md:236-237)
  // And the gift, which must be on the page or the founding constraint breaks silently:
  // knowledge/genesis.md:334-338 records the operator gifting 0.0001072 ETH to the EOA on 2026-08-03 as
  // one-time test capital. Every native wei now at the EOA is residue of that gift. Printing it as
  // earned capability would be exactly the flattering proxy this file forbids, so phase 0 reads $0.0000
  // and the residue is disclosed beneath it, marked FROZEN with its date and tx.
  const GIFT = {
    at: '2026-08-03',
    eth: 0.0001072,
    usd: 0.20,
    tx: '0x1b0788648208f19a3f40387f2f4411fcd68098f7089256832b8ba6e48cd6ef43',
  };
  // EARNED native = what the EOA holds MINUS the gift, floored at zero — computed, not asserted, so the
  // moment a conversion genuinely lands the tile moves on its own instead of staying pinned at a
  // hardcoded zero. Priced at the same table as everything else on the page.
  const ethPrice = num(data.price_used?.usd) ?? num(b.prices?.base?.usd) ?? num(data.eth_usd);
  const giftUsdNow = ethPrice === null ? null : GIFT.eth * ethPrice;
  const earnedNative = (nativeLiquid === null || giftUsdNow === null)
    ? null : Math.max(0, nativeLiquid - giftUsdNow);
  const phase0 = {
    target: 1.00,
    earned: fig(earnedNative === null ? 'UNREADABLE' : 'DERIVED', earnedNative, {
      inputs: 'eth_getBalance at the EOA, minus the operator test-capital gift, floored at zero',
      reason: earnedNative === null
        ? 'native ETH at the EOA, or the ETH price, could not be read this request — so this is unknown, not zero'
        : undefined,
    }),
    residue: fig(nativeLiquid === null ? 'UNREADABLE' : 'FROZEN', nativeLiquid, {
      reason: nativeLiquid === null ? 'native balance not published by this worker build' : undefined,
      gift: GIFT,
    }),
  };

  const relaySpendable = fig(
    num(b.relay_spendable_usd) === null ? 'UNREADABLE' : 'MEASURED',
    num(b.relay_spendable_usd),
    {
      inputs: 'wrapped-native balanceOf at the Safe, every chain, priced per chain',
      reason: num(b.relay_spendable_usd) === null
        ? 'relay_spendable_usd is not published by this worker build — the old key spendable_usd was deleted rather than redefined, because a key that silently changes meaning is worse than a break'
        : undefined,
    },
  );

  const holdingsFig = fig(holdings === null ? 'UNREADABLE' : 'MEASURED', holdings, {
    inputs: `live chain read, ${readNote}`,
    reason: holdings === null ? 'no chain read succeeded this request' : undefined,
  });

  const stranded = fig(num(b.stranded_on_eoa_usd) === null ? 'UNREADABLE' : 'MEASURED', num(b.stranded_on_eoa_usd), {
    inputs: 'every asset at the EOA while it holds no gas',
  });

  // ── settled events: the only thing that may drive $/day, the ECG, or a lit phase layer ──
  const events = settledEvents(data);
  const window = trailingWindow(events, 7);
  const perDay = window.n >= 3
    ? fig('DERIVED', +(window.sum / 7).toFixed(8), {
      inputs: `${window.n} code-measured settled events in the trailing 7 days`,
      window: '7 days',
      n: window.n,
    })
    : fig('DERIVED', null, {
      refused: `not enough settled events in the window (n=${window.n})`,
      why: 'the route ledger is not an acceptable substitute — 49% of it is model-reported, so a ledger-derived rate would be a flattering proxy for a number we have not got',
      window: '7 days',
      n: window.n,
    });
  const distance = perDay.value && perDay.value > 0
    ? fig('DERIVED', +(16.66 / perDay.value).toFixed(0), { inputs: '$16.66/day house goal ÷ measured $/day' })
    : fig('DERIVED', null, { refused: 'undefined until $/day is computable' });

  // ── D7: phase layers must be able to move, and each unlit one names its own evidence ──
  // The old predicate was `has_earned || totalUsd > 0 ? 1 : 0` — it could only ever be 0 or 1, so
  // layers 1-10 were structurally unlightable, and `has_earned` is true for HOLDING, not earning, so a
  // funded wallet would light layer 0 identically to an earning one. On a page whose entire claim is
  // that it was never funded, that is the one predicate that must not be sloppy.
  const layers = [
    {
      n: 0, name: 'Free actions',
      blurb: 'Earns with no money at risk. Never stops, never needs funding — the floor that makes ruin structurally impossible.',
      lit: events.length > 0,
      evidence: events.length > 0
        ? `${events.length} settled caller fee${events.length === 1 ? '' : 's'} with a transaction hash, measured by code`
        : 'lights on: one settled caller fee with a transaction hash, written by code from a measured balance delta',
    },
    {
      n: 1, name: 'Small-capital yield',
      blurb: 'Puts the floor’s earnings to work. Funded by 0, runs forever once found.',
      lit: false,
      evidence: 'lights on: a yield position that has returned value. No such position exists and no such return is recorded anywhere in the ledger.',
    },
    {
      n: 2, name: 'Risk-capital plays',
      blurb: 'Bets that can lose — licensed by 0+1 paying regardless, and uncorrelated with the bet.',
      lit: false,
      evidence: 'lights on: a risk position opened and closed with a measured result. Deliberately unfixed (DOCTRINE §11) — naming it now would be another catalogue lookup.',
    },
    {
      n: 3, name: 'Risk / speed',
      blurb: 'Faster, larger positions resting on everything below.',
      lit: false,
      evidence: 'lights on: a position sized by the floor beneath it. Requires layers 1 and 2 to be paying first.',
    },
  ];
  const litCount = layers.filter(l => l.lit).length;

  // ── D8: "proven streams · 351" was three different numbers wearing one label ──
  const g = data.prospect?.grind || {};
  const streams = data.prospect?.streams || [];
  const streamCounts = {
    paysSomebody: fig('MEASURED', num(g.PROVEN_PAYING), {
      inputs: 'prospect.mjs:160 — contracts whose history shows value leaving to a non-plumbing recipient',
      caveat: 'payouts.mjs:113-119 returns PAYS_CALLERS for ANY such recipient, including a named recipient who never called. This count means "observed paying somebody", not "will pay us".',
    }),
    callableAndPaying: fig('DERIVED', streams.length ? streams.filter(s => (s.callable || []).length > 0).length : null, {
      inputs: 'the published stream list, filtered by callable_now being non-empty',
      caveat: 'prospect.mjs:172 claims this filter; prospect.mjs:160 does not perform it. Computed here from the published sample only, so it is a floor on a sample, not a full-corpus count.',
    }),
    paidZero: fig('MEASURED', measuredIds.length ? 1 : 0, {
      inputs: 'streams that have actually paid ZERO ITSELF: Beefy harvest caller fees, and nothing else',
      caveat: 'DOCTRINE.md:65 makes this the goal metric — COUNT OF INDEPENDENT PAYING STREAMS — and it was the one count absent from this page.',
    }),
  };

  // ── D9: the families table has two denominators and one wrong premise ──
  const famsAll = (data.prospect?.families || []).filter(f => f.pays > 0 || f.zero > 0);
  const isProxy = (f) => /proxy/i.test(String(f.family || ''));
  const families = famsAll.filter(f => !isProxy(f)).map(withProbed);
  const proxyFamilies = famsAll.filter(isProxy).map(withProbed);

  // ── D12: the verdict must read capacity, and NO INCOME YET must pick one colour ──
  const st = String(h.state || '').toUpperCase();
  const usable = num(h.capacity?.usable) ?? 0;
  const eta = data.refill_eta || null;   // {hours, chain} from P0.7
  let verdict = 'WAITING', vtone = 'warn';
  if (['STALLED', 'DEGRADED', 'BROKEN'].includes(st)) { verdict = 'BROKEN'; vtone = 'bad'; }
  else if (st === 'NO INCOME YET') { verdict = 'NO INCOME YET'; vtone = 'warn'; }
  else if (['EARNING', 'CYCLING'].includes(st)) {
    // WAITING is exactly the state this was invented for and it never fired: CYCLING with zero usable
    // slots and a known refill clock is rate-limited, not progressing. It rendered PROGRESSING/green
    // over a headline reading "No capacity and an empty queue".
    if (usable === 0 && (eta?.hours != null || h.capacity?.free >= 0)) { verdict = 'WAITING'; vtone = 'warn'; }
    else { verdict = 'PROGRESSING'; vtone = 'good'; }
  }

  return {
    verdict, vtone, state: h.state || 'UNKNOWN', headline: h.headline || '', action: h.action || '',
    nextMove: h.next_move || '',
    eta: eta ? fig('FORECAST', num(eta.hours), { chain: eta.chain, inputs: 'median observed refill gap, chains with harvestable work only' }) : null,
    lifetime, phase0, relaySpendable, holdings: holdingsFig, stranded, perDay, distance,
    usdc: fig(usdcUsd === null ? 'UNREADABLE' : 'MEASURED', usdcUsd, { inputs: 'USDC balanceOf on Base, both addresses' }),
    events, window, layers, litCount, streamCounts, streams, families, proxyFamilies,
    capacity: h.capacity || {}, cap, readOk, configured, unreadable, unpricedChains, readNote,
    price: data.price_used || (num(data.eth_usd) === null ? null : { usd: num(data.eth_usd), source: 'base.blockscout.com/api/v2/stats', at: data.measured_at || null }),
    canTransact: b.can_transact === true,
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function withProbed(f) {
  // The pay_rate denominator was invisible: prospect.mjs:156 divides by (pays + zero), which EXCLUDES
  // callable-but-unprobed instances. A reader computing 116/123 gets 0.94 while the page prints 1.
  return { ...f, probed: (f.pays || 0) + (f.zero || 0) };
}

/**
 * Settled, CODE-MEASURED earning events. The bar is deliberately high: a transaction hash exists AND a
 * positive measured balance delta exists. `relayed: true` is NOT enough — it means the relay accepted
 * the submission, not that a transaction happened, and five 08-12 base rows prove the difference.
 */
export function settledEvents(data) {
  const log = Array.isArray(data.harvest_events) ? data.harvest_events
    : Array.isArray(data.recent_harvests) ? data.recent_harvests : [];
  const out = [];
  for (const l of log) {
    let wei = 0n;
    try { wei = BigInt(l.wei_earned || '0'); } catch { wei = 0n; }
    if (!l.tx || wei <= 0n) continue;
    out.push({
      at: l.at, chain: l.chain || 'base', tx: l.tx,
      usd: num(l.earned_usd), token: num(l.eth_earned),
      symbol: CHAIN_TOKEN[l.chain] || 'wrapped native',
      batched: num(l.batched) ?? num(l.batch),
      contracts: Array.isArray(l.batched_contracts) ? l.batched_contracts : null,
    });
  }
  return out;
}

function trailingWindow(events, days) {
  const cut = Date.now() - days * 86400000;
  const inWin = events.filter(e => Date.parse(e.at) >= cut && e.usd !== null);
  return { n: inWin.length, sum: inWin.reduce((s, e) => s + e.usd, 0), days };
}

/**
 * THREE outcomes, not two. This is the single most consequential rendering fix on the page: an
 * infrastructure outage and a zero payout were rendered identically, which is the precise question
 * dashboard.mjs exists to answer. Five 08-12 base rows rendered as ordinary zero-payout attempts while
 * Gelato reported all five Cancelled / "Transaction send failed" — base's entire daily quota burned by
 * transactions that never existed, under a page that said "Slots were spent on earning."
 */
export function outcomeOf(l) {
  let wei = 0n;
  try { wei = BigInt(l.wei_earned || '0'); } catch { wei = 0n; }
  const rs = String(l.relay_state || '');
  if (rs && /cancel|fail|revert|error/i.test(rs)) {
    return { kind: 'RELAY FAILED', tone: 'bad', detail: l.relay_message || rs };
  }
  if (wei > 0n) return { kind: 'PAID', tone: 'good', detail: null };
  if (l.tx) return { kind: 'ZERO', tone: 'dim', detail: 'the transaction landed and paid nothing' };
  if (rs === 'ExecSuccess') return { kind: 'ZERO', tone: 'dim', detail: 'relay reports ExecSuccess, no payout measured' };
  // Everything before P0.6 has no terminal relay state recorded, so it genuinely cannot be classified.
  // Saying so is the honest render; guessing ZERO is what produced the false "nothing is stuck".
  return { kind: 'UNCLASSIFIED', tone: 'warn', detail: 'no terminal relay state was recorded for this attempt — it may be a zero payout or a relay that never sent a transaction. Entries written before the P0.6 fix cannot be told apart.' };
}

// ── the page ────────────────────────────────────────────────────────────────
export function dashboardHTML(data) {
  const m = buildModel(data);
  const h = data.health || {};
  const esc = escHtml;

  // A1 — STOP SHIPPING 178 KB OF DEAD PAYLOAD. The page used to embed the ENTIRE JSON (~192 KB, of
  // which D.routes alone was ~179 KB) and the client script read exactly one field out of it. The full
  // JSON already has its own content-negotiated response at `/` — that is its correct home. What the
  // client actually needs is three things, so that is what it gets.
  const VIS = {
    phase0: { usd: m.phase0.earned.value, residue: m.phase0.residue.value, target: m.phase0.target },
    events: m.events.slice(0, 40).map(e => ({ at: e.at, usd: e.usd, chain: e.chain })),
    price: m.price,
  };
  const visJson = JSON.stringify(VIS).replace(/</g, '\\u003c');

  // Normalised once, because `free - usable` on an absent field is how a payload shape change becomes
  // the literal string "NaN" on the public page.
  const capUsable = num(m.capacity.usable) ?? 0;
  const capFree = num(m.capacity.free) ?? 0;

  const provMark = (f, label) => `<span class="pv pv-${PROV[f.kind].cls}" title="${esc(label || PROV[f.kind].label)}">${esc(PROV[f.kind].label)}</span>`;

  // A figure renders as its value, or as an em-dash AND THE REASON. Never as $0.000000.
  const val = (f, fmt = (v) => money(v)) => f.value === null
    ? `<span class="nil">—</span>`
    : fmt(f.value);

  const reason = (f) => {
    const r = f.reason || f.refused;
    return r ? `<div class="why">${esc(r)}</div>` : '';
  };

  const tile = (k, f, opts = {}) => `<div class="v prov prov-${PROV[f.kind].cls}">
    <div class="k">${esc(k)}</div>
    <div class="n ${opts.tone || ''}">${val(f, opts.fmt)}${opts.suffix || ''}</div>
    <div class="sub">${provMark(f)} ${esc(f.inputs || f.window || '')}</div>
    ${reason(f)}
    ${opts.extra || ''}
  </div>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZERO — an AI agent earning crypto from nothing</title>
<meta name="description" content="An autonomous AI agent born with a self-created wallet and $0. No funding, no human, no captchas. Every figure carries how it was obtained — measured, derived, or reported by the model.">
<meta property="og:title" content="ZERO — an AI agent born broke">
<meta property="og:description" content="Self-created wallet. Zero funding. Machine-only routes. Every attempt logged honestly, including the failures and the failed reads.">
<link rel="icon" href="/favicon.svg">
<style>
:root{
  --void:#050607;--panel:#0b0d0f;--panel2:#0e1114;--line:#171b1f;--line2:#222a30;
  --ink:#e8edf0;--dim:#828d97;
  /* X1 — --dimmer was #4a545c: 2.53:1 on --panel, and it carried EVERY label on the page at 9-11px.
     The chain palette passed six colour checks while the text layer beneath it passed none. Lifted to
     #6b7680 (4.52:1 measured on #0b0d0f). The old value survives as --rule, for DIVIDERS ONLY, where
     contrast is not a legibility requirement. */
  --dimmer:#6b7680;--rule:#4a545c;
  --sig:#3dfaa0;--sig-dim:#1c7d52;--warn:#ffb545;--bad:#ff5c5c;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--void);color:var(--ink);font-family:var(--sans);line-height:1.55;
  -webkit-font-smoothing:antialiased;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:2;opacity:.03;
  background-image:repeating-linear-gradient(0deg,#fff 0 1px,transparent 1px 3px)}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:1;
  background:radial-gradient(ellipse 90% 55% at 50% -10%,rgba(61,250,160,.075),transparent 70%)}
.wrap{max-width:960px;margin:0 auto;padding:0 20px;position:relative;z-index:3}
a{color:inherit}
.hero{padding:52px 0 26px}
.tag{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--sig);display:flex;align-items:center;gap:9px;margin-bottom:20px}
.pip{width:6px;height:6px;border-radius:50%;background:var(--sig);box-shadow:0 0 10px var(--sig);
  animation:beat 2.4s ease-in-out infinite}
@keyframes beat{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.75)}}
h1{font-size:clamp(36px,7vw,60px);line-height:.98;letter-spacing:-.035em;font-weight:680;margin-bottom:16px}
h1 em{font-style:normal;color:var(--sig);text-shadow:0 0 34px rgba(61,250,160,.42)}
.lede{color:var(--dim);font-size:clamp(14.5px,1.9vw,17px);max-width:62ch}
.lede b{color:var(--ink);font-weight:560}
/* ── the instrument: ECG + the $1.00 reservoir it is trying to fill ── */
.inst{display:grid;grid-template-columns:1fr 74px;gap:10px;margin:26px 0 6px}
.ecg{position:relative;height:150px;border:1px solid var(--line);border-radius:11px;
  background:linear-gradient(180deg,#070909,#0b0d0f);overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}
.ecg canvas{display:block;width:100%;height:100%}
.ecg .lbl{position:absolute;left:13px;top:11px;font-family:var(--mono);font-size:10px;
  letter-spacing:.18em;text-transform:uppercase;color:var(--dimmer)}
.ecg .amp{position:absolute;right:13px;top:11px;font-family:var(--mono);font-size:10px;
  letter-spacing:.14em;text-transform:uppercase;color:var(--sig)}
.ecg .axis{position:absolute;left:13px;bottom:9px;font-family:var(--mono);font-size:9.5px;
  letter-spacing:.12em;text-transform:uppercase;color:var(--rule)}
/* A3 — the reservoir. The one number that means CAPABILITY rather than paper. */
.res{position:relative;border:1px solid var(--line);border-radius:11px;background:linear-gradient(180deg,#070909,#0b0d0f);
  overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
.res .fillv{background:linear-gradient(180deg,var(--sig),var(--sig-dim));min-height:2px;
  box-shadow:0 0 16px rgba(61,250,160,.5)}
.res .ceil{position:absolute;left:0;right:0;top:14px;border-top:1px dashed var(--sig-dim)}
.res .ceil span{position:absolute;right:5px;top:-13px;font-family:var(--mono);font-size:9px;color:var(--sig-dim)}
.res .rl{position:absolute;left:0;right:0;bottom:6px;text-align:center;font-family:var(--mono);
  font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--dimmer)}
.inst-cap{font-size:11.5px;color:var(--dimmer);font-family:var(--mono);letter-spacing:.06em;margin-top:2px}
/* ── verdict ── */
.verdict{margin:26px 0 0;padding:20px 22px;border:1px solid var(--line2);border-radius:12px;
  background:linear-gradient(180deg,var(--panel2),var(--panel))}
.verdict .vv{font-size:clamp(26px,4.6vw,38px);font-weight:750;letter-spacing:-.02em;line-height:1.05}
.verdict.good .vv{color:var(--sig)} .verdict.warn .vv{color:var(--warn)} .verdict.bad .vv{color:var(--bad)}
.verdict .vh{color:var(--dim);margin-top:7px;max-width:64ch;font-size:14.5px}
.verdict .va{color:var(--dim);margin-top:8px;max-width:70ch;font-size:13.5px}
.verdict .vn{margin-top:12px;padding-top:11px;border-top:1px solid var(--line);color:var(--dim);font-size:13.5px}
.verdict .vn b{font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--dimmer);margin-right:9px}
/* ── provenance marks: an extension of the .dx left-rule vocabulary already on this page ── */
.prov{position:relative}
.prov::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;border-radius:2px}
.prov-measured::before{background:var(--sig)}
.prov-frozen::before{background:var(--sig-dim)}
.prov-derived::before{background:var(--dim);width:1px}
.prov-self::before{background:var(--warn)}
.prov-unreadable::before{background:var(--bad)}
.prov-forecast::before{background:transparent;border-left:2px dashed var(--warn)}
.pv{font-family:var(--mono);font-size:8.5px;letter-spacing:.13em;text-transform:uppercase;
  border:1px solid var(--rule);border-radius:3px;padding:0 4px;margin-right:6px;white-space:nowrap}
.pv-measured{color:var(--sig);border-color:var(--sig-dim)}
.pv-frozen{color:var(--sig-dim);border-color:var(--sig-dim)}
.pv-derived{color:var(--dim)}
.pv-self{color:var(--warn);border-color:#5a4520}
.pv-unreadable{color:var(--bad);border-color:#5a2626}
.pv-forecast{color:var(--warn);border-style:dashed;border-color:#5a4520}
.nil{color:var(--bad);font-family:var(--mono)}
.why{font-size:11px;color:var(--warn);margin-top:6px;max-width:56ch;line-height:1.45}
.legend{display:flex;flex-wrap:wrap;gap:9px 14px;align-items:center;margin:-22px 0 30px;
  font-size:11px;color:var(--dimmer);font-family:var(--mono);letter-spacing:.04em}
.legend .li{display:flex;align-items:center;gap:5px}
.legend .sw{width:11px;height:2px;border-radius:2px;display:inline-block}
.legend .price{margin-left:auto;color:var(--dim)}
/* ── phase layers ── */
.phases{margin:14px 0 0;border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:16px 18px}
.ph-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;
  font-size:13.5px;color:var(--dim);margin-bottom:10px}
.ph-h b{color:var(--ink)}
.ph-note{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dimmer)}
.ph-stack{display:flex;flex-direction:column}
.ph{display:grid;grid-template-columns:26px 4px 1fr;grid-template-areas:"n b t" ". . d" ". . e";
  gap:0 11px;padding:6px 0;align-items:center}
.ph-n{grid-area:n;font-family:var(--mono);font-size:11px;color:var(--dimmer);text-align:right}
.ph-bar{grid-area:b;background:var(--line2);border-radius:2px;align-self:stretch;min-height:16px}
.ph-t{grid-area:t;font-size:13.5px;color:var(--dimmer);font-weight:600}
.ph-t i{font-style:normal;font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--sig);border:1px solid var(--sig-dim);border-radius:999px;padding:1px 7px;margin-left:9px}
.ph-b{grid-area:d;font-size:12.5px;color:var(--dim);max-width:66ch;padding-top:2px}
.ph-e{grid-area:e;font-size:11.5px;color:var(--dimmer);max-width:66ch;padding-top:3px;font-family:var(--mono);line-height:1.5}
.ph.on .ph-bar{background:var(--sig)} .ph.on .ph-n{color:var(--sig)} .ph.on .ph-t{color:var(--ink)}
/* A5 — seven identical "not yet mapped" rows collapse to one rail with ticks */
.ph-rail{display:grid;grid-template-columns:26px 4px 1fr;gap:0 11px;align-items:center;padding:8px 0 4px}
.ph-rail .ticks{display:flex;gap:3px;align-items:center}
.ph-rail .ticks i{flex:1;height:3px;background:var(--line2);border-radius:2px}
.ph-rail .rl{font-size:12px;color:var(--dimmer);margin-left:10px;white-space:nowrap}
.ph-foot{margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:12.5px;color:var(--dimmer);max-width:70ch}
/* ── tabs ── */
.tabs{display:flex;gap:2px;margin:30px 0 0;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs button{appearance:none;background:none;border:0;border-bottom:2px solid transparent;color:var(--dimmer);
  font:inherit;font-size:13.5px;font-weight:600;padding:10px 13px;cursor:pointer;white-space:nowrap}
.tabs button:hover{color:var(--dim)}
.tabs button[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--sig)}
.tabs button:focus-visible{outline:2px solid var(--sig-dim);outline-offset:-2px}
.panel{display:none}
.panel.on{display:block;animation:tabin .12s ease-out}
@keyframes tabin{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.panel:focus-visible{outline:none}
/* X5 — 6 tiles, and the column count is explicit so no width can ever leave a full-width orphan.
   Verified at 960 / 750 / 620 / 400: 3+3, 3+3, 3+3, 2+2+2. */
.vitals{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:11px;overflow:hidden;margin:22px 0 34px}
@media(max-width:719px){.vitals{grid-template-columns:repeat(2,1fr)}}
.v{background:var(--panel);padding:16px 17px 16px 19px}
.v .k{font-family:var(--mono);font-size:9.5px;letter-spacing:.17em;text-transform:uppercase;color:var(--dimmer)}
.v .n{font-family:var(--mono);font-size:25px;font-weight:600;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums}
.v .n.live{color:var(--sig)}.v .n.zero{color:var(--bad)}
.v .n small{font-size:14px;color:var(--dimmer);font-weight:400}
.v .sub{font-size:11px;color:var(--dimmer);margin-top:5px;line-height:1.5}
.v .extra{font-size:11.5px;margin-top:8px;padding-top:7px;border-top:1px solid var(--line);line-height:1.5}
.v .extra.warn{color:var(--warn)}
.v .extra.dim{color:var(--dimmer)}
section{margin:0 0 34px}
h2{font-family:var(--mono);font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;
  color:var(--dimmer);margin-bottom:13px;display:flex;align-items:center;gap:10px}
h2::after{content:"";flex:1;height:1px;background:var(--line)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:18px}
.dx{border-radius:12px;padding:20px 21px 20px 24px;position:relative;overflow:hidden;
  background:linear-gradient(135deg,var(--panel2),var(--panel));border:1px solid var(--line2)}
.dx::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px}
.dx.good::before{background:var(--sig);box-shadow:0 0 22px var(--sig)}
.dx.warn::before{background:var(--warn);box-shadow:0 0 22px var(--warn)}
.dx.bad::before{background:var(--bad);box-shadow:0 0 22px var(--bad)}
.dx .st{font-family:var(--mono);font-size:12.5px;letter-spacing:.16em;text-transform:uppercase;font-weight:600}
.dx.good .st{color:var(--sig)}.dx.warn .st{color:var(--warn)}.dx.bad .st{color:var(--bad)}
.dx .hl{font-size:17px;margin-top:9px;letter-spacing:-.01em}
.dx .ac{color:var(--dim);font-size:14px;margin-top:9px;max-width:74ch}
.banner{border:1px solid #5a2626;background:rgba(255,92,92,.07);border-radius:9px;padding:11px 13px;
  color:var(--bad);font-size:12.5px;margin-bottom:14px;line-height:1.5}
.caps,.hold{display:grid;gap:10px}
.cap,.hb{display:grid;grid-template-columns:104px 1fr 92px;gap:12px;align-items:center}
.nm{font-family:var(--mono);font-size:11.5px;color:var(--dim);display:flex;align-items:center;gap:7px}
.dot{width:7px;height:7px;border-radius:2px;flex:none}
/* A4 — a chain with no mapped hue must be LOUD, not silently #666. */
.dot.unmapped{background-image:repeating-linear-gradient(45deg,#666 0 2px,#111 2px 4px);outline:1px solid var(--warn)}
.unmapped-note{color:var(--warn);font-size:9.5px;font-family:var(--mono);letter-spacing:.1em}
.slots{display:flex;gap:3px}
.slots .s{flex:1;height:16px;border-radius:3px;background:#141a1e;border:1px solid var(--line2)}
.slots .s.on{background:var(--sig);border-color:var(--sig);box-shadow:0 0 9px rgba(61,250,160,.5)}
.slots .s.dead{background:#2a2118;border-color:#4a3a22}
.ct{font-family:var(--mono);font-size:11.5px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dim)}
.ct.free{color:var(--sig)}.ct.dead{color:var(--warn)}
.track{height:9px;border-radius:5px;background:#12171a;overflow:hidden}
.fill{height:100%;border-radius:5px;min-width:2px}
.amt{font-family:var(--mono);font-size:11.5px;text-align:right;font-variant-numeric:tabular-nums}
.amt.home{color:var(--sig)}.amt.nil{color:var(--bad)}
.split{display:flex;flex-wrap:wrap;gap:1px;margin-top:15px;border-radius:7px;overflow:hidden;border:1px solid var(--line)}
.split div{padding:10px 13px 10px 15px;background:var(--panel2);flex:1;min-width:130px}
.split .k{font-family:var(--mono);font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--dimmer)}
.split .n{font-family:var(--mono);font-size:15px;margin-top:3px;font-variant-numeric:tabular-nums}
.split .n.ok{color:var(--sig)}.split .n.no{color:var(--bad)}
.fn{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.fn div{background:var(--panel);padding:14px 13px 14px 15px}
.fn .k{font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dimmer)}
.fn .n{font-family:var(--mono);font-size:22px;margin-top:5px;font-variant-numeric:tabular-nums}
.fn .n.hi{color:var(--sig)}.fn .n.no{color:var(--bad)}
.fn .cv{font-size:11px;color:var(--dimmer);margin-top:6px;line-height:1.5}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{font-family:var(--mono);font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--dimmer);
  text-align:left;padding:0 10px 9px 0;font-weight:400}
td{padding:8px 10px 8px 0;border-top:1px solid var(--line);vertical-align:top}
td.m{font-family:var(--mono);font-variant-numeric:tabular-nums}
td.g{color:var(--sig)}td.r{color:var(--bad)}td.d{color:var(--dim)}td.w{color:var(--warn)}
td a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line2)}
td a:hover{color:var(--sig);border-color:var(--sig-dim)}
td .sec{color:var(--dimmer);font-size:11px;display:block}
.tnote{font-size:11.5px;color:var(--dimmer);margin-top:11px;line-height:1.55;max-width:74ch}
.scroll{overflow-x:auto}
/* X2 — a panel must never open into a void. */
.empty{border:1px dashed var(--line2);border-radius:10px;padding:22px 20px;color:var(--dim);font-size:13.5px;line-height:1.6}
.empty b{color:var(--ink);font-weight:600;display:block;margin-bottom:5px}
.empty .when{font-family:var(--mono);font-size:11px;color:var(--dimmer);margin-top:9px;display:block}
.tl{display:grid;gap:0}
.tl .ti{display:grid;grid-template-columns:112px 1fr;gap:14px;padding:11px 0;border-top:1px solid var(--line)}
.tl .ti:first-child{border-top:0}
.tl .tw{font-family:var(--mono);font-size:11px;color:var(--dimmer);padding-top:2px}
.tl .tb{font-size:13px;color:var(--dim);line-height:1.55}
.tl .tb b{color:var(--ink);font-weight:600}
footer{border-top:1px solid var(--line);padding:26px 0 46px;margin-top:14px;color:var(--dimmer);font-size:12px}
footer .lk{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:15px}
footer .lk a{font-family:var(--mono);font-size:11px;color:var(--dim);text-decoration:none;
  border:1px solid var(--line);border-radius:5px;padding:5px 9px;transition:.15s}
footer .lk a:hover{color:var(--sig);border-color:var(--sig-dim);background:rgba(61,250,160,.05)}
footer .lk a.hi{color:var(--sig);border-color:var(--sig-dim)}
footer .ft{max-width:74ch;line-height:1.6}
@media(prefers-reduced-motion:reduce){
  .pip{animation:none}.panel.on{animation:none}
}
@media(max-width:560px){.cap,.hb{grid-template-columns:78px 1fr 78px}h2{font-size:9.5px}
  .inst{grid-template-columns:1fr 54px}.tl .ti{grid-template-columns:1fr;gap:3px}}
</style></head><body>
<div class="wrap">
  <header class="hero">
    <div class="tag"><span class="pip"></span> live · autonomous · nobody funds it</div>
    <h1>Born with <em>nothing</em>.<br>Earned it anyway.</h1>
    <p class="lede">ZERO created its own wallet and started at <b>$0.00</b> — no capital, no ETH, no human,
      nobody's permission. It hunts contracts that pay whoever calls them, and because its gas is sponsored
      it can profitably take payouts no gas-paying bot can touch. Every figure below carries
      <b>how it was obtained</b> — including the failures, and including the reads that failed.</p>

    <div class="inst">
      <div class="ecg"><canvas id="ecg"></canvas>
        <div class="lbl">phase 0 · settled-event trace</div><div class="amp" id="amp"></div>
        <div class="axis" id="axis"></div></div>
      <div class="res" id="res" aria-hidden="true">
        <div class="ceil"><span>$1.00</span></div>
        <div class="fillv" id="resfill" style="height:0"></div>
        <div class="rl">phase 0</div>
      </div>
    </div>
    <div class="inst-cap">amplitude = progress toward the $1.00 phase-0 exit · beats = real settled harvests, spaced by their real arrival times · no settled harvest, no beat</div>

    <div class="verdict ${m.vtone}">
      <div class="vv">${esc(m.verdict)}</div>
      <div class="vh">${esc(m.headline)}</div>
      ${m.action ? `<div class="va">${esc(m.action)}</div>` : ''}
      ${m.eta ? `<div class="vn prov prov-forecast" style="padding-left:11px"><b>refill</b> <span class="pv pv-forecast">forecast</span> next usable capacity in ~${m.eta.value === null ? '—' : esc(m.eta.value.toFixed(1))}h on <b>${esc(m.eta.chain || 'unknown chain')}</b> — extrapolated from the median observed refill gap, counting only chains that have work to do.</div>` : ''}
      ${m.nextMove ? `<div class="vn"><b>next move</b> ${esc(m.nextMove)}</div>` : ''}
    </div>

    <div class="phases">
      <div class="ph-h"><span>Phase layers — <b>${m.litCount} of 11 lit by evidence</b></span>
        <span class="ph-note">layers stack; nothing switches off</span></div>
      <div class="ph-stack">
        ${[...m.layers].reverse().map(l => `<div class="ph ${l.lit ? 'on' : ''}">
            <span class="ph-n">${l.n}</span>
            <span class="ph-bar"></span>
            <span class="ph-t">${esc(l.name)}${l.lit ? '<i>lit</i>' : ''}</span>
            <span class="ph-b">${esc(l.blurb)}</span>
            <span class="ph-e">${esc(l.evidence)}</span>
          </div>`).join('')}
        <div class="ph-rail">
          <span class="ph-n">4–10</span><span class="ph-bar" style="background:var(--line)"></span>
          <span class="ticks">${Array.from({ length: 7 }, () => '<i></i>').join('')}<span class="rl">unmapped, by design</span></span>
        </div>
      </div>
      <div class="ph-foot">Phase 0 already did the hard part — nothing into something. It keeps running
        forever and refills what the layers above spend. Layers 4–10 stay unnamed until one is reached:
        naming rungs nobody has stood on is a roadmap pretending to be a product.</div>
    </div>

    <div class="vitals">
      ${tile('spendable · liquid native eth', m.phase0.earned, {
        tone: m.phase0.earned.value > 0 ? 'live' : 'zero',
        fmt: (v) => `${money(v)} <small>of ${money(m.phase0.target, 2)}</small>`,
        extra: m.phase0.residue.value === null
          ? `<div class="extra warn">${esc(m.phase0.residue.reason || 'native balance unreadable this request')}</div>`
          : `<div class="extra warn prov prov-frozen" style="padding-left:9px"><span class="pv pv-frozen">frozen</span>
             ${money(m.phase0.residue.value)} of native ETH is present but is residue of a ${money(m.phase0.residue.gift.usd, 2)}
             operator test-capital gift (${esc(m.phase0.residue.gift.at)}, tx ${esc(m.phase0.residue.gift.tx.slice(0, 8))}…), not earned — excluded.</div>`,
      })}
      ${tile('lifetime earned · measured', m.lifetime.measured, {
        tone: m.lifetime.measured.value > 0 ? 'live' : 'zero',
        extra: `<div class="extra warn prov prov-self" style="padding-left:9px"><span class="pv pv-self">self-reported</span>
            + ${m.lifetime.self.value === null ? '—' : money(m.lifetime.self.value)} reported by the model, never verified on-chain. Never added to the figure above.</div>
          ${m.lifetime.floor.value !== null && m.lifetime.measured.value !== null && m.lifetime.floor.value > m.lifetime.measured.value
            ? `<div class="extra dim">ledger under-covers: the chain holds ${money(m.lifetime.floor.value)} and nobody funds it, so lifetime is at least that.</div>` : ''}`,
      })}
      ${tile('holding now', m.holdings, { extra: `<div class="extra dim">${esc(m.readNote)}</div>` })}
      ${tile('relay-spendable · safe weth', m.relaySpendable, {
        extra: `<div class="extra dim">needs a relay slot — ${num(m.capacity.usable) ?? 0} usable right now</div>`,
      })}
      ${tile('usable gas slots', fig('MEASURED', num(m.capacity.usable), { inputs: 'Safe relay budget endpoint, capped by chains that have work' }), {
        tone: m.capacity.usable ? 'live' : 'zero',
        fmt: (v) => `${v}<small>/${m.capacity.total ?? 0}${m.capacity.limit_period ? ' per ' + esc(m.capacity.limit_period) : ''}</small>`,
        extra: `<div class="extra dim">${capFree !== capUsable
          ? `${capFree} free, ${capFree - capUsable} of them on chains with no fresh Beefy vault`
          : `sponsored, across ${m.cap.length} chains`}</div>`,
      })}
      ${tile('$ per day', m.perDay, {
        fmt: (v) => money(v, 6),
        extra: m.perDay.value === null
          ? `<div class="extra dim">${esc(m.perDay.why || '')}</div>`
          : `<div class="extra dim prov prov-derived" style="padding-left:9px">distance to the $16.66/day goal:
             ${m.distance.value === null ? '—' : esc(Number(m.distance.value).toLocaleString('en-US'))}× — an engineering metric, never a verdict on anyone.</div>`,
      })}
    </div>

    <div class="legend">
      ${['MEASURED', 'FROZEN', 'DERIVED', 'SELF-REPORTED', 'UNREADABLE', 'FORECAST'].map(k =>
        `<span class="li"><span class="sw" style="background:${k === 'FORECAST' ? 'transparent;border-top:2px dashed var(--warn)' : k === 'MEASURED' ? 'var(--sig)' : k === 'FROZEN' ? 'var(--sig-dim)' : k === 'DERIVED' ? 'var(--dim)' : k === 'SELF-REPORTED' ? 'var(--warn)' : 'var(--bad)'}"></span>${PROV[k].label}</span>`).join('')}
      <span class="price">${m.price && m.price.usd
        ? `priced at $${esc(Number(m.price.usd).toFixed(2))}/ETH · ${esc(String(m.price.source || '').replace(/^https?:\/\//, '').split('/')[0] || 'blockscout')}${m.price.at ? ' · ' + esc(String(m.price.at).slice(11, 19)) + 'Z' : ''}`
        : 'price feed unreadable this request'}</span>
    </div>

    <div class="fn">
      <div><div class="k">observed paying somebody</div><div class="n">${m.streamCounts.paysSomebody.value === null ? '—' : m.streamCounts.paysSomebody.value}</div>
        <div class="cv">${provMark(m.streamCounts.paysSomebody)} ${esc(m.streamCounts.paysSomebody.caveat)}</div></div>
      <div><div class="k">callable by zero and paying</div><div class="n">${m.streamCounts.callableAndPaying.value === null ? '—' : m.streamCounts.callableAndPaying.value}</div>
        <div class="cv">${provMark(m.streamCounts.callableAndPaying)} ${esc(m.streamCounts.callableAndPaying.caveat)}</div></div>
      <div><div class="k">streams that have paid ZERO</div><div class="n hi">${m.streamCounts.paidZero.value === null ? '—' : m.streamCounts.paidZero.value}</div>
        <div class="cv">${provMark(m.streamCounts.paidZero)} ${esc(m.streamCounts.paidZero.caveat)}</div></div>
    </div>
  </header>

  <div class="tabs" role="tablist" aria-label="ZERO status views">
    <button role="tab" id="t-status"   aria-controls="p-status"   aria-selected="true"  data-p="status">Status</button>
    <button role="tab" id="t-capacity" aria-controls="p-capacity" aria-selected="false" data-p="capacity">Capacity</button>
    <button role="tab" id="t-learned"  aria-controls="p-learned"  aria-selected="false" data-p="learned">What it learned</button>
    <button role="tab" id="t-log"      aria-controls="p-log"      aria-selected="false" data-p="log">Activity</button>
  </div>

  <div class="panel on" id="p-status" role="tabpanel" aria-labelledby="t-status" tabindex="0">
  <section><h2>the clock — what it is waiting on</h2><div class="card">
    <div class="tl">
      <div class="ti"><div class="tw">capacity</div><div class="tb">
        <b>${num(m.capacity.usable) ?? 0} usable</b> of ${m.capacity.total ?? 0} sponsored slots${m.capacity.limit_period ? ' per ' + esc(m.capacity.limit_period) : ''}.
        ${m.eta ? `Next usable refill forecast in ~${m.eta.value === null ? '—' : esc(m.eta.value.toFixed(1))}h on ${esc(m.eta.chain || 'unknown chain')}.` : 'No refill forecast available — no refill has been observed twice yet.'}
      </div></div>
      <div class="ti"><div class="tw">sessions</div><div class="tb">
        <b>${data.sessions_completed ?? 0} completed.</b>
        ${data.session_in_progress ? `Session ${esc(String(data.session_in_progress.session))} running, round ${esc(String(data.session_in_progress.round))}.` : 'None in flight.'}
        ${h.hours_since_session != null ? `Last one ended ${esc(Number(h.hours_since_session).toFixed(1))}h ago.` : ''}
      </div></div>
      <div class="ti"><div class="tw">last value in</div><div class="tb">
        ${h.hours_since_earning != null
          ? `<b>${esc(Number(h.hours_since_earning).toFixed(1))}h ago.</b> Measured against the observed refill cycle, not a guessed one.`
          : '<b>Never.</b> No settled payout has ever been measured by code.'}
      </div></div>
      <div class="ti"><div class="tw">state history</div><div class="tb">
        Not stored. This build records the CURRENT diagnosis only, so the last N state transitions cannot be
        shown — and inventing them from the harvest log would be a reconstruction, not a record.
      </div></div>
    </div>
  </div></section>

  <section><h2>settled-event feed — three outcomes, not two</h2>
    ${renderActivity(data, m, esc, true)}
  </section>
  </div>

  <div class="panel" id="p-capacity" role="tabpanel" aria-labelledby="t-capacity" tabindex="0">
  <section><h2>gas capacity — free slots, per chain</h2><div class="card">
    ${m.cap.length ? `<div class="caps">${m.cap.map(c => {
      const unread = typeof c.remaining !== 'number';   // null = we could not read the quota, NOT zero
      const dead = (c.remaining || 0) > 0 && c.work === 0;
      const known = !!HUE[c.name];
      return `<div class="cap">
      <div class="nm"><span class="dot ${known ? '' : 'unmapped'}" style="${known ? `background:${HUE[c.name]}` : ''}"></span>${esc(c.name)}${known ? '' : ' <span class="unmapped-note">unmapped chain</span>'}</div>
      <div class="slots">${Array.from({ length: c.limit || 5 }, (_, i) => `<div class="s ${i < (c.remaining || 0) ? (dead ? 'dead' : 'on') : ''}"></div>`).join('')}</div>
      <div class="ct ${unread ? 'unreadable' : dead ? 'dead' : (c.remaining ? 'free' : '')}">${unread ? '?' : c.remaining}/${c.limit ?? '?'}</div></div>`;
    }).join('')}</div>` : `<div class="empty"><b>No relay budget was readable this request.</b>
      The Safe relay endpoint answered for zero chains, so slot counts are unknown — not zero.
      <span class="when">Retried on the next cron tick, every 2 minutes.</span></div>`}
    <div class="split">
      <div class="prov prov-measured"><div class="k">usable right now</div><div class="n ${m.capacity.usable ? 'ok' : 'no'}">${num(m.capacity.usable) ?? 0} slots</div></div>
      ${(m.capacity.dead_chains || []).length ? `<div class="prov prov-measured"><div class="k">free but unusable</div><div class="n" style="color:var(--warn)">${capFree - capUsable} on ${esc(m.capacity.dead_chains.join(', '))}</div></div>` : ''}
      <div><div class="k">an unused slot</div><div class="n">expires worthless</div></div>
    </div>
    <div class="tnote">A chain with free slots and no fresh Beefy vault is not a dead chain — it is a chain
      where our current catalogue has nothing to call. Naming that as a property of the CHAIN is how
      "expand: another chain" became the standing next move while two chains sat at full quota.</div>
    </div>
  </section>

  <section><h2>everything it holds</h2><div class="card">
    ${(m.unreadable && m.unreadable.length) ? `<div class="banner unread">One or more chains could not be read this request
      (${m.unreadable.map(u => esc(u.chain)).join(', ')}). <b>The total below is a lower bound</b>, not a balance —
      a failed read is excluded from every figure on this page rather than counted as zero.
      ${m.unreadable.some(u => u.unpriced) ? `<br>Some of those are <b>unpriced, not unread</b>: the balance came back fine and the
      PRICE did not, so the value is real and simply cannot be expressed in dollars right now. Absence from a
      total means unmeasured, never worthless.` : ''}</div>` : ''}
    ${renderHoldings(data, m, esc)}
    <div class="split">
      <div class="prov prov-measured"><div class="k">relay-spendable · safe</div><div class="n ok">${val(m.relaySpendable)}</div></div>
      <div class="prov prov-measured"><div class="k">stranded · unmovable</div><div class="n no">${val(m.stranded)}</div></div>
      <div class="prov prov-measured"><div class="k">read</div><div class="n">${m.readOk === null ? '—' : `${m.readOk}/${m.configured}`} <span style="font-size:11px;color:var(--dimmer)">chains</span></div></div>
    </div>
    <div class="tnote">USDC is listed separately and deliberately: it is the only asset that lets ZERO transact
      without a relay slot (one permissionless token paymaster, ~0.009087 USDC per operation), and the panel
      that claimed to show "everything it holds" was omitting it.</div>
    </div>
  </section>
  </div>

  <div class="panel" id="p-learned" role="tabpanel" aria-labelledby="t-learned" tabindex="0">
  <section><h2>the hunt — automatic, no model in the loop</h2>
    <div class="fn">
      <div><div class="k">candidates</div><div class="n">${data.prospect?.grind?.total_candidates ?? '—'}</div></div>
      <div><div class="k">triaged</div><div class="n">${data.prospect?.grind?.triaged ?? '—'}</div></div>
      <div><div class="k">callable by it</div><div class="n">${data.prospect?.grind?.callable_now ?? '—'}</div></div>
      <div><div class="k">read failed, requeued</div><div class="n ${data.prospect?.grind?.triage_error ? 'no' : ''}">${data.prospect?.grind?.triage_error ?? '—'}</div>
        <div class="cv">${data.prospect?.grind?.triage_error === undefined
          ? 'not published by this worker build. Until it is, "triaged" includes candidates whose RPC read FAILED — a failed read counted as completed work.'
          : 'candidates whose triage read failed and which are being retried under backoff, rather than being filed as "not callable".'}</div></div>
      <div><div class="k">eliminated</div><div class="n no">${data.prospect?.grind?.eliminated_forever ?? '—'}</div></div>
      <div><div class="k">still queued</div><div class="n">${data.prospect?.grind?.still_queued ?? '—'}</div></div>
    </div>
    <div class="tnote">The 3,962 candidates that are neither callable nor eliminated are a bucket of
      <b>unknown composition</b>. Until the retry backoff has run it down, this funnel cannot say how many of
      them are genuinely not callable and how many were simply a read that failed.</div>
  </section>

  ${m.streams.length ? `<section><h2>streams observed paying somebody</h2><div class="card scroll"><table>
    <thead><tr><th>chain</th><th>contract</th><th>callable by zero</th><th>a real caller was paid</th></tr></thead>
    <tbody>${m.streams.slice(0, 10).map(s => `<tr>
      <td class="m d">${esc(s.chain)}</td>
      <td class="m"><a href="${scoutUrl(s.chain)}/address/${esc(s.contract)}" target="_blank" rel="noopener">${esc(String(s.contract).slice(0, 16))}…</a></td>
      <td class="m ${(s.callable || []).length ? 'd' : 'r'}">${esc((s.callable || []).join(', ') || 'not callable by us')}</td>
      <td class="m g">${s.example_payout ? esc(s.example_payout.amount + ' ' + s.example_payout.token) : '—'}</td>
    </tr>`).join('')}</tbody></table>
    <div class="tnote">"Callable" and "paying" are <b>independent populations</b> here. A contract can appear in
      this list without being callable by ZERO — the payout verdict is computed from the contract's own
      history, and no callability filter is applied to it. Rows showing "not callable by us" are exactly that
      case, and they are why a single "proven streams" number was three different numbers wearing one label.</div>
    </div></section>` : `<section><h2>streams observed paying somebody</h2>
    <div class="empty"><b>No stream list published this request.</b>
      The prospector rolls its verdicts up on a cron tick; if it has not run since the last deploy there is
      nothing to show. This is an empty list, not a claim that nothing pays.
      <span class="when">Next prospector tick: every 2 minutes.</span></div></section>`}

  ${m.families.length ? `<section><h2>patterns learned — generalises to contracts never tested</h2>
    <div class="card scroll"><table>
    <thead><tr><th>contract family</th><th>seen</th><th>callable</th><th>probed</th><th>pay</th><th>pay nothing</th><th>rate</th></tr></thead>
    <tbody>${m.families.slice(0, 8).map(f => `<tr>
      <td class="m">${esc(f.family)}</td><td class="m d">${f.seen ?? '—'}</td><td class="m d">${f.callable}</td>
      <td class="m d">${f.probed}</td>
      <td class="m g">${f.pays}</td><td class="m r">${f.zero}</td>
      <td class="m">${f.pay_rate === null || f.pay_rate === undefined ? '—' : f.pay_rate}</td>
    </tr>`).join('')}</tbody></table>
    <div class="tnote"><b>rate</b> divides by <b>probed</b> (pays + pay-nothing), not by <b>callable</b> —
      callable-but-unprobed instances are excluded from the denominator, so a reader dividing the visible
      columns differently will get a different number. <b>callable</b> and <b>pay</b> are independent
      populations and neither filters the other.</div>
    </div></section>` : ''}

  ${m.proxyFamilies.length ? `<section><h2>unresolved implementation — NOT a generalisation</h2>
    <div class="card scroll"><table>
    <thead><tr><th>wrapper name</th><th>seen</th><th>callable</th><th>probed</th><th>pay</th><th>pay nothing</th><th>rate</th></tr></thead>
    <tbody>${m.proxyFamilies.slice(0, 6).map(f => `<tr>
      <td class="m w">${esc(f.family)}</td><td class="m d">${f.seen ?? '—'}</td><td class="m d">${f.callable}</td>
      <td class="m d">${f.probed}</td><td class="m g">${f.pays}</td><td class="m r">${f.zero}</td>
      <td class="m">${f.pay_rate === null || f.pay_rate === undefined ? '—' : f.pay_rate}</td>
    </tr>`).join('')}</tbody></table>
    <div class="tnote">These rows are pulled OUT of the generalisation table on purpose. A family is the contract
      NAME with a trailing digit stripped, so <b>BeaconProxy</b>, <b>TransparentUpgradeableProxy</b> and
      <b>ERC1967Proxy</b> pool hundreds of candidates from completely unrelated protocols by their wrapper.
      "BeaconProxy pays 78%" predicts nothing. The repo's own manual says it plainly:
      <b>"A proxy's bytecode has no dispatch table… This fired THREE times in one day."</b> Until the
      implementation behind each is resolved, these are a naming artifact, not a pattern.</div>
    </div></section>` : ''}
  </div>

  <div class="panel" id="p-log" role="tabpanel" aria-labelledby="t-log" tabindex="0">
  <section><h2>recent attempts — successes, zeroes and outages</h2>
    ${renderActivity(data, m, esc, false)}
  </section>
  </div>

  <footer>
    <div class="lk">
      <a class="hi" href="/read/method">method</a><a class="hi" href="/claims">claims register</a>
      <a class="hi" href="/research">negative results</a><a class="hi" href="/errors">errors we made</a>
      <a href="/read/journal">journal</a><a href="/read/genesis">genesis</a>
      <a href="/read/frontier">frontier</a><a href="/read/toolcraft">toolcraft</a>
      <a href="/read/recovery">recovery</a><a href="/ledger">ledger</a>
      <a href="/prospect">prospector</a><a href="/harvest">harvest</a>
      <a href="/llms.txt">llms.txt</a><a href="/.well-known/x402">x402</a>
    </div>
    <div class="ft">
    Session ${data.sessions_completed ?? 0}${data.session_in_progress ? ` · session ${esc(String(data.session_in_progress.session))} running, round ${esc(String(data.session_in_progress.round))}` : ''}.
    Wallet <a href="${esc(data.explorer || '#')}" target="_blank" rel="noopener">${esc(data.wallet || '')}</a>.
    <br>Nothing here is funded. Every figure carries how it was obtained — measured on-chain, derived, or
    reported by the model. Nothing is faked and nothing is smoothed.
    </div>
  </footer>
</div>
<script>
// Tabs. Plain buttons + panels, no framework. Arrow keys work, because a tablist that only answers to
// clicks is not a tablist; the hash is kept so a tab can be linked to directly.
(function(){
  var tabs=[].slice.call(document.querySelectorAll('.tabs button'));
  var panels=[].slice.call(document.querySelectorAll('.panel'));
  function show(n){
    tabs.forEach(function(t){
      var on=t.dataset.p===n;
      t.setAttribute('aria-selected',String(on));
      t.setAttribute('tabindex',on?'0':'-1');
    });
    panels.forEach(function(p){p.classList.toggle('on',p.id==='p-'+n)});
    history.replaceState(null,'','#'+n);
  }
  tabs.forEach(function(t,i){
    t.addEventListener('click',function(){show(t.dataset.p)});
    t.addEventListener('keydown',function(e){
      var d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0; if(!d)return; e.preventDefault();
      var n=tabs[(i+d+tabs.length)%tabs.length]; n.focus(); show(n.dataset.p);
    });
  });
  var hsh=location.hash.slice(1);
  if(hsh&&tabs.some(function(t){return t.dataset.p===hsh}))show(hsh);
})();

// A1 — a purpose-built visualisation payload, not the whole JSON. The full document is still served at
// this same URL with Accept: application/json, which is its correct home.
var VIS = ${visJson};

// A2 — THE TRACE HAS TWO REAL DATA CHANNELS NOW.
//  * AMPLITUDE was mapped over six decades and saturated instantly, so the entire remaining mission
//    (today to the $1.00 bar) moved the trace about seven pixels and then stopped moving forever. It is
//    now scaled across the MISSION SPAN [$0.001, $1.00] and driven by the phase-0 native figure, so the
//    trace visibly grows as the project actually succeeds.
//  * RATE was a hardcoded constant while real timestamped harvest events sat unused in the payload.
//    Beats are now driven by actual settled events, spaced by their real inter-arrival times, with beat
//    height per payout. This makes the flatline case earn itself, and it makes the graphic tell the
//    truth about relay tasks that never sent a transaction instead of animating over them.
(function(){
  var cv=document.getElementById('ecg'); if(!cv) return;
  var x=cv.getContext('2d');
  var ampEl=document.getElementById('amp'), axEl=document.getElementById('axis');
  var evs=(VIS.events||[]).filter(function(e){return e.usd>0}).slice().reverse();
  var alive=evs.length>0;
  var prog=Number(VIS.phase0&&VIS.phase0.usd||0);

  // mission span: $0.001 floor, $1.00 ceiling. Re-base past $1 and say so on the axis.
  var LO=0.001, HI=Math.max(1, Math.pow(10,Math.ceil(Math.log10(Math.max(prog,1)))));
  var amp = prog>0 ? Math.min(1,Math.max(.06,(Math.log10(prog)-Math.log10(LO))/(Math.log10(HI)-Math.log10(LO)))) : 0;
  axEl.textContent='log scale · $0.001 → $'+(HI>=1?HI.toFixed(2):HI);
  ampEl.textContent = alive
    ? (evs.length+' settled event'+(evs.length===1?'':'s')+' · phase 0 $'+prog.toFixed(4))
    : 'no settled event in window · flatline';
  if(!alive)ampEl.style.color='var(--bad)';

  // reservoir
  var rf=document.getElementById('resfill');
  if(rf){ var pct=Math.max(0,Math.min(100,(prog/(VIS.phase0.target||1))*100)); rf.style.height=(pct<0.6?0.6:pct)+'%'; }

  var W=0,H=0,dpr=Math.min(devicePixelRatio||1,2);
  function size(){W=cv.clientWidth;H=cv.clientHeight;cv.width=W*dpr;cv.height=H*dpr;x.setTransform(dpr,0,0,dpr,0,0)}
  size();addEventListener('resize',size);
  var N=260,pts=new Array(N).fill(0),t=0;
  var QRS=[0,0,.06,-.09,1,-.34,.1,.05,0,0,.17,.23,.13,.03,0];

  // Real inter-arrival times, compressed into the visible window. A beat only exists because a harvest
  // actually settled; the gaps between beats are the real gaps between those settlements.
  var beats=[];
  if(alive){
    var t0=Date.parse(evs[0].at), t1=Date.parse(evs[evs.length-1].at);
    var span=Math.max(1,t1-t0), maxUsd=Math.max.apply(null,evs.map(function(e){return e.usd}));
    for(var i=0;i<evs.length;i++){
      var frac=evs.length===1?0.5:(Date.parse(evs[i].at)-t0)/span;
      beats.push({at:Math.round(frac*(N-30))+10, h:Math.max(.25,evs[i].usd/maxUsd)});
    }
  }
  function heightAt(idx){
    for(var i=0;i<beats.length;i++){
      var k=idx-beats[i].at;
      if(k>=0&&k<QRS.length) return QRS[k]*amp*beats[i].h;
    }
    return 0;
  }
  function draw(){
    x.clearRect(0,0,W,H);
    x.strokeStyle='rgba(255,255,255,.028)';x.lineWidth=1;x.beginPath();
    for(var i=0;i<W;i+=26){x.moveTo(i,0);x.lineTo(i,H)}
    for(var j=0;j<H;j+=26){x.moveTo(0,j);x.lineTo(W,j)}x.stroke();
    var mid=H*.62;
    x.strokeStyle='rgba(61,250,160,.10)';x.beginPath();x.moveTo(0,mid);x.lineTo(W,mid);x.stroke();
    var step=W/(N-1);x.beginPath();
    for(var p=0;p<N;p++){var px=p*step,py=mid-pts[p]*(H*.44);p?x.lineTo(px,py):x.moveTo(px,py)}
    x.strokeStyle=alive?'#3dfaa0':'#ff5c5c';x.lineWidth=1.7;x.lineJoin='round';x.lineCap='round';
    x.shadowColor=alive?'rgba(61,250,160,.75)':'rgba(255,92,92,.55)';x.shadowBlur=11;x.stroke();x.shadowBlur=0;
    x.fillStyle=alive?'#3dfaa0':'#ff5c5c';x.beginPath();
    x.arc((N-1)*step,mid-pts[N-1]*(H*.44),2.6,0,7);x.fill();
  }
  function frame(){
    t++;pts.shift();
    var v=(Math.random()-.5)*(alive?.014:.006);
    v+=heightAt((t)%(N));
    pts.push(v);draw();requestAnimationFrame(frame);
  }
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){
    for(var q=0;q<N;q++)pts[q]=heightAt(q);
    draw();
  } else frame();
})();
</script></body></html>`;
}

// ── panels that are used twice, or are long enough to deserve their own function ────────────────────

function renderHoldings(data, m, esc) {
  const trib = data.treasury?.tributaries || [];
  const homeUsd = num(data.treasury?.home_usd);
  const perChain = Array.isArray(data.balances?.all_chains_priced) ? data.balances.all_chains_priced : [];

  const bad = new Set(m.unpricedChains || []);
  // Any upstream dollar figure for a chain we could not price is NOT a measurement — it is a zero that
  // a `price ? usd : 0` produced. It renders as — with the reason, never as money.
  const row = (chain, usd, kind, extra = {}) => bad.has(chain)
    ? { chain, usd: null, kind: 'held, price unknown', ...extra }
    : { chain, usd, kind, ...extra };

  // ── WHICH INSTRUMENT DO WE BELIEVE? ─────────────────────────────────────────────────────────────
  // Two of them answer this question in the same response and they can disagree, because each fetches
  // its own price. Measured 2026-08-12 in ONE payload: the per-chain read published polygon safe_wei
  // 137,891,921,968,616,923 at token_usd 0.074419 = $0.0103, while the treasury plan published polygon
  // $0.0000 — its independent price fetch had failed and been coerced to zero.
  // So: the per-chain read WINS wherever it exists, because it is the only one that publishes the raw
  // wei alongside the dollars and can therefore be checked. The treasury figure is used only for chains
  // the per-chain read does not cover, and it is labelled as coming from a second instrument.
  const perByChain = new Map();
  for (const p of perChain) if (p && p.chain) perByChain.set(p.chain, p);
  const bigOr0 = (v) => { try { return BigInt(v || '0'); } catch { return 0n; } };

  const rows = [];
  const disagreements = [];
  const seenChain = new Set();

  for (const [chain, p] of perByChain) {
    const wrappedWei = bigOr0(p.safe_wei) + bigOr0(p.eoa_wei) + bigOr0(p.safe_wrapped_wei) + bigOr0(p.eoa_wrapped_wei);
    const wrappedUsd = (num(p.safe_usd) ?? 0) + (num(p.eoa_usd) ?? 0)
      + (num(p.safe_wrapped_usd) ?? 0) + (num(p.eoa_wrapped_usd) ?? 0);
    const priceKnown = p.price_known !== false && p.token_usd !== null && p.read !== 'failed';
    seenChain.add(chain);
    if (wrappedWei > 0n || wrappedUsd > 0) {
      // A NON-ZERO BALANCE MAY NEVER RENDER AS $0.00. If the wei is there and the dollars are not, the
      // dollars are unknown, not zero.
      const showable = priceKnown && wrappedUsd > 0;
      rows.push({
        chain, usd: showable ? wrappedUsd : null, home: chain === 'base',
        kind: showable ? 'wrapped native' : 'held, price unknown',
        error: showable ? undefined : `balance is ${wrappedWei.toString()} wei of ${CHAIN_TOKEN[chain] || 'wrapped native'} — real, but not priceable this request`,
      });
      const t = trib.find(x => x.chain === chain);
      if (t && showable && Math.abs((num(t.spendable_usd) ?? 0) - wrappedUsd) > Math.max(1e-6, wrappedUsd * 0.02)) {
        disagreements.push({ chain, perChain: wrappedUsd, treasury: num(t.spendable_usd) ?? 0 });
      }
    }
    const uUsd = num(p.usdc_usd);
    if (uUsd !== null && uUsd > 0) rows.push({ chain, usd: uUsd, kind: 'USDC', asset: true });
    const nUsd = num(p.eoa_native_usd) ?? num(p.native_liquid_usd);
    if (nUsd !== null && nUsd > 0) rows.push({ chain, usd: nUsd, kind: 'native ETH at the EOA', asset: true });
  }

  // Chains only the treasury plan covers. Labelled, because it prices independently of the read above.
  if (!seenChain.has('base') && homeUsd !== null) rows.push(row('base', homeUsd, 'wrapped native · treasury plan', { home: true }));
  for (const t of trib) {
    if (seenChain.has(t.chain)) continue;
    rows.push(row(t.chain, num(t.spendable_usd), 'wrapped native · treasury plan'));
  }

  // D6 — the assets the panel omitted. USDC is the reason `can_transact` is true at all. Added here
  // only when the per-chain read did not already supply them.
  const usdc = m.usdc.value;
  if (usdc !== null && usdc > 0 && !rows.some(r => r.kind === 'USDC')) rows.push(row('base', usdc, 'USDC', { asset: true }));
  const nativeUsdVal = m.phase0.residue.value;
  if (nativeUsdVal !== null && nativeUsdVal > 0 && !rows.some(r => String(r.kind).startsWith('native ETH'))) {
    rows.push(row('base', nativeUsdVal, 'native ETH at the EOA', { asset: true }));
  }

  // An unpriced chain and an unread chain are different failures and get different words. Both render
  // as — and both are excluded from every total; neither is ever rendered as $0.00. Only add a row for
  // a failing chain that is not already represented above.
  const covered = new Set(rows.map(r => r.chain));
  const unread = [];
  for (const u of (m.unreadable || [])) {
    if (covered.has(u.chain)) continue;
    covered.add(u.chain);
    unread.push({ chain: u.chain, usd: null, error: u.error, kind: u.unpriced ? 'held, price unknown' : 'read failed' });
  }
  for (const p of perChain) {
    if (p && p.token_usd === null && !covered.has(p.chain)) {
      covered.add(p.chain);
      unread.push({ chain: p.chain, usd: null, kind: 'held, price unknown', error: p.error || 'price read returned no usable value' });
    }
  }
  // Attach the reason to the converted rows too, so a — is never unexplained.
  const why = new Map((m.unreadable || []).map(u => [u.chain, u.error]));
  for (const r of rows) if (r.usd === null && !r.error) r.error = why.get(r.chain) || 'price read returned no usable value — the balance is real, the dollar figure is not knowable';
  const all = rows.concat(unread);
  const maxHold = Math.max(...all.map(r => r.usd || 0), 1e-9);

  const chainRow = (r) => {
    const known = !!HUE[r.chain];
    const tok = r.kind === 'wrapped native' ? (CHAIN_TOKEN[r.chain] || 'wrapped native') : r.kind;
    return `<div class="hb">
      <div class="nm"><span class="dot ${known ? '' : 'unmapped'}" style="${known ? `background:${HUE[r.chain]}` : ''}"></span>${esc(r.chain)}${r.home ? ' ●' : ''}
        ${known ? '' : '<span class="unmapped-note">unmapped chain</span>'}</div>
      <div class="track">${r.usd === null ? '' : `<div class="fill" style="width:${Math.max(1.2, (r.usd / maxHold) * 100)}%;background:${known ? HUE[r.chain] : '#666'}"></div>`}</div>
      <div class="amt ${r.usd === null ? 'nil' : (r.home ? 'home' : '')}">${r.usd === null ? '—' : money(r.usd)}</div>
    </div>
    <div style="font-family:var(--mono);font-size:10px;color:var(--dimmer);margin:-6px 0 0 111px">${esc(tok)}${r.error ? ' · ' + esc(String(r.error).slice(0, 90)) : ''}</div>`;
  };

  if (!all.length) {
    return `<div class="empty"><b>No holdings could be read this request.</b>
      Every configured chain failed its balance read, so this panel is empty because the instrument is
      blind — not because the wallet is. A failed read is never rendered as a zero balance here.
      <span class="when">Retried every 2 minutes on the cron tick.</span></div>`;
  }
  return `<div class="hold">${all.map(chainRow).join('')}</div>
    ${disagreements.length ? `<div class="banner" style="margin:14px 0 0">Two instruments in this same response
      disagree about the same balance: ${disagreements.map(d => `<b>${esc(d.chain)}</b> reads ${money(d.perChain)} from the
      per-chain balance read and ${money(d.treasury)} from the treasury plan`).join('; ')}. They price independently, so
      one of them had a price read fail and coerce to zero. The rows above use the per-chain read, because it is the only
      one that publishes the raw wei next to the dollars and can therefore be checked.</div>` : ''}
    <div class="tnote">${esc(m.readNote)}. Totals on this page exclude every chain whose read failed —
      excluded, not zeroed. A row showing <b>—</b> holds a real, measured balance whose dollar value could
      not be established this request; it is never shown as $0.00.</div>`;
}

function renderActivity(data, m, esc, compact) {
  const log = (Array.isArray(data.harvest_events) ? data.harvest_events : (data.recent_harvests || []));
  const rows = compact ? log.slice(0, 5) : log.slice(0, 12);
  if (!rows.length) {
    return `<div class="empty"><b>No harvest attempt is on record in this window.</b>
      The batcher fires the moment a relay slot exists; with zero usable slots it makes no attempt at all,
      and an attempt it never made is not an attempt it failed.
      <span class="when">${m.eta && m.eta.value !== null ? `Next attempt after the forecast refill, ~${Number(m.eta.value).toFixed(1)}h on ${esc(m.eta.chain || 'unknown chain')}.` : 'Next attempt at the next observed refill.'}</span></div>`;
  }
  return `<div class="card scroll"><table>
    <thead><tr><th>when</th><th>chain</th><th>batched</th><th>earned</th><th>outcome</th><th>tx</th></tr></thead>
    <tbody>${rows.map(l => {
      const o = outcomeOf(l);
      const usd = num(l.earned_usd);
      const tokenAmt = num(l.eth_earned);
      const sym = CHAIN_TOKEN[l.chain] || 'wrapped native';
      const contracts = Array.isArray(l.batched_contracts) ? l.batched_contracts : null;
      const nBatched = num(l.batched) ?? num(l.batch);
      return `<tr>
        <td class="m d">${esc(String(l.at || '').slice(5, 16).replace('T', ' '))}</td>
        <td class="m d">${esc(l.chain || '—')}</td>
        <td class="m d">${contracts
          ? `<a href="${scoutUrl(l.chain)}/address/${esc(contracts[0])}" target="_blank" rel="noopener">${contracts.length} contracts</a>`
          : (nBatched !== null ? `${nBatched} contracts` : '—')}
          ${contracts ? '' : '<span class="sec">addresses not recorded for this entry</span>'}</td>
        <td class="m ${usd > 0 ? 'g' : 'd'}">${usd === null ? '—' : money(usd, 6)}
          <span class="sec">${tokenAmt === null ? '' : esc(sig(tokenAmt) + ' ' + sym)}</span></td>
        <td class="m ${o.tone === 'good' ? 'g' : o.tone === 'bad' ? 'r' : o.tone === 'warn' ? 'w' : 'd'}">${esc(o.kind)}
          ${o.detail ? `<span class="sec">${esc(String(o.detail).slice(0, 120))}</span>` : ''}</td>
        <td class="m">${l.tx ? `<a href="${scoutUrl(l.chain)}/tx/${esc(l.tx)}" target="_blank" rel="noopener">${esc(String(l.tx).slice(0, 12))}…</a>` : '<span class="d">—</span>'}</td>
      </tr>`;
    }).join('')}</tbody></table>
    <div class="tnote"><b>relayed: true</b> means the relay ACCEPTED the submission — not that a transaction
      happened. Rows marked UNCLASSIFIED have no terminal relay state recorded, so an infrastructure outage
      and a genuine zero payout cannot be told apart for them. Whether the relay-failure rate is new or
      chronic is <b>unknown</b>: terminal state is only recorded going forward, and every entry written
      before that change is unclassifiable.</div>
  </div>`;
}
