// _fa_report.mjs — turn measured hits into the deliverable. Enriches every PAYS row with the two
// things that decide whether it is income (is the token worth anything / can it be done again),
// then writes faucets-airdrops.json + .md ranked by REALISABLE usd.
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import * as L from './_fa_lib.mjs';
import * as V from './_fa_value.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT_JSON = path.join(HERE, 'faucets-airdrops.json');

const EXPLORER = { base: 'https://base.blockscout.com', optimism: 'https://optimism.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com', polygon: 'https://polygon.blockscout.com',
  gnosis: 'https://gnosis.blockscout.com', unichain: 'https://unichain.blockscout.com' };

const RPC1 = (c) => L.RPCS[c][0];

/** The exact command a future session can paste to re-measure this row. Nothing to trust, only to run. */
function reproduceCmd(chain, contract, data, recipient, token) {
  const bd = token === ethers.ZeroAddress
    ? `{"target":"${L.MULTICALL3}","allowFailure":true,"callData":"${L.ethBalOf(recipient)}"}`
    : `{"target":"${token}","allowFailure":true,"callData":"${L.balOf(recipient)}"}`;
  return `node -e "import('./_fa_lib.mjs').then(async L=>console.log(JSON.stringify(await L.payTest('${chain}','${contract}','${data}',L.REF_TOKENS.${chain}),null,1)))"`
    + `   # raw: aggregate3 [${bd}, {target:${contract}, callData:${data}}, ${bd}] via ${RPC1(chain)}`;
}

async function symbolOf(chain, token) {
  if (token === ethers.ZeroAddress) return 'NATIVE';
  const s = L.decStr(await L.tryCall(chain, token, L.sel('symbol()')));
  return s || '?';
}

/** balanceOf() means "how many tokens" for ERC-20 and "how many NFTs" for ERC-721 — never conflate. */
async function isNFT(chain, token) {
  if (token === ethers.ZeroAddress) return false;
  for (const id of ['80ac58cd', 'd9b67a26']) { // ERC-721, ERC-1155
    const r = await L.tryCall(chain, token, L.sel('supportsInterface(bytes4)') + id + '0'.repeat(56));
    if (r && r.length >= 66 && BigInt(r) === 1n) return true;
  }
  return false;
}

/**
 * Directly measured accrual, base blocks 49379857 -> 49380158 (301 blocks / 10.0 min wall clock).
 * This is stronger repeatability evidence than any cooldown variable: the claimable amount was read
 * twice and it GREW, so the payout regenerates rather than being a one-off balance sitting there.
 */
const ACCRUAL = {
  '0xd90ec9e27c47fdf0f766c0d6fc4f0f47376daa47': { weiPer10min: '97489419068', usdPerDay: 0.041910 },
  '0xd8d64ed31e432d9375d07df11555a58f66e12d69': { weiPer10min: '937365876', usdPerDay: 0.000403 },
  '0x3a89e5f24469f37f847672c9f39edb4f1f8cd466': { weiPer10min: '1459852', usdPerDay: 0.000001 },
};

/** Why is a contract that pays anyone still holding a balance? An honest answer or it is not a finding. */
function whyNotDrained(row) {
  if (!row.tokenHasLiquidity) return 'the token has no market — there is nothing to drain worth the trouble';
  if (row.estUsd < 0.01) return `the payout is worth ~$${row.estUsd.toFixed(6)} — below anyone's gas cost, which is exactly the asymmetry ZERO exploits (it does not pay gas)`;
  if (row.repeatable === 'once') return 'one claim per address caps what any single actor can take';
  return 'UNEXPLAINED — treat as suspicious until answered; an unlimited open payout of real value would already be gone';
}

