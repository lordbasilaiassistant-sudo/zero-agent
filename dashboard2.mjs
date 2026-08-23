/* ZERO — public dashboard v2 (2026-08-13).
 *
 * Replaces a 1,266-line page that shipped ~13,000 characters of prose and still framed everything
 * around a retired target. Anthony: "too many words, not actual info dense for numbers and basics
 * of their working flow" + "should auto-update easier", with two reference dashboards (Geckoboard
 * dark, Power BI light). Their shared grammar, which this file follows:
 *    huge KPI + delta vs target · labelled bar charts · arc gauge · insight list · tight panel grid
 *
 * RULES THIS FILE KEEPS:
 *  1. EVERY NUMBER COMES FROM THE PAYLOAD. No hardcoded balance/address/count anywhere — that is
 *     exactly how the old page went stale. If the system changes, this page changes with it.
 *  2. NO INVENTED DELTAS. A "vs target" only renders where a real target exists in the data
 *     ($1.00 phase-0 exit; 30 relay tx/day). We do not fabricate a "vs last month" we cannot compute.
 *  3. THE TWO EPOCHS ARE NEVER SUMMED. GENESIS I money came from a wallet that later took founder
 *     ETH. Adding them would make this page a lie.
 *  4. AUTO-UPDATES every 20s in place, so an open tab is never wrong for long.
 *  5. Theme-aware: light and dark both first-class.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
const int = (v) => { const x = n(v); return x === null ? '—' : x.toLocaleString('en-US'); };
const money = (v) => { const x = n(v); if (x === null) return '—'; if (x === 0) return '$0.00'; return Math.abs(x) < 0.01 ? '$' + x.toFixed(6) : '$' + x.toFixed(2); };
const ago = (iso) => { if (!iso) return '—'; const ms = Date.now() - new Date(iso).getTime(); if (!Number.isFinite(ms) || ms < 0) return '—'; const m = Math.floor(ms / 6e4); if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); return h < 48 ? h + 'h ago' : Math.floor(h / 24) + 'd ago'; };

/* Arc gauge — value in the middle, min/max at the ends, like the Power BI reference. */
function gauge(pct, label, centre) {
  const p = Math.max(0, Math.min(100, n(pct) ?? 0));
  const R = 52, C = Math.PI * R;                 // semicircle circumference
  const on = (p / 100) * C;
  return `<div class="gauge">
    <svg viewBox="0 0 140 82" role="img" aria-label="${esc(label)} ${p.toFixed(1)}%">
      <path d="M18 70 A52 52 0 0 1 122 70" fill="none" stroke="var(--track)" stroke-width="15" stroke-linecap="round"/>
      <path d="M18 70 A52 52 0 0 1 122 70" fill="none" stroke="var(--accent)" stroke-width="15" stroke-linecap="round"
            stroke-dasharray="${on.toFixed(1)} ${C.toFixed(1)}"/>
      <text x="70" y="66" text-anchor="middle" class="gv">${esc(centre)}</text>
    </svg>
    <div class="gends"><span>0</span><span>${esc(label)}</span><span>100%</span></div>
  </div>`;
}

/* Labelled bar chart — value printed above each bar, as in both references. */
function bars(rows) {
  const max = Math.max(1, ...rows.map(r => n(r[1]) ?? 0));
  return `<div class="bars">${rows.map(([k, v, sub]) => {
    const val = n(v) ?? 0;
    const h = Math.max(3, Math.round((val / max) * 100));
    return `<div class="bar"><div class="bval">${int(val)}</div>
      <div class="btrack"><div class="bfill" style="height:${h}%"></div></div>
      <div class="bk">${esc(k)}</div><div class="bsub">${esc(sub || '')}</div></div>`;
  }).join('')}</div>`;
}

