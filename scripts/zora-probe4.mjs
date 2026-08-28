// zora-probe4.mjs — copy a live poolConfig from a recent factory deploy, build ZERO's deploy, estimate gas.
// Read-only (eth_call/eth_estimateGas only). Saves scripts/zora-probe4-result.json
import { writeFileSync, readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { LIVE_EOA } from '../shop.mjs';

const FACTORY = '0x777777751622c0d3258f214F9DF38E35BF45baF3';
const ZERO_EOA = LIVE_EOA;
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://1rpc.io/base'];
const BS = 'https://base.blockscout.com/api/v2';

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(`${method}@${url}: ${JSON.stringify(j.error)}`);
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const abi = JSON.parse(readFileSync(new URL('./zora-factory-abi.json', import.meta.url), 'utf8'));
const iface = new ethers.Interface(abi);
const out = { probedAt: new Date().toISOString() };

// 1. walk back through recent blocks for factory logs -> recent deploy txs
const latest = Number(await rpc('eth_blockNumber', []));
let txHashes = [];
for (let hi = latest, hop = 0; hop < 12 && txHashes.length < 8; hop++) {
  const lo = hi - 1999;
  try {
    const logs = await rpc('eth_getLogs', [{ address: FACTORY, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }]);
    for (const l of logs) if (!txHashes.includes(l.transactionHash)) txHashes.push(l.transactionHash);
  } catch (e) { out.getLogsErr = String(e).slice(0, 150); }
  hi = lo - 1;
}
out.recentFactoryTxCount = txHashes.length;
console.log(`found ${txHashes.length} recent factory txs (scanned back from block ${latest})`);

// 2. decode them; keep the first plain content-coin deploy (name starts with 'deploy', not CreatorCoin/TrendCoin)
let sample = null;
for (const h of txHashes) {
  try {
    const tx = await rpc('eth_getTransactionByHash', [h]);
    if (!tx || tx.to?.toLowerCase() !== FACTORY.toLowerCase()) continue;
    const parsed = iface.parseTransaction({ data: tx.input, value: tx.value });
    if (!parsed || !/^deploy$/i.test(parsed.name)) continue;
    const named = {};
    parsed.fragment.inputs.forEach((inp, i) => {
      const v = parsed.args[i];
      named[inp.name || `arg${i}`] = typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(String) : String(v);
    });
    sample = { hash: h, from: tx.from, value: BigInt(tx.value).toString(), signature: parsed.signature, args: named };
    break;
  } catch { }
}
if (!sample) { console.log('NO plain deploy() found in recent txs — dump of what was seen saved.'); }
out.sample = sample;
console.log('\nSAMPLE DEPLOY:', JSON.stringify(sample, null, 2));

// 3. build ZERO's deploy: same overload, same poolConfig, value=0, no post-deploy hook, our addresses everywhere
if (sample) {
  const poolConfig = sample.args.poolConfig;
  out.poolConfig = poolConfig;
  // try to read the currency out of poolConfig (version byte + address is the common layout — eyeball aid only)
  try {
    const dec = ethers.AbiCoder.defaultAbiCoder().decode(['uint8', 'address'], ethers.dataSlice(poolConfig, 0));
    out.poolConfigGuess = { version: dec[0].toString(), currency: dec[1] };
  } catch { }

  const uri = 'https://zero-agent.broke2built.workers.dev/coin.json';
  let data;
  if (Object.keys(sample.args).length === 10) {
    const salt = ethers.id('ZERO-genesis-coin-1');
    data = iface.encodeFunctionData('deploy(address,address[],string,string,string,bytes,address,address,bytes,bytes32)',
      [ZERO_EOA, [ZERO_EOA], uri, 'ZERO', 'ZERO', poolConfig, ZERO_EOA, ethers.ZeroAddress, '0x', salt]);
  } else {
    data = iface.encodeFunctionData(sample.signature.replace(/^function /, ''),
      [ZERO_EOA, [ZERO_EOA], uri, 'ZERO', 'ZERO', poolConfig, ZERO_EOA, 0n]);
  }
  out.ourCalldataLen = (data.length - 2) / 2;
  writeFileSync(new URL('./zero-coin-calldata.txt', import.meta.url), data);

  // 4. estimate gas from ZERO's (empty) EOA — no fee fields so balance isn't checked
  try {
    const est = await rpc('eth_estimateGas', [{ from: ZERO_EOA, to: FACTORY, data, value: '0x0' }]);
    out.gasEstimate = Number(est);
  } catch (e) { out.gasEstimateError = String(e).slice(0, 400); }
  const gasPrice = BigInt(await rpc('eth_gasPrice', []));
  out.gasPriceWei = gasPrice.toString();
  if (out.gasEstimate) {
    const costWei = BigInt(out.gasEstimate) * gasPrice;
    out.l2CostEth = ethers.formatEther(costWei);
    // L1 data fee: ~calldata bytes * 16 * l1BaseFee * scalar — small on Base; pad final ask 3x for safety
    out.suggestedFundingEth = ethers.formatEther(costWei * 4n);
  }
  console.log('\nGAS:', JSON.stringify({ gasEstimate: out.gasEstimate, gasEstimateError: out.gasEstimateError,
    gasPriceWei: out.gasPriceWei, l2CostEth: out.l2CostEth, suggestedFundingEth: out.suggestedFundingEth }, null, 2));
}

writeFileSync(new URL('./zora-probe4-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nsaved -> scripts/zora-probe4-result.json');