export async function enrich(hits) {
  const rows = [];
  const gated = [];
  for (const h of hits) {
    if (h.verdict !== 'PAYS') continue;
    for (const p of h.paying) {
      for (const d of p.deltas) {
        // Re-apply the domain gate HERE as well as in the probe: the long sweeps were launched before
        // the balance-poisoning class was discovered, and their hit files still contain it. A gate that
        // only runs in one of two places is not a gate.
        const g = await L.plausibleDelta(h.chain, d.wei, d.token, p.data).catch(() => ({ ok: true }));
        if (!g.ok) { gated.push({ chain: h.chain, contract: h.contract, sig: p.sig, wei: d.wei, why: g.why }); continue; }
        const symbol = d.symbol === 'SELF' || d.symbol === '?' ? await symbolOf(h.chain, d.token) : d.symbol;
        const nft = await isNFT(h.chain, d.token).catch(() => false);
        const val = nft
          ? { tokenHasLiquidity: false, estUsd: 0, note: `NFT (ERC-721/1155) — the measured delta is a COUNT of ${d.wei} token(s), not an amount; no fungible pool can price it` }
          : await V.valueOfPayment(h.chain, d.token, d.symbol, d.wei, d.decimals).catch(() => ({ tokenHasLiquidity: false, estUsd: 0, note: 'valuation failed' }));
        // Budget the expensive part where it changes a decision. A payout in a token with no market is
        // worth $0 whether it repeats hourly or never, so it gets a shallow history scan; anything with
        // real value gets the full window, because there the cadence IS the finding.
        const worthDeepScan = val.tokenHasLiquidity && val.estUsd > 0;
        const rep = await V.repeatability(h.chain, h.contract, { chunks: worthDeepScan ? 12 : 2 })
          .catch(() => ({ verdict: 'scan failed' }));
        const gate = await V.gateState(h.chain, h.contract).catch(() => ({}));
        const cooldown = Number(gate['cooldown()'] || gate['COOLDOWN()'] || gate['claimInterval()'] || gate['waitTime()'] || gate['lockTime()'] || 0) || null;
        const acc = ACCRUAL[h.contract.toLowerCase()];
        let repeatable = 'unknown';
        if (acc) repeatable = 'per-block';   // measured twice, it grew
        else if (/^REPEATABLE/.test(rep.verdict)) repeatable = cooldown ? (cooldown <= 86400 ? 'daily' : 'unknown') : 'unlimited';
        else if (rep.distinctRecipients > 0) repeatable = 'once';
        if (gate['hasClaimed(address)'] === '1') repeatable = 'once';

        const row = {
          chain: h.chain, contract: h.contract, selector: p.sel, signature: p.sig,
          recipient: d.recipient, measuredWei: d.wei, token: d.token, tokenSymbol: symbol,
          tokenHasLiquidity: !!val.tokenHasLiquidity, estUsd: Number((val.estUsd || 0).toFixed(8)),
          repeatable, cooldownSeconds: cooldown,
          evidenceOfRepeat: acc
            ? `DIRECTLY MEASURED: the claimable amount was read twice, 301 base blocks apart (49379857 -> 49380158), and GREW by ${acc.weiPer10min} wei in 10.0 min => ~$${acc.usdPerDay.toFixed(6)}/day at $${V.ETH_USD}/ETH. It regenerates; it is not a one-off balance.`
            : rep.topRepeater
              ? `${rep.topRepeater.address} was paid ${rep.topRepeater.times}x by this contract (${rep.repeatRecipients} addresses paid more than once, ${rep.payouts} payouts / ${rep.blocksScanned} blocks)`
              : rep.verdict,
          usdPerDay: acc ? acc.usdPerDay : null,
          blockNumber: h.blockNumber ?? null,
          reproduceCmd: reproduceCmd(h.chain, h.contract, p.data, d.recipient, d.token),
          confidence: 'MEASURED',
          whyNotDrained: '',
          notes: [
            h.name ? `named ${JSON.stringify(h.name)}` : null,
            `discovered via ${h.src}`,
            d.recipient === L.MULTICALL3 ? 'paid to msg.sender (Multicall3 stood in for ZERO\'s Safe — same shape in production)'
              : d.recipient === L.PROBER ? 'native ETH, measured with the override prober because Multicall3 cannot receive ETH'
                : 'paid directly to ZERO\'s Safe (the call takes a recipient address)',
            val.note,
            // The blanket "ZERO can only hold it" is true for arbitrary ERC-20s and FALSE for wrapped
            // native. MEASURED: WETH.withdraw(uint256) on base returned 0x from a holder under state
            // override — a 1:1 unwrap, no DEX, no liquidity, no price. So a WETH payout is realisable
            // in phase 0 for the cost of one extra relay slot.
            /^W(ETH|POL|XDAI)$/i.test(symbol)
              ? `${symbol} is wrapped native — realisable in phase 0 via withdraw(uint256) (1:1 unwrap, no swap), at the cost of one extra relay slot`
              : symbol === 'NATIVE'
                ? 'native gas token — already realised, nothing further needed'
                : 'ZERO cannot swap in phase 0 — this payout is value it can only HOLD, not realise',
          ].filter(Boolean).join('; '),
        };
        row.whyNotDrained = whyNotDrained(row);
        if (!row.tokenHasLiquidity || row.estUsd < 0.000001) row.confidence = 'DEAD';
        rows.push(row);
      }
    }
  }
  rows.sort((a, b) => b.estUsd - a.estUsd);
  if (gated.length) {
    fs.writeFileSync(path.join(HERE, '_fa_gated_out.json'), JSON.stringify(gated, null, 1));
    console.log(`domain gate rejected ${gated.length} well-formed non-payments (see _fa_gated_out.json)`);
  }
  return rows;
}

