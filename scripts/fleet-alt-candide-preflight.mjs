#!/usr/bin/env node
// Follow-up: dummy-sig Candide preflight + 7708 sample + Coinbase predicted code + Gelato chainId string.
// SIMULATE ONLY — no eth_sendUserOperation, no Safe relay POST, no EOA ETH.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { SMART_ACCOUNT, LIVE_EOA } from '../shop.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPCS = ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://1rpc.io/base'];
const CANDIDE = 'https://api.candide.dev/public/v3/8453';
const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const PM = '0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const FH = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const dummySig = () => '0x' + '00'.repeat(12) + 'ff'.repeat(65);

const factoryIface = new ethers.Interface([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address)',
]);
const safeIface = new ethers.Interface([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
]);
const exec = new ethers.Interface([
  'function executeUserOpWithErrorString(address to, uint256 value, bytes data, uint8 operation)',
]);
const epIface = new ethers.Interface(['function getNonce(address sender, uint192 key) view returns (uint256)']);
const erc20 = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);

async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      if (j.error) { last = j.error; continue; }
      return j;
    } catch (e) { last = e; }
  }
  return { error: last };
}
async function rpcOk(method, params) {
  const j = await rpc(method, params);
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 240));
  return j.result;
}
async function candide(method, params) {
  const r = await fetch(CANDIDE, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  const msg = j.error?.message || null;
  const m = msg && (msg.match(/`(0x[0-9a-fA-F]+)`/) || msg.match(/\b(0x[0-9a-fA-F]+)\b/));
  return { http: r.status, error: j.error || null, result: j.result || null, requiredHex: m ? m[1] : null };
}

const out = { at: new Date().toISOString(), submitted: false };

const init = safeIface.encodeFunctionData('setup', [
  [LIVE_EOA], 1, ethers.ZeroAddress, '0x', FH, ethers.ZeroAddress, 0, ethers.ZeroAddress,
]);
const salt = (BigInt(ethers.keccak256(ethers.toUtf8Bytes('zero-fleet-bucket-2-' + LIVE_EOA))) % (2n ** 64n)) + 3n;
const factoryData = factoryIface.encodeFunctionData('createProxyWithNonce', [SINGLETON, init, salt]);
const predicted = '0xc3BF465cF65D70EFc90CbdBEfbcd4292737C2A7F';

const [usdcSafe, allowSafe, usdcPred, nonceRaw, gasPriceHex, block] = await Promise.all([
  rpcOk('eth_call', [{ to: USDC, data: erc20.encodeFunctionData('balanceOf', [SMART_ACCOUNT]) }, 'latest']),
  rpcOk('eth_call', [{ to: USDC, data: erc20.encodeFunctionData('allowance', [SMART_ACCOUNT, PM]) }, 'latest']),
  rpcOk('eth_call', [{ to: USDC, data: erc20.encodeFunctionData('balanceOf', [predicted]) }, 'latest']),
  rpcOk('eth_call', [{ to: EP, data: epIface.encodeFunctionData('getNonce', [SMART_ACCOUNT, 0n]) }, 'latest']),
  rpcOk('eth_gasPrice', []),
  rpcOk('eth_getBlockByNumber', ['latest', false]),
]);
const baseFee = BigInt(block.baseFeePerGas);
const BUNDLER_MIN = 0x5265c0n;
const maxPriority = BUNDLER_MIN;
let maxFee = baseFee * 2n > BUNDLER_MIN ? baseFee * 2n : BUNDLER_MIN;
if (maxFee < maxPriority) maxFee = maxPriority;

out.inventory = {
  usdcSafe: Number(BigInt(usdcSafe)) / 1e6,
  usdcSafeAllowanceToCandidePm: Number(BigInt(allowSafe)) / 1e6,
  usdcAtPredictedNewSafe: Number(BigInt(usdcPred)) / 1e6,
  epNonce: BigInt(nonceRaw).toString(),
  baseFeeGwei: Number(baseFee) / 1e9,
  maxFeeGwei: Number(maxFee) / 1e9,
};

const callData = exec.encodeFunctionData('executeUserOpWithErrorString', [FACTORY, 0n, factoryData, 0]);
const existingOp = {
  sender: SMART_ACCOUNT,
  nonce: ethers.toBeHex(BigInt(nonceRaw)),
  callData,
  callGasLimit: '0x7a120',
  verificationGasLimit: '0x7a120',
  preVerificationGas: '0xc350',
  maxFeePerGas: ethers.toBeHex(maxFee),
  maxPriorityFeePerGas: ethers.toBeHex(maxPriority),
  signature: dummySig(),
};
out.fromExistingSafe = {
  shape: 'UserOp sender=GENESIS II (has USDC) callData=executeUserOp(createProxyWithNonce salt+3) — NOT Rhinestone, NOT initCode-on-empty-sender',
  predictedNewSafe: predicted,
  pmStub: await candide('pm_getPaymasterStubData', [existingOp, EP, '0x2105', { token: USDC }]),
  pmData: await candide('pm_getPaymasterData', [existingOp, EP, '0x2105', { token: USDC }]),
  estimate: await candide('eth_estimateUserOperationGas', [existingOp, EP]),
};

const newOp = {
  sender: predicted,
  nonce: '0x0',
  factory: FACTORY,
  factoryData,
  callData: '0x',
  callGasLimit: '0x30d40',
  verificationGasLimit: '0x7a120',
  preVerificationGas: '0xc350',
  maxFeePerGas: ethers.toBeHex(maxFee),
  maxPriorityFeePerGas: ethers.toBeHex(maxPriority),
  signature: dummySig(),
};
out.initCodeNewSender = {
  shape: 'UserOp sender=undeployed predicted Safe, factory+factoryData=createProxyWithNonce — Candide checks USDC on NEW sender',
  pmStub: await candide('pm_getPaymasterStubData', [newOp, EP, '0x2105', { token: USDC }]),
  pmData: await candide('pm_getPaymasterData', [newOp, EP, '0x2105', { token: USDC }]),
  estimate: await candide('eth_estimateUserOperationGas', [newOp, EP]),
};

function reqUsd(row) {
  const hex = row?.requiredHex;
  if (!hex) return null;
  try { return Number(BigInt(hex)) / 1e6; } catch { return null; }
}
out.fromExistingSafe.requiredUsdc = reqUsd(out.fromExistingSafe.pmStub) ?? reqUsd(out.fromExistingSafe.pmData) ?? reqUsd(out.fromExistingSafe.estimate);
out.initCodeNewSender.requiredUsdc = reqUsd(out.initCodeNewSender.pmStub) ?? reqUsd(out.initCodeNewSender.pmData);

// Gelato: chainId as string (docs use string)
out.gelatoStringChainId = {};
for (const [label, url, body] of [
  ['v2str', 'https://api.gelato.digital/relays/v2/sponsored-call', { chainId: '8453', target: FACTORY, data: factoryData }],
  ['relaystr', 'https://relay.gelato.digital/relays/v2/sponsored-call', { chainId: '8453', target: FACTORY, data: factoryData }],
]) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  out.gelatoStringChainId[label] = { http: r.status, body: (await r.text()).slice(0, 200) };
}

