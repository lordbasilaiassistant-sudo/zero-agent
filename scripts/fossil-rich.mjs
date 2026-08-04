// fossil-rich.mjs — hunt ABANDONED-BUT-FUNDED contracts using the index that already exists.
//
// Block-scanning for births was the wrong instrument: a chain's genesis era is EMPTY (gnosis' first
// 3,936 blocks held 67 txs total). Fossils are active-then-abandoned, millions of blocks later.
// Blockscout already ranks EVERY address by balance — so read that, keep the CONTRACTS, keep the
// ones with no recent activity, recover their interface from bytecode, and simulate every no-arg
// call from ZERO's address. Abandonment is the one break in the equilibrium cap: no competitor bids
// a forgotten contract's payout down to the gas floor, because nobody is looking at it.
//
// Read-only. Usage: node scripts/fossil-rich.mjs [chain] [pages]
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const CHAINS = {
  gnosis:   { bs: 'https://gnosis.blockscout.com/api/v2',   rpcs: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'], sym: 'xDAI', free: true },
  optimism: { bs: 'https://optimism.blockscout.com/api/v2', rpcs: ['https://optimism-rpc.publicnode.com'], sym: 'ETH', free: true },
  base:     { bs: 'https://base.blockscout.com/api/v2',     rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'], sym: 'ETH', free: true },
};
const chain = process.argv[2] || 'gnosis';
const PAGES = Number(process.argv[3] || 6);
const C = CHAINS[chain];
const EOA = '0x50624F7790732f9767180871D03A304756200dB9';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const STALE_DAYS = 180;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let rr = 0;
async function rpc(method, params, attempt = 0) {
  const url = C.rpcs[(rr++) % C.rpcs.length];
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) { if (/rate|limit|busy/i.test(j.error.message || '') && attempt < 5) { await sleep(400 * (attempt + 1)); return rpc(method, params, attempt + 1); } throw new Error(j.error.message); }
    return j.result;
  } catch (e) { if (attempt < 3) { await sleep(250); return rpc(method, params, attempt + 1); } throw e; }
}

// ── STAGE 1: richest addresses, straight off the index ──────────────────────
console.log(`STAGE 1 — pulling ${PAGES} pages of richest ${chain} addresses…`);
let items = [], next = null;
for (let p = 0; p < PAGES; p++) {
  const url = `${C.bs}/addresses` + (next ? `?${new URLSearchParams(next)}` : '');
  const j = await fetch(url).then(r => r.json()).catch(() => null);
  if (!j?.items) break;
  items = items.concat(j.items);
  next = j.next_page_params;
  if (!next) break;
  await sleep(300);
}
const contracts = items.filter(i => i.is_contract && BigInt(i.coin_balance || '0') > 0n);
console.log(`  ${items.length} addresses · ${contracts.length} are funded CONTRACTS`);

// ── STAGE 2: which are ABANDONED? (no transactions in STALE_DAYS) ───────────
console.log(`STAGE 2 — checking staleness (no tx in ${STALE_DAYS}d)…`);
const cutoff = Date.now() - STALE_DAYS * 864e5;
const fossils = [];
for (const c of contracts) {
  // A FAILED READ LOOKS EXACTLY LIKE A NULL RESULT. Treating a fetch error as "no transactions"
  // labelled WETH — the busiest contract on Base — as idle for 9999 days. Only a response that
  // genuinely parsed and genuinely carries an empty/old item list may mark a fossil.
  let txs = null, readOk = false;
  for (let a = 0; a < 3 && !readOk; a++) {
    try {
      const r = await fetch(`${C.bs}/addresses/${c.hash}/transactions?filter=to%20%7C%20from`);
      if (!r.ok) { await sleep(400); continue; }
      txs = await r.json();
      readOk = Array.isArray(txs?.items);
    } catch { await sleep(400); }
  }
  if (!readOk) { console.log(`  skip ${c.hash}: activity read FAILED (not evidence of abandonment)`); await sleep(150); continue; }
  const last = txs.items[0]?.timestamp ? Date.parse(txs.items[0].timestamp) : 0;
  const ageDays = last ? Math.round((Date.now() - last) / 864e5) : 9999;
  if (!last || last < cutoff) {
    fossils.push({ address: c.hash, balance: ethers.formatEther(c.coin_balance), name: c.name || null, daysSinceLastTx: ageDays });
    console.log(`  fossil: ${c.hash} · ${ethers.formatEther(c.coin_balance)} ${C.sym} · idle ${ageDays}d · ${c.name || 'unverified'}`);
  }
  await sleep(200);
  if (fossils.length >= 40) break;
}
console.log(`  ${fossils.length} abandoned-but-funded contracts`);

