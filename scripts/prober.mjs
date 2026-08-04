// prober.mjs — a FAITHFUL payout probe. Fixes the flaw that may have hidden every payer all night.
//
// THE FLAW: our balance sandwich routes through Multicall3, so msg.sender is MULTICALL3. Any
// contract paying its caller implicitly paid Multicall3, our EOA balance never moved, and we
// recorded "does not pay". Every msg.sender-paying mechanism was invisible.
//
// THE FIX: inject prober bytecode AT ZERO'S OWN ADDRESS via state override. Then address(this) is
// ZERO, msg.sender at the target is ZERO, and the payout lands exactly where it really would.
// The prober calls the target, then RETURNS ITS OWN BALANCE — we set the starting balance to a
// known constant, so (returned - constant) is the true payout.
//
// Assembled by hand, per probe:
//   PUSH4 sel · PUSH0 · MSTORE                     selector at mem[28:32]
//   PUSH0 PUSH0 PUSH1 4 PUSH1 28 PUSH0 PUSH20 tgt GAS CALL POP
//   SELFBALANCE · PUSH0 · MSTORE · PUSH1 32 · PUSH0 · RETURN
//
// Read-only: eth_call with overrides. Nothing deploys, nothing spends.
// Usage: node scripts/prober.mjs selftest | scan [file]
import { readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const RPC = 'https://base-rpc.publicnode.com';
const EOA = '0x50624F7790732f9767180871D03A304756200dB9';
const SEED = ethers.parseEther('1');            // known starting balance for the prober
const SEED_HEX = '0x' + SEED.toString(16);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function rpc(method, params, attempt = 0) {
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) { if (/rate|limit/i.test(j.error.message || '') && attempt < 5) { await sleep(500 * (attempt + 1)); return rpc(method, params, attempt + 1); } throw new Error(JSON.stringify(j.error).slice(0, 110)); }
    return j.result;
  } catch (e) { if (attempt < 3) { await sleep(300); return rpc(method, params, attempt + 1); } throw e; }
}

// build prober runtime that calls `target` with a 4-byte `selector`
export function proberCode(target, selector) {
  const sel = selector.replace(/^0x/, '').padEnd(8, '0').slice(0, 8);
  const tgt = target.replace(/^0x/, '').toLowerCase().padStart(40, '0');
  return '0x'
    + '63' + sel            // PUSH4 selector
    + '5f' + '52'           // PUSH0, MSTORE   -> selector occupies mem[28:32]
    + '5f'                  // retSize  = 0
    + '5f'                  // retOffset= 0
    + '6004'                // argsSize = 4
    + '601c'                // argsOffset = 28
    + '5f'                  // value = 0
    + '73' + tgt            // PUSH20 target
    + '5a'                  // GAS
    + 'f1'                  // CALL
    + '50'                  // POP (drop success flag)
    + '47'                  // SELFBALANCE
    + '5f' + '52'           // PUSH0, MSTORE
    + '6020' + '5f' + 'f3'; // PUSH1 32, PUSH0, RETURN
}

// returns payout in wei that ZERO would actually receive
export async function probe(target, selector, extraOverrides = {}) {
  const overrides = { [EOA]: { code: proberCode(target, selector), balance: SEED_HEX }, ...extraOverrides };
  const res = await rpc('eth_call', [{ from: EOA, to: EOA, data: '0x' }, 'latest', overrides]);
  if (!res || res === '0x') return { ok: false, wei: 0n };
  const after = BigInt(res);
  return { ok: true, wei: after > SEED ? after - SEED : 0n };
}

// ── selftest: does the prober actually see a msg.sender payout? ─────────────
// SANDBOX runtime pays its whole balance to msg.sender: CALL(gas, caller, selfbalance, 0,0,0,0)
const SANDBOX = '0x00000000000000000000000000000000DeaDBeef';
const PAY_CALLER = '0x5f5f5f5f47335af100';

