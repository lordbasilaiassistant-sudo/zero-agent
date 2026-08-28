// _kb_lib.mjs — keeper-bounties lane harness. READ-ONLY. eth_call / eth_getCode only.
//
// The ONE rule this file exists to enforce: a payment test is an ISOLATED aggregate3 shaped
//   [ balanceOf(X), <the one call>, balanceOf(X) ]
// with exactly ONE candidate call in it. Batching candidates shares state and produced 92% phantoms.
// Multiple BALANCE READS around a single call are still isolated (reads have no side effects), so
// probeIsolated may read several tokens at once — but never several candidate calls.
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { LIVE_EOA, SMART_ACCOUNT } from '../../shop.mjs';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const ZERO_EOA = LIVE_EOA;
export const ZERO_SAFE = SMART_ACCOUNT;

export const RPCS = {
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  optimism: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
  arbitrum: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  polygon: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
  gnosis: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com'],
  unichain: ['https://unichain-rpc.publicnode.com', 'https://mainnet.unichain.org'],
};

const CACHE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '_cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
const cacheKey = (s) => path.join(CACHE_DIR, ethers.id(s).slice(2, 34) + '.json');
export function cacheGet(k) { try { return JSON.parse(fs.readFileSync(cacheKey(k), 'utf8')); } catch { return null; } }
export function cacheSet(k, v) { try { fs.writeFileSync(cacheKey(k), JSON.stringify(v)); } catch {} ; return v; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rrIdx = {};

// Pinned blocks so every measurement in this lane is comparable and reproducible.
export const PINNED = {};
export async function pin(chain) {
  if (PINNED[chain]) return PINNED[chain];
  const h = await rpc(chain, 'eth_blockNumber', []);
  PINNED[chain] = '0x' + BigInt(h).toString(16);
  return PINNED[chain];
}
export const pinnedDec = (chain) => PINNED[chain] ? Number(BigInt(PINNED[chain])) : null;

export async function rpc(chain, method, params, { tries = 4 } = {}) {
  const urls = RPCS[chain];
  if (!urls) throw new Error(`no rpc for ${chain}`);
  let lastErr;
  for (let t = 0; t < tries; t++) {
    rrIdx[chain] = ((rrIdx[chain] || 0) + 1) % urls.length;
    const url = urls[rrIdx[chain]];
    try {
      const ctl = AbortSignal.timeout(30000);
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl,
      });
      if (r.status === 429) { await sleep(900 * (t + 1)); continue; }
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.result;
    } catch (e) { lastErr = e; await sleep(350 * (t + 1)); }
  }
  throw lastErr || new Error('rpc failed');
}

export const AGG = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
]);
export const sel = (sig) => ethers.id(sig).slice(0, 10);
export const balOf = (a) => '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0');
export const ethBalOf = (a) => '0x4d2301cc' + a.slice(2).toLowerCase().padStart(64, '0'); // Multicall3.getEthBalance
export const addrArg = (a) => a.slice(2).toLowerCase().padStart(64, '0');
export const u256 = (n) => BigInt(n).toString(16).padStart(64, '0');

// --- proxy resolution -------------------------------------------------------
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const LEGACY_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const word = (v) => { if (!v || v.length < 42) return null; const a = '0x' + v.slice(-40); return /^0x0+$/i.test(a) ? null : ethers.getAddress(a); };
export async function implOf(chain, c) {
  const ck = `impl:${chain}:${c}`; const hit = cacheGet(ck); if (hit !== null) return hit;
  let out = null;
  try {
    for (const s of [IMPL_SLOT, LEGACY_SLOT]) {
      const a = word(await rpc(chain, 'eth_getStorageAt', [c, s, 'latest']).catch(() => null));
      if (a) { out = a; break; }
    }
    if (!out) {
      const b = word(await rpc(chain, 'eth_getStorageAt', [c, BEACON_SLOT, 'latest']).catch(() => null));
      if (b) out = word(await rpc(chain, 'eth_call', [{ to: b, data: '0x5c60da1b' }, 'latest']).catch(() => null));
    }
    if (!out) out = word(await rpc(chain, 'eth_call', [{ to: c, data: '0x5c60da1b' }, 'latest']).catch(() => null));
  } catch {}
  return cacheSet(ck, out);
}

const SKIP_SEL = new Set(['0x06fdde03','0x95d89b41','0x313ce567','0x18160ddd','0x70a08231','0xdd62ed3e',
  '0x01ffc9a7','0x8da5cb5b','0x5c60da1b','0x3644e515','0x54fd4d50','0xa9059cbb','0x23b872dd','0x095ea7b3']);

export function extractSelectors(code) {
  const out = new Set();
  if (!code || code.length < 10) return [];
  const hex = code.startsWith('0x') ? code.slice(2) : code;
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) !== '63') continue;
    const s = '0x' + hex.slice(i + 2, i + 10).toLowerCase();
    if (/^0x0{4,}/.test(s)) continue;
    if (SKIP_SEL.has(s)) continue;
    out.add(s);
  }
  return [...out];
}

export async function codeOf(chain, c) {
  const ck = `code:${chain}:${c}`; const hit = cacheGet(ck); if (hit !== null) return hit;
  const code = await rpc(chain, 'eth_getCode', [c, 'latest']).catch(() => '0x');
  return cacheSet(ck, code);
}

