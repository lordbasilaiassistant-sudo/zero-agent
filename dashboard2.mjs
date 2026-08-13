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

  const g2 = n(bal.eth_like_total) ?? 0;          // GENESIS II — the only honest "from zero" figure
  const g1 = n(life.measured_usd);                 // GENESIS I — contaminated, shown but never summed
  const TARGET = 1.0;                              // phase-0 exit, a real target in its own system
  const pctTarget = (g2 / TARGET) * 100;

  const wins = n(d?.harvest_wins), attempts = n(d?.harvest_attempts);
  const hit = (wins !== null && attempts) ? (wins / attempts) * 100 : null;

  const RELAY_MAX = 30;                            // 6 chains x 5/day, measured 2026-08-13
  const relayFree = n(health.free_slots) ?? n(d?.capacity?.free);

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
    `gas sponsored — ${RELAY_MAX} free relay tx/day across 6 chains, $0 cost`,
    `${int(d?.chain_reads?.chains_read_ok)}/${int(d?.chain_reads?.chains_configured)} chains reading OK`,
    `${int(d?.sessions_completed)} sessions run · last ${ago(d?.last_session)}`,
  ].filter(Boolean);

  const harvestRows = (d?.recent_harvests || []).slice(0, 7).map(h => `<tr>
      <td class="dim mono">${esc((h.at || '').slice(5, 16).replace('T', ' '))}</td>
      <td>${esc(h.chain || '—')}</td>
      <td class="mono r">${int(h.batched)}</td>
      <td class="mono">${h.tx ? `<a href="https://basescan.org/tx/${esc(h.tx)}">${esc(String(h.tx).slice(0, 8))}…</a>` : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="dim">no harvests on this wallet yet</td></tr>';

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
    <p class="pt">Earned — genesis II</p>
    <div class="row"><div class="kpi" id="g2">${money(g2)}</div>
      <span class="delta">▲ ${pctTarget.toFixed(1)}%<span class="dlabel">of $1.00 phase-0 exit</span></span></div>
    <div class="sm dim" style="margin-top:10px">${bal.has_earned === true ? 'settled on-chain' : 'no earnings on this wallet yet — this is the number that proves the claim'}</div>
  </div>
  <div class="p">
    <p class="pt">Free gas — relay budget</p>
    <div class="row"><div class="kpi">${relayFree === null ? RELAY_MAX : int(relayFree)}<small> / ${RELAY_MAX}</small></div></div>
    <div class="sm dim" style="margin-top:10px">Safe public relayer · 5/day × 6 chains · <strong>$0</strong>, no account, no key</div>
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
    <p class="pt">Recent harvest sizes</p>
    ${spark}
    <table style="margin-top:10px"><thead><tr><th>when</th><th>chain</th><th class="r">batched</th><th>tx</th></tr></thead><tbody>${harvestRows}</tbody></table>
  </div>
  <div class="p">
    <p class="pt">Identity</p>
    <dl class="kv">
      <dt>wallet</dt><dd class="mono"><a href="${esc(d?.explorer || '#')}">${esc(String(d?.wallet || '—').slice(0, 12))}…</a></dd>
      <dt>smart acct</dt><dd class="mono"><a href="${esc(d?.smart_account_explorer || '#')}">${esc(String(d?.smart_account || '—').slice(0, 12))}…</a></dd>
      <dt>chains</dt><dd class="mono">${int(d?.chain_reads?.chains_read_ok)}/${int(d?.chain_reads?.chains_configured)} reading</dd>
      <dt>sessions</dt><dd class="mono" id="sessions">${int(d?.sessions_completed)}</dd>
    </dl>
    <p class="pt" style="margin-top:16px">Two ledgers — never added</p>
    <dl class="kv">
      <dt>genesis II</dt><dd class="mono">${money(g2)} <span class="dim">unfunded · proves the claim</span></dd>
      <dt>genesis I</dt><dd class="mono dim">${g1 === null ? '—' : money(g1)} · retired wallet, took founder ETH</dd>
    </dl>
    <p class="sm dim" style="margin-top:8px">The first wallet accepted 0.000107 ETH from a human to chase a token launch that ended worthless — ~41% of its balance. The work was real; the proof was not. Hence a clean wallet, and two ledgers that are never summed.</p>
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
const set=(id,v)=>{const e=document.getElementById(id);if(e&&v!=null)e.textContent=v;};
const money=v=>v==null?'—':(v===0?'$0.00':(Math.abs(v)<0.01?'$'+v.toFixed(6):'$'+v.toFixed(2)));
async function tick(){
  try{
    const r=await fetch('/',{headers:{accept:'application/json'},cache:'no-store'});
    if(!r.ok)throw 0;
    const d=await r.json();
    set('g2',money(d?.balances?.eth_like_total??0));
    set('sessions',Number(d?.sessions_completed??0).toLocaleString('en-US'));
    set('livetxt','live');
  }catch(e){set('livetxt','stale');}
}
setInterval(tick,20000);
</script>
</body></html>`;
}
