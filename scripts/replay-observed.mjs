// replay-observed.mjs — close the loop the oracle can't: simulate the EXACT selector that was
// OBSERVED paying a caller, from ZERO's own address, and measure the balance delta.
// payout_oracle guesses from a vocabulary of names it already knows. This one replays what the
// chain actually did — no vocabulary, no guessing. Read-only (eth_call only).
import { readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const EOA = '0x50624F7790732f9767180871D03A304756200dB9';
const WETH = '0x4200000000000000000000000000000000000006';
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'];

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 120));
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const map = JSON.parse(readFileSync(new URL('./freemoney-map-result.json', import.meta.url), 'utf8'));
const cands = (map.permissionless ?? []).filter(r => r.usd_per_call > 0).slice(0, 25);
console.log(`replaying ${cands.length} observed payers from ZERO's address…\n`);

const mc = new ethers.Interface([
  'function aggregate3(( address target, bool allowFailure, bytes callData )[] calls) payable returns (( bool success, bytes returnData )[] returnData)',
]);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);

const results = [];
for (const c of cands) {
  // the tokens this contract was seen paying
  const tokens = (c.tokens ?? []).map(t => t.token);
  const probeToken = tokens.find(t => t.toLowerCase() === WETH.toLowerCase()) ?? tokens[0] ?? WETH;
  const balCall = erc20.encodeFunctionData('balanceOf', [EOA]);
  // [balanceOf, target.selector(), balanceOf] — the delta IS the payout, same trick as payout_oracle
  // but with the OBSERVED selector instead of a guessed one.
  const calls = [
    { target: probeToken, allowFailure: true, callData: balCall },
    { target: c.contract, allowFailure: true, callData: c.selector },
    { target: probeToken, allowFailure: true, callData: balCall },
  ];
  const row = { contract: c.contract, selector: c.selector, observed_usd_per_call: c.usd_per_call, distinct_callers: c.distinct_callers, probeToken };
  try {
    const res = await rpc('eth_call', [{ from: EOA, to: MULTICALL, data: mc.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
    const [decoded] = mc.decodeFunctionResult('aggregate3', res);
    row.call_succeeded = decoded[1].success;
    if (decoded[0].success && decoded[2].success) {
      const before = BigInt(decoded[0].returnData), after = BigInt(decoded[2].returnData);
      row.delta_raw = (after - before).toString();
      row.pays_zero_now = after > before;
    }
  } catch (e) { row.error = String(e).slice(0, 140); }
  results.push(row);
  console.log(` ${row.contract} ${row.selector} · call_ok=${row.call_succeeded} · delta=${row.delta_raw ?? 'n/a'} ${row.pays_zero_now ? '  <-- PAYS US' : ''}`);
}

const winners = results.filter(r => r.pays_zero_now);
const out = { probedAt: new Date().toISOString(), tested: results.length, winners: winners.length, results };
writeFileSync(new URL('./replay-observed-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`\n${winners.length} of ${results.length} pay ZERO right now.`);
console.log('saved -> scripts/replay-observed-result.json');