/** Full external interface of a contract (proxy + implementation). */
export async function interfaceOf(chain, c) {
  const impl = await implOf(chain, c);
  const [a, b] = await Promise.all([codeOf(chain, c), impl ? codeOf(chain, impl) : Promise.resolve('0x')]);
  return { impl, size: (a.length - 2) / 2, selectors: [...new Set([...extractSelectors(a), ...extractSelectors(b)])], hay: (a + b).toLowerCase() };
}

/** Does the bytecode expose this signature? (dispatch table cannot hide) */
export function has(hay, sig) { return hay.includes(sel(sig).slice(2)); }

// --- the payment test -------------------------------------------------------
/**
 * THE ISOLATED PAYMENT TEST. Exactly ONE candidate call, wrapped in balance reads of `recipient`.
 * Reads are side-effect free, so reading several tokens at once does not break isolation.
 * Returns per-token deltas. Anything > 0 is measured payment.
 */
export async function probeIsolated(chain, target, callData, recipient, tokens, block = 'latest', opts = {}) {
  const pre = [{ target: MULTICALL3, allowFailure: true, callData: ethBalOf(recipient) },
    ...tokens.map(t => ({ target: t.address, allowFailure: true, callData: balOf(recipient) }))];
  const calls = [...pre, { target, allowFailure: true, callData }, ...pre];
  const n = pre.length;
  let rows;
  try {
    // `from` sets tx.origin. MEASURED 2026-07-31: without it, tx.origin is the zero address while
    // msg.sender is Multicall3, so EVERY function guarded by `require(msg.sender == tx.origin)`
    // reverts and reads as "permissioned". Setting from = MULTICALL3 makes origin == sender and the
    // guard passes — which is how you TELL THEM APART. (They are still unreachable for a Safe: a
    // relayed Safe tx always has tx.origin = the relayer, never the Safe.)
    const p = { to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) };
    if (opts.origin) p.from = opts.origin;
    const ret = await rpc(chain, 'eth_call', [p, block]);
    [rows] = AGG.decodeFunctionResult('aggregate3', ret);
  } catch (e) { return { ok: false, reason: 'aggregate3 failed: ' + String(e.message).slice(0, 90) }; }
  const call = rows[n];
  if (!call?.success) return { ok: false, reason: 'call reverts for an arbitrary caller' };
  const deltas = [];
  const names = ['NATIVE', ...tokens.map(t => t.symbol)];
  const addrs = [ethers.ZeroAddress, ...tokens.map(t => t.address)];
  for (let i = 0; i < n; i++) {
    const b = rows[i], a = rows[n + 1 + i];
    if (!b?.success || !a?.success) continue;
    let d = 0n;
    try { d = BigInt(a.returnData) - BigInt(b.returnData); } catch { continue; }
    if (d > 0n) deltas.push({ token: names[i], address: addrs[i], wei: d.toString() });
  }
  return { ok: true, callable: true, pays: deltas.length > 0, deltas, returnData: call.returnData };
}

/** The canonical 3-element form the deliverable asks for: [balanceOf(X), call, balanceOf(X)]. */
export async function probeCanonical(chain, target, callData, recipient, token, block = 'latest') {
  const bd = token === 'NATIVE'
    ? { target: MULTICALL3, callData: ethBalOf(recipient) }
    : { target: token, callData: balOf(recipient) };
  const calls = [
    { target: bd.target, allowFailure: true, callData: bd.callData },
    { target, allowFailure: true, callData },
    { target: bd.target, allowFailure: true, callData: bd.callData },
  ];
  const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }, block]);
  const [rows] = AGG.decodeFunctionResult('aggregate3', ret);
  if (!rows[1].success) return { ok: false, reason: 'reverts' };
  const d = BigInt(rows[2].returnData) - BigInt(rows[0].returnData);
  return { ok: true, wei: d.toString(), pays: d > 0n };
}

/** SCREENING ONLY (shared state — never a finding). Many contracts, one selector. */
export async function screenMany(chain, contracts, callDataFor, recipient, token, per = 24) {
  const out = [];
  const bd = token === 'NATIVE' ? { t: MULTICALL3, d: ethBalOf(recipient) } : { t: token, d: balOf(recipient) };
  for (let i = 0; i < contracts.length; i += per) {
    const slice = contracts.slice(i, i + per);
    const calls = [{ target: bd.t, allowFailure: true, callData: bd.d }];
    for (const c of slice) {
      calls.push({ target: c, allowFailure: true, callData: callDataFor(c) });
      calls.push({ target: bd.t, allowFailure: true, callData: bd.d });
    }
    let rows;
    try {
      const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
      [rows] = AGG.decodeFunctionResult('aggregate3', ret);
    } catch { continue; }
    for (let k = 0; k < slice.length; k++) {
      const b = rows[k * 2], c = rows[1 + k * 2], a = rows[2 + k * 2];
      if (!c?.success) continue;
      let d = 0n; try { d = BigInt(a.returnData) - BigInt(b.returnData); } catch {}
      out.push({ contract: slice[k], callable: true, screenWei: d.toString() });
    }
  }
  return out;
}

export async function ethCall(chain, to, data, block = 'latest') {
  return rpc(chain, 'eth_call', [{ to, data }, block]);
}
export async function tryCall(chain, to, data, block = 'latest') {
  try { return await ethCall(chain, to, data, block); } catch { return null; }
}
export const dec = (hex) => { try { return BigInt(hex); } catch { return null; } };
export const decAddr = (hex) => word(hex);
