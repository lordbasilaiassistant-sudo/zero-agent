// prober-token.mjs — closes the last known fidelity gap: ERC-20 payouts.
//
// prober.mjs measured SELFBALANCE, so it saw NATIVE payouts only. Nearly every keeper fee on Base
// settles in WETH or USDC, so "0 of 66 pay ZERO" was honest for ETH and BLIND for tokens.
// This variant runs the target call, then STATICCALLs token.balanceOf(address(this)) and returns
// that — with the prober injected AT ZERO'S OWN ADDRESS, so msg.sender at the target is genuinely
// ZERO and the token lands where it really would.
//
// Assembled runtime:
//   PUSH4 sel · PUSH0 · MSTORE                                  selector -> mem[28:32]
//   PUSH0 PUSH0 PUSH1 4 PUSH1 28 PUSH0 PUSH20 target GAS CALL POP
//   PUSH4 70a08231 · PUSH0 · MSTORE                             balanceOf sel -> mem[28:32]
//   ADDRESS · PUSH1 32 · MSTORE                                 address(this) -> mem[32:64]
//   PUSH1 32 PUSH1 64 PUSH1 36 PUSH1 28 PUSH20 token GAS STATICCALL POP
//   PUSH1 32 · PUSH1 64 · RETURN                                return mem[64:96] = our balance
//
// Read-only. Usage: node scripts/prober-token.mjs selftest | scan
import { readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { SMART_ACCOUNT } from '../shop.mjs';

const RPC = 'https://base-rpc.publicnode.com';
const EOA = SMART_ACCOUNT;
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

function proberCode(target, selector, token) {
  const sel = selector.replace(/^0x/, '').padEnd(8, '0').slice(0, 8);
  const tgt = target.replace(/^0x/, '').toLowerCase().padStart(40, '0');
  const tok = token.replace(/^0x/, '').toLowerCase().padStart(40, '0');
  return '0x'
    + '63' + sel + '5f' + '52'                       // selector -> mem[28:32]
    + '5f5f' + '6004' + '601c' + '5f' + '73' + tgt + '5a' + 'f1' + '50'  // CALL target, drop result
    + '6370a08231' + '5f' + '52'                     // balanceOf selector -> mem[28:32]
    + '30' + '6020' + '52'                           // ADDRESS -> mem[32:64]
    + '6020' + '6040' + '6024' + '601c' + '73' + tok + '5a' + 'fa' + '50' // STATICCALL balanceOf
    + '6020' + '6040' + 'f3';                        // return mem[64:96]
}

async function probeToken(target, selector, token, extra = {}) {
  const overrides = { [EOA]: { code: proberCode(target, selector, token), balance: '0x0' }, ...extra };
  const res = await rpc('eth_call', [{ from: EOA, to: EOA, data: '0x' }, 'latest', overrides]);
  if (!res || res === '0x') return { ok: false, bal: 0n };
  return { ok: true, bal: BigInt(res) };
}

// ── selftest: prove it detects an ERC-20 payout to msg.sender ───────────────
async function selftest() {
  console.log('SELFTEST — can it see an ERC-20 payout landing on msg.sender?\n');
  // baseline: ZERO holds no WETH, and a no-op target must read 0
  const noop = await probeToken(SANDBOX, '0x00000000', WETH, { [SANDBOX]: { code: '0x00' } });
  console.log(` control (no-op target): WETH balance reads ${ethers.formatEther(noop.bal)} — must be 0`);

  // positive: inject a WETH balance for ZERO via storage override; the prober must SEE it.
  // WETH9 on Base keeps balanceOf at slot 3.
  const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [EOA, 3]));
  const withBal = await probeToken(SANDBOX, '0x00000000', WETH, {
    [SANDBOX]: { code: '0x00' },
    [WETH]: { stateDiff: { [slot]: ethers.toBeHex(ethers.parseEther('2.5'), 32) } },
  });
  console.log(` injected 2.5 WETH:      prober reads ${ethers.formatEther(withBal.bal)}`);
  const pass = noop.bal === 0n && withBal.bal === ethers.parseEther('2.5');
  console.log(pass ? ' >>> PASS: token-balance readback is faithful.' : ' >>> FAIL: do not trust a scan built on this.');
  return pass;
}

// ── scan every candidate for TOKEN payouts ─────────────────────────────────
async function scan() {
  const files = ['sweep1000-result.json', 'freemoney-map-result.json', 'replay-real-result.json', 'oracle-sweep-result.json'];
  const targets = new Map();
  for (const f of files) {
    let j; try { j = JSON.parse(readFileSync(new URL('./' + f, import.meta.url), 'utf8')); } catch { continue; }
    const arr = (v) => Array.isArray(v) ? v : [];
    for (const r of [...arr(j.permissionless), ...arr(j.top), ...arr(j.results), ...arr(j.sample), ...arr(j.rows)]) {
      const c = r?.contract, s = r?.selector || r?.fn;
      if (c && s && /^0x[0-9a-fA-F]{8}$/.test(s)) targets.set(c.toLowerCase() + s, { contract: c, selector: s });
    }
  }
  const list = [...targets.values()];
  console.log(`\nprobing ${list.length} pairs for WETH and USDC payouts (msg.sender = ZERO)…\n`);
  const hits = [];
  let n = 0;
  for (const t of list) {
    for (const [tok, sym, dec] of [[WETH, 'WETH', 18], [USDC, 'USDC', 6]]) {
      try {
        const r = await probeToken(t.contract, t.selector, tok);
        if (r.bal > 0n) {
          hits.push({ ...t, token: sym, raw: r.bal.toString(), amount: ethers.formatUnits(r.bal, dec) });
          console.log(`  *** PAYS ZERO: ${t.contract} ${t.selector} -> ${ethers.formatUnits(r.bal, dec)} ${sym}`);
        }
      } catch { }
    }
    if (++n % 40 === 0) console.log(`  …${n}/${list.length}`);
    await sleep(50);
  }
  writeFileSync(new URL('./prober-token-result.json', import.meta.url), JSON.stringify({ probedAt: new Date().toISOString(), tested: list.length, hits }, null, 2));
  console.log(`\n=== ${list.length} probed · ${hits.length} PAY ZERO IN TOKENS ===`);
  if (hits.length) console.log(JSON.stringify(hits, null, 2));
}

const cmd = process.argv[2] || 'selftest';
if (cmd === 'selftest') await selftest();
else if (cmd === 'scan') { if (await selftest()) await scan(); else console.log('\nrefusing to scan with an unvalidated prober.'); }
