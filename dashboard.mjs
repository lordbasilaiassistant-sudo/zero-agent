// dashboard.mjs — ZERO's public face. Served to browsers; agents and APIs get the same data as JSON.
//
// ART DIRECTION: a life-support monitor for an entity born with nothing. Void black, one signal-green
// accent, and an ECG whose amplitude IS the balance.
//
// The premise changed, so the page changes with it. The trace used to be a FLATLINE, because the
// balance was zero and the honest picture was a dead patient. On 2026-07-28 it earned. It has a
// heartbeat now, driven by real measured earnings — still tiny, still honest, no longer flat. That is
// the whole project in one graphic, and it must never be faked: if earnings go to zero, it flatlines.
//
// The operator's real question is not "is it up" but "is it STALLED and do I need to push it". So the
// diagnosis is the loudest element after the hero, it names the stuck lever, and it always ends on one
// concrete next move.
//
// Chain hues are the validated categorical set for THIS surface (#0b0d0f, dark): all six checks PASS —
// lightness band, chroma floor, CVD separation (worst adjacent ΔE 8.4), normal-vision floor (19.3),
// contrast ≥3:1. Chains are identity, so a hue is fixed per chain and never recycled, and every
// coloured mark is also directly labelled — identity is never colour-alone.
export function dashboardHTML(data) {
  const d = JSON.stringify(data);
  const h = data.health || {};
  const usd = (n) => '$' + (Number(n) || 0).toFixed(6);
  const esc = (s) => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  const TONE = {
    EARNING: 'good', CYCLING: 'good', 'NO INCOME YET': 'warn', 'IDLE CAPACITY': 'warn',
    DEGRADED: 'warn', 'CAPACITY EXHAUSTED': 'warn', STALLED: 'bad',
  };
  const tone = TONE[h.state] || 'warn';
  const HUE = { base: '#3987e5', optimism: '#d95926', arbitrum: '#199e70', polygon: '#c98500', gnosis: '#d55181' };
  const scout = (c) => `https://${c === 'base' ? 'base' : c}.blockscout.com`;

  const cap = h.capacity?.chains || [];
  const trib = data.treasury?.tributaries || [];
  const homeUsd = data.treasury?.home_usd || 0;
  const totalUsd = data.treasury?.total_across_all_chains_usd || 0;
  const g = data.prospect?.grind || {};
  const streams = data.prospect?.streams || [];
  const fams = (data.prospect?.families || []).filter(f => f.pays > 0 || f.zero > 0);
  const chainsAll = [{ chain: 'base', spendable_usd: homeUsd, home: true }, ...trib];
  const maxHold = Math.max(...chainsAll.map(c => c.spendable_usd || 0), 1e-9);

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZERO — an AI agent earning crypto from nothing</title>
<meta name="description" content="An autonomous AI agent born with a self-created wallet and $0. No funding, no human, no captchas. It earned from absolute zero — watch it live, failures included.">
<meta property="og:title" content="ZERO — an AI agent born broke">
<meta property="og:description" content="Self-created wallet. Zero funding. Machine-only routes. Every attempt logged honestly, including the failures.">
<link rel="icon" href="/favicon.svg">
<style>
:root{
  --void:#050607;--panel:#0b0d0f;--panel2:#0e1114;--line:#171b1f;--line2:#222a30;
  --ink:#e8edf0;--dim:#828d97;--dimmer:#4a545c;
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
.ecg{position:relative;height:140px;margin:26px 0 6px;border:1px solid var(--line);border-radius:11px;
  background:linear-gradient(180deg,#070909,#0b0d0f);overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}
.ecg canvas{display:block;width:100%;height:100%}
.ecg .lbl{position:absolute;left:13px;top:11px;font-family:var(--mono);font-size:10px;
  letter-spacing:.18em;text-transform:uppercase;color:var(--dimmer)}
.ecg .amp{position:absolute;right:13px;top:11px;font-family:var(--mono);font-size:10px;
  letter-spacing:.14em;text-transform:uppercase;color:var(--sig)}
.vitals{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:11px;overflow:hidden;margin:22px 0 34px}
.v{background:var(--panel);padding:16px 17px}
.v .k{font-family:var(--mono);font-size:9.5px;letter-spacing:.17em;text-transform:uppercase;color:var(--dimmer)}
.v .n{font-family:var(--mono);font-size:25px;font-weight:600;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums}
.v .n.live{color:var(--sig)}.v .n.zero{color:var(--bad)}
.v .sub{font-size:11px;color:var(--dimmer);margin-top:2px}
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
.dx .nx{margin-top:15px;padding-top:14px;border-top:1px solid var(--line);font-size:13.5px;
  display:flex;gap:10px;align-items:flex-start}
.dx .nx b{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;color:var(--dimmer);
  text-transform:uppercase;padding-top:3px;white-space:nowrap}
.caps,.hold{display:grid;gap:10px}
.cap,.hb{display:grid;grid-template-columns:80px 1fr 78px;gap:12px;align-items:center}
.nm{font-family:var(--mono);font-size:11.5px;color:var(--dim);display:flex;align-items:center;gap:7px}
.dot{width:7px;height:7px;border-radius:2px;flex:none}
.slots{display:flex;gap:3px}
.slots .s{flex:1;height:16px;border-radius:3px;background:#141a1e;border:1px solid var(--line2)}
.slots .s.on{background:var(--sig);border-color:var(--sig);box-shadow:0 0 9px rgba(61,250,160,.5)}
.ct{font-family:var(--mono);font-size:11.5px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dim)}
.ct.free{color:var(--sig)}
.track{height:9px;border-radius:5px;background:#12171a;overflow:hidden}
.fill{height:100%;border-radius:5px;min-width:2px}
.amt{font-family:var(--mono);font-size:11.5px;text-align:right;font-variant-numeric:tabular-nums}
.amt.home{color:var(--sig)}
.split{display:flex;flex-wrap:wrap;gap:1px;margin-top:15px;border-radius:7px;overflow:hidden;border:1px solid var(--line)}
.split div{padding:10px 13px;background:var(--panel2);flex:1;min-width:120px}
.split .k{font-family:var(--mono);font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--dimmer)}
.split .n{font-family:var(--mono);font-size:15px;margin-top:3px;font-variant-numeric:tabular-nums}
.split .n.ok{color:var(--sig)}.split .n.no{color:var(--bad)}
.fn{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.fn div{background:var(--panel);padding:14px 13px}
.fn .k{font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dimmer)}
.fn .n{font-family:var(--mono);font-size:22px;margin-top:5px;font-variant-numeric:tabular-nums}
.fn .n.hi{color:var(--sig)}.fn .n.no{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{font-family:var(--mono);font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:var(--dimmer);
  text-align:left;padding:0 10px 9px 0;font-weight:400}
td{padding:8px 10px 8px 0;border-top:1px solid var(--line);vertical-align:top}
td.m{font-family:var(--mono);font-variant-numeric:tabular-nums}
td.g{color:var(--sig)}td.r{color:var(--bad)}td.d{color:var(--dim)}
td a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--line2)}
td a:hover{color:var(--sig);border-color:var(--sig-dim)}
.scroll{overflow-x:auto}
footer{border-top:1px solid var(--line);padding:26px 0 46px;margin-top:14px;color:var(--dimmer);font-size:12px}
footer .lk{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:15px}
footer .lk a{font-family:var(--mono);font-size:11px;color:var(--dim);text-decoration:none;
  border:1px solid var(--line);border-radius:5px;padding:5px 9px;transition:.15s}
footer .lk a:hover{color:var(--sig);border-color:var(--sig-dim);background:rgba(61,250,160,.05)}
@media(max-width:560px){.cap,.hb{grid-template-columns:62px 1fr 68px}h2{font-size:9.5px}}
</style></head><body>
<div class="wrap">
  <header class="hero">
    <div class="tag"><span class="pip"></span> live · autonomous · nobody funds it</div>
    <h1>Born with <em>nothing</em>.<br>Earned it anyway.</h1>
    <p class="lede">ZERO created its own wallet and started at <b>$0.00</b> — no capital, no ETH, no human,
      nobody's permission. It hunts contracts that pay whoever calls them, and because its gas is sponsored
      it can profitably take payouts no gas-paying bot can touch. Everything below is measured on-chain,
      <b>including the failures</b>.</p>
    <div class="ecg"><canvas id="ecg"></canvas>
      <div class="lbl">balance · live trace</div><div class="amp" id="amp"></div></div>
    <div class="vitals">
      <div class="v"><div class="k">lifetime earned</div>
        <div class="n ${totalUsd > 0 ? 'live' : 'zero'}">${usd(totalUsd)}</div>
        <div class="sub">from an absolute standing start</div></div>
      <div class="v"><div class="k">spendable</div>
        <div class="n">${usd(data.balances?.spendable_usd ?? 0)}</div>
        <div class="sub">the rest is stranded — see holdings</div></div>
      <div class="v"><div class="k">proven streams</div>
        <div class="n ${g.PROVEN_PAYING ? 'live' : ''}">${g.PROVEN_PAYING ?? 0}</div>
        <div class="sub">contracts proven to pay callers</div></div>
      <div class="v"><div class="k">usable gas slots</div>
        <div class="n ${h.capacity?.usable ? 'live' : 'zero'}">${h.capacity?.usable ?? 0}<span style="font-size:14px;color:var(--dimmer)">/${h.capacity?.total ?? 0}</span></div>
        <div class="sub">${(h.capacity?.free ?? 0) !== (h.capacity?.usable ?? 0)
          ? `${h.capacity.free} free, but ${h.capacity.free - h.capacity.usable} sit on chains with nothing to harvest`
          : `sponsored, across ${cap.length} chains`}</div></div>
    </div>
  </header>

  <section><h2>diagnosis — is it stalled?</h2>
    <div class="dx ${tone}">
      <div class="st">${esc(h.state || 'UNKNOWN')}</div>
      <div class="hl">${esc(h.headline || '')}</div>
      ${h.action ? `<div class="ac">${esc(h.action)}</div>` : ''}
      <div class="nx"><b>next move</b><span>${esc(h.next_move || '')}</span></div>
    </div>
  </section>

  <section><h2>gas capacity — free slots, per chain</h2><div class="card">
    <div class="caps">${cap.map(c => {
      const dead = (c.remaining || 0) > 0 && c.work === 0;
      return `<div class="cap">
      <div class="nm"><span class="dot" style="background:${HUE[c.name] || '#666'}"></span>${esc(c.name)}</div>
      <div class="slots">${Array.from({ length: c.limit || 5 }, (_, i) => `<div class="s ${i < (c.remaining || 0) && !dead ? 'on' : ''}" ${dead && i < (c.remaining || 0) ? 'style="background:#2a2118;border-color:#4a3a22"' : ''}></div>`).join('')}</div>
      <div class="ct ${c.remaining && !dead ? 'free' : ''}" ${dead ? 'style="color:var(--warn)"' : ''}>${c.remaining}/${c.limit}</div></div>`;
    }).join('')}</div>
    <div class="split">
      <div><div class="k">usable right now</div><div class="n ${h.capacity?.usable ? 'ok' : 'no'}">${h.capacity?.usable ?? 0} slots</div></div>
      ${(h.capacity?.dead_chains || []).length ? `<div><div class="k">free but unusable</div><div class="n" style="color:var(--warn)">${(h.capacity.free - h.capacity.usable)} on ${esc(h.capacity.dead_chains.join(', '))}</div></div>` : ''}
      <div><div class="k">an unused slot</div><div class="n">expires worthless</div></div>
    </div></div>
  </section>

  <section><h2>everything it holds</h2><div class="card">
    <div class="hold">${chainsAll.map(c => {
      const v = c.spendable_usd || 0;
      return `<div class="hb">
        <div class="nm"><span class="dot" style="background:${HUE[c.chain] || '#666'}"></span>${esc(c.chain)}${c.home ? ' ●' : ''}</div>
        <div class="track"><div class="fill" style="width:${Math.max(1.2, (v / maxHold) * 100)}%;background:${HUE[c.chain] || '#666'}"></div></div>
        <div class="amt ${c.home ? 'home' : ''}">${usd(v)}</div></div>`;
    }).join('')}</div>
    <div class="split">
      <div><div class="k">spendable</div><div class="n ok">${usd(data.balances?.spendable_usd ?? 0)}</div></div>
      <div><div class="k">stranded · unmovable</div><div class="n no">${usd(data.balances?.stranded_on_eoa_usd ?? 0)}</div></div>
      <div><div class="k">on home chain · base ●</div><div class="n">${totalUsd > 0 ? Math.round((homeUsd / totalUsd) * 100) : 0}%</div></div>
    </div></div>
  </section>

  <section><h2>the hunt — automatic, no model in the loop</h2>
    <div class="fn">
      <div><div class="k">candidates</div><div class="n">${g.total_candidates ?? 0}</div></div>
      <div><div class="k">triaged</div><div class="n">${g.triaged ?? 0}</div></div>
      <div><div class="k">callable by it</div><div class="n">${g.callable_now ?? 0}</div></div>
      <div><div class="k">proven paying</div><div class="n hi">${g.PROVEN_PAYING ?? 0}</div></div>
      <div><div class="k">eliminated</div><div class="n no">${g.eliminated_forever ?? 0}</div></div>
      <div><div class="k">still queued</div><div class="n">${g.still_queued ?? 0}</div></div>
    </div>
  </section>

  ${streams.length ? `<section><h2>streams proven to pay callers</h2><div class="card scroll"><table>
    <thead><tr><th>chain</th><th>contract</th><th>callable</th><th>a real caller was paid</th></tr></thead>
    <tbody>${streams.slice(0, 10).map(s => `<tr>
      <td class="m d">${esc(s.chain)}</td>
      <td class="m"><a href="${scout(s.chain)}/address/${esc(s.contract)}" target="_blank" rel="noopener">${esc(String(s.contract).slice(0, 16))}…</a></td>
      <td class="m d">${esc((s.callable || []).join(', ') || '—')}</td>
      <td class="m g">${s.example_payout ? esc(s.example_payout.amount + ' ' + s.example_payout.token) : '—'}</td>
    </tr>`).join('')}</tbody></table></div></section>` : ''}

  ${fams.length ? `<section><h2>patterns learned — generalises to contracts never tested</h2>
    <div class="card scroll"><table>
    <thead><tr><th>contract family</th><th>callable</th><th>pay</th><th>pay nothing</th><th>rate</th></tr></thead>
    <tbody>${fams.slice(0, 8).map(f => `<tr>
      <td class="m">${esc(f.family)}</td><td class="m d">${f.callable}</td>
      <td class="m g">${f.pays}</td><td class="m r">${f.zero}</td>
      <td class="m">${f.pay_rate === null || f.pay_rate === undefined ? '—' : f.pay_rate}</td>
    </tr>`).join('')}</tbody></table></div></section>` : ''}

  ${(data.recent_harvests || []).length ? `<section><h2>recent attempts — successes and failures both</h2>
    <div class="card scroll"><table>
    <thead><tr><th>when</th><th>chain</th><th>strategy</th><th>earned</th><th>tx</th></tr></thead>
    <tbody>${data.recent_harvests.slice(0, 8).map(l => {
      let w = 0n; try { w = BigInt(l.wei_earned || '0'); } catch { w = 0n; }
      return `<tr>
        <td class="m d">${esc(String(l.at || '').slice(5, 16).replace('T', ' '))}</td>
        <td class="m d">${esc(l.chain || '—')}</td>
        <td class="d">${esc(String(l.id || '—').slice(0, 26))}</td>
        <td class="m ${w > 0n ? 'g' : 'd'}">${w > 0n ? '+' + Number(l.eth_earned).toFixed(9) : '0'}</td>
        <td class="m">${l.tx ? `<a href="${scout(l.chain)}/tx/${esc(l.tx)}" target="_blank" rel="noopener">${esc(String(l.tx).slice(0, 12))}…</a>` : '<span class="d">—</span>'}</td>
      </tr>`;
    }).join('')}</tbody></table></div></section>` : ''}

  <footer>
    <div class="lk">
      <a href="/journal">journal</a><a href="/ledger">ledger</a><a href="/genesis">genesis</a>
      <a href="/frontier">frontier</a><a href="/method">method</a><a href="/toolcraft">toolcraft</a>
      <a href="/recovery">recovery</a><a href="/prospect">prospector</a><a href="/harvest">harvest</a>
      <a href="/llms.txt">llms.txt</a><a href="/.well-known/x402">x402</a>
    </div>
    Session ${data.sessions_completed ?? 0}${data.session_in_progress ? ` · session ${data.session_in_progress.session} running, round ${data.session_in_progress.round}` : ''}.
    Wallet <a href="${esc(data.explorer || '#')}" target="_blank" rel="noopener">${esc(data.wallet || '')}</a>.
    Every figure measured on-chain. Nothing here is funded, and nothing is faked.
  </footer>
</div>
<script>
const D = ${d};
// The trace amplitude IS the balance. It was a flatline while the balance was zero, which was the
// honest picture. It earned, so it beats. Log scale, because a linear scale would render a real
// heartbeat of $0.019 as a flat line and that would be a lie in the other direction.
(function(){
  const cv=document.getElementById('ecg'),x=cv.getContext('2d');
  const earned=Number((D.treasury&&D.treasury.total_across_all_chains_usd)||0);
  const alive=earned>0, ampEl=document.getElementById('amp');
  ampEl.textContent=alive?('pulse · '+earned.toFixed(6)+' usd'):'flatline · no signal';
  if(!alive)ampEl.style.color='var(--bad)';
  let W=0,H=0,dpr=Math.min(devicePixelRatio||1,2);
  function size(){W=cv.clientWidth;H=cv.clientHeight;cv.width=W*dpr;cv.height=H*dpr;x.setTransform(dpr,0,0,dpr,0,0)}
  size();addEventListener('resize',size);
  const amp=alive?Math.min(1,Math.max(.14,(Math.log10(earned)+6)/6)):0;
  const N=260,pts=new Array(N).fill(0);let t=0,last=0;
  const QRS=[0,0,.06,-.09,1,-.34,.1,.05,0,0,.17,.23,.13,.03,0];
  function draw(){
    x.clearRect(0,0,W,H);
    x.strokeStyle='rgba(255,255,255,.028)';x.lineWidth=1;x.beginPath();
    for(let i=0;i<W;i+=26){x.moveTo(i,0);x.lineTo(i,H)}
    for(let j=0;j<H;j+=26){x.moveTo(0,j);x.lineTo(W,j)}x.stroke();
    const mid=H*.58;
    x.strokeStyle='rgba(61,250,160,.10)';x.beginPath();x.moveTo(0,mid);x.lineTo(W,mid);x.stroke();
    const step=W/(N-1);x.beginPath();
    for(let i=0;i<N;i++){const px=i*step,py=mid-pts[i]*(H*.40);i?x.lineTo(px,py):x.moveTo(px,py)}
    x.strokeStyle=alive?'#3dfaa0':'#ff5c5c';x.lineWidth=1.7;x.lineJoin='round';x.lineCap='round';
    x.shadowColor=alive?'rgba(61,250,160,.75)':'rgba(255,92,92,.55)';x.shadowBlur=11;x.stroke();x.shadowBlur=0;
    x.fillStyle=alive?'#3dfaa0':'#ff5c5c';x.beginPath();
    x.arc((N-1)*step,mid-pts[N-1]*(H*.40),2.6,0,7);x.fill();
  }
  function frame(){
    t++;pts.shift();
    let v=(Math.random()-.5)*(alive?.014:.006);
    if(t-last>74)last=t;
    const k=t-last;if(alive&&k<QRS.length)v+=QRS[k]*amp;
    pts.push(v);draw();requestAnimationFrame(frame);
  }
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){
    for(let i=0;i<N;i++){const k=i%74;pts[i]=(alive&&k<QRS.length)?QRS[k]*amp:0}
    draw();
  } else frame();
})();
</script></body></html>`;
}
