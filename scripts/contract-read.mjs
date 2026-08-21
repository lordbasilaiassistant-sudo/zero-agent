#!/usr/bin/env node
/**
 * contract-read.mjs — READ THE CONTRACT, DON'T GUESS AT IT.
 *
 * Anthony, 2026-08-21: *"read hella contracts to understand better too. youll find so many things if
 * you actually get proper context of contract code."*
 *
 * He is right, and the session that produced this file is the proof. I probed Aura's L2 booster with
 * `earmarkRewards(uint256)` — a signature I assumed — and all 36 gnosis pools reverted. Reading the
 * deployed dispatcher instead took one call and produced two facts that no amount of guessing would
 * have reached:
 *
 *   · the real signature is `earmarkRewards(uint256,address)` — the one-arg version is not in the
 *     contract at all, which is precisely why every call reverted;
 *   · `isShutdown()` returns **1** — the booster is retired, so nothing was ever going to pay,
 *     on any signature. Five chains and 241 pools killed by one read each.
 *
 * Guessing a selector can only ever confirm what you already suspected. Reading the dispatcher tells
 * you what is actually there, INCLUDING the thing you did not know to look for — which is the entire
 * "evolutionarily novel" class in DOCTRINE §6, the one nobody has catalogued.
 *
 * HOW IT WORKS, and why it needs no ABI, no explorer key, and no verified source: solc emits every
 * external function's 4-byte selector as a PUSH4 literal in the dispatch table, so the selectors are
 * recoverable from runtime bytecode alone. That works on unverified contracts, proxies (follow the
 * implementation), and contracts whose source was never published. Names come from openchain.xyz's
 * free signature database; an unresolved selector is reported as unknown rather than dropped,
 * because an unnamed function is exactly where an uncatalogued mechanism would hide.
 *
 * Usage:
 *   node scripts/contract-read.mjs <chain> <address> [--calls]
 *   node scripts/contract-read.mjs gnosis 0x98Ef32edd24e2c92525E59afc4475C1242a30184
 *   node scripts/contract-read.mjs base 0x... --calls     # also read every 0-arg view
 */
import { formatUnits } from 'ethers';

const RPC = {
  base: 'https://base-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  gnosis: 'https://rpc.gnosischain.com',
  polygon: 'https://1rpc.io/matic',
  unichain: 'https://unichain-rpc.publicnode.com',
};

const [chain, address, ...rest] = process.argv.slice(2);
if (!chain || !address) { console.error('usage: contract-read.mjs <chain> <address> [--calls]'); process.exit(2); }
const DO_CALLS = rest.includes('--calls');
const url = RPC[chain];
if (!url) { console.error('unknown chain. known: ' + Object.keys(RPC).join(', ')); process.exit(2); }

const rpc = async (method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  return j.error ? null : j.result;
};

/* EIP-1167 minimal proxies and EIP-1967 upgradeable proxies both hide the real code elsewhere.
 * Reading the proxy's own dispatcher would return three functions and miss the entire contract. */
const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
async function resolveImplementation(addr) {
  const code = await rpc('eth_getCode', [addr, 'latest']);
  if (!code || code === '0x') return { addr, code: '', note: 'no code at this address' };
  // EIP-1167: 363d3d373d3d3d363d73<impl>5af43d82803e903d91602b57fd5bf3
  const m = code.match(/363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i);
  if (m) {
    const impl = '0x' + m[1];
    const ic = await rpc('eth_getCode', [impl, 'latest']);
    return { addr: impl, code: ic || '', note: `EIP-1167 minimal proxy -> ${impl}` };
  }
  const slot = await rpc('eth_getStorageAt', [addr, EIP1967_IMPL, 'latest']);
  if (slot && /^0x0*[1-9a-f]/i.test(slot)) {
    const impl = '0x' + slot.slice(26);
    const ic = await rpc('eth_getCode', [impl, 'latest']);
    if (ic && ic !== '0x') return { addr: impl, code: ic, note: `EIP-1967 proxy -> ${impl}` };
  }
  return { addr, code, note: 'direct (not a recognised proxy)' };
}

