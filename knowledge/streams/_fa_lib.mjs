// _fa_lib.mjs — faucet/airdrop lane primitives. READ-ONLY: eth_call, eth_getCode, eth_getLogs only.
//
// Two things this file does that the older bruteforce.mjs does not, both measured caveats from the brief:
//   1. Selectors are recovered by WALKING OPCODES, not by scanning for the byte 0x63. A naive scan
//      counts PUSH-immediate data as instructions (~14% phantoms). A walker knows a PUSH4's 4 bytes are
//      data, not the next opcode, so every hit sits on a real instruction boundary.
//   2. EIP-1167 minimal proxies (45 bytes, no dispatch table) are decoded directly from their bytecode
//      pattern. Without this you read a 45-byte blob, find zero functions, and record a false negative.
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { LIVE_EOA, SMART_ACCOUNT } from '../../shop.mjs';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const ZERO_EOA = LIVE_EOA;
export const ZERO_SAFE = SMART_ACCOUNT;

export const RPCS = {
  // llamarpc removed 2026-08-01: it answers with an HTML error page, which every JSON parse in this
  // file reads as a transport failure and silently retries away. A bad endpoint in a round-robin does
  // not look like a bad endpoint, it looks like the chain having nothing to say.
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  optimism: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
  arbitrum: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  polygon: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
  gnosis: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com'],
  unichain: ['https://unichain-rpc.publicnode.com', 'https://mainnet.unichain.org'],
};

