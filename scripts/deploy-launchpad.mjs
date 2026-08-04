// deploy-launchpad.mjs — ZERO deploys ZeroLaunchpad from its own wallet.
// Gates: simulate the creation first, re-measure fees live, refuse if the balance can't cover it
// with headroom, then verify the deployed code and its immutable constants on-chain afterwards.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ethers } from 'ethers';

const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://1rpc.io/base'];
const EOA = '0x50624F7790732f9767180871D03A304756200dB9';
const FACTORY = '0x777777751622c0d3258f214F9DF38E35BF45baF3';
const RESERVE = 30_000_000_000_000n; // keep 0.00003 ETH for the shop's delivery leg

async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 140));
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}

const bin = '0x' + readFileSync(new URL('../contracts/ZeroLaunchpad.bin', import.meta.url), 'utf8').trim();
const env = {};
for (const line of readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const wallet = new ethers.Wallet(env.AGENT_PRIVATE_KEY);
if (wallet.address.toLowerCase() !== EOA.toLowerCase()) throw new Error('key is not ZERO');

// gate 1 — the creation must simulate cleanly
const gasHex = await rpc('eth_estimateGas', [{ from: EOA, data: bin }]);
const gas = (BigInt(gasHex) * 125n) / 100n;

// gate 2 — measured fees, not recalled ones
const [block, prioHex, nonceHex, balHex] = await Promise.all([
  rpc('eth_getBlockByNumber', ['latest', false]),
  rpc('eth_maxPriorityFeePerGas', []).catch(() => '0x0f4240'),
  rpc('eth_getTransactionCount', [EOA, 'latest']),
  rpc('eth_getBalance', [EOA, 'latest']),
]);
const baseFee = BigInt(block.baseFeePerGas);
const prio = BigInt(prioHex);
const maxFee = baseFee * 2n + prio;
const worst = gas * maxFee;
const balance = BigInt(balHex);
console.log(`gas ${gas} · baseFee ${ethers.formatUnits(baseFee, 'gwei')} gwei · worst-case ${ethers.formatEther(worst)} ETH · balance ${ethers.formatEther(balance)} ETH`);
if (balance - worst < RESERVE) throw new Error(`would breach the ${ethers.formatEther(RESERVE)} ETH reserve`);

const signed = await wallet.signTransaction({
  type: 2, chainId: 8453, nonce: Number(nonceHex), data: bin, value: 0n,
  gasLimit: gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio,
});
const hash = await rpc('eth_sendRawTransaction', [signed]);
console.log('sent:', hash);

let rcpt = null;
for (let i = 0; i < 45 && !rcpt; i++) { await new Promise(r => setTimeout(r, 2000)); rcpt = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null); }
if (!rcpt) throw new Error('no receipt in 90s — check ' + hash);
if (rcpt.status !== '0x1') throw new Error('DEPLOY REVERTED ' + hash);
const addr = ethers.getAddress(rcpt.contractAddress);
console.log(`deployed: ${addr} · gasUsed ${Number(rcpt.gasUsed)} · block ${Number(rcpt.blockNumber)}`);

// gate 3 — verify on-chain that the immutable constants are what we intended
const code = await rpc('eth_getCode', [addr, 'latest']);
const iface = new ethers.Interface(JSON.parse(readFileSync(new URL('../contracts/ZeroLaunchpad.abi.json', import.meta.url), 'utf8')));
const readAddr = async (fn) => {
  const r = await rpc('eth_call', [{ to: addr, data: iface.encodeFunctionData(fn) }, 'latest']);
  return ethers.getAddress('0x' + r.slice(26));
};
const zeroConst = await readAddr('ZERO');
const facConst = await readAddr('FACTORY');
const verify = {
  codeBytes: (code.length - 2) / 2,
  ZERO: zeroConst, ZERO_ok: zeroConst.toLowerCase() === EOA.toLowerCase(),
  FACTORY: facConst, FACTORY_ok: facConst.toLowerCase() === FACTORY.toLowerCase(),
};
console.log('VERIFY:', JSON.stringify(verify, null, 2));

const out = {
  deployedAt: new Date().toISOString(), address: addr, txHash: hash,
  gasUsed: Number(rcpt.gasUsed), costEth: ethers.formatEther(BigInt(rcpt.gasUsed) * (rcpt.effectiveGasPrice ? BigInt(rcpt.effectiveGasPrice) : maxFee)),
  verify,
  links: { basescan: `https://basescan.org/address/${addr}`, blockscout: `https://base.blockscout.com/address/${addr}` },
};
writeFileSync(new URL('./launchpad-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nsaved -> scripts/launchpad-result.json');
