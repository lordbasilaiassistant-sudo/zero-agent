// factory-born.mjs — see the contracts we were blind to.
//
// THE GAP THIS CLOSES: our block scanner only detected top-level creations (tx.to === null).
// Measured proof it was blind: polygon block 25,000,000 carried 179,922 txs across 2,173 blocks and
// yielded ZERO births. Most contracts are spawned by FACTORIES via internal CREATE — and
// factory-spawned per-user vaults, escrows and wallets are EXACTLY the abandoned-with-funds shape
// worth hunting (one owner, one purpose, forgotten when that owner moved on).
//
// Blockscout exposes internal transactions per block with a `created_contract` field, so this needs
// no debug_trace and no archive node. Pipeline: internal CREATEs -> live balance -> for the funded
// ones, PUSH4 interface recovery -> Multicall3 balance-sandwich simulation from ZERO's address.
// A hit means the call actually increases ZERO's balance — not merely that it executes.
//
// Read-only. Usage: node scripts/factory-born.mjs [chain] [blocks] [startOffset]
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { SMART_ACCOUNT } from '../shop.mjs';

const CHAINS = {
  gnosis:   { bs: 'https://gnosis.blockscout.com/api/v2',   rpcs: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'], sym: 'xDAI' },
  base:     { bs: 'https://base.blockscout.com/api/v2',     rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'], sym: 'ETH' },
  optimism: { bs: 'https://optimism.blockscout.com/api/v2', rpcs: ['https://optimism-rpc.publicnode.com'], sym: 'ETH' },
};
const chain = process.argv[2] || 'gnosis';
const NBLOCKS = Number(process.argv[3] || 400);
const OFFSET = Number(process.argv[4] || 0);   // blocks back from head — go old to find the forgotten
const C = CHAINS[chain];
const EOA = SMART_ACCOUNT;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

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
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } } })); return out; }

// ── STAGE 1: internal CREATEs ───────────────────────────────────────────────
const head = Number(await rpc('eth_blockNumber', []));
const start = head - OFFSET;
console.log(`STAGE 1 — ${chain}: reading internal CREATEs across ${NBLOCKS} blocks from ${start} (head ${head})…`);
const blocks = Array.from({ length: NBLOCKS }, (_, k) => start - k);
const born = new Map();
let done = 0, seen = 0;
await pool(blocks, 5, async (b) => {
  const j = await fetch(`${C.bs}/blocks/${b}/internal-transactions`).then(r => r.ok ? r.json() : null).catch(() => null);
  done++;
  if (!Array.isArray(j?.items)) return;          // failed read is NOT an empty block
  for (const it of j.items) {
    seen++;
    const created = it.created_contract?.hash;
    if (created) born.set(created.toLowerCase(), { block: b, creator: it.from?.hash, type: it.type });
  }
  if (done % 100 === 0) console.log(`  …${done}/${NBLOCKS} blocks · ${seen} internal txs · ${born.size} factory-born contracts`);
});
console.log(`factory-born: ${born.size} contracts (from ${seen} internal txs across ${done} blocks)`);

// ── STAGE 2: which hold value? ──────────────────────────────────────────────
const addrs = [...born.keys()];
console.log(`STAGE 2 — balances of ${addrs.length} factory-born contracts…`);
const funded = [];
await pool(addrs, 8, async (a) => {
  const [bal, code] = await Promise.all([
    rpc('eth_getBalance', [a, 'latest']).catch(() => '0x0'),
    rpc('eth_getCode', [a, 'latest']).catch(() => '0x'),
  ]);
  if (BigInt(bal) > 0n && code && code !== '0x') funded.push({ address: a, wei: BigInt(bal).toString(), bal: ethers.formatEther(bal), code, ...born.get(a) });
});
funded.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1));
console.log(`funded: ${funded.length}`);
for (const f of funded.slice(0, 12)) console.log(`  ${f.address} · ${f.bal} ${C.sym} · born blk ${f.block} via ${f.creator}`);

// ── STAGE 3: does any of it pay ZERO? (balance sandwich, not a gas heuristic) ──
function selectorsOf(code) {
  const out = new Set(); const hex = code.slice(2);
  for (let i = 0; i + 10 <= hex.length; i += 2)
    if (hex.slice(i, i + 2) === '63') { const s = '0x' + hex.slice(i + 2, i + 10); if (!/^0x0{8}$/.test(s) && !/^0xf{8}$/.test(s)) out.add(s); }
  return [...out];
}
const mc = new ethers.Interface(['function aggregate3(( address target, bool allowFailure, bytes callData )[] calls) payable returns (( bool success, bytes returnData )[] returnData)']);
const balCall = { target: MULTICALL3, allowFailure: true, callData: '0x4d2301cc' + EOA.slice(2).toLowerCase().padStart(64, '0') };
const ADDR = EOA.slice(2).toLowerCase().padStart(64, '0');
console.log(`STAGE 3 — firing at ${funded.length} funded factory-born contracts…`);
const findings = [];
for (const f of funded) {
  for (const s of selectorsOf(f.code).slice(0, 80)) {
    for (const data of [s, s + ADDR]) {
      try {
        const res = await rpc('eth_call', [{ from: EOA, to: MULTICALL3, data: mc.encodeFunctionData('aggregate3', [[balCall, { target: f.address, allowFailure: true, callData: data }, balCall]]) }, 'latest']);
        const [dec] = mc.decodeFunctionResult('aggregate3', res);
        if (!dec[1].success || !dec[0].success || !dec[2].success) continue;
        const delta = BigInt(dec[2].returnData) - BigInt(dec[0].returnData);
        if (delta > 0n) {
          findings.push({ contract: f.address, holds: f.bal, selector: data.slice(0, 10), gained: ethers.formatEther(delta), gained_wei: delta.toString(), bornBlock: f.block, creator: f.creator });
          console.log(`  *** PAYS ZERO: ${f.address} ${data.slice(0, 10)} +${ethers.formatEther(delta)} ${C.sym} (holds ${f.bal})`);
        }
      } catch { }
    }
    await sleep(40);
  }
}

const out = { probedAt: new Date().toISOString(), chain, blocksScanned: done, internalTxs: seen, factoryBorn: born.size, funded: funded.map(({ code, ...r }) => r).slice(0, 60), findings };
writeFileSync(new URL(`./factory-born-${chain}.json`, import.meta.url), JSON.stringify(out, null, 2));
console.log(`\n=== ${born.size} factory-born · ${funded.length} funded · ${findings.length} PAY ZERO ===`);
console.log(`saved -> scripts/factory-born-${chain}.json`);
