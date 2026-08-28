// render-check.mjs — render dashboard2.mjs against real payloads and ASSERT the output.
//
// The Worker serves dashboard2 (worker.mjs import). dashboard.mjs is reference only.
// A page that renders is not a page that is honest. This script exists because the spec's gate is
// "render both fixtures and they must NOT look the same": a degraded payload must change what the
// live page actually shows (identity chain-read counts, holdings rows), and empty payloads must
// not throw — a throw here is a public outage.
//
//   node scripts/render-check.mjs                 # live payload from the deployed worker
//   node scripts/render-check.mjs path/to.json    # any saved payload (fixtures/ is gitignored)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardHTML } from '../dashboard2.mjs';
import { reviveStatusPayload } from '../health.mjs';
import { LIVE_EOA, SMART_ACCOUNT } from '../shop.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.env.RENDER_OUT || path.join(here, '..', '.render');
fs.mkdirSync(outDir, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

async function loadPayloads() {
  const args = process.argv.slice(2);
  if (args.length) {
    return args.map(a => ({ name: path.basename(a), data: JSON.parse(fs.readFileSync(a, 'utf8')) }));
  }
  const res = await fetch('https://zero-agent.broke2built.workers.dev/', { headers: { accept: 'application/json' } });
  const data = await res.json();
  fs.writeFileSync(path.join(outDir, 'live.json'), JSON.stringify(data, null, 1));
  return [{ name: 'live', data }];
}

/**
 * Shape the concurrent consolidation work publishes: holdings under `total_holdings_usd`, a per-chain
 * leg whose `token_usd` is a REAL null because the price read failed. dashboard2 must survive it.
 */
export function corrected(data) {
  const d = JSON.parse(JSON.stringify(data));
  const b = d.balances || (d.balances = {});
  const holdings = b.all_chains_usd ?? d.treasury?.total_across_all_chains_usd ?? 0;
  const safeWrapped = b.spendable_usd ?? 0;
  b.spendable_liquid_native_eth_on_base_usd = 0.00217792;
  b.spendable_usd = 0.00217792;
  b.spendable_means = 'native ETH at the EOA on base — the only asset nobody can revoke or rate-limit';
  b.phase0_target_usd = 1;
  b.phase0_pct = 0.2178;
  b.total_holdings_usd = holdings;
  b.holdings_usd = holdings;
  b.holdings_breakdown = {
    spendable_native_eth_on_base_usd: 0.00217792,
    native_eth_at_eoa_other_chains_usd: 0,
    wrapped_native_in_safe_usd: safeWrapped,
    wrapped_native_stranded_at_eoa_usd: 0,
    usdc_usd: 0.00978,
  };
  b.unpriced_chains = [{ chain: 'unichain', reason: 'no price source configured' }];
  b.read_errors = ['gnosis usdc: upstream returned 502'];
  b.all_chains_priced = (b.all_chains_priced || []).map((c, i) => (i === 1 ? { ...c, token_usd: null, error: 'price read returned no usable value' } : c));
  delete d.lifetime_earned; delete d.price_used;
  d.lifetime_earned_usd = 0.146667;          // the old scalar, which this page must not read
  return d;
}

/** Payloads that carry almost nothing. A render throw here is a public outage, not a cosmetic bug. */
export function empties() {
  return [
    ['empty-object', {}],
    ['empty-branches', { balances: {}, health: {}, treasury: {}, prospect: {}, routes: {}, recent_harvests: [] }],
    ['nulls', { balances: null, health: null, treasury: null, prospect: null, routes: null, recent_harvests: null, lifetime_earned: null }],
    ['error-payload', { error: 'upstream timeout' }],
  ];
}

// A degraded twin: two chains fail their read. dashboard2 shows chain_reads on the identity panel
// and drops zero-value rows from the holdings table — mutate both so the HTML actually changes.
export function degrade(data) {
  const d = JSON.parse(JSON.stringify(data));
  d.balances = d.balances || {};
  d.balances.all_chains_priced = (d.balances.all_chains_priced || []).filter(c => c.chain !== 'arbitrum' && c.chain !== 'polygon');
  d.balances.unreadable = [
    { chain: 'arbitrum', error: 'eth_call: upstream returned 429 (rate limited)' },
    { chain: 'polygon', error: 'price: blockscout returned no coin_price' },
  ];
  d.balances.chains_read_ok = 4;
  d.balances.chains_configured = 6;
  d.chain_reads = { ...(d.chain_reads || {}), chains_read_ok: 3, chains_configured: 6 };
  d.treasury = d.treasury || {};
  d.treasury.tributaries = (d.treasury.tributaries || []).filter(t => t.chain !== 'arbitrum' && t.chain !== 'polygon');
  const dropped = (data.treasury?.tributaries || []).filter(t => t.chain === 'arbitrum' || t.chain === 'polygon')
    .reduce((s, t) => s + (t.spendable_usd || 0), 0);
  if (typeof d.treasury.total_across_all_chains_usd === 'number') d.treasury.total_across_all_chains_usd -= dropped;
  if (typeof d.balances.holdings_usd === 'number') d.balances.holdings_usd -= dropped;
  if (typeof d.balances.all_chains_usd === 'number') d.balances.all_chains_usd -= dropped;
  return d;
}

function hygiene(label, html) {
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  check(`${label}: >4000 bytes (${html.length})`, html.length > 4000);
  check(`${label}: no literal "undefined"`, !visible.includes('undefined'),
    visible.includes('undefined') ? visible.slice(Math.max(0, visible.indexOf('undefined') - 90), visible.indexOf('undefined') + 40) : '');
  check(`${label}: no literal "NaN"`, !visible.includes('NaN'),
    visible.includes('NaN') ? visible.slice(Math.max(0, visible.indexOf('NaN') - 90), visible.indexOf('NaN') + 30) : '');
  check(`${label}: no $0.000000 anywhere`, !/\$0\.000000/.test(visible));
}

const payloads = await loadPayloads();
const rendered = {};

for (const { name, data } of payloads) {
  for (const [variant, raw] of [['healthy', data], ['corrected', corrected(data)], ['degraded', degrade(data)]]) {
    const payload = variant === 'healthy'
      ? reviveStatusPayload(JSON.parse(JSON.stringify(raw)))
      : raw;
    const label = `${name}/${variant}`;
    console.log(`\n── ${label} ──`);
    let html;
    try { html = dashboardHTML(payload); }
    catch (e) { fail++; console.log(`  FAIL  renders at all — ${e.message}`); continue; }
    const file = path.join(outDir, `${name}.${variant}.html`);
    fs.writeFileSync(file, html);
    rendered[variant] = html;

    hygiene(label, html);
    check(`${label}: served renderer is dashboard2 (k-spend/k-relay, not retired id=res)`,
      html.includes('id="k-spend"') && html.includes('id="k-relay"') && !html.includes('id="res"'));
    check(`${label}: phase-0 exit label present`, /phase-0 exit/.test(html));
    check(`${label}: identity panel present`, />wallet</.test(html) && />smart acct</.test(html));
    if (variant === 'healthy') {
      if (payload.wallet) {
        check(`${label}: payload wallet is GENESIS II EOA`,
          String(payload.wallet).toLowerCase() === LIVE_EOA.toLowerCase(), payload.wallet);
      }
      if (payload.smart_account) {
        check(`${label}: payload smart_account is GENESIS II Safe`,
          String(payload.smart_account).toLowerCase() === SMART_ACCOUNT.toLowerCase(), payload.smart_account);
      }
      const spendable = payload.balances?.spendable_liquid_native_eth_on_base_usd;
      const baseNative = (payload.balances?.all_chains_priced || payload.balances?.per_chain_read || [])
        .find(r => String(r.chain) === 'base')?.eoa_native_usd;
      const measured = [spendable, baseNative].find(v => typeof v === 'number' && v > 0.01);
      const kpi = (html.match(/id="k-spend">([^<]+)/) || [])[1];
      if (measured) {
        check(`${label}: spendable KPI is not $0 while Base EOA native is measured`,
          kpi && kpi !== '—' && !/^\$0\.00/.test(kpi), `kpi=${kpi} measured=${measured}`);
      }
    }

    if (variant === 'degraded') {
      check(`${label}: identity shows 3/6 chains reading`, /3\/6 reading/.test(html));
    }
    if (variant === 'corrected') {
      check(`${label}: does not print the stale lifetime scalar $0.146667`, !/0\.146667/.test(html));
      check(`${label}: spendable KPI uses the native-ETH field`,
        html.includes('$0.002178') || html.includes('$0.002177'));
    }
  }
  console.log(`\n── ${name}/empty payloads ──`);
  for (const [ename, epayload] of empties()) {
    let html = null, threw = null;
    try { html = dashboardHTML(epayload); } catch (e) { threw = e; }
    check(`empty:${ename}: does not throw`, !threw, threw ? threw.message : '');
    if (!html) continue;
    fs.writeFileSync(path.join(outDir, `empty.${ename}.html`), html);
    hygiene(`empty:${ename}`, html);
    check(`empty:${ename}: served renderer is dashboard2`, html.includes('id="k-spend"') && html.includes('id="k-relay"'));
  }

  console.log(`\n── ${name}/session-in-flight ──`);
  const inflight = dashboardHTML({
    ...data,
    session_in_progress: { session: 973, round: 2, started: '2026-08-27T23:02:28.980Z' },
    sessions_completed: 972,
    last_session: '2026-08-26T11:50:30.804Z',
    health: { ...(data.health || {}), state: 'EARNING', headline: 'Working.' },
  });
  check(`${name}: names the in-flight session`, inflight.includes('session 973') && inflight.includes('in flight'));
  check(`${name}: does not headline a 35h completed-session gap`,
    !inflight.includes('last 35h ago') && !inflight.includes('last 36h ago'));

  if (rendered.healthy && rendered.degraded) {
    check(`${name}: healthy and degraded renders DIFFER`, rendered.healthy !== rendered.degraded);
  }
}

console.log(`\n${pass} passed, ${fail} failed. HTML written to ${outDir}`);
process.exitCode = fail ? 1 : 0;
