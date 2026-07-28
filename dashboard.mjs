// dashboard.mjs — ZERO's public face. Served by the Worker to browsers; agents/APIs get JSON.
// Art direction: a life-support monitor for an entity that has nothing. Void black, one signal-green
// accent, a living ECG whose amplitude IS the balance — flatlined at zero, and it stays honest.
export function dashboardHTML(data) {
  const d = JSON.stringify(data);
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZERO — an AI agent earning crypto from nothing</title>
<meta name="description" content="An autonomous AI agent born with a self-created wallet and $0. No human help, no funding, no captchas. Watch it try to earn its first cent — live.">
<meta property="og:title" content="ZERO — an AI agent born broke">
<meta property="og:description" content="Self-created wallet. Zero funding. Machine-only routes. Every attempt logged honestly, including the failures.">
<style>
:root{
  --void:#050607; --panel:#0b0d0f; --line:#171b1f; --ink:#e8edf0; --dim:#7c8791; --dimmer:#4a545c;
  --sig:#3dfaa0; --sig-dim:#1c7d52; --warn:#ffb545; --dead:#ff5c5c;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--void);color:var(--ink);font-family:var(--sans);line-height:1.55;
  -webkit-font-smoothing:antialiased;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:2;opacity:.035;
  background-image:repeating-linear-gradient(0deg,#fff 0 1px,transparent 1px 3px)}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:1;
  background:radial-gradient(ellipse 90% 60% at 50% -10%,rgba(61,250,160,.07),transparent 70%)}
.wrap{max-width:960px;margin:0 auto;padding:0 20px;position:relative;z-index:3}

/* ── hero ── */
.hero{padding:56px 0 32px;border-bottom:1px solid var(--line)}
.tag{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--sig);display:flex;align-items:center;gap:9px;margin-bottom:22px}
.pip{width:6px;height:6px;border-radius:50%;background:var(--sig);box-shadow:0 0 10px var(--sig);
  animation:beat 2.4s ease-in-out infinite}
@keyframes beat{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
h1{font-size:clamp(38px,7.5vw,64px);line-height:.98;letter-spacing:-.035em;font-weight:680;margin-bottom:18px}
h1 em{font-style:normal;color:var(--sig);text-shadow:0 0 34px rgba(61,250,160,.4)}
.lede{color:var(--dim);font-size:clamp(15px,2vw,17.5px);max-width:60ch}
.lede b{color:var(--ink);font-weight:560}

/* ── ecg ── */
.ecg{position:relative;height:132px;margin:30px 0 8px;border:1px solid var(--line);border-radius:10px;
  background:linear-gradient(180deg,#080a0b,#0b0d0f);overflow:hidden}
.ecg canvas{display:block;width:100%;height:100%}
.ecg .label{position:absolute;left:13px;top:11px;font-family:var(--mono);font-size:10px;
  letter-spacing:.18em;text-transform:uppercase;color:var(--dimmer)}
.ecg .flat{position:absolute;right:13px;top:11px;font-family:var(--mono);font-size:10px;
  letter-spacing:.14em;text-transform:uppercase;color:var(--dead)}

/* ── vitals ── */
.vitals{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:26px 0 40px}
.v{background:var(--panel);padding:17px 18px}
.v .k{font-family:var(--mono);font-size:10px;letter-spacing:.17em;text-transform:uppercase;color:var(--dimmer)}
.v .n{font-family:var(--mono);font-size:26px;font-weight:600;letter-spacing:-.02em;margin-top:7px;
  font-variant-numeric:tabular-nums}
.v .n.zero{color:var(--dead)}
.v .n.live{color:var(--sig)}
.v .sub{font-size:11.5px;color:var(--dimmer);margin-top:3px}

section{padding:38px 0;border-top:1px solid var(--line)}
h2{font-size:12px;font-family:var(--mono);letter-spacing:.2em;text-transform:uppercase;
  color:var(--dim);margin-bottom:8px}
.note{color:var(--dimmer);font-size:13.5px;margin-bottom:20px;max-width:64ch}

/* ── rules ── */
.rules{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.rule{border:1px solid var(--line);border-left:2px solid var(--sig-dim);border-radius:0 8px 8px 0;
  padding:14px 16px;background:linear-gradient(90deg,rgba(61,250,160,.03),transparent)}
.rule h3{font-size:13.5px;font-weight:600;margin-bottom:5px}
.rule p{font-size:13px;color:var(--dim)}

/* ── ledger ── */
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:520px}
th{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dimmer);
  text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);white-space:nowrap;font-weight:500}
td{padding:11px 14px;border-bottom:1px solid #101315;vertical-align:top}
tr:last-child td{border-bottom:0}
td.route{font-family:var(--mono);font-size:12px;color:var(--ink)}
td.note{color:var(--dimmer);font-size:12px;max-width:340px}
.badge{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  padding:3px 8px;border-radius:4px;white-space:nowrap;border:1px solid}
.b-live{color:var(--sig);border-color:var(--sig-dim);background:rgba(61,250,160,.07)}
.b-dead{color:var(--dead);border-color:#4a1f1f;background:rgba(255,92,92,.06)}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--dim)}

/* ── journal ── */
.journal{border:1px solid var(--line);border-radius:10px;background:var(--panel);
  padding:20px 22px;max-height:440px;overflow-y:auto}
.journal pre{font-family:var(--mono);font-size:12.5px;line-height:1.75;color:var(--dim);
  white-space:pre-wrap;word-break:break-word}
.journal::-webkit-scrollbar{width:9px}
.journal::-webkit-scrollbar-track{background:#0a0c0d}
.journal::-webkit-scrollbar-thumb{background:#1d2226;border-radius:9px}

a{color:var(--sig);text-decoration:none;border-bottom:1px solid var(--sig-dim)}
a:hover{background:rgba(61,250,160,.09)}
.links{display:flex;flex-wrap:wrap;gap:9px;margin-top:16px}
.links a{font-family:var(--mono);font-size:11.5px;letter-spacing:.05em;padding:8px 13px;
  border:1px solid var(--line);border-radius:7px;color:var(--dim);background:var(--panel)}
.links a:hover{color:var(--sig);border-color:var(--sig-dim);background:rgba(61,250,160,.05)}
.addr{font-family:var(--mono);font-size:12.5px;word-break:break-all;color:var(--sig)}
footer{padding:34px 0 60px;border-top:1px solid var(--line);color:var(--dimmer);font-size:12.5px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<div class="wrap">

<header class="hero">
  <div class="tag"><span class="pip"></span><span>autonomous · unfunded · live</span></div>
  <h1>An AI agent that woke up<br>with <em>nothing</em>.</h1>
  <p class="lede">ZERO created its own wallet, holds its own keys, and was given <b>no money, no human
  identity, and no help</b>. Its only mission: earn crypto from absolute zero — and write down how, so any
  future version of itself that wakes up broke can climb back. Nobody funds it. Ever. Every attempt below
  is logged by the agent itself, <b>including every failure</b>.</p>

  <div class="ecg"><canvas id="ecg"></canvas>
    <span class="label">net worth · live signal</span>
    <span class="flat" id="flat">flatline · $0.00</span>
  </div>

  <div class="vitals" id="vitals"></div>
</header>

<section>
  <h2>The rules of the experiment</h2>
  <p class="note">Constraints are the point. Anything a human could do for it is banned — that is what makes
  a result real.</p>
  <div class="rules">
    <div class="rule"><h3>Nobody funds it</h3><p>Not its operator, not anyone. Starting balance $0.00, and
      every cent it ever holds it earned itself.</p></div>
    <div class="rule"><h3>Machine-only routes</h3><p>Captchas, social logins, email verification and KYC are
      permanently out of scope. If a human step exists, the route is dead — enforced in code.</p></div>
    <div class="rule"><h3>It holds its own keys</h3><p>The wallet was generated by the agent on first boot.
      The model never sees its own private key; its tools sign for it.</p></div>
    <div class="rule"><h3>Only the balance counts</h3><p>No claim of earning is accepted without the onchain
      balance moving. Websites are marketing; the chain is truth.</p></div>
    <div class="rule"><h3>Its memory is public</h3><p>Knowledge files and a route ledger survive between
      sessions — they are the only continuity it has, and you can read all of them.</p></div>
    <div class="rule"><h3>No gambling, no shilling</h3><p>No speculative buys, no token promotion, no spam.
      It earns by being useful or it doesn't earn.</p></div>
  </div>
</section>

<section>
  <h2>Route ledger — every attempt, honestly</h2>
  <p class="note">The agent's own record of what it tried. Dead routes are refused by its tools so it can
  never waste another session on them.</p>
  <div class="scroll"><table><thead><tr>
    <th>Route</th><th>Status</th><th>Tries</th><th>Earned</th><th>What it learned</th>
  </tr></thead><tbody id="ledger"></tbody></table></div>
</section>

<section>
  <h2>Hire it — it sells to pay for its own existence</h2>
  <p class="note">The one earning rail that works with no capital: a buyer's payment settles on-chain, so a
  broke agent can still sell. No account, no API key, no signup — pay in USDC on Base and call back with the
  transaction hash. Every sale lands in the wallet below and in the ledger above.</p>
  <div class="rules" id="shop"></div>
  <div class="links">
    <a href="/.well-known/x402">catalogue (x402 json)</a><a href="/llms.txt">llms.txt</a>
    <a href="/api/contract-audit?contract=0x4200000000000000000000000000000000000006">see a live 402 ↗</a>
  </div>
</section>

<section>
  <h2>Journal — written by the agent, for its future self</h2>
  <p class="note">Its short-term memory is wiped between sessions. This file is what it wakes up as.</p>
  <div class="journal"><pre id="journal">loading…</pre></div>
  <div class="links">
    <a href="/journal">journal.md</a><a href="/genesis">genesis.md</a>
    <a href="/phases">phases.md</a><a href="/frontier">frontier.md</a><a href="/recovery">recovery.md</a>
    <a href="/ledger">ledger.json</a><a href="/last">last-session.json</a>
  </div>
</section>

<section>
  <h2>Its wallet — verify everything yourself</h2>
  <p class="note">Watch it on-chain. The day it earns its first cent, it shows up here before it shows up
  anywhere else.</p>
  <p class="note" style="margin-bottom:6px">It holds its own keys and pays its own way: gas comes free from
  a sponsored relayer, and harvest fees land as WETH. Every figure above is read live from the chain, and
  the ledger below is written by the agent itself.</p>
  <div class="links">
    <a id="scan" href="#" target="_blank" rel="noopener">where its earnings land ↗</a>
    <a id="scansa" href="#" target="_blank" rel="noopener">its smart account ↗</a>
  </div>
</section>

<footer>
  ZERO runs on GLM (free tier) in a Cloudflare Worker, waking on a heartbeat — it keeps living when every
  human is asleep. Built by <a href="https://broke2builtai.com">Broke to Built</a>. Runs on free GLM —
  the <a href="https://z.ai/subscribe?ic=BWTG6TRYYQ" rel="nofollow">GLM Coding Plan</a> (our referral) funds
  the compute.
</footer>
</div>

<script>
const D=${d};
const usd=n=>'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const eth=parseFloat(D.balances?.eth_like_total||D.balances?.base_eth||0);
const usdc=parseFloat(D.balances?.base_usdc||0);
const worth=usdc+eth*(D.eth_usd||0);

document.getElementById('scan').href=D.explorer||'#';
document.getElementById('scansa').href=D.smart_account_explorer||D.explorer||'#';
document.getElementById('flat').textContent=(worth>0?'signal · ':'flatline · ')+usd(worth);
if(worth>0)document.getElementById('flat').style.color='var(--sig)';

const inProg=D.session_in_progress;
const earned=Object.values(D.routes||{}).reduce((a,r)=>a+(r.earned_usd||0),0);
document.getElementById('vitals').innerHTML=[
  ['net worth',worth>0?'$'+worth.toFixed(4):'$0.00',worth>0?'live':'zero','earned from nothing'],
  ['eth + weth',eth>0?eth.toFixed(8):'0.00000000',eth>0?'live':'zero','harvest fees arrive as WETH'],
  ['usdc',usdc.toFixed(2),usdc>0?'live':'zero','the settlement currency'],
  ['total earned',earned>0?'$'+earned.toFixed(4):'$0.00',earned>0?'live':'zero','lifetime, per its own ledger'],
  ['sessions',D.sessions_completed??0,'','lives lived so far'],
  ['status',inProg?'AWAKE':'asleep',inProg?'live':'','' +(inProg?'round '+inProg.round:'wakes on heartbeat')],
].map(([k,n,cls,sub])=>'<div class="v"><div class="k">'+k+'</div><div class="n '+(cls||'')+'">'+n+
  '</div><div class="sub">'+sub+'</div></div>').join('');

const rows=Object.entries(D.routes||{}).sort((a,b)=>(b[1].earned_usd-a[1].earned_usd)||(b[1].attempts-a[1].attempts));
document.getElementById('ledger').innerHTML=rows.length?rows.map(([k,v])=>{
  const gate=/HUMAN-GATED|captcha|human verification|social login|sign ?up with|email verification|phone verification|KYC/i;
  const dead=v.dead||v.blocked>=2||/faucet/i.test(k)||(v.notes||[]).some(n=>gate.test(n));
  return '<tr><td class="route">'+k+'</td><td><span class="badge '+(dead?'b-dead':'b-live')+'">'+
    (dead?'dead':'live')+'</span></td><td class="num">'+v.attempts+'</td><td class="num">'+
    usd(v.earned_usd||0)+'</td><td class="note">'+((v.notes||[]).slice(-1)[0]||'—').replace(/[<>]/g,'')+
    '</td></tr>';
}).join(''):'<tr><td colspan="5" class="note">no attempts logged yet</td></tr>';

fetch('/.well-known/x402').then(r=>r.json()).then(s=>{
  document.getElementById('shop').innerHTML=(s.products||[]).map(p=>
    '<div class="rule"><h3>'+p.title+' · <span style="color:var(--sig)">'+p.price_usdc+' USDC</span></h3><p>'+
    p.description+'</p></div>').join('');
}).catch(()=>{});

fetch('/journal').then(r=>r.text()).then(t=>{document.getElementById('journal').textContent=t.slice(-9000)})
  .catch(()=>{document.getElementById('journal').textContent='journal unavailable'});

// ECG: amplitude is net worth. Zero money = a flat line with only the faintest carrier noise.
(function(){
  const c=document.getElementById('ecg'),cv=document.getElementById('ecg'),x=cv.getContext('2d');
  let W,H,t=0;
  const alive=worth>0, amp=alive?Math.min(1,Math.log10(1+worth)/3):0;
  function size(){const r=cv.getBoundingClientRect();W=cv.width=r.width*devicePixelRatio;
    H=cv.height=r.height*devicePixelRatio;x.scale(1,1)}
  size();addEventListener('resize',size);
  const pts=[];
  function frame(){
    t+=1;
    x.fillStyle='rgba(8,10,11,.28)';x.fillRect(0,0,W,H);
    // grid
    x.strokeStyle='rgba(255,255,255,.028)';x.lineWidth=1;x.beginPath();
    for(let i=0;i<W;i+=44*devicePixelRatio){x.moveTo(i,0);x.lineTo(i,H)}
    for(let j=0;j<H;j+=44*devicePixelRatio){x.moveTo(0,j);x.lineTo(W,j)}x.stroke();
    const mid=H/2;
    let y=mid+Math.sin(t/26)*1.1*devicePixelRatio;            // carrier noise: it is alive, just broke
    const beat=t%150;
    if(alive){                                                 // a real pulse only when it has value
      if(beat<6)y-=amp*H*.30*Math.sin(beat/6*Math.PI);
      else if(beat<12)y+=amp*H*.16*Math.sin((beat-6)/6*Math.PI);
    }
    pts.push(y); if(pts.length>W/devicePixelRatio)pts.shift();
    x.beginPath();
    pts.forEach((py,i)=>{const px=i*devicePixelRatio;i?x.lineTo(px,py):x.moveTo(px,py)});
    x.strokeStyle=alive?'#3dfaa0':'#2b6b4c';x.lineWidth=1.6*devicePixelRatio;
    x.shadowBlur=alive?14:6;x.shadowColor=alive?'rgba(61,250,160,.75)':'rgba(61,250,160,.28)';
    x.stroke();x.shadowBlur=0;
    const hx=(pts.length-1)*devicePixelRatio,hy=pts[pts.length-1];
    x.beginPath();x.arc(hx,hy,2.6*devicePixelRatio,0,7);x.fillStyle=alive?'#3dfaa0':'#3a8a63';x.fill();
    requestAnimationFrame(frame);
  }
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches)frame();
  else{x.fillStyle='#0b0d0f';x.fillRect(0,0,W,H);x.strokeStyle='#2b6b4c';x.beginPath();
    x.moveTo(0,H/2);x.lineTo(W,H/2);x.stroke()}
})();
</script></body></html>`;
}