// Coinbase predicted accounts — code + quota
out.coinbasePredicted = [];
for (const addr of ['0xcc41f3c921a23572f300f4ff7f2db2a5e542328b', '0x3494e378164d01e7673e30487796404cae32f3c0']) {
  const code = await rpcOk('eth_getCode', [addr, 'latest']);
  out.coinbasePredicted.push({ address: addr, bytes: code === '0x' ? 0 : (code.length - 2) / 2, empty: !code || code === '0x' });
}

// 7708: any value>0 tx in last 8 blocks
out.eip7708 = { live: false, samples: [] };
const headBlock = await rpcOk('eth_getBlockByNumber', ['latest', true]);
for (const tx of headBlock.transactions || []) {
  if (BigInt(tx.value || '0x0') === 0n) continue;
  try {
    const rcpt = await rpcOk('eth_getTransactionReceipt', [tx.hash]);
    const logs = rcpt?.logs || [];
    const tlogs = logs.filter(l => l.topics?.[0] === TRANSFER);
    const native = tlogs.some(l =>
      l.address.toLowerCase() === tx.from.toLowerCase()
      || (tx.to && l.address.toLowerCase() === tx.to.toLowerCase())
      || l.address === ethers.ZeroAddress);
    out.eip7708.samples.push({
      hash: tx.hash, value: tx.value, inputLen: (tx.input || '0x').length, logCount: logs.length,
      transferLogs: tlogs.length, nativeTransferLog: native, type: tx.type,
    });
    if (native) out.eip7708.live = true;
  } catch (e) {
    out.eip7708.samples.push({ hash: tx.hash, error: String(e).slice(0, 120) });
  }
  if (out.eip7708.samples.length >= 2) break;
}

console.log(JSON.stringify(out, null, 2));
const prevPath = path.join(__dirname, 'fleet-alt-mint-result.json');
const prev = JSON.parse(readFileSync(prevPath, 'utf8'));
prev.followup = out;
writeFileSync(prevPath, JSON.stringify(prev, null, 2));
console.log('merged into', prevPath);
