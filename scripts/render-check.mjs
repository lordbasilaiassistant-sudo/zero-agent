// render-check.mjs — render dashboard.mjs against real payloads and ASSERT the output.
//
// A page that renders is not a page that is honest. This script exists because the spec's gate is
// "render both fixtures and they must NOT look the same": the degraded payload must show a reduced
// chain count, an UNREADABLE banner, and no $0.000000 standing in for a chain that failed.
//
//   node scripts/render-check.mjs                 # live payload from the deployed worker
//   node scripts/render-check.mjs fixtures/*.json # any saved payloads
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardHTML, buildModel } from '../dashboard.mjs';

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
  const res = await fetch('https://zero-agent.broke2builtai.com/', { headers: { accept: 'application/json' } });
  const data = await res.json();
  fs.writeFileSync(path.join(outDir, 'live.json'), JSON.stringify(data, null, 1));
  return [{ name: 'live', data }];
}

/**
 * THE CORRECTED SHAPE. For a window after any deploy the same dashboard code serves three different
 * payloads, and it must survive all of them. This is the shape the concurrent consolidation work
 * publishes: the scoreboard under its full name, holdings under `total_holdings_usd`, a per-chain leg
 * whose `token_usd` is a REAL null because the price read failed, and `unpriced_chains` beside it.
 * Built by transforming the live payload so the only differences are the field names and the null.
 */
export function corrected(data) {
  const d = JSON.parse(JSON.stringify(data));
  const b = d.balances || (d.balances = {});
  const holdings = b.all_chains_usd ?? d.treasury?.total_across_all_chains_usd ?? 0;
  const safeWrapped = b.spendable_usd ?? 0;
  b.spendable_liquid_native_eth_on_base_usd = 0.00217792;
  b.spendable_usd = 0.00217792;              // REDEFINED upstream — this page must not read it
  b.spendable_means = 'native ETH at the EOA on base — the only asset nobody can revoke or rate-limit';
  b.phase0_target_usd = 1;
  b.phase0_pct = 0.2178;
  b.total_holdings_usd = holdings;
  b.holdings_breakdown = {
    spendable_native_eth_on_base_usd: 0.00217792,
    native_eth_at_eoa_other_chains_usd: 0,
    wrapped_native_in_safe_usd: safeWrapped,
    wrapped_native_stranded_at_eoa_usd: 0,
    usdc_usd: 0.00978,
  };
  b.holdings_note = 'total_holdings_usd is NET WORTH, not capability.';
  b.unpriced_chains = [{ chain: 'unichain', reason: 'no price source configured' }];
  b.unpriced_note = 'These chains hold value that is REAL but NOT counted in any USD figure above.';
  b.read_errors = ['gnosis usdc: upstream returned 502'];
  delete b.holdings_usd; delete b.relay_spendable_usd; delete b.native_liquid_usd;
  delete b.chains_read_ok; delete b.chains_configured; delete b.unreadable;
  b.all_chains_priced = (b.all_chains_priced || []).map((c, i) => (i === 1 ? { ...c, token_usd: null, error: 'price read returned no usable value' } : c));
  delete d.lifetime_earned; delete d.chain_reads; delete d.refill_eta; delete d.price_used;
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

// A degraded twin of any payload: two chains fail their read. This is the second fixture the gate
// requires, and it is built from the real one so the ONLY difference is the read failures.
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
  d.treasury = d.treasury || {};
  d.treasury.tributaries = (d.treasury.tributaries || []).filter(t => t.chain !== 'arbitrum' && t.chain !== 'polygon');
  const dropped = (data.treasury?.tributaries || []).filter(t => t.chain === 'arbitrum' || t.chain === 'polygon')
    .reduce((s, t) => s + (t.spendable_usd || 0), 0);
  if (typeof d.treasury.total_across_all_chains_usd === 'number') d.treasury.total_across_all_chains_usd -= dropped;
  if (typeof d.balances.holdings_usd === 'number') d.balances.holdings_usd -= dropped;
  if (typeof d.balances.all_chains_usd === 'number') d.balances.all_chains_usd -= dropped;
  return d;
}

const payloads = await loadPayloads();
const rendered = {};

