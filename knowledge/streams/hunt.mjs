// novel-classes hunter — behaviour-first. Recover interface from bytecode, price EVERY nullary/
// single-address function with an ISOLATED payment test where ZERO's Safe IS the msg.sender
// (state-override injects Multicall3 code at the Safe, so inner calls see caller = Safe). Truthful:
// tx.origin-based payouts pay 0x0 and are correctly excluded; only msg.sender payouts to Safe count.
import { ethers } from 'ethers';
import fs from 'fs';

const CH = {
  base:     { url: 'https://mainnet.base.org' },
  optimism: { url: 'https://optimism-rpc.publicnode.com' },
};
const MC   = '0xcA11bde05977b3631167028862bE2a173976CA11';
const SAFE = '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';

const TOKENS = {
  base: [
    ['WETH', '0x4200000000000000000000000000000000000006'],
    ['USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
    ['USDbC', '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA'],
    ['DAI', '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'],
    ['USDT', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'],
    ['AERO', '0x940181a94A35A4569E4529A3CDfB74e38FD98631'],
    ['cbETH', '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'],
  ],
  optimism: [
    ['WETH', '0x4200000000000000000000000000000000000006'],
    ['USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'],
    ['USDCe', '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'],
    ['DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'],
    ['USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'],
    ['OP', '0x4200000000000000000000000000000000000042'],
    ['VELO', '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db'],
  ],
};

const AGG = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);
const balOf   = (a) => '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0');
const ethBalC = (a) => '0x4d2301cc' + a.slice(2).toLowerCase().padStart(64, '0'); // MC.getEthBalance

async function rpc(url, m, p) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const SKIP = new Set(['0x06fdde03', '0x95d89b41', '0x313ce567', '0x18160ddd', '0x70a08231', '0xdd62ed3e', '0x01ffc9a7', '0x8da5cb5b', '0x5c60da1b', '0x3644e515', '0x54fd4d50', '0xc45a0155', '0x0dfe1681', '0xd21220a7', '0x38d52e0f', '0x7dc0d1d0', '0xfc0c546a', '0x17d7de7c', '0xa9059cbb', '0x23b872dd', '0x095ea7b3', '0x40c10f19', '0x42966c68']);

function stripMetadata(bytes) {
  if (bytes.length < 3) return bytes;
  const len = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  const end = bytes.length - 2 - len;
  if (end > 0 && end < bytes.length && (bytes[end] === 0xa2 || bytes[end] === 0xa3)) return bytes.subarray(0, end);
  return bytes;
}
function extractSelectors(code) {
  const out = new Set();
  if (!code || code.length < 10) return [];
  let bytes = Buffer.from(code.replace(/^0x/, ''), 'hex');
  bytes = stripMetadata(bytes);
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i];
    if (op === 0x63) {
      const s = '0x' + bytes.subarray(i + 1, i + 5).toString('hex');
      if (!/^0x0{4,}/.test(s) && !SKIP.has(s)) out.add(s);
    }
    i += (op >= 0x60 && op <= 0x7f) ? (op - 0x5f + 1) : 1;
  }
  return [...out];
}
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const word = (v) => { if (!v || v.length < 42) return null; const a = '0x' + v.slice(-40); return /^0x0+$/.test(a) ? null : a; };
async function implOf(url, c) {
  try {
    const a = word(await rpc(url, 'eth_getStorageAt', [c, IMPL_SLOT, 'latest']).catch(() => null)); if (a) return a;
    const b = word(await rpc(url, 'eth_getStorageAt', [c, BEACON_SLOT, 'latest']).catch(() => null));
    if (b) return word(await rpc(url, 'eth_call', [{ to: b, data: '0x5c60da1b' }, 'latest']).catch(() => null));
    return word(await rpc(url, 'eth_call', [{ to: c, data: '0x5c60da1b' }, 'latest']).catch(() => null));
  } catch { return null; }
}