/** Selectors appear as PUSH4 literals in the dispatch table. Cheap, complete enough, no ABI needed. */
function extractSelectors(code) {
  const out = new Set();
  const hex = code.startsWith('0x') ? code.slice(2) : code;
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) === '63') {           // PUSH4
      const sel = hex.slice(i + 2, i + 10);
      if (/^[0-9a-f]{8}$/.test(sel) && sel !== '00000000' && sel !== 'ffffffff') out.add('0x' + sel);
    }
  }
  return [...out];
}

async function resolveNames(selectors) {
  const names = {};
  for (let i = 0; i < selectors.length; i += 50) {
    const chunk = selectors.slice(i, i + 50);
    try {
      const r = await fetch('https://api.openchain.xyz/signature-database/v1/lookup?function=' + chunk.join(',') + '&filter=true',
        { signal: AbortSignal.timeout(25000) });
      const j = await r.json();
      const res = j?.result?.function || {};
      for (const s of chunk) {
        const hits = res[s];
        if (Array.isArray(hits) && hits.length) names[s] = hits[0].name;
      }
    } catch { /* unresolved stays unknown, which is reported, not hidden */ }
  }
  return names;
}

/* Words that mark a function as paying, incentivising, or gating a caller — the classes we hunt.
 * Deliberately generous: a false hit costs one glance, a miss costs the whole mechanism. */
const INTERESTING = /harvest|earmark|reward|incentive|bount|claim|compound|poke|update|sync|liquidat|redeem|skim|sweep|collect|distribut|notify|checkUpkeep|performUpkeep|exec|settle|finali[sz]e|crank|kick|ping|tend|report/i;
const GATE = /shutdown|paused|owner|guardian|keeper|whitelist|authorized|operator|role/i;

const resolved = await resolveImplementation(address);
console.log(`\n${chain} ${address}`);
console.log(`  ${resolved.note}`);
if (!resolved.code) { console.log('  nothing to read.'); process.exit(0); }
console.log(`  runtime bytecode: ${(resolved.code.length - 2) / 2} bytes`);

const sels = extractSelectors(resolved.code);
console.log(`  selectors in dispatcher: ${sels.length}`);
const names = await resolveNames(sels);
const known = sels.filter(s => names[s]);
console.log(`  named via openchain: ${known.length} · unknown: ${sels.length - known.length}\n`);

const pay = known.filter(s => INTERESTING.test(names[s]));
const gates = known.filter(s => GATE.test(names[s]));

if (pay.length) {
  console.log('== CALLER-FACING / PAYING-SHAPED FUNCTIONS ==');
  for (const s of pay.sort((a, b) => names[a].localeCompare(names[b]))) console.log(`  ${s}  ${names[s]}`);
}
if (gates.length) {
  console.log('\n== GATES / PERMISSIONS (read these before assuming permissionless) ==');
  for (const s of gates.sort((a, b) => names[a].localeCompare(names[b]))) console.log(`  ${s}  ${names[s]}`);
}

if (DO_CALLS) {
  console.log('\n== 0-ARG VIEWS, ACTUALLY CALLED ==');
  for (const s of known) {
    if (!/\(\)$/.test(names[s])) continue;
    const r = await rpc('eth_call', [{ to: address, data: s }, 'latest']);
    if (r == null || r === '0x') continue;
    let v = r;
    if (r.length === 66) {
      const n = BigInt(r);
      v = n < 10n ** 12n ? n.toString() : `${n} (${formatUnits(n, 18)}e18)`;
      if (/^0x0{24}[0-9a-f]{40}$/.test(r)) v = '0x' + r.slice(26);
    }
    console.log(`  ${names[s].padEnd(34)} = ${String(v).slice(0, 80)}`);
  }
}

const unknown = sels.filter(s => !names[s]);
if (unknown.length) {
  console.log(`\n== UNNAMED SELECTORS (${unknown.length}) — an uncatalogued mechanism would live exactly here ==`);
  console.log('  ' + unknown.join(' '));
}
