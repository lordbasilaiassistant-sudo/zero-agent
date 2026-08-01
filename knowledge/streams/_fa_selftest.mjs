// _fa_selftest.mjs — prove the payment test can SEE a payment before trusting it to report zero.
//
// A lane that reports "nothing pays" is only meaningful if the instrument demonstrably detects
// payment when payment happens. So: build a faucet that exists only inside eth_call (state override),
// fund it, and run it through the SAME payTest() the sweep uses. If this goes green, a zero result
// downstream is a fact about the chain, not about the tool.
import { ethers } from 'ethers';
import * as L from './_fa_lib.mjs';

const FAKE = ethers.getAddress('0x00000000000000000000000000000000face0001');
const WETH = '0x4200000000000000000000000000000000000006';
const WETH_BAL_SLOT = 3; // measured by override-readback, not recalled

// "send my entire native balance to whoever called me"
//   PUSH1 0 x4 (retSize,retOff,argsSize,argsOff) ; SELFBALANCE ; CALLER ; GAS ; CALL ; POP ; STOP
const NATIVE_FAUCET = '0x600060006000600047335af15000';

// "transfer(msg.sender, 1e18)" against WETH
//   selector<<224 -> mem[0]; caller -> mem[4]; 1e18 -> mem[36]; CALL(gas, WETH, 0, 0, 0x44, 0, 0)
const ERC20_FAUCET = '0x' + [
  '63a9059cbb', '60e0', '1b', '6000', '52',            // mem[0..32) = selector
  '33', '6004', '52',                                   // mem[4..36) = caller
  '670de0b6b3a7640000', '6024', '52',                   // mem[36..68) = 1e18
  '6000', '6000', '6044', '6000', '6000',               // retSize retOff argsSize argsOff value
  '73' + WETH.slice(2).toLowerCase(), '5a', 'f1', '50', '00',
].join('');

const slotFor = (addr, slot) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [addr, slot]));

async function run() {
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); ok ? pass++ : fail++; };

  // 1. NATIVE positive control, via the ETH-accepting prober -------------------
  {
    const ov = { [FAKE]: { code: NATIVE_FAUCET, balance: '0x' + (10n ** 16n).toString(16) } };
    const r = await L.payTestNative('base', FAKE, '0x', 'latest', ov);
    check('native faucet detected (prober)', r.ok && r.pays && BigInt(r.wei) === 10n ** 16n, r.ok ? `${r.wei} wei to ${r.recipient}` : r.reason);
  }

  // 1b. the blind spot itself, recorded as a fact rather than a guess ----------
  {
    const ov = { [FAKE]: { code: NATIVE_FAUCET, balance: '0x' + (10n ** 16n).toString(16) } };
    const r = await L.payTest('base', FAKE, '0x', L.REF_TOKENS.base, 'latest', ov);
    check('multicall3 leg is blind to native pay (known, why the prober exists)', r.callable && !r.pays, `pays=${r.pays}`);
  }

  // 1c. prober must NOT invent payment where there is none ---------------------
  {
    const ov = { [FAKE]: { code: '0x00', balance: '0x' + (10n ** 16n).toString(16) } };
    const r = await L.payTestNative('base', FAKE, '0x', 'latest', ov);
    check('prober: no-op pays zero', r.ok && r.callable && !r.pays, `callable=${r.callable} wei=${r.wei}`);
  }

  // 2. ERC-20 positive control -------------------------------------------------
  {
    const ov = {
      [FAKE]: { code: ERC20_FAUCET },
      [ethers.getAddress(WETH)]: { stateDiff: { [slotFor(FAKE, WETH_BAL_SLOT)]: '0x' + (10n ** 18n).toString(16).padStart(64, '0') } },
    };
    const r = await L.payTest('base', FAKE, '0x', L.REF_TOKENS.base, 'latest', ov);
    const d = (r.deltas || []).find(x => x.symbol === 'WETH');
    check('erc20 faucet detected', !!d && BigInt(d.wei) === 10n ** 18n, d ? `${d.wei} WETH to ${d.recipient}` : JSON.stringify(r).slice(0, 160));
  }

  // 3. NEGATIVE control: a contract that succeeds but pays nothing --------------
  {
    // "return immediately, pay nobody" — the exact shape that produces false positives when batched.
    const ov = { [FAKE]: { code: '0x00', balance: '0x' + (10n ** 16n).toString(16) } };
    const r = await L.payTest('base', FAKE, '0x', L.REF_TOKENS.base, 'latest', ov);
    check('silent no-op reported as NOT paying', r.callable === true && r.pays === false, `callable=${r.callable} pays=${r.pays}`);
  }

  // 4. NEGATIVE control: the real contract the brief names as a known liar ------
  {
    const C = '0x11dD6940AeA57aAC6aC4D204E13161BB6E5Bf0A8';
    const r = await L.payTest('base', C, L.sel('claim()'), L.REF_TOKENS.base);
    check('known-liar contract not scored as paying', r.pays === false, `callable=${r.callable} ${r.reason || ''}`);
  }

  // 5. selector walker vs known ABI --------------------------------------------
  {
    const i = await L.interfaceOf('base', WETH);
    const need = ['deposit()', 'withdraw(uint256)', 'transfer(address,uint256)', 'approve(address,uint256)', 'totalSupply()'];
    const miss = need.filter(s => !i.selectors.includes(L.sel(s)));
    check('walker recovers WETH real ABI', miss.length === 0, `${i.selectors.length} selectors, missing: ${miss.join(',') || 'none'}`);
  }

  // 6. EIP-1167 clone resolution ------------------------------------------------
  {
    // A 45-byte clone has no dispatch table; if impl resolution works we see the target's functions.
    const clone = '0x' + '363d3d373d3d3d363d73' + WETH.slice(2).toLowerCase() + '5af43d82803e903d91602b57fd5bf3';
    const m = L.extractSelectors(clone);
    check('1167 clone has no dispatch table (as expected)', m.length === 0, `${m.length} selectors from raw clone bytecode`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run();
