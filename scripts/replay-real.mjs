// replay-real.mjs — the fix. Replay the FULL observed calldata, not a bare selector.
// For each observed payer: fetch the winning tx, take its exact input, substitute the original
// caller's address everywhere it appears (32-byte-aligned) with ZERO's, and simulate from ZERO.
// Measures the real balance delta on every token that tx paid out. Read-only (eth_call only).
import { readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { SMART_ACCOUNT } from '../shop.mjs';

const EOA = SMART_ACCOUNT;
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// A rate-limited probe looks EXACTLY like a clean zero — genesis says so, and this script proved it
// by reporting 18 untested candidates as failures. Throttle, retry on -32016, never treat it as data.
async function rpc(method, params, attempt = 0) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) {
        if (j.error.code === -32016 || /rate limit/i.test(j.error.message || '')) {
          if (attempt < 5) { await sleep(1500 * (attempt + 1)); return rpc(method, params, attempt + 1); }
          throw new Error('RATE_LIMITED_UNTESTED');
        }
        throw new Error(JSON.stringify(j.error).slice(0, 130));
      }
      return j.result;
    } catch (e) {
      lastErr = e;
      if (String(e.message) === 'RATE_LIMITED_UNTESTED') throw e;
    }
  }
  throw lastErr;
}

const mc = new ethers.Interface([
  'function aggregate3(( address target, bool allowFailure, bytes callData )[] calls) payable returns (( bool success, bytes returnData )[] returnData)',
]);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const bare = (a) => a.toLowerCase().replace(/^0x/, '');

const map = JSON.parse(readFileSync(new URL('./freemoney-map-result.json', import.meta.url), 'utf8'));
const cands = [...(map.permissionless ?? []), ...(map.top ?? [])]
  .filter((r, i, arr) => r.usd_per_call > 0 && arr.findIndex(x => x.contract === r.contract && x.selector === r.selector) === i)
  .sort((a, b) => b.distinct_callers - a.distinct_callers || b.usd_per_call - a.usd_per_call)
  .slice(0, 30);

console.log(`replaying ${cands.length} observed payers with FULL calldata, caller substituted…\n`);
const results = [];

for (const c of cands) {
  const row = { contract: c.contract, selector: c.selector, observed_usd_per_call: c.usd_per_call, distinct_callers: c.distinct_callers, sample_tx: c.sample_tx };
  try {
    const tx = await rpc('eth_getTransactionByHash', [c.sample_tx]);
    if (!tx) { row.error = 'sample tx not found'; results.push(row); continue; }
    const origCaller = bare(tx.from);
    let data = tx.input;
    // substitute the original caller for ZERO everywhere it appears in the calldata
    const occurrences = (data.toLowerCase().match(new RegExp(origCaller, 'g')) || []).length;
    row.caller_in_calldata = occurrences;
    if (occurrences) data = data.replace(new RegExp(origCaller, 'gi'), bare(EOA));
    row.calldata_bytes = (data.length - 2) / 2;

    const tokens = (c.tokens ?? []).map(t => t.token);
    if (!tokens.length) { row.error = 'no token recorded'; results.push(row); continue; }
    const calls = [];
    for (const t of tokens) calls.push({ target: t, allowFailure: true, callData: erc20.encodeFunctionData('balanceOf', [EOA]) });
    calls.push({ target: c.contract, allowFailure: true, callData: data });
    for (const t of tokens) calls.push({ target: t, allowFailure: true, callData: erc20.encodeFunctionData('balanceOf', [EOA]) });

    const res = await rpc('eth_call', [{ from: EOA, to: MULTICALL, data: mc.encodeFunctionData('aggregate3', [calls]) }, 'latest']);
    const [dec] = mc.decodeFunctionResult('aggregate3', res);
    const n = tokens.length;
    row.call_succeeded = dec[n].success;
    row.deltas = {};
    let anyPay = false;
    for (let i = 0; i < n; i++) {
      if (!dec[i].success || !dec[i + n + 1].success) continue;
      const before = BigInt(dec[i].returnData), after = BigInt(dec[i + n + 1].returnData);
      const d = after - before;
      row.deltas[tokens[i]] = d.toString();
      if (d > 0n) anyPay = true;
    }
    row.pays_zero_now = anyPay;
    if (!row.call_succeeded) {
      // capture the revert reason so a failure is informative, not just "false"
      try {
        await rpc('eth_call', [{ from: EOA, to: c.contract, data }, 'latest']);
      } catch (e) { row.revert = String(e.message || e).slice(0, 150); }
    }
  } catch (e) { row.error = String(e).slice(0, 150); }
  row.untested = String(row.error || '').includes('RATE_LIMITED_UNTESTED');
  results.push(row);
  console.log(` ${row.contract} ${row.selector} · sub=${row.caller_in_calldata ?? '?'} · ok=${row.call_succeeded} · ${row.untested ? 'UNTESTED (rate limited)' : row.pays_zero_now ? '*** PAYS ZERO ***' : (row.revert ? row.revert.slice(0, 70) : 'no delta')}`);
  await sleep(700); // stay under the public RPC's limit so a zero means zero
}

const untested = results.filter(r => r.untested);
if (untested.length) console.log(`\n⚠️  ${untested.length} candidates were RATE LIMITED — untested, NOT negatives.`);
const winners = results.filter(r => r.pays_zero_now);
writeFileSync(new URL('./replay-real-result.json', import.meta.url), JSON.stringify({ probedAt: new Date().toISOString(), tested: results.length, winners: winners.length, results }, null, 2));
console.log(`\n${winners.length} of ${results.length} pay ZERO right now.`);
if (winners.length) console.log(JSON.stringify(winners, null, 2));
console.log('saved -> scripts/replay-real-result.json');
