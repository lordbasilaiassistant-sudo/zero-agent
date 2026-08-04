// simlab.mjs — MANUFACTURE ground truth instead of waiting for the chain to hand us a positive.
//
// The deadlock: reinforcement needs a profitable action to reinforce, and we have zero real ones.
// The break: `eth_call` accepts a STATE OVERRIDE object (verified working on base-rpc.publicnode.com)
// that injects arbitrary bytecode, balance and storage at any address for the duration of one
// simulated call. Nothing is deployed, nothing is spent, and it is unlimited.
//
// Two capabilities that unlock:
//   A. SYNTHESISE POSITIVES — write contracts that DO pay a caller, inject them, simulate, label.
//      Free, instant, and as many as we want. That is the training corpus we could not collect.
//   B. COUNTERFACTUAL PROBING — the one that matters for money. Every revert tonight meant "you do
//      not have X". Override ZERO's own balance/allowance and re-simulate the SAME real contract to
//      ask: WHAT WOULD I NEED FOR THIS TO PAY? A dead end becomes a shopping list with a price.
//
// Usage: node scripts/simlab.mjs prove          # end-to-end proof on synthetic payers
//        node scripts/simlab.mjs what-if <0xcontract> [chain]
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const RPC = 'https://base-rpc.publicnode.com';
const EOA = '0x50624F7790732f9767180871D03A304756200dB9';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SANDBOX = '0x00000000000000000000000000000000DeaDBeef';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function rpc(method, params, attempt = 0) {
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) { if (/rate|limit/i.test(j.error.message || '') && attempt < 5) { await sleep(500 * (attempt + 1)); return rpc(method, params, attempt + 1); } throw new Error(JSON.stringify(j.error).slice(0, 110)); }
    return j.result;
  } catch (e) { if (attempt < 3) { await sleep(300); return rpc(method, params, attempt + 1); } throw e; }
}

const mc = new ethers.Interface(['function aggregate3(( address target, bool allowFailure, bytes callData )[] calls) payable returns (( bool success, bytes returnData )[] returnData)']);
const ethBal = { target: MULTICALL3, allowFailure: true, callData: '0x4d2301cc' + EOA.slice(2).toLowerCase().padStart(64, '0') };

// measure ZERO's native delta around one call, under an arbitrary injected world state
async function measure(target, data, overrides = {}) {
  const calls = [ethBal, { target, allowFailure: true, callData: data }, ethBal];
  const params = [{ from: EOA, to: MULTICALL3, data: mc.encodeFunctionData('aggregate3', [calls]) }, 'latest'];
  if (Object.keys(overrides).length) params.push(overrides);
  const res = await rpc('eth_call', params);
  const [dec] = mc.decodeFunctionResult('aggregate3', res);
  if (!dec[0].success || !dec[2].success) return { ok: false, delta: 0n, reason: 'balance read failed' };
  return { ok: dec[1].success, delta: BigInt(dec[2].returnData) - BigInt(dec[0].returnData) };
}

// ── A. synthetic payers: hand-written runtime bytecode with KNOWN behaviour ──
// Ground-truth positives, generated from nothing. Each is a distinct "shape" of paying contract,
// which is exactly the variety a triage model needs and the real chain would not give us.
const SPECIMENS = {
  // CALLER, SELFBALANCE, then CALL(gas, caller, selfbalance, 0,0,0,0) — pays its whole balance out
  pay_all_to_caller: '0x5f5f5f5f47335af1005f5ffd',
  // same, but pays only half — tests that we measure AMOUNT, not just "did something move"
  pay_half_to_caller: '0x5f5f5f5f4760029004335af1005f5ffd',
  // reverts always — a guaranteed negative
  always_revert: '0x5f5ffd',
  // returns 1 but moves nothing — the "looks successful, pays nothing" trap our gas heuristic fell for
  succeed_pay_nothing: '0x60015f5260205ff3',
};