for (const { name, data } of payloads) {
  for (const [variant, payload] of [['healthy', data], ['corrected', corrected(data)], ['degraded', degrade(data)]]) {
    const label = `${name}/${variant}`;
    console.log(`\n── ${label} ──`);
    let html;
    try { html = dashboardHTML(payload); }
    catch (e) { fail++; console.log(`  FAIL  renders at all — ${e.message}`); continue; }
    const file = path.join(outDir, `${name}.${variant}.html`);
    fs.writeFileSync(file, html);
    rendered[variant] = html;

    check(`${label}: >5000 bytes (${html.length})`, html.length > 5000);
    check(`${label}: no literal "undefined"`, !html.includes('undefined'),
      html.includes('undefined') ? html.slice(Math.max(0, html.indexOf('undefined') - 90), html.indexOf('undefined') + 40) : '');
    check(`${label}: no literal "NaN"`, !html.includes('NaN'),
      html.includes('NaN') ? html.slice(Math.max(0, html.indexOf('NaN') - 90), html.indexOf('NaN') + 30) : '');
    check(`${label}: no $0.000000 anywhere`, !/\$0\.000000/.test(html));
    check(`${label}: banned string "Every figure measured on-chain" absent`, !html.includes('Every figure measured on-chain'));
    check(`${label}: banned string "less than lifetime" absent`, !html.includes('less than lifetime'));
    check(`${label}: banned string "the rest is stranded" absent`, !html.includes('the rest is stranded'));
    check(`${label}: provenance legend present`, /class="legend"/.test(html) && /self-reported/.test(html));
    check(`${label}: phase-0 headline renders "of $1.00"`, /of \$1\.00/.test(html));
    check(`${label}: lifetime split renders self-reported line`, /reported by the model, never verified on-chain/.test(html));
    check(`${label}: $1.00 reservoir column present`, /id="res"/.test(html));

    const m = buildModel(payload);
    // THE INVARIANT THAT MATTERS MOST, and the one a live payload actually broke: no chain we could not
    // price may render a dollar figure anywhere in the holdings panel. `treasuryPlan` hands us a clean
    // `spendable_usd: 0` for exactly those chains, so this is checked against the rendered rows.
    const holdBlock = (html.match(/<div class="hold">[\s\S]*?<div class="tnote">/) || [''])[0];
    for (const ch of (m.unpricedChains || [])) {
      const rowRe = new RegExp('>' + ch + '(?:[^<]*)<[\\s\\S]{0,400}?class="amt[^"]*">([^<]*)<');
      const mm = holdBlock.match(rowRe);
      check(`${label}: unpriced chain "${ch}" renders — not a dollar figure`,
        !mm || mm[1].trim() === '—', mm ? `rendered "${mm[1].trim()}"` : '');
    }
    check(`${label}: measured and self-reported are never summed`,
      m.lifetime.measured.value === null || m.lifetime.self.value === null
      || !html.includes('$' + (m.lifetime.measured.value + m.lifetime.self.value).toFixed(4)));

    if (variant === 'degraded') {
      check(`${label}: shows "read 4 of 6 chains"`, /read 4 of 6 chains/.test(html));
      check(`${label}: UNREADABLE banner present`, /class="banner unread"/.test(html) && /lower bound/.test(html));
      check(`${label}: names the chains that failed`, /arbitrum/.test(html) && /rate limited|429/.test(html));
    }
    if (variant === 'corrected') {
      // The scoreboard must come from the FULL-NAMED corrected field, and the redefined `spendable_usd`
      // must not be believed. Both happen to be 0.00217792 here, so the discriminator is that the tile
      // reads $0.0000 EARNED with the gift disclosed beneath it — not $0.0022 of capability.
      check(`${label}: reads the corrected native-ETH field (gift residue disclosed)`,
        /residue of a \$0\.20\s*\n?\s*operator test-capital gift/.test(html.replace(/\s+/g, ' ')) || /operator test-capital gift/.test(html));
      check(`${label}: phase-0 earned is not inflated by the gift`, />\$0\.0000 <small>of \$1\.00/.test(html));
      check(`${label}: an unpriced leg renders as unknown, never $0`,
        /held, price unknown/.test(html) && /unpriced, not unread|price read failed/.test(html));
      check(`${label}: does not print the stale lifetime scalar $0.146667`, !/0\.146667/.test(html));
    }
  }
  // ── the empty / broken payloads. A throw here is an outage on the only public face of the system. ──
  console.log(`\n── ${name}/empty payloads ──`);
  for (const [ename, epayload] of empties()) {
    let html = null, threw = null;
    try { html = dashboardHTML(epayload); } catch (e) { threw = e; }
    check(`empty:${ename}: does not throw`, !threw, threw ? threw.message : '');
    if (!html) continue;
    fs.writeFileSync(path.join(outDir, `empty.${ename}.html`), html);
    check(`empty:${ename}: >5000 bytes (${html.length})`, html.length > 5000);
    check(`empty:${ename}: no literal "undefined"`, !html.includes('undefined'),
      html.includes('undefined') ? html.slice(Math.max(0, html.indexOf('undefined') - 90), html.indexOf('undefined') + 40) : '');
    check(`empty:${ename}: no literal "NaN"`, !html.includes('NaN'),
      html.includes('NaN') ? html.slice(Math.max(0, html.indexOf('NaN') - 90), html.indexOf('NaN') + 30) : '');
    check(`empty:${ename}: no $0.000000`, !/\$0\.000000/.test(html));
    check(`empty:${ename}: shows a designed empty state, not a void`, /class="empty"/.test(html));
  }

  if (rendered.healthy && rendered.degraded) {
    check(`${name}: healthy and degraded renders DIFFER`, rendered.healthy !== rendered.degraded);
    // The banner must track the DATA, not the fixture's name. Asserting "healthy has no banner" was
    // itself an assumption, and it failed against a live payload that genuinely had a failed polygon
    // price read — the page was right and the test was wrong. Assert the invariant instead: a banner
    // appears exactly when there is something unreadable or unpriced to warn about.
    const hasIssue = (p) => {
      const b = p.balances || {};
      return (b.unreadable || []).length > 0 || (b.read_errors || []).length > 0
        || (b.unpriced_chains || []).length > 0
        || (b.all_chains_priced || []).some(c => c && c.token_usd === null);
    };
    check(`${name}: banner appears exactly when a chain is unreadable or unpriced`,
      /class="banner unread"/.test(rendered.healthy) === hasIssue(data)
      && /class="banner unread"/.test(rendered.degraded) === hasIssue(degrade(data)));
    check(`${name}: the degraded render does carry the banner`, /class="banner unread"/.test(rendered.degraded));
  }
}

console.log(`\n${pass} passed, ${fail} failed. HTML written to ${outDir}`);
// process.exitCode, not process.exit(): an outstanding keep-alive fetch handle makes a hard exit
// trip a libuv assertion on Windows, which looks like a test failure and is not one.
process.exitCode = fail ? 1 : 0;