async function selftest() {
  console.log('SELFTEST — can the prober see a payout that lands on msg.sender?\n');
  const overrides = {
    [EOA]: { code: proberCode(SANDBOX, '0x00000000'), balance: SEED_HEX },
    [SANDBOX]: { code: PAY_CALLER, balance: '0x' + ethers.parseEther('3').toString(16) },
  };
  const res = await rpc('eth_call', [{ from: EOA, to: EOA, data: '0x' }, 'latest', overrides]);
  const after = res && res !== '0x' ? BigInt(res) : 0n;
  const gain = after > SEED ? after - SEED : 0n;
  console.log(` prober returned balance: ${ethers.formatEther(after)} ETH (seeded ${ethers.formatEther(SEED)})`);
  console.log(` payout detected: ${ethers.formatEther(gain)} ETH`);
  console.log(gain > 0n
    ? ' >>> PASS: the prober SEES msg.sender payouts. Our old Multicall3 probe could not.'
    : ' >>> FAIL: still blind — do not trust any scan built on this until it passes.');
  // control: a contract that pays nothing must read zero
  const ctl = await rpc('eth_call', [{ from: EOA, to: EOA, data: '0x' }, 'latest', {
    [EOA]: { code: proberCode(SANDBOX, '0x00000000'), balance: SEED_HEX },
    [SANDBOX]: { code: '0x5f5ffd', balance: '0x' + ethers.parseEther('3').toString(16) },
  }]);
  const cgain = ctl && ctl !== '0x' ? (BigInt(ctl) > SEED ? BigInt(ctl) - SEED : 0n) : 0n;
  console.log(` control (always-revert): ${ethers.formatEther(cgain)} ETH — must be 0`);
  return gain > 0n && cgain === 0n;
}

// ── scan: re-run every candidate we ever fired, with the faithful prober ────
async function scan() {
  const files = ['sweep1000-result.json', 'freemoney-map-result.json', 'replay-real-result.json'];
  const targets = new Map();
  for (const f of files) {
    let j; try { j = JSON.parse(readFileSync(new URL('./' + f, import.meta.url), 'utf8')); } catch { continue; }
    const arr = (v) => Array.isArray(v) ? v : [];
    for (const r of [...arr(j.permissionless), ...arr(j.top), ...arr(j.results), ...arr(j.sample)]) {
      if (r?.contract && r?.selector) targets.set(r.contract.toLowerCase() + ':' + r.selector, { contract: r.contract, selector: r.selector, callers: r.distinct_callers ?? 0 });
    }
  }
  const list = [...targets.values()];
  console.log(`re-probing ${list.length} (contract, selector) pairs with msg.sender = ZERO…\n`);
  const hits = [];
  let n = 0;
  for (const t of list) {
    try {
      const r = await probe(t.contract, t.selector);
      if (r.wei > 0n) {
        hits.push({ ...t, wei: r.wei.toString(), eth: ethers.formatEther(r.wei) });
        console.log(`  *** PAYS ZERO: ${t.contract} ${t.selector} +${ethers.formatEther(r.wei)} ETH`);
      }
    } catch { }
    if (++n % 50 === 0) console.log(`  …${n}/${list.length}`);
    await sleep(60);
  }
  writeFileSync(new URL('./prober-scan-result.json', import.meta.url), JSON.stringify({ probedAt: new Date().toISOString(), tested: list.length, hits }, null, 2));
  console.log(`\n=== ${list.length} probed · ${hits.length} PAY ZERO ===`);
  console.log('saved -> scripts/prober-scan-result.json');
}

const cmd = process.argv[2] || 'selftest';
if (cmd === 'selftest') { const ok = await selftest(); process.exit(ok ? 0 : 1); }
else if (cmd === 'scan') { if (await selftest()) { console.log('\n'); await scan(); } else console.log('\nrefusing to scan with a blind prober.'); }