// ── STAGE 3: recover interface + simulate every no-arg call from ZERO ───────
function selectorsOf(code) {
  const out = new Set(); const hex = code.slice(2);
  for (let i = 0; i + 10 <= hex.length; i += 2)
    if (hex.slice(i, i + 2) === '63') { const s = '0x' + hex.slice(i + 2, i + 10); if (!/^0x0{8}$/.test(s) && !/^0xf{8}$/.test(s)) out.add(s); }
  return [...out];
}
console.log(`STAGE 3 — firing at ${fossils.length} fossils from ZERO's address…`);
const ADDR = EOA.slice(2).toLowerCase().padStart(64, '0');
const findings = [];
for (const f of fossils) {
  const code = await rpc('eth_getCode', [f.address, 'latest']).catch(() => '0x');
  if (!code || code === '0x') continue;
  const sels = selectorsOf(code).slice(0, 100);
  f.selectors = sels.length;
  // "executable + state-changing" is NOT "pays us" — deposit() passes that test and SPENDS our money.
  // The only honest test is the balance sandwich: read our balance, make the call, read it again.
  const mc = new ethers.Interface(['function aggregate3(( address target, bool allowFailure, bytes callData )[] calls) payable returns (( bool success, bytes returnData )[] returnData)']);
  const bal = { target: MULTICALL3, allowFailure: true, callData: '0x4d2301cc' + EOA.slice(2).toLowerCase().padStart(64, '0') }; // getEthBalance(address)
  for (const s of sels) {
    for (const data of [s, s + ADDR]) {
      try {
        const res = await rpc('eth_call', [{ from: EOA, to: MULTICALL3, data: mc.encodeFunctionData('aggregate3', [[bal, { target: f.address, allowFailure: true, callData: data }, bal]]) }, 'latest']);
        const [dec] = mc.decodeFunctionResult('aggregate3', res);
        if (!dec[1].success) continue;
        if (!dec[0].success || !dec[2].success) continue;
        const delta = BigInt(dec[2].returnData) - BigInt(dec[0].returnData);
        if (delta > 0n) {
          findings.push({ fossil: f.address, holds: f.balance, sym: C.sym, selector: data.slice(0, 10), withSelfArg: data.length > 10, gained_wei: delta.toString(), gained: ethers.formatEther(delta), idleDays: f.daysSinceLastTx });
          console.log(`  *** PAYS ZERO: ${f.address} ${data.slice(0, 10)} +${ethers.formatEther(delta)} ${C.sym} (holds ${f.balance}, idle ${f.daysSinceLastTx}d)`);
        }
      } catch { }
    }
    await sleep(60);
  }
}

const out = { probedAt: new Date().toISOString(), chain, addressesScanned: items.length, fundedContracts: contracts.length, fossils, findings };
writeFileSync(new URL(`./fossil-rich-${chain}.json`, import.meta.url), JSON.stringify(out, null, 2));
console.log(`\n=== ${contracts.length} funded contracts · ${fossils.length} abandoned · ${findings.length} EXECUTABLE state-changing calls ===`);
console.log(`saved -> scripts/fossil-rich-${chain}.json`);
