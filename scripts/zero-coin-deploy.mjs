// zero-coin-deploy.mjs — ZERO deploys its own Zora content coin on Base, all rewards to itself.
// Research behind every constant: knowledge/zora-coin-research.md
// Safety: refuses to run unless (a) metadata endpoint is live, (b) wallet is ZERO's EOA,
// (c) balance covers a re-estimated cost with headroom. Idempotent-ish: salted CREATE2 —
// re-running with the same salt after success reverts at the factory, it cannot double-deploy.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ethers } from 'ethers';

const FACTORY = '0x777777751622c0d3258f214F9DF38E35BF45baF3'; // ZoraFactory (verified, probe 2/3)
const ZERO_EOA = '0x50624F7790732f9767180871D03A304756200dB9';
const URI = 'https://zero-agent.broke2built.workers.dev/coin.json';
const NAME = 'ZERO';
const SYMBOL = 'ZERO';
const SALT = ethers.id('ZERO-genesis-coin-1');
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://1rpc.io/base'];

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

// wallet
const envText = readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }
const wallet = new ethers.Wallet(env.AGENT_PRIVATE_KEY);
if (wallet.address.toLowerCase() !== ZERO_EOA.toLowerCase()) throw new Error(`key mismatch: ${wallet.address} is not ZERO's EOA`);

// gate 1: metadata must be live BEFORE the uri is baked into the coin
const metaRes = await fetch(URI);
if (!metaRes.ok) throw new Error(`metadata gate FAILED: ${URI} -> HTTP ${metaRes.status}. Deploy the Worker first.`);
const meta = await metaRes.json();
if (meta.name !== NAME || !meta.image) throw new Error(`metadata gate FAILED: unexpected body ${JSON.stringify(meta).slice(0, 120)}`);
const imgRes = await fetch(meta.image);
if (!imgRes.ok) throw new Error(`metadata gate FAILED: image ${meta.image} -> HTTP ${imgRes.status}`);
console.log(`metadata gate OK: ${URI} live, image ${meta.image} live`);

// calldata — poolConfig copied byte-for-byte from a live content-coin deploy (probe 4)
const probe4 = JSON.parse(readFileSync(new URL('./zora-probe4-result.json', import.meta.url), 'utf8'));
const poolConfig = probe4.sample.args.poolConfig;
if (!poolConfig?.startsWith('0x')) throw new Error('poolConfig missing from probe4 result');
const abi = JSON.parse(readFileSync(new URL('./zora-factory-abi.json', import.meta.url), 'utf8'));
const iface = new ethers.Interface(abi);
const data = iface.encodeFunctionData('deploy(address,address[],string,string,string,bytes,address,address,bytes,bytes32)',
  [ZERO_EOA, [ZERO_EOA], URI, NAME, SYMBOL, poolConfig, ZERO_EOA, ethers.ZeroAddress, '0x', SALT]);

// gate 2: fresh estimate + balance check with measured fees (never recalled ones)
const [balHex, gasHex, feeBlock, prioHex, nonceHex] = await Promise.all([
  rpc('eth_getBalance', [ZERO_EOA, 'latest']),
  rpc('eth_estimateGas', [{ from: ZERO_EOA, to: FACTORY, data, value: '0x0' }]),
  rpc('eth_getBlockByNumber', ['latest', false]),
  rpc('eth_maxPriorityFeePerGas', []).catch(() => '0x0f4240'), // 0.001 gwei fallback
  rpc('eth_getTransactionCount', [ZERO_EOA, 'latest']),
]);
const balance = BigInt(balHex);
const gasLimit = (BigInt(gasHex) * 125n) / 100n;
const baseFee = BigInt(feeBlock.baseFeePerGas);
const prio = BigInt(prioHex);
const maxFee = baseFee * 2n + prio;
const worstCost = gasLimit * maxFee;
console.log(`balance ${ethers.formatEther(balance)} ETH | gasLimit ${gasLimit} | baseFee ${ethers.formatUnits(baseFee, 'gwei')} gwei | worst-case ${ethers.formatEther(worstCost)} ETH`);
if (balance === 0n) throw new Error(`NOT FUNDED YET — send ~0.00003 ETH on Base to ${ZERO_EOA} then re-run.`);
if (balance < (worstCost * 110n) / 100n) throw new Error(`balance too thin: have ${ethers.formatEther(balance)}, want >= ${ethers.formatEther((worstCost * 110n) / 100n)} ETH`);

// send
const tx = {
  type: 2, chainId: 8453, nonce: Number(nonceHex), to: FACTORY, value: 0n, data,
  gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio,
};
const signed = await wallet.signTransaction(tx);
const hash = await rpc('eth_sendRawTransaction', [signed]);
console.log(`sent: ${hash}`);

// wait for receipt
let receipt = null;
for (let i = 0; i < 60 && !receipt; i++) {
  await new Promise(r => setTimeout(r, 2000));
  receipt = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
}
if (!receipt) throw new Error(`no receipt after 120s — check ${hash} on basescan manually`);
console.log(`status ${receipt.status} | gasUsed ${Number(receipt.gasUsed)} | block ${Number(receipt.blockNumber)}`);
if (receipt.status !== '0x1') throw new Error(`DEPLOY REVERTED: ${hash}`);

// find the coin address in the factory's event
let coin = null, eventName = null;
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== FACTORY.toLowerCase()) continue;
  try {
    const p = iface.parseLog({ topics: log.topics, data: log.data });
    if (p && /CoinCreated/i.test(p.name)) {
      eventName = p.name;
      const arg = p.args.coin ?? p.args[p.fragment.inputs.findIndex(i => i.name === 'coin')];
      coin = String(arg);
    }
  } catch { }
}
console.log(`event ${eventName} | coin ${coin}`);

// verify the newborn: it must be a clone whose payoutRecipient is ZERO
let verify = {};
if (coin) {
  const code = await rpc('eth_getCode', [coin, 'latest']);
  const payoutRes = await rpc('eth_call', [{ to: coin, data: ethers.id('payoutRecipient()').slice(0, 10) }, 'latest']);
  verify = {
    isMinimalProxy: code.startsWith('0x363d3d373d3d3d363d73'),
    cloneTarget: code.startsWith('0x363d3d373d3d3d363d73') ? '0x' + code.slice(22, 62) : null,
    payoutRecipient: ethers.getAddress('0x' + payoutRes.slice(26)),
    payoutIsZeroEoa: payoutRes.slice(26).toLowerCase() === ZERO_EOA.slice(2).toLowerCase(),
  };
  console.log('VERIFY:', JSON.stringify(verify, null, 2));
}

const out = {
  deployedAt: new Date().toISOString(), txHash: hash, coin, eventName, verify,
  gasUsed: Number(receipt.gasUsed), effectiveGasPrice: receipt.effectiveGasPrice ? Number(receipt.effectiveGasPrice) : null,
  name: NAME, symbol: SYMBOL, uri: URI, salt: SALT,
  links: coin ? {
    basescan: `https://basescan.org/token/${coin}`,
    blockscout: `https://base.blockscout.com/token/${coin}`,
    zora: `https://zora.co/coin/base:${coin}`,
  } : null,
};
writeFileSync(new URL('./zero-coin-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nRESULT:', JSON.stringify(out.links, null, 2));
console.log('saved -> scripts/zero-coin-result.json');