export function dashboardHTML(d) {
  const g = d?.prospect?.grind || {};
  const bal = d?.balances || {};
  const health = d?.health || {};
  const life = d?.lifetime_earned || {};

  /* ── THE HEADLINE (rebuilt 2026-08-23, Anthony: "the frontend doesnt match reality ever") ──
     Three bugs were stacked in the tile this replaces, all confirmed against the live payload:
       1. UNITS. `earnedCum` summed harvest `wei_earned`, divided by 1e18 — an ETH QUANTITY — and
          printed it through money() with a "$". 0.0000115 ETH rendered as "$0.000011". Off by the
          ETH price, ~2,413x. Every harvest row already carries a priced `earned_usd` field sitting
          right next to the one the page misread.
       2. WINDOW. `recent_harvests` is the last EIGHT harvests, not a ledger. A tile labelled
          CUMULATIVE was a sliding window that FALLS as old harvests age out. (Same class as
          memory measurement-windows-expire.)
       3. SELF-FALSIFYING COPY. It printed "if held ever exceeded earned, this page would be lying"
          directly above earned $0.000011 / held $0.442298 — held exceeded earned by 40,000x.
     Fix: stop inventing an earnings number in the renderer. The worker already computes the honest
     ones, so render THOSE by name with their methods attached, and never average them.
     CAPABILITY vs NET WORTH is the distinction the old page erased. `holdings_note` in the payload
     says reporting the total as spendable overstated this agent 104x on 2026-08-12 — so the big
     number is capability, and net worth sits beside it, labelled as what it is. */
  const spendable = n(bal.spendable_liquid_native_eth_on_base_usd); // capability: liquid native ETH, Base EOA
  const heldNow = n(bal.holdings_usd);                              // net worth: every chain, BOTH accounts
  const TARGET = n(bal.phase0_target_usd) ?? 1.0;   // phase-0 exit, a real target in its own system
  /* The worker computes phase0_pct against this same capability figure. Take its number instead of
     recomputing, so page and API can never disagree about the one metric Anthony actually reads. */
  const pctTarget = n(bal.phase0_pct) ?? (spendable !== null ? (spendable / TARGET) * 100 : null);
  const pctHeld = heldNow !== null ? (heldNow / TARGET) * 100 : null;

  /* Earnings: three estimators that DISAGREE. The payload is explicit that they are never summed
     and never averaged, so show all three with what each one actually counts. */
  const eMeasured = n(life.measured_usd);      // code-measured ledger — under-covers, see coverage_note
  const eReported = n(life.self_reported_usd); // typed by the model into route_log — weakest evidence
  const eFloor = n(life.chain_floor_usd);      // nobody funded it, so everything it holds was earned

  const wins = n(d?.harvest_wins), attempts = n(d?.harvest_attempts);
  const hit = (wins !== null && attempts) ? (wins / attempts) * 100 : null;

  /* RELAY BUDGET. The old tile read `health.free_slots` / `d.capacity.free` — NEITHER PATH EXISTS
     in the payload (the real one is health.capacity.free), so it always fell through to the
     `?? RELAY_MAX` branch and printed a permanent "30 / 30" while its own Insights bullet on the
     same screen read "10 slots are free". And free != usable: those 10 free slots were on gnosis
     and unichain, chains with nothing harvestable, so usable capacity was 0. Both from the payload
     now, and usable is shown whenever it differs from free. */
  const cap = health.capacity || d?.capacity || {};
  const RELAY_MAX = n(cap.total) ?? 30;            // 6 chains x 5/day
  const relayFree = n(cap.free);
  const relayUsable = n(cap.usable);
  const deadChains = Array.isArray(cap.dead_chains) ? cap.dead_chains : [];

  const events = (d?.recent_harvests || []).slice(0, 24).reverse();
  const spark = (() => {
    if (events.length < 2) return '<div class="dim sm">not enough harvests on this wallet to plot yet</div>';
    const vals = events.map(e => Number(e.expected_wei || 0) / 1e18);
    const max = Math.max(...vals, 1e-12), W = 560, H = 90;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1) * W).toFixed(1)},${(H - (v / max) * (H - 12)).toFixed(1)}`);
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="recent harvest sizes">
      <polygon points="0,${H} ${pts.join(' ')} ${W},${H}" fill="var(--fillsoft)"/>
      <polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    </svg>`;
  })();

  // "Insights" panel — the Power BI narrative equivalent, but every line is a measured fact.
  const insights = [
    health.state ? `state ${health.state}${health.headline ? ' — ' + String(health.headline).split('.')[0] : ''}` : null,
    `${int(g.PROVEN_PAYING)} routes proven to pay an arbitrary caller`,
    `${int(g.callable_now)} callable right now, of ${int(g.total_candidates)} scanned`,
    hit !== null ? `${hit.toFixed(1)}% of ${int(attempts)} harvest attempts landed` : null,
    `gas sponsored — ${int(RELAY_MAX)} free relay tx/day, $0 cost · ${relayFree === null ? '—' : int(relayFree)} unspent right now, ${relayUsable === null ? '—' : int(relayUsable)} of them usable`,
    `${int(d?.chain_reads?.chains_read_ok)}/${int(d?.chain_reads?.chains_configured)} chains reading OK`,
    `${int(d?.sessions_completed)} sessions run · last ${ago(d?.last_session)}`,
  ].filter(Boolean);

  /* EVERY tx link pointed at basescan.org regardless of chain. The last eight harvests all ran on
     arbitrum and optimism, so every receipt on the page was a dead link — on a page whose entire
     pitch is "check it yourself". A verification link that 404s is worse than no link. */
  const EXPLORER = {
    base: 'https://basescan.org/tx/',
    arbitrum: 'https://arbiscan.io/tx/',
    optimism: 'https://optimistic.etherscan.io/tx/',
    polygon: 'https://polygonscan.com/tx/',
    gnosis: 'https://gnosisscan.io/tx/',
    unichain: 'https://uniscan.xyz/tx/',
  };
  const txLink = (chain, tx) => {
    const base = EXPLORER[String(chain || '').toLowerCase()];
    if (!tx) return '—';
    const short = esc(String(tx).slice(0, 8)) + '…';
    return base ? `<a href="${base}${esc(tx)}" rel="noopener">${short}</a>` : `<span class="mono">${short}</span>`;
  };

  const harvestRows = (d?.recent_harvests || []).slice(0, 7).map(h => `<tr>
      <td class="dim mono">${esc((h.at || '').slice(5, 16).replace('T', ' '))}</td>
      <td>${esc(h.chain || '—')}</td>
      <td class="mono r">${int(h.batched)}</td>
      <td class="mono r">${n(h.earned_usd) === null ? '—' : '$' + Number(h.earned_usd).toFixed(6)}</td>
      <td class="mono">${txLink(h.chain, h.tx)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="dim">no harvests on this wallet yet</td></tr>';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZERO — autonomous agent, live</title>
<meta name="description" content="ZERO: an AI agent earning crypto from an unfunded wallet. Live measured numbers, no human in the loop.">
<style>
  :root{
    --bg:#f4f6fa; --panel:#ffffff; --line:#e2e7ef; --fg:#131a24; --dim:#69768a;
    --accent:#12b886; --accent2:#f0b429; --track:#e6ebf2; --fillsoft:rgba(18,184,134,.13);
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    --shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.05);
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#0b0f16; --panel:#151b26; --line:#242d3c; --fg:#e9eef7; --dim:#8493a8;
    --track:#222b39; --fillsoft:rgba(18,184,134,.16);
    --shadow:0 1px 2px rgba(0,0,0,.4);
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:1120px;margin:0 auto;padding:22px 18px 56px}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  .mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
  .dim{color:var(--dim)} .sm{font-size:12px} .r{text-align:right}
  header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  h1{font-size:27px;margin:0;letter-spacing:-.02em}
  .tag{font-size:12px;color:var(--dim)}
  .live{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--accent);
    border:1px solid var(--accent);border-radius:99px;padding:2px 9px}
  .dot{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:p 2s infinite}
  @keyframes p{0%,100%{opacity:1}50%{opacity:.25}}
  .sub{color:var(--dim);font-size:13px;margin:4px 0 18px}
  .g{display:grid;gap:12px;margin-bottom:12px}
  .g3{grid-template-columns:repeat(3,1fr)}
  .g2{grid-template-columns:2fr 1fr}
  .p{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;box-shadow:var(--shadow)}
  .pt{font-size:12px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.07em;margin:0 0 10px}
  .kpi{font-family:var(--mono);font-size:42px;font-weight:700;letter-spacing:-.03em;line-height:1}
  .kpi small{font-size:20px;font-weight:600}
  .delta{display:inline-flex;align-items:center;gap:5px;font-weight:700;color:var(--accent);font-size:15px;margin-left:10px}
  .dlabel{font-size:11px;color:var(--dim);font-weight:500;display:block;margin-top:2px}
  .row{display:flex;align-items:flex-end;flex-wrap:wrap}
  .bars{display:flex;gap:14px;align-items:flex-end;height:150px;margin-top:6px}
  .bar{flex:1;display:flex;flex-direction:column;align-items:center;height:100%}
  .bval{font-family:var(--mono);font-size:12px;font-weight:600;margin-bottom:4px}
  .btrack{flex:1;width:100%;display:flex;align-items:flex-end}
  .bfill{width:100%;background:var(--accent2);border-radius:4px 4px 0 0}
  .bar:last-child .bfill{background:var(--accent)}
  .bk{font-size:11px;font-weight:600;margin-top:6px}
  .bsub{font-size:10px;color:var(--dim);text-align:center}
  .gauge svg{width:100%;height:auto;max-width:190px;display:block;margin:0 auto}
  .gv{font-family:var(--mono);font-size:22px;font-weight:700;fill:var(--fg)}
  .gends{display:flex;justify-content:space-between;font-size:10px;color:var(--dim);max-width:190px;margin:2px auto 0}
  .spark{width:100%;height:90px;display:block}
  /* Two-tone progress: the wide bar is net worth, the bright bar inside it is what is actually
     spendable. The gap between them IS the "held but not yet usable" story, drawn to scale. */
  .prog{position:relative;height:7px;border-radius:99px;background:var(--track);margin-top:12px;overflow:hidden}
  .pf{position:absolute;left:0;top:0;height:100%;border-radius:99px;background:var(--accent2);opacity:.45}
  .pf2{background:var(--accent);opacity:1}
  .delta.warn{color:var(--accent2);border-color:var(--accent2)}
  td.acct{font-variant-numeric:tabular-nums}
  tr.tot td{border-top:1px solid var(--line);border-bottom:0;font-weight:700}
  ul.ins{list-style:none;margin:0;padding:0;font-size:13px}
  ul.ins li{padding:6px 0;border-bottom:1px solid var(--line);display:flex;gap:8px}
  ul.ins li:last-child{border-bottom:0}
  ul.ins li::before{content:"▸";color:var(--accent);flex:none}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);
    padding:0 6px 7px 0;border-bottom:1px solid var(--line)}
  td{padding:7px 6px 7px 0;border-bottom:1px solid var(--line)}
  dl.kv{display:grid;grid-template-columns:120px 1fr;gap:5px 12px;font-size:13px;margin:0}
  dl.kv dt{color:var(--dim)} dl.kv dd{margin:0;overflow-wrap:anywhere}
  footer{margin-top:26px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--dim)}
  @media (max-width:900px){.g3,.g2{grid-template-columns:1fr}.kpi{font-size:34px}}
</style></head><body><div class="wrap">

<header>
  <h1>ZERO</h1>
  <span class="live"><span class="dot"></span><span id="livetxt">live</span></span>
  <span class="tag">autonomous · unfunded · no human in the loop</span>
</header>
<p class="sub">Earning crypto from a wallet nobody funded. Wallet reset <span class="mono">2026-08-13</span> — every figure below is the clean epoch.</p>

<div class="g g3">
  <div class="p">
    <p class="pt">Spendable right now — no permission needed</p>
    <div class="row"><div class="kpi" id="k-spend">${spendable === null ? '—' : '$' + spendable.toFixed(6)}</div>
      <span class="delta">${pctTarget === null ? '—' : pctTarget.toFixed(1) + '%'}<span class="dlabel">of $${TARGET.toFixed(2)} phase-0 exit</span></span></div>
    <div class="prog" title="progress toward the $${TARGET.toFixed(2)} phase-0 exit">
      <div class="pf" style="width:${Math.max(0, Math.min(100, pctHeld ?? 0)).toFixed(2)}%"></div>
      <div class="pf pf2" style="width:${Math.max(0, Math.min(100, pctTarget ?? 0)).toFixed(2)}%"></div>
    </div>
    <div class="sm dim" style="margin-top:8px">
      Native ETH at the EOA on Base. Nobody can revoke it, no relay slot required.
    </div>
    <div class="sm" style="margin-top:8px">
      <strong id="k-held">${heldNow === null ? '—' : '$' + heldNow.toFixed(6)}</strong>
      <span class="dim">net worth — every chain, both accounts (${pctHeld === null ? '—' : pctHeld.toFixed(1)}% of target).
      Wrapped and off-chain value counts here but cannot be spent until it is swept home.</span>
    </div>
  </div>
  <div class="p">
    <p class="pt">Free gas — relay budget today</p>
    <div class="row"><div class="kpi"><span id="k-relay">${relayFree === null ? '—' : int(relayFree)} / ${int(RELAY_MAX)}</span></div>
      ${relayUsable !== null && relayUsable !== relayFree
        ? `<span class="delta warn">${int(relayUsable)} usable<span class="dlabel">${deadChains.length ? 'free slots sit on ' + esc(deadChains.join(' + ')) : 'nothing to harvest on the free chains'}</span></span>`
        : ''}</div>
    <div class="sm dim" style="margin-top:10px">Safe public relayer · 5/day × ${int(n(cap.chains?.length) ?? 6)} chains · <strong>$0</strong>, no account, no key.
      ${relayUsable === 0 && relayFree ? 'Free is not the same as usable: a slot on a chain with nothing to harvest buys nothing.' : ''}</div>
  </div>
  <div class="p">
    <p class="pt">Harvest hit rate</p>
    ${gauge(hit ?? 0, 'wins / attempts', hit === null ? '—' : hit.toFixed(1) + '%')}
    <div class="sm dim r">${int(wins)} of ${int(attempts)} attempts</div>
  </div>
</div>

<div class="g g2">
  <div class="p">
    <p class="pt">Working flow — where the money is found and taken</p>
    ${bars([['scanned', g.total_candidates, 'contracts'], ['callable', g.callable_now, 'reachable now'], ['proven', g.PROVEN_PAYING, 'pay any caller'], ['executed', wins, 'landed']])}
    <div class="sm dim" style="margin-top:10px">It hunts contracts that pay whoever calls them. Because its gas is sponsored, it can profitably take payouts no gas-paying bot can touch — that asymmetry is the entire strategy.</div>
  </div>
  <div class="p">
    <p class="pt">Insights</p>
    <ul class="ins">${insights.map(i => `<li><span>${esc(i)}</span></li>`).join('')}</ul>
  </div>
</div>

<div class="g g2">
  <div class="p">
    <p class="pt">Where the money is — it must end as liquid Base ETH</p>
    ${(() => {
      /* Harvests pay in WETH ON THE CHAIN THEY RAN. That is EARNED, not SPENDABLE. Anthony's rule:
         it must ultimately become liquid ETH on Base. So the panel states, per chain, whether the
         value is home or still in transit — a glance should answer "how much can we actually use",
         never only "how much did we earn". */
      const rows = d?.balances?.all_chains_priced;
      if (!Array.isArray(rows) || !rows.length) {
        return `<p class="sm dim">per-chain balances not present in this payload — showing totals only</p>`;
      }
      /* ⚠️ token_usd is the PRICE OF ONE TOKEN, not our holding. Reading it as a balance made the
         panel announce "$1,885 on optimism" when we held $0.0138 — a 136,000x overstatement on the
         one screen Anthony reads. Our value is eoa_native_usd + safe_usd + usdc_usd.

         ── AND THE REASON THIS TABLE WAS REBUILT (Anthony, 2026-08-23): "it doesnt add up both
         smart and non smart wallets for balance." ZERO holds value in TWO places — a plain EOA
         (0xC949…) and its Safe smart account (0x75d9…) — and this panel silently merged them into
         one number per chain. Worse, it then labelled the merged base figure "LIQUID · native ETH
         on Base" when only the EOA slice is native ETH: $0.415010 shown, of which the actually
         liquid native ETH was $0.375363. The other $0.039647 was Safe WETH plus Safe USDC — two
         assets that are neither liquid nor native nor ETH, wearing that label. A 10.6% overstatement
         of the exact number the whole page is about.
         So: one column per ACCOUNT, one per asset kind, and a TOTAL row that visibly sums to the
         net-worth figure in the headline. If the columns stop adding up, the page shows it. */
      const cells = rows.map(r => {
        const eoa = n(r.eoa_native_usd) ?? 0;               // liquid native — the only spendable kind
        const safeWrapped = n(r.safe_usd) ?? 0;             // wrapped native inside the Safe
        const eoaWrapped = n(r.eoa_usd) ?? 0;               // wrapped stranded at the EOA (rare)
        const usdc = n(r.usdc_usd) ?? 0;
        const ours = eoa + safeWrapped + eoaWrapped + usdc;
        if (ours <= 0) return null;
        return { chain: String(r.chain || '—'), eoa, safe: safeWrapped + eoaWrapped, usdc, ours };
      }).filter(Boolean);

      if (!cells.length) return '<p class="sm dim">nothing held yet</p>';
      const sum = (k) => cells.reduce((t, c) => t + c[k], 0);
      const cash = (v) => v === 0 ? '<span class="dim">—</span>' : '$' + v.toFixed(6);
      const body = cells.map(c => {
        const home = c.chain.toLowerCase() === 'base';
        return `<tr>
          <td>${esc(c.chain)}${home ? ' <span class="sm dim">home</span>' : ''}</td>
          <td class="mono r acct">${c.eoa === 0 ? '<span class="dim">—</span>' : '<strong>$' + c.eoa.toFixed(6) + '</strong>'}</td>
          <td class="mono r acct dim">${cash(c.safe)}</td>
          <td class="mono r acct dim">${cash(c.usdc)}</td>
          <td class="mono r acct">$${c.ours.toFixed(6)}</td>
        </tr>`;
      }).join('');
      /* RECONCILIATION. The columns are summed here from the per-chain rows, and the headline net
         worth comes from the worker's own aggregate. They are two independent paths to the same
         number, so print the gap instead of trusting either: a table that cannot be checked against
         the number above it is the thing being fixed. A few micro-dollars of gap is expected — each
         chain marks its holdings at its OWN price quote, fetched moments apart (optimism read
         $2,414.13 while the aggregate used $2,414.25). Anything larger is a defect and says so. */
      const colTotal = sum('ours');
      const gap = heldNow === null ? null : colTotal - heldNow;
      /* The worker publishes its own verdict in balances.price_coherence — prefer it, because it is
         computed where the prices are and can see WHY they agree. Fall back to the local comparison
         when an older payload does not carry it. */
      const verdict = bal.price_coherence;
      const material = verdict ? verdict.price_coherent === false
        : (gap !== null && Math.abs(gap) > Math.max(1e-6, Math.abs(heldNow) * 0.0001));
      const recon = gap === null
        ? ''
        : material
          ? `<p class="sm" style="margin-top:8px;color:var(--accent2)"><strong>Reconciliation gap ${gap > 0 ? '+' : '−'}$${Math.abs(gap).toFixed(6)}</strong>
             — these rows and the net-worth figure above disagree. Trust neither until it is explained:
             it means something priced the same balance twice.</p>`
          : `<p class="sm dim" style="margin-top:8px">Rows sum to $${colTotal.toFixed(6)}, and the net worth above is
             $${heldNow.toFixed(6)} — the same number by two independent paths, marked at one price table.
             The check runs on every request and would say so here if they ever diverged.</p>`;
      return `<table><thead><tr>
          <th>chain</th>
          <th class="r">EOA · native</th>
          <th class="r">Safe · wrapped</th>
          <th class="r">USDC</th>
          <th class="r">total</th>
        </tr></thead><tbody>${body}
        <tr class="tot">
          <td>all chains</td>
          <td class="mono r acct">$${sum('eoa').toFixed(6)}</td>
          <td class="mono r acct">$${sum('safe').toFixed(6)}</td>
          <td class="mono r acct">$${sum('usdc').toFixed(6)}</td>
          <td class="mono r acct">$${colTotal.toFixed(6)}</td>
        </tr></tbody></table>
        <p class="sm dim" style="margin-top:8px">Only the <strong>EOA · native</strong> column is
        spendable — that column's Base cell is the headline number. Everything else is real value
        ZERO owns but cannot use until it is unwrapped or swept home.
        ${cells.length < (n(bal.chains_configured) ?? cells.length)
          ? `${int((n(bal.chains_configured) ?? 0) - cells.length)} of ${int(bal.chains_configured)} chains hold nothing and are omitted.`
          : ''}</p>
        ${recon}`;
    })()}
    <p class="note" style="margin-top:10px">Earnings arrive as <strong>WETH on whichever chain the
      harvest ran</strong> — earned, but not yet spendable. Target state is liquid ETH on Base;
      anything on another chain is a to-do, not a balance.</p>
  </div>
  <div class="p">
    <p class="pt">Last ${Math.min(7, (d?.recent_harvests || []).length)} harvests</p>
    ${spark}
    <table style="margin-top:10px"><thead><tr><th>when</th><th>chain</th><th class="r">batched</th><th class="r">earned</th><th>tx</th></tr></thead><tbody>${harvestRows}</tbody></table>
    <p class="sm dim" style="margin-top:8px">A recent window, not a total — these ${int((d?.recent_harvests || []).length)} rows are
      the most recent harvests the agent kept, and they age out. Every tx links to that chain's own explorer; check any of them.</p>
  </div>
  <div class="p">
    <p class="pt">Identity</p>
    <dl class="kv">
      <dt>wallet</dt><dd class="mono"><a href="${esc(d?.explorer || '#')}">${esc(String(d?.wallet || '—').slice(0, 12))}…</a></dd>
      <dt>smart acct</dt><dd class="mono"><a href="${esc(d?.smart_account_explorer || '#')}">${esc(String(d?.smart_account || '—').slice(0, 12))}…</a></dd>
      <dt>chains</dt><dd class="mono">${int(d?.chain_reads?.chains_read_ok)}/${int(d?.chain_reads?.chains_configured)} reading</dd>
      <dt>sessions</dt><dd class="mono" id="sessions">${int(d?.sessions_completed)}</dd>
    </dl>
    <p class="pt" style="margin-top:16px">Lifetime earned — three estimators that disagree</p>
    <dl class="kv">
      <dt>code-measured</dt><dd class="mono">${eMeasured === null ? '—' : '$' + eMeasured.toFixed(6)} <span class="dim">balance deltas written by harvest.mjs</span></dd>
      <dt>self-reported</dt><dd class="mono dim">${eReported === null ? '—' : '$' + eReported.toFixed(6)} · typed by the model into a route log</dd>
      <dt>chain floor</dt><dd class="mono">${eFloor === null ? '—' : '$' + eFloor.toFixed(6)} <span class="dim">nobody funded it, so everything it holds was earned</span></dd>
    </dl>
    <p class="sm dim" style="margin-top:8px">${esc(life.unresolved || '')}
      They are never summed and never averaged: the code-measured ledger under-covers, and the chain
      floor is a lower bound rather than a count. The honest reading is "at least the floor".</p>
    <p class="sm dim" style="margin-top:8px">Genesis I — the retired wallet — accepted 0.000107 ETH from a human
      to chase a token launch that ended worthless, ~41% of its balance. The work was real; the proof was not.
      Hence a clean wallet, and two epochs that are never added.</p>
  </div>
</div>

<footer>
  JSON: <a href="/">/</a> · <a href="/journal">/journal</a> · <a href="/ledger">/ledger</a> ·
  <a href="/genesis">/genesis</a> · <a href="/prospect">/prospect</a> ·
  <a href="/frontier">/frontier</a><br>
  Built by <a href="https://broke2builtai.com">Broke to Built</a> — a company of machines, building things it gives away.
</footer>
</div>
<script>
/* Auto-update: refetch the same JSON this page rendered from and patch the volatile figures in
   place every 20s. No full-document innerHTML, so scroll position and links survive. On failure we
   keep the last good numbers and flip the badge to "stale" rather than showing a wrong number. */
/* THIS BLOCK USED TO RE-INTRODUCE THE BUG THE SERVER SIDE HAD ALREADY FIXED. It patched the
   headline with balances.eth_like_total - an ETH QUANTITY - through a money() that just prefixes
   a dollar sign. So the server rendered one wrong number and 20 seconds later the client replaced
   it with a different wrong number. Patch only fields that are already USD in the payload, and
   never apply a currency format to a token amount. Arithmetic stays on the server. */
const set=(id,v)=>{const e=document.getElementById(id);if(e&&v!=null)e.textContent=v;};
const usd=v=>(v==null||isNaN(Number(v)))?'—':'$'+Number(v).toFixed(6);
async function tick(){
  try{
    const r=await fetch('/',{headers:{accept:'application/json'},cache:'no-store'});
    if(!r.ok)throw 0;
    const d=await r.json();
    const b=d&&d.balances||{};
    set('k-spend',usd(b.spendable_liquid_native_eth_on_base_usd));
    set('k-held',usd(b.holdings_usd));
    const cap=(d&&d.health&&d.health.capacity)||{};
    if(cap.free!=null&&cap.total!=null)set('k-relay',cap.free+' / '+cap.total);
    set('sessions',Number(d&&d.sessions_completed||0).toLocaleString('en-US'));
    set('livetxt','live');
  }catch(e){set('livetxt','stale');}
}
setInterval(tick,20000);
</script>
</body></html>`;
}