// Reference tokens per chain — what a payment worth having would actually arrive as.
export const REF_TOKENS = {
  base: [
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    { symbol: 'DAI', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  ],
  optimism: [
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
  ],
  arbitrum: [
    { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  ],
  polygon: [
    { symbol: 'WPOL', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18 },
    { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  ],
  gnosis: [
    { symbol: 'WXDAI', address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', decimals: 18 },
    { symbol: 'USDC', address: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', decimals: 6 },
  ],
  unichain: [
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'USDC', address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', decimals: 6 },
  ],
};

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CACHE = path.join(HERE, '_cache');
try { fs.mkdirSync(CACHE, { recursive: true }); } catch {}
const ck = (s) => path.join(CACHE, 'fa' + ethers.id(s).slice(2, 34) + '.json');
export function cacheGet(k) { try { return JSON.parse(fs.readFileSync(ck(k), 'utf8')); } catch { return undefined; } }
export function cacheSet(k, v) { try { fs.writeFileSync(ck(k), JSON.stringify(v)); } catch {} return v; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rr = {};
export async function rpc(chain, method, params, { tries = 4 } = {}) {
  const urls = RPCS[chain];
  if (!urls) throw new Error('no rpc for ' + chain);
  let last;
  for (let t = 0; t < tries; t++) {
    rr[chain] = ((rr[chain] || 0) + 1) % urls.length;
    try {
      const r = await fetch(urls[rr[chain]], {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 429) { await sleep(800 * (t + 1)); continue; }
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    } catch (e) { last = e; await sleep(300 * (t + 1)); }
  }
  throw last || new Error('rpc failed');
}

export const AGG = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
]);
export const sel = (sig) => ethers.id(sig).slice(0, 10);
export const balOf = (a) => '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0');
export const ethBalOf = (a) => '0x4d2301cc' + a.slice(2).toLowerCase().padStart(64, '0');
export const addrArg = (a) => a.slice(2).toLowerCase().padStart(64, '0');
export const u256 = (n) => BigInt(n).toString(16).padStart(64, '0');

// ---------------------------------------------------------------- bytecode
/** Drop the trailing CBOR metadata blob solc appends; its bytes are not instructions. */
export function stripMetadata(hex) {
  if (hex.length < 8) return hex;
  const len = parseInt(hex.slice(-4), 16);
  if (!Number.isFinite(len) || len <= 0) return hex;
  const cut = hex.length - 4 - len * 2;
  if (cut <= 0 || cut > hex.length) return hex;
  // solc metadata starts with 0xa1..0xa3 (CBOR map header)
  const head = hex.slice(cut, cut + 2);
  if (!/^a[123]$/i.test(head)) return hex;
  return hex.slice(0, cut);
}

/**
 * Walk the EVM instruction stream and collect PUSH4 immediates.
 * Because the walker knows PUSHn consumes n bytes of DATA, no immediate is ever
 * mistaken for an opcode — which is exactly the 14% phantom rate a naive scan pays.
 */
export function extractSelectors(code) {
  if (!code || code.length < 10) return [];
  let hex = code.startsWith('0x') ? code.slice(2) : code;
  hex = stripMetadata(hex);
  const out = new Set();
  for (let i = 0; i + 2 <= hex.length;) {
    const op = parseInt(hex.slice(i, i + 2), 16);
    if (!Number.isFinite(op)) break;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (op === 0x63) {
        const s = '0x' + hex.slice(i + 2, i + 10).toLowerCase();
        if (s.length === 10 && !/^0x0{6,}/.test(s)) out.add(s);
      }
      i += 2 + n * 2;
    } else i += 2;
  }
  return [...out];
}

const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;
const EIP1167_ALT = /363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i;
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const LEGACY_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const word = (v) => { if (!v || v.length < 42) return null; const a = '0x' + v.slice(-40); return /^0x0+$/i.test(a) ? null : ethers.getAddress(a); };

export async function codeOf(chain, c) {
  const k = `code:${chain}:${c.toLowerCase()}`; const h = cacheGet(k); if (h !== undefined) return h;
  const code = await rpc(chain, 'eth_getCode', [c, 'latest']).catch(() => '0x');
  return cacheSet(k, code);
}

/** Resolve what actually holds the dispatch table: 1167 clone, ERC-1967 proxy, beacon, or itself. */
export async function implOf(chain, c, code) {
  const k = `impl:${chain}:${c.toLowerCase()}`; const h = cacheGet(k); if (h !== undefined) return h;
  let out = null;
  try {
    const raw = (code ?? await codeOf(chain, c)) || '0x';
    const m = EIP1167.exec(raw) || EIP1167_ALT.exec(raw);
    if (m) out = ethers.getAddress('0x' + m[1]);
    if (!out) for (const s of [IMPL_SLOT, LEGACY_SLOT]) {
      const a = word(await rpc(chain, 'eth_getStorageAt', [c, s, 'latest']).catch(() => null));
      if (a) { out = a; break; }
    }
    if (!out) {
      const b = word(await rpc(chain, 'eth_getStorageAt', [c, BEACON_SLOT, 'latest']).catch(() => null));
      if (b) out = word(await rpc(chain, 'eth_call', [{ to: b, data: '0x5c60da1b' }, 'latest']).catch(() => null));
    }
    if (!out) out = word(await rpc(chain, 'eth_call', [{ to: c, data: '0x5c60da1b' }, 'latest']).catch(() => null));
  } catch {}
  return cacheSet(k, out);
}

export async function interfaceOf(chain, c) {
  const code = await codeOf(chain, c);
  if (!code || code === '0x') return { size: 0, selectors: [], impl: null, hay: '', isEOA: true };
  const impl = await implOf(chain, c, code);
  const icode = impl ? await codeOf(chain, impl) : '0x';
  return {
    impl, size: (code.length - 2) / 2,
    selectors: [...new Set([...extractSelectors(code), ...extractSelectors(icode)])],
    hay: (code + icode).toLowerCase(),
    isEOA: false,
  };
}

// ---------------------------------------------------------------- payment test
/**
 * THE PAYMENT TEST — one ISOLATED aggregate3, exactly ONE candidate call, wrapped in balance reads.
 * Balance reads are side-effect free, so reading several tokens at once preserves isolation; only
 * batching several CANDIDATE CALLS shares state (94.7% false positives) and that never happens here.
 *
 * Note on who "the caller" is: inside aggregate3, msg.sender is Multicall3. A faucet paying msg.sender
 * therefore credits Multicall3 in simulation and would credit ZERO's Safe in production — same shape.
 * We measure BOTH addresses so the report can say which one actually received.
 */
export async function payTest(chain, target, callData, tokens, block = 'latest', overrides = null) {
  const watch = [];
  for (const who of [MULTICALL3, ZERO_SAFE]) {
    watch.push({ who, symbol: 'NATIVE', address: ethers.ZeroAddress, target: MULTICALL3, data: ethBalOf(who), decimals: 18 });
    for (const t of tokens) watch.push({ who, symbol: t.symbol, address: t.address, target: t.address, data: balOf(who), decimals: t.decimals ?? 18 });
  }
  const pre = watch.map(w => ({ target: w.target, allowFailure: true, callData: w.data }));
  const calls = [...pre, { target, allowFailure: true, callData }, ...pre];
  const n = pre.length;
  let rows;
  try {
    const p = [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }, block];
    if (overrides) p.push(overrides);
    const ret = await rpc(chain, 'eth_call', p);
    [rows] = AGG.decodeFunctionResult('aggregate3', ret);
  } catch (e) { return { ok: false, callable: false, pays: false, reason: 'aggregate3 failed: ' + String(e.message).slice(0, 100) }; }
  const call = rows[n];
  if (!call?.success) return { ok: true, callable: false, pays: false, reason: 'reverts for an arbitrary caller' };
  const deltas = [];
  for (let i = 0; i < n; i++) {
    const b = rows[i], a = rows[n + 1 + i];
    if (!b?.success || !a?.success) continue;
    let d = 0n;
    try { d = BigInt(a.returnData) - BigInt(b.returnData); } catch { continue; }
    if (d > 0n) deltas.push({ recipient: watch[i].who, token: watch[i].address, symbol: watch[i].symbol, wei: d.toString(), decimals: watch[i].decimals });
  }
  return { ok: true, callable: true, pays: deltas.length > 0, deltas, returnData: call.returnData };
}

/**
 * SCREENING ONLY — shared state across the batch, so a screen hit is NEVER a finding, only a lead
 * that earns an isolated payment test. Many selectors on ONE contract.
 *
 * Two watcher kinds, because money moving can be seen from either end:
 *   'in'  a balance that should RISE   (Multicall3 receives the token)
 *   'out' a balance that should FALL   (the contract's own ETH leaves — this catches native payouts
 *         that Multicall3 could never receive, without needing the prober inside a batch)
 */
export async function screenSelectors(chain, contract, variants, watchers, per = 20) {
  const hits = [];
  const probe = watchers.map(w => ({ target: w.target, allowFailure: true, callData: w.data }));
  const W = probe.length;
  for (let i = 0; i < variants.length; i += per) {
    const slice = variants.slice(i, i + per);
    const calls = [...probe];
    for (const v of slice) { calls.push({ target: contract, allowFailure: true, callData: v.data }); calls.push(...probe); }
    let rows;
    try {
      const ret = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
      [rows] = AGG.decodeFunctionResult('aggregate3', ret);
    } catch { continue; }
    for (let k = 0; k < slice.length; k++) {
      const base = k * (W + 1);
      const c = rows[base + W];
      if (!c?.success) continue;
      let moved = false; const seen = [];
      for (let w = 0; w < W; w++) {
        const b = rows[base + w], a = rows[base + W + 1 + w];
        if (!b?.success || !a?.success) continue;
        let d = 0n; try { d = BigInt(a.returnData) - BigInt(b.returnData); } catch { continue; }
        if (d === 0n) continue;
        const want = watchers[w].dir === 'out' ? d < 0n : d > 0n;
        if (want) { moved = true; seen.push({ watcher: watchers[w].label, delta: d.toString() }); }
      }
      if (moved) hits.push({ ...slice[k], callable: true, screen: seen });
    }
  }
  return hits;
}

// ------------------------------------------------- the NATIVE payment test
// MEASURED 2026-08-01: Multicall3 REJECTS a plain ETH transfer. So a faucet that pays native ETH to
// msg.sender pays nothing inside an aggregate3 and looks dead — a systematic false negative across the
// single most valuable class for ZERO (native ETH needs no swap, and ZERO cannot swap in phase 0).
// Fix: a prober contract that exists only inside eth_call via state override, and DOES accept ETH.
// It is still an isolated payment test — one call, wrapped in self-balance reads — just with a caller
// that behaves like ZERO's Safe (a contract with a payable fallback) instead of like Multicall3.
export const PROBER = ethers.getAddress('0x00000000000000000000000000000000face0003');
// guard(calldatasize<20 -> stop); copy args; before=SELFBALANCE; CALL(target=calldata[0:20], args);
// after=SELFBALANCE; return (before, after, success)
export const PROBER_CODE = '0x36601411603257' + '60143603806014608037' + '47600052' +
  '600060008260806000600035' + '60601c5af1' + '47602052' + '604052' + '60606000f3' + '5b00';

/** Isolated NATIVE-ETH payment test. Returns the wei delta credited to a contract that accepts ETH. */
export async function payTestNative(chain, target, callData, block = 'latest', extraOverrides = null) {
  const ov = { [PROBER]: { code: PROBER_CODE }, ...(extraOverrides || {}) };
  const data = target.toLowerCase() + (callData.startsWith('0x') ? callData.slice(2) : callData);
  let res;
  try {
    res = await rpc(chain, 'eth_call', [{ to: PROBER, data }, block, ov]);
  } catch (e) { return { ok: false, supported: !/override|unsupported|not supported|method/i.test(String(e.message)), reason: String(e.message).slice(0, 110) }; }
  if (!res || res.length < 2 + 192) return { ok: false, reason: 'short return from prober' };
  const b = BigInt('0x' + res.slice(2, 66));
  const a = BigInt('0x' + res.slice(66, 130));
  const ok = BigInt('0x' + res.slice(130, 194)) === 1n;
  return { ok: true, callable: ok, pays: ok && a > b, wei: (a - b).toString(), recipient: PROBER };
}

/** Does this chain's RPC honour eth_call state overrides? Without it the native leg is blind. */
export async function overridesSupported(chain) {
  const r = await payTestNative(chain, MULTICALL3, '0x4d2301cc' + '0'.repeat(64)).catch(() => null);
  return !!(r && r.ok);
}

export async function tryCall(chain, to, data, block = 'latest') {
  try { return await rpc(chain, 'eth_call', [{ to, data }, block]); } catch { return null; }
}

/**
 * DOMAIN GATE on a measured delta. The arithmetic can be flawless and the "payment" still fake.
 *
 * MEASURED 2026-08-01, on a cluster of 11 vanity-address contracts (0x0000…0000) on optimism: every
 * one reported a delta of 462562227601867317537366769653933563683203632049, which is
 * 0x510601f59fda068d70ad6760c9d9085b0f42cbb1 — ZERO's own Safe address, echoed back as a number. The
 * contracts write the address argument into the slot balanceOf reads. Nothing was paid; the balance
 * was poisoned with our own input. A positive delta is a WELL-FORMED result, not a true one.
 *
 * Two bindings a real payment cannot violate:
 *   1. you cannot be paid more of a token than exists  (delta <= totalSupply)
 *   2. a payment is not an address                     (delta != any address in the calldata)
 */
export async function plausibleDelta(chain, delta, tokenAddr, callData) {
  const wei = BigInt(delta);
  if (wei <= 0n) return { ok: false, why: 'non-positive' };
  const hex = (callData || '').toLowerCase().replace(/^0x/, '').slice(8);
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    const w = hex.slice(i, i + 64);
    if (!/^0{24}[0-9a-f]{40}$/.test(w)) continue;
    if (BigInt('0x' + w) === wei) return { ok: false, why: 'the delta IS an address passed in the calldata — the contract wrote our own argument into the balance slot, it did not pay us' };
  }
  if (tokenAddr === ethers.ZeroAddress) return { ok: true };
  const ts = dec(await tryCall(chain, tokenAddr, sel('totalSupply()')));
  if (ts !== null && ts > 0n && wei > ts) return { ok: false, why: `delta ${wei} exceeds the token's totalSupply ${ts} — arithmetically impossible as a transfer` };
  return { ok: true, totalSupply: ts?.toString() ?? null };
}
export const dec = (h) => { try { return BigInt(h); } catch { return null; } };
export const decStr = (h) => { try { return ethers.AbiCoder.defaultAbiCoder().decode(['string'], h)[0]; } catch { return null; } };
