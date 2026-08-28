// rollout.mjs — the game-tree engine. Everything we fired before was DEPTH 1.
//
// THE INSIGHT: Multicall3.aggregate3 executes its calls SEQUENTIALLY INSIDE ONE eth_call, so state
// carries from one action to the next. That makes it a free, unlimited rollout engine against real
// live chain state — the "perfect simulator" half of the AlphaGo analogy, already shipped by the EVM.
// A move that reverts alone can pay as move 3 of a sequence; we have never once looked.
//
// Search: for a target contract, enumerate candidate actions (its own selectors + generic setup
// moves), then breadth-search sequences up to DEPTH, scoring each rollout by the NET BALANCE DELTA
// to ZERO across every token the contract touches. Keep any sequence that ends richer.
//
// Nothing can move: aggregate3 is invoked through eth_call, never sent. Rollouts are free and
// unlimited, which is exactly why depth is affordable.
//
// Usage: node scripts/rollout.mjs <0xcontract> [depth] [chain]
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { SMART_ACCOUNT } from '../shop.mjs';

const CHAINS = {
  base: { rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'], weth: '0x4200000000000000000000000000000000000006', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  gnosis: { rpcs: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'], weth: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', usdc: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83' },
};
const TARGET = process.argv[2];
const DEPTH = Number(process.argv[3] || 3);
const CH = CHAINS[process.argv[4] || 'base'];
const EOA = SMART_ACCOUNT;
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
if (!/^0x[0-9a-fA-F]{40}$/.test(TARGET || '')) { console.log('usage: node scripts/rollout.mjs <0xcontract> [depth] [chain]'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let rr = 0;
async function rpc(method, params, attempt = 0) {
  const url = CH.rpcs[(rr++) % CH.rpcs.length];
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) {
      if (/rate|limit|busy|capacity/i.test(j.error.message || '') && attempt < 5) { await sleep(400 * (attempt + 1)); return rpc(method, params, attempt + 1); }
      throw new Error(JSON.stringify(j.error).slice(0, 110));
    }
    return j.result;
  } catch (e) { if (attempt < 3) { await sleep(250 * (attempt + 1)); return rpc(method, params, attempt + 1); } throw e; }
}

const mc = new ethers.Interface(['function aggregate3(( address target, bool allowFailure, bytes callData )[] calls) payable returns (( bool success, bytes returnData )[] returnData)']);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);

// ── candidate actions ───────────────────────────────────────────────────────
function selectorsOf(code) {
  const out = new Set(); const hex = code.slice(2);
  for (let i = 0; i + 10 <= hex.length; i += 2)
    if (hex.slice(i, i + 2) === '63') { const s = '0x' + hex.slice(i + 2, i + 10); if (!/^0x0{8}$/.test(s) && !/^0xf{8}$/.test(s)) out.add(s); }
  return [...out];
}
// A PROXY'S BYTECODE HAS NO DISPATCH TABLE — harvesting the shell yields 2 selectors and a dead
// search. Resolve the implementation first (EIP-1967 impl slot, beacon slot -> implementation(),
// or a direct implementation()). This trap has fired four times in this project now.
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
async function resolveImpl(addr) {
  for (const slot of [IMPL_SLOT, BEACON_SLOT]) {
    const raw = await rpc('eth_getStorageAt', [addr, slot, 'latest']).catch(() => null);
    if (raw && BigInt(raw) !== 0n) {
      const a = '0x' + raw.slice(26);
      if (slot === BEACON_SLOT) {
        const r = await rpc('eth_call', [{ to: a, data: '0x5c60da1b' }, 'latest']).catch(() => null); // implementation()
        if (r && BigInt(r) !== 0n) return '0x' + r.slice(26);
      }
      return a;
    }
  }
  const r = await rpc('eth_call', [{ to: addr, data: '0x5c60da1b' }, 'latest']).catch(() => null);
  if (r && r !== '0x' && BigInt(r) !== 0n) return '0x' + r.slice(26);
  return null;
}

