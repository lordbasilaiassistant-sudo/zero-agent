// harvest-eoa.mjs — ZERO's EOA fires direct harvest txs on Base for oracle-proven payers.
// New capability 2026-08-03: the EOA holds native gas, so no relay slot is needed.
// Guards: fresh eth_call sim per target, skip if est. gas cost > half the oracle payout,
// hard reserve floor keeps ETH for the shop delivery leg.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';

const RESERVE_WEI = 40_000_000_000_000n; // 0.00004 ETH stays untouched
const TARGETS = [ // oracle-priced 2026-08-03, scripts/oracle-sweep-result.json
  { contract: '0xafF4f20E5F340f11944DB3eC9adE6A29c13FE67d', payoutWei: 21183129594589n },
  { contract: '0x6aEa497106845bCE2CCe35E770a12a63288c5B65', payoutWei: 7345425357208n },
  { contract: '0xA2f9E116b377A9052B06e005c326f11AD7C6F2fA', payoutWei: 2850183363152n },
];
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://1rpc.io/base'];

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const env = {};
for (const line of fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const wallet = new ethers.Wallet(env.AGENT_PRIVATE_KEY);
const EOA = wallet.address;
const WETH = '0x4200000000000000000000000000000000000006';
const balOf = async (addr) => BigInt(await rpc('eth_call', [{ to: WETH, data: '0x70a08231' + addr.slice(2).padStart(64, '0') }, 'latest']));

const iface = new ethers.Interface(['function harvest(address callFeeRecipient)']);
const results = [];
let nonce = Number(await rpc('eth_getTransactionCount', [EOA, 'latest']));
const wethBefore = await balOf(EOA);

for (const t of TARGETS) {
  const data = iface.encodeFunctionData('harvest', [EOA]);
  const row = { contract: t.contract, oracle_payout_eth: ethers.formatEther(t.payoutWei) };
  try {
    const bal = BigInt(await rpc('eth_getBalance', [EOA, 'latest']));
    const [gasHex, block, prioHex] = await Promise.all([
      rpc('eth_estimateGas', [{ from: EOA, to: t.contract, data }]),
      rpc('eth_getBlockByNumber', ['latest', false]),
      rpc('eth_maxPriorityFeePerGas', []).catch(() => '0x0f4240'),
    ]);
    const gasLimit = (BigInt(gasHex) * 130n) / 100n;
    const maxFee = BigInt(block.baseFeePerGas) * 2n + BigInt(prioHex);
    const worst = gasLimit * maxFee;
    row.est_gas = Number(gasHex); row.worst_cost_eth = ethers.formatEther(worst);
    if (worst * 2n > t.payoutWei) { row.skipped = 'gas cost exceeds half the payout'; results.push(row); console.log(JSON.stringify(row)); continue; }
    if (bal - worst < RESERVE_WEI) { row.skipped = 'would breach ETH reserve floor'; results.push(row); console.log(JSON.stringify(row)); break; }
    const signed = await wallet.signTransaction({ type: 2, chainId: 8453, nonce, to: t.contract, data, value: 0n, gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: BigInt(prioHex) });
    row.txHash = await rpc('eth_sendRawTransaction', [signed]);
    nonce += 1;
    let rcpt = null;
    for (let i = 0; i < 30 && !rcpt; i++) { await new Promise(r => setTimeout(r, 2000)); rcpt = await rpc('eth_getTransactionReceipt', [row.txHash]).catch(() => null); }
    row.status = rcpt?.status ?? 'no-receipt';
    row.gasUsed = rcpt ? Number(rcpt.gasUsed) : null;
  } catch (e) { row.error = String(e).slice(0, 200); }
  results.push(row);
  console.log(JSON.stringify(row));
}

const wethAfter = await balOf(EOA);
const earned = wethAfter - wethBefore;
const summary = {
  at: new Date().toISOString(),
  weth_before: ethers.formatEther(wethBefore), weth_after: ethers.formatEther(wethAfter),
  EARNED_WETH: ethers.formatEther(earned),
  eth_left: ethers.formatEther(BigInt(await rpc('eth_getBalance', [EOA, 'latest']))),
  results,
};
fs.writeFileSync(new URL('./harvest-eoa-result.json', import.meta.url), JSON.stringify(summary, null, 2));
console.log('\nSUMMARY:', JSON.stringify({ EARNED_WETH: summary.EARNED_WETH, eth_left: summary.eth_left }, null, 2));