async function prove() {
  console.log('A. SYNTHESISING GROUND TRUTH (no deployment, no gas, no chain cooperation)\n');
  const rows = [];
  for (const [name, code] of Object.entries(SPECIMENS)) {
    const r = await measure(SANDBOX, '0x', { [SANDBOX]: { code, balance: '0xde0b6b3a7640000' } }); // 1 ETH
    const label = r.delta > 0n ? 1 : 0;
    rows.push({ specimen: name, executed: r.ok, delta_eth: ethers.formatEther(r.delta), label });
    console.log(` ${name.padEnd(22)} executed=${String(r.ok).padEnd(5)} delta=${ethers.formatEther(r.delta).padEnd(20)} label=${label}`);
  }
  const pos = rows.filter(r => r.label === 1).length;
  console.log(`\n  -> ${pos} synthetic POSITIVES and ${rows.length - pos} negatives, ground truth, generated in one round trip.`);
  console.log('  -> this is the corpus the real chain refused to give us (0 positives in 359k txs).');

  console.log('\nB. COUNTERFACTUAL PROBING — turning "it reverted" into "here is what it would cost"\n');
  // Ask a real, live contract what state would make it pay. WETH.withdraw(1e18) reverts for ZERO
  // (it holds no WETH) — override the balance slot and watch the same call succeed and pay.
  const wd = new ethers.Interface(['function withdraw(uint256)']).encodeFunctionData('withdraw', [ethers.parseEther('1')]);
  const bare = await measure(WETH, wd);
  console.log(` real world:      WETH.withdraw(1 ETH) executed=${bare.ok} delta=${ethers.formatEther(bare.delta)}`);
  // WETH balanceOf mapping is slot 3 on this implementation; compute ZERO's storage key
  const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [EOA, 3]));
  const withWeth = await measure(WETH, wd, { [WETH]: { stateDiff: { [slot]: ethers.toBeHex(ethers.parseEther('1'), 32) } } });
  console.log(` counterfactual:  same call, if ZERO held 1 WETH -> executed=${withWeth.ok} delta=${ethers.formatEther(withWeth.delta)}`);
  console.log(`\n  -> the override tells us the EXACT precondition ("hold 1 WETH") and the EXACT payoff.`);
  console.log('  -> every revert tonight was "you do not have X". This converts each into a priced shopping list.');

  writeFileSync(new URL('./simlab-result.json', import.meta.url), JSON.stringify({ probedAt: new Date().toISOString(), synthetic: rows, counterfactual: { bare_ok: bare.ok, bare_delta: ethers.formatEther(bare.delta), withWeth_ok: withWeth.ok, withWeth_delta: ethers.formatEther(withWeth.delta) } }, null, 2));
  console.log('\nsaved -> scripts/simlab-result.json');
}

// ── what-if: for a real contract, find which precondition unlocks a payout ──
async function whatIf(target) {
  const code = await rpc('eth_getCode', [target, 'latest']);
  const sels = (() => { const o = new Set(); const h = code.slice(2); for (let i = 0; i + 10 <= h.length; i += 2) if (h.slice(i, i + 2) === '63') { const s = '0x' + h.slice(i + 2, i + 10); if (!/^0x0{8}$/.test(s) && !/^0xf{8}$/.test(s)) o.add(s); } return [...o]; })();
  console.log(`${target}: ${sels.length} selectors. probing each under 4 injected world-states…`);
  const WORLDS = {
    'as-is': {},
    'ZERO holds 10 ETH': { [EOA]: { balance: '0x8ac7230489e80000' } },
    'ZERO holds 1 WETH': { [WETH]: { stateDiff: { [ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [EOA, 3]))]: ethers.toBeHex(ethers.parseEther('1'), 32) } } },
    'ZERO holds 1000 USDC': { [USDC]: { stateDiff: { [ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [EOA, 9]))]: ethers.toBeHex(1000000000n, 32) } } },
  };
  const hits = [];
  const ADDR = EOA.slice(2).toLowerCase().padStart(64, '0');
  for (const s of sels.slice(0, 60)) {
    for (const data of [s, s + ADDR]) {
      for (const [world, ov] of Object.entries(WORLDS)) {
        try {
          const r = await measure(target, data, ov);
          if (r.delta > 0n) { hits.push({ selector: data.slice(0, 10), world, gain: ethers.formatEther(r.delta) }); console.log(`  *** ${data.slice(0, 10)} pays ${ethers.formatEther(r.delta)} ETH under "${world}"`); }
        } catch { }
      }
    }
    await sleep(50);
  }
  writeFileSync(new URL(`./simlab-whatif-${target.slice(0, 10)}.json`, import.meta.url), JSON.stringify({ target, hits }, null, 2));
  console.log(`\n${hits.length} paying (selector, precondition) pairs. saved.`);
}

const cmd = process.argv[2];
if (cmd === 'prove') await prove();
else if (cmd === 'what-if') await whatIf(process.argv[3]);
else console.log('usage: node scripts/simlab.mjs prove | what-if <0xcontract>');