let code = await rpc('eth_getCode', [TARGET, 'latest']);
if (!code || code === '0x') { console.log('not a contract'); process.exit(1); }
let sels = selectorsOf(code);
let implNote = '';
if (sels.length < 8 || (code.length - 2) / 2 < 600) {
  const impl = await resolveImpl(TARGET);
  if (impl) {
    const ic = await rpc('eth_getCode', [impl, 'latest']).catch(() => null);
    if (ic && ic !== '0x') {
      const isels = selectorsOf(ic);
      if (isels.length > sels.length) { sels = isels; implNote = ` (proxy -> impl ${impl}, ${isels.length} selectors)`; }
    }
  }
}
console.log(`target ${TARGET} · ${(code.length - 2) / 2} bytes · ${sels.length} selectors${implNote}`);

// action set: bare selectors, selectors taking our address, plus generic setup moves
const ADDR_ARG = EOA.slice(2).toLowerCase().padStart(64, '0');
const actions = [];
for (const s of sels.slice(0, 60)) {
  actions.push({ label: `${s}()`, target: TARGET, data: s });
  actions.push({ label: `${s}(self)`, target: TARGET, data: s + ADDR_ARG });
}
// setup moves that unlock other moves (classic depth-2 dependency)
actions.push({ label: 'approve(target,max)@weth', target: CH.weth, data: erc20.encodeFunctionData('approve', [TARGET, ethers.MaxUint256]) });
actions.push({ label: 'approve(target,max)@usdc', target: CH.usdc, data: erc20.encodeFunctionData('approve', [TARGET, ethers.MaxUint256]) });
console.log(`action set: ${actions.length}`);

const TOKENS = [CH.weth, CH.usdc];
const balCalls = TOKENS.map(t => ({ target: t, allowFailure: true, callData: erc20.encodeFunctionData('balanceOf', [EOA]) }));

// ── rollout: [balances, ...sequence, balances] in ONE eth_call ──────────────
async function rolloutSeq(seq) {
  const calls = [...balCalls, ...seq.map(a => ({ target: a.target, allowFailure: true, callData: a.data })), ...balCalls];
  const res = await rpc('eth_call', [{ from: EOA, to: MULTICALL, data: mc.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
  const [dec] = mc.decodeFunctionResult('aggregate3', res);
  const n = TOKENS.length;
  const okFlags = seq.map((_, i) => dec[n + i].success);
  const deltas = {};
  let gained = false;
  for (let i = 0; i < n; i++) {
    if (!dec[i].success || !dec[dec.length - n + i].success) continue;
    const d = BigInt(dec[dec.length - n + i].returnData) - BigInt(dec[i].returnData);
    if (d !== 0n) deltas[TOKENS[i]] = d.toString();
    if (d > 0n) gained = true;
  }
  return { okFlags, anyOk: okFlags.some(Boolean), allOk: okFlags.every(Boolean), deltas, gained };
}

// ── breadth search ──────────────────────────────────────────────────────────
console.log(`searching sequences to depth ${DEPTH}…`);
const wins = [];
let frontier = [[]];
let rollouts = 0;
for (let d = 1; d <= DEPTH; d++) {
  const next = [];
  for (const prefix of frontier) {
    for (const a of actions) {
      const seq = [...prefix, a];
      let r;
      try { r = await rolloutSeq(seq); } catch { continue; }
      rollouts++;
      if (r.gained) {
        wins.push({ depth: d, sequence: seq.map(x => x.label), deltas: r.deltas });
        console.log(`  *** GAIN at depth ${d}: ${seq.map(x => x.label).join(' -> ')} ${JSON.stringify(r.deltas)}`);
      }
      // a step that EXECUTED (didn't revert) is worth extending — that's the branch that matters
      if (r.okFlags[d - 1] && next.length < 40) next.push(seq);
      if (rollouts % 100 === 0) console.log(`  …${rollouts} rollouts, depth ${d}, frontier ${next.length}`);
    }
  }
  frontier = next;
  console.log(` depth ${d} done · ${rollouts} rollouts · ${frontier.length} live branches · ${wins.length} gains`);
  if (!frontier.length) break;
}

const out = { probedAt: new Date().toISOString(), target: TARGET, depth: DEPTH, rollouts, wins };
writeFileSync(new URL(`./rollout-${TARGET.slice(0, 10)}.json`, import.meta.url), JSON.stringify(out, null, 2));
console.log(`\n=== ${rollouts} rollouts · ${wins.length} profitable sequences ===`);
console.log(`saved -> scripts/rollout-${TARGET.slice(0, 10)}.json`);