// isolated payment test: ONE mutating call, N read balances before+after. Safe = caller (override) = recipient.
async function priceOne(url, block, mcCode, tokens, contract, selData) {
  const reads = [{ target: MC, allowFailure: true, callData: ethBalC(SAFE) }];
  for (const [, t] of tokens) reads.push({ target: t, allowFailure: true, callData: balOf(SAFE) });
  const calls = [...reads, { target: contract, allowFailure: true, callData: selData }, ...reads];
  const data = AGG.encodeFunctionData('aggregate3', [calls]);
  const overrides = { [SAFE]: { code: mcCode } };
  let rows;
  try { const ret = await rpc(url, 'eth_call', [{ to: SAFE, data }, block, overrides]); [rows] = AGG.decodeFunctionResult('aggregate3', ret); }
  catch (e) { return { err: e.message.slice(0, 60) }; }
  const n = reads.length;
  if (!rows[n].success) return { reverted: true };
  const deltas = [];
  for (let k = 0; k < n; k++) {
    const before = rows[k], after = rows[n + 1 + k];
    if (!before.success || !after.success) continue;
    let d = 0n; try { d = BigInt(after.returnData) - BigInt(before.returnData); } catch { continue; }
    if (d > 0n) { const sym = k === 0 ? 'ETH' : tokens[k - 1][0]; const addr = k === 0 ? 'native' : tokens[k - 1][1]; deltas.push({ sym, addr, wei: d.toString() }); }
  }
  return { deltas };
}

const args = process.argv.slice(2);
const CHAINS = args.length ? args : ['base', 'optimism'];
const MAXC = 60, MAXFN = 45;

for (const chain of CHAINS) {
  const { url } = CH[chain];
  const block = '0x' + (parseInt(await rpc(url, 'eth_blockNumber', []), 16)).toString(16);
  const mcCode = await rpc(url, 'eth_getCode', [MC, 'latest']);
  const tokens = TOKENS[chain];
  const uni = JSON.parse(fs.readFileSync(`_uni_${chain}.json`, 'utf8'));
  const cands = uni.top.map(x => x[0]).slice(0, MAXC);
  const results = [];
  let ci = 0;
  for (const c of cands) {
    ci++;
    let code = await rpc(url, 'eth_getCode', [c, 'latest']).catch(() => '0x');
    if (!code || code === '0x') continue;
    let sels = extractSelectors(code);
    if (sels.length < 3) { const impl = await implOf(url, c); if (impl) { const ic = await rpc(url, 'eth_getCode', [impl, 'latest']).catch(() => '0x'); sels = [...new Set([...sels, ...extractSelectors(ic)])]; } }
    if (!sels.length) continue;
    sels = sels.slice(0, MAXFN);
    for (const s of sels) {
      let r = await priceOne(url, block, mcCode, tokens, c, s);
      if (r.deltas && r.deltas.length) { results.push({ chain, contract: c, selector: s, shape: '()', block, deltas: r.deltas }); console.log(`HIT ${chain} ${c} ${s}() ->`, r.deltas.map(d => d.sym + ':' + d.wei).join(',')); }
      const sd = s + SAFE.slice(2).toLowerCase().padStart(64, '0');
      r = await priceOne(url, block, mcCode, tokens, c, sd);
      if (r.deltas && r.deltas.length) { results.push({ chain, contract: c, selector: s, shape: '(address)', block, deltas: r.deltas }); console.log(`HIT ${chain} ${c} ${s}(safe) ->`, r.deltas.map(d => d.sym + ':' + d.wei).join(',')); }
    }
    if (ci % 10 === 0) console.error(`  ${chain} ${ci}/${cands.length} scanned, ${results.length} hits`);
  }
  fs.writeFileSync(`_hits_${chain}.json`, JSON.stringify({ chain, block, candidates: cands.length, results }, null, 1));
  console.log(`=== ${chain}: ${results.length} raw hits across ${cands.length} contracts, block ${block} ===`);
}