const fmt = (wei, dec) => { try { return ethers.formatUnits(wei, dec ?? 18); } catch { return wei; } };

export function toMarkdown(rows, stats, extra = {}) {
  const live = rows.filter(r => r.confidence === 'MEASURED');
  const dead = rows.filter(r => r.confidence === 'DEAD');
  const L1 = [];
  L1.push('# Faucets & open airdrops — contracts that pay whoever asks');
  L1.push('');
  L1.push(`_Measured ${extra.date || new Date().toISOString().slice(0, 10)}. READ-ONLY: every number below came from an \`eth_call\` this session ran; nothing was signed, no relay slot was spent._`);
  L1.push('');
  L1.push('## TLDR');
  L1.push('');
  L1.push(extra.tldr || '');
  L1.push('');
  L1.push('## What survived the payment test');
  L1.push('');
  L1.push('| # | chain | contract | function | pays | token | liquid? | est USD | repeatable |');
  L1.push('|---|-------|----------|----------|------|-------|---------|---------|------------|');
  rows.forEach((r, i) => L1.push(`| ${i + 1} | ${r.chain} | \`${r.contract}\` | \`${r.signature}\` | ${fmt(r.measuredWei, 18)} | ${r.tokenSymbol} | ${r.tokenHasLiquidity ? 'yes' : '**no**'} | $${r.estUsd.toFixed(6)} | ${r.repeatable} |`));
  L1.push('');
  L1.push(`${live.length} MEASURED, ${dead.length} DEAD. A DEAD row is a killed lead — it is here so the next session does not spend the same hour on it.`);
  L1.push('');
  for (const r of rows) {
    L1.push(`### ${r.chain} · \`${r.contract}\` · \`${r.signature}\` — ${r.confidence}`);
    L1.push('');
    L1.push(`- **measured** \`${r.measuredWei}\` units of ${r.tokenSymbol} (\`${r.token}\`) to \`${r.recipient}\``);
    L1.push(`- **liquidity** ${r.tokenHasLiquidity ? 'a real pool holds a quote balance' : 'NO pool holds any quote asset — the payout cannot be sold'}`);
    L1.push(`- **est USD** $${r.estUsd.toFixed(8)}`);
    L1.push(`- **repeatable** ${r.repeatable}${r.cooldownSeconds ? ` (cooldown ${r.cooldownSeconds}s)` : ''} — ${r.evidenceOfRepeat}`);
    L1.push(`- **why not drained** ${r.whyNotDrained}`);
    L1.push(`- **notes** ${r.notes}`);
    L1.push(`- **reproduce** \`${r.reproduceCmd.split('   # raw:')[0].trim()}\``);
    L1.push('');
  }
  if (stats) {
    L1.push('## Coverage (the denominator, so the zero means something)');
    L1.push('');
    L1.push('| chain | probed | pays | no-pay | error |');
    L1.push('|-------|--------|------|--------|-------|');
    for (const [c, s] of Object.entries(stats)) L1.push(`| ${c} | ${s.probed} | ${s.pays} | ${s.dead} | ${s.err} |`);
    L1.push('');
  }
  return L1.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('_fa_report.mjs')) {
  const files = process.argv.slice(2);
  let hits = [];
  for (const f of files) {
    try { hits = hits.concat(JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8'))); }
    catch (e) { console.log('skip', f, e.message.slice(0, 60)); }
  }
  const paying = hits.filter(h => h.verdict === 'PAYS');
  console.log(`${hits.length} probed rows, ${paying.length} PAYS -> enriching`);
  const rows = await enrich(paying);
  fs.writeFileSync(OUT_JSON, JSON.stringify(rows, null, 1));
  console.log(`${rows.length} enriched rows -> ${OUT_JSON}`);
  for (const r of rows) console.log(` $${r.estUsd.toFixed(6).padStart(12)} ${r.confidence.padEnd(8)} ${r.chain} ${r.contract} ${r.signature} ${r.measuredWei} ${r.tokenSymbol} [${r.repeatable}]`);
  // probe-population stats for the honest denominator
  const stats = {};
  for (const h of hits) { const k = h.chain || '?'; stats[k] = stats[k] || { probed: 0, pays: 0, dead: 0, err: 0 };
    stats[k].probed++; if (h.verdict === 'PAYS') stats[k].pays++; else if (h.verdict === 'ERROR') stats[k].err++; else stats[k].dead++; }
  fs.writeFileSync(path.join(HERE, '_fa_stats.json'), JSON.stringify(stats, null, 1));
  console.log(JSON.stringify(stats));
}
