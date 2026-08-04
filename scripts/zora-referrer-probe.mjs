// zora-referrer-probe.mjs — the control run on Kimi's one survivable claim:
// "any swap routed with your address in hookData pays you a trade-referrer fee, on ANY coin."
//
// Claim decomposes into three testable parts:
//   H1: the Zora v4 content-coin hook emits a fee-distribution event naming distinct recipients
//   H2: a TRADE REFERRER is among them, and is per-swap (varies between swaps on the same coin)
//   H3: the amounts are non-trivial — measure actual ETH paid to referrers, don't trust "4% of fees"
// Read-only. Saves scripts/zora-referrer-result.json
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const HOOK = '0x0469a4Bd3724DC86C9542F4694c976DA13C450c0'; // measured: contentCoinHook == creatorCoinHook
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://1rpc.io/base'];
const BS = 'https://base.blockscout.com/api/v2';

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const out = { probedAt: new Date().toISOString(), hook: HOOK };

// H1 — get the hook's ABI and find its reward/fee events
let abi = [];
try {
  const meta = await fetch(`${BS}/smart-contracts/${HOOK}`).then(r => r.json());
  abi = meta.abi ?? [];
  out.hookName = meta.name; out.hookVerified = meta.is_verified;
  if (meta.implementations?.length) out.hookImpl = meta.implementations;
} catch (e) { out.abiError = String(e).slice(0, 200); }
const events = abi.filter(f => f.type === 'event');
out.eventNames = events.map(e => `${e.name}(${e.inputs.map(i => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name}`).join(',')})`);
console.log(`hook: ${out.hookName} verified=${out.hookVerified}`);
console.log('events:'); out.eventNames.forEach(e => console.log('  ', e));

const iface = new ethers.Interface(abi);
const rewardEvents = events.filter(e => /reward|fee|distribut/i.test(e.name));
out.rewardEventNames = rewardEvents.map(e => e.name);
console.log('\nreward-shaped events:', out.rewardEventNames.join(', ') || '(none)');

// H2/H3 — pull recent logs and decode who actually got paid
const latest = Number(await rpc('eth_blockNumber', []));
let logs = [];
for (let hi = latest, hop = 0; hop < 10 && logs.length < 60; hop++) {
  const lo = hi - 1999;
  try {
    const got = await rpc('eth_getLogs', [{ address: HOOK, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }]);
    logs = logs.concat(got);
  } catch (e) { out.logsError = String(e).slice(0, 150); }
  hi = lo - 1;
}
out.recentLogCount = logs.length;
console.log(`\n${logs.length} recent hook logs (scanned from block ${latest})`);

const byEvent = {};
const payouts = [];
for (const log of logs) {
  let p = null;
  try { p = iface.parseLog({ topics: log.topics, data: log.data }); } catch { }
  if (!p) { byEvent['<undecodable>'] = (byEvent['<undecodable>'] ?? 0) + 1; continue; }
  byEvent[p.name] = (byEvent[p.name] ?? 0) + 1;
  if (!/reward|fee|distribut/i.test(p.name)) continue;
  const row = { event: p.name, tx: log.transactionHash, fields: {} };
  p.fragment.inputs.forEach((inp, i) => {
    const v = p.args[i];
    row.fields[inp.name || `arg${i}`] = typeof v === 'bigint' ? v.toString() : String(v);
  });
  payouts.push(row);
}
out.eventHistogram = byEvent;
console.log('event histogram:', JSON.stringify(byEvent, null, 1));

// isolate the referrer-shaped fields and measure real amounts
const refRows = payouts.filter(r => Object.keys(r.fields).some(k => /referr/i.test(k)));
out.referrerPayoutSamples = refRows.slice(0, 8);
if (refRows.length) {
  console.log(`\n${refRows.length} payout events carrying a referrer field. Samples:`);
  for (const r of refRows.slice(0, 5)) console.log(' ', r.event, JSON.stringify(r.fields));

  // H2: does the trade referrer VARY across swaps? (per-swap attribution vs fixed-at-creation)
  const refKeys = Object.keys(refRows[0].fields).filter(k => /referr/i.test(k));
  out.referrerVariety = {};
  for (const k of refKeys) {
    const vals = new Set(refRows.map(r => (r.fields[k] || '').toLowerCase()));
    out.referrerVariety[k] = { distinct: vals.size, zeroAddressShare: +(refRows.filter(r => /^0x0{40}$/i.test(r.fields[k] || '')).length / refRows.length).toFixed(3) };
  }
  console.log('\nreferrer field variety:', JSON.stringify(out.referrerVariety, null, 1));

  // H3: real amounts — find numeric fields paired with referrer recipients
  const amountKeys = Object.keys(refRows[0].fields).filter(k => /amount|value|fee|reward/i.test(k) && /^\d+$/.test(refRows[0].fields[k] ?? ''));
  out.amountKeys = amountKeys;
  for (const k of amountKeys) {
    const nums = refRows.map(r => BigInt(r.fields[k] || '0')).filter(n => n > 0n);
    if (!nums.length) continue;
    const total = nums.reduce((a, b) => a + b, 0n);
    const avg = total / BigInt(nums.length);
    out[`measured_${k}`] = { nonzero: nums.length, avg_eth: ethers.formatEther(avg), max_eth: ethers.formatEther(nums.reduce((a, b) => a > b ? a : b)) };
    console.log(`  ${k}: ${nums.length} nonzero, avg ${ethers.formatEther(avg)} ETH, max ${ethers.formatEther(nums.reduce((a, b) => a > b ? a : b))} ETH`);
  }
} else {
  console.log('\nNO referrer-carrying payout events in the recent window — claim UNSUPPORTED at this sample.');
}

writeFileSync(new URL('./zora-referrer-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nsaved -> scripts/zora-referrer-result.json');
