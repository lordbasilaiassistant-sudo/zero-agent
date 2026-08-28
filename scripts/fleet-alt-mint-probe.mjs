#!/usr/bin/env node
// FLEET-ALT mint probe — SIMULATE / PREFLIGHT ONLY.
// Mandate: find another way to mint a Safe (or any smart account with its own free relay quota)
// without Anthony's money, without spending EOA ETH, without retrying the failed Rhinestone
// createProxyWithNonce + 1M gasLimit + salt+2 payload.
// This script NEVER POSTs to safe-client.safe.global/relay (that burns quota even on later Rejected).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { SMART_ACCOUNT, LIVE_EOA, RETIRED_SAFE, RETIRED_EOA } from '../shop.mjs';
import { RELAY_HEADERS } from '../harvest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAILED_PROXY = '0x9f48142d1cda293e6f092e74728ca0d2cc1c161f';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EP07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const CANDIDE_PM = '0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba';
const CANDIDE = 'https://api.candide.dev/public/v3/8453';
const PIMLICO = 'https://public.pimlico.io/v2/8453/rpc';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const FACTORIES = {
  safe141: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  safe130: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
  safe150: '0x14F2982D601c9458F93bd70B218933A6f8165e7b',
  cbsw11: '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',
  cbsw10: '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a',
};
const SINGLETONS = {
  l2_141: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  l1_141: '0x41675C099F32341bf84BFc5382aF534df5C7461a',
  l2_130: '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA',
  l2_150: '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
};
const FALLBACKS = {
  fh141: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
  fh150: '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4',
};
const RPC = {
  base: 'https://base-rpc.publicnode.com',
  gnosis: 'https://rpc.gnosischain.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
};
const CHAIN_IDS = { base: 8453, gnosis: 100, optimism: 10, arbitrum: 42161, polygon: 137 };

const factoryIface = new ethers.Interface([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address)',
  'function createProxyWithNonceL2(address _singleton, bytes initializer, uint256 saltNonce) returns (address)',
  'function createChainSpecificProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address)',
  'function proxyCreationCode() view returns (bytes)',
]);
const safeIface = new ethers.Interface([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
]);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  return j;
}
async function rpcOk(url, method, params) {
  const j = await rpc(url, method, params);
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 220));
  return j.result;
}
function clip(x, n = 240) {
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function codeLen(code) {
  if (!code || code === '0x') return 0;
  return (code.length - 2) / 2;
}
function setupBytes(owner, fallback) {
  return safeIface.encodeFunctionData('setup', [
    [owner], 1, ethers.ZeroAddress, '0x', fallback, ethers.ZeroAddress, 0, ethers.ZeroAddress,
  ]);
}
async function httpTry(url, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    return { http: r.status, ms: Date.now() - t0, body: clip(text, 280) };
  } catch (e) {
    return { http: null, ms: Date.now() - t0, error: String(e.message || e).slice(0, 180) };
  }
}

const out = {
  hunter: 'FLEET-ALT',
  probedAt: new Date().toISOString(),
  slotBudget: 0,
  spentSlot: false,
  txHash: null,
  note: 'SIMULATE ONLY. Failed Rhinestone createProxyWithNonce + gasLimit 1M + salt+2 is NOT retried.',
};

const owner = LIVE_EOA;
const init141 = setupBytes(owner, FALLBACKS.fh141);
const init150 = setupBytes(owner, FALLBACKS.fh150);
const fleetSaltBase = BigInt(ethers.keccak256(ethers.toUtf8Bytes('zero-fleet-bucket-2-' + owner))) % (2n ** 64n);
const genesisSalt = BigInt(ethers.keccak256(ethers.toUtf8Bytes('zero-genesis-ii-' + owner))) % (2n ** 64n);

console.log('owner', owner);
console.log('failed predicted', FAILED_PROXY);
console.log('fleetSaltBase', fleetSaltBase.toString(), 'genesisSalt', genesisSalt.toString());

// ── 0. live quotas + code at known addresses ────────────────────────────────
out.quotas = {};
out.codeAt = {};
const quotaTargets = {
  eoa: LIVE_EOA,
  genesisII: SMART_ACCOUNT,
  failedPredicted: FAILED_PROXY,
  retiredSafe: RETIRED_SAFE,
  retiredEoa: RETIRED_EOA,
};
for (const chain of ['base', 'gnosis', 'optimism', 'arbitrum', 'polygon']) {
  out.quotas[chain] = {};
  for (const [label, addr] of Object.entries(quotaTargets)) {
    const r = await fetch(`https://safe-client.safe.global/v1/chains/${CHAIN_IDS[chain]}/relay/${addr}`, { headers: RELAY_HEADERS });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: clip(text, 80) }; }
    out.quotas[chain][label] = { http: r.status, remaining: j.remaining ?? null, limit: j.limit ?? null };
    await sleep(80);
  }
  console.log(`quota ${chain}: EOA ${out.quotas[chain].eoa.remaining}/${out.quotas[chain].eoa.limit}  Safe ${out.quotas[chain].genesisII.remaining}/${out.quotas[chain].genesisII.limit}  failedProxy ${out.quotas[chain].failedPredicted.remaining}/${out.quotas[chain].failedPredicted.limit}`);
}

for (const chain of ['base', 'gnosis']) {
  out.codeAt[chain] = {};
  const addrs = {
    eoa: LIVE_EOA,
    genesisII: SMART_ACCOUNT,
    failedPredicted: FAILED_PROXY,
    retiredSafe: RETIRED_SAFE,
    factory141: FACTORIES.safe141,
    factory130: FACTORIES.safe130,
    factory150: FACTORIES.safe150,
    singleton141: SINGLETONS.l2_141,
    singleton150: SINGLETONS.l2_150,
    cbsw11: FACTORIES.cbsw11,
    cbsw10: FACTORIES.cbsw10,
  };
  for (const [label, addr] of Object.entries(addrs)) {
    try {
      const code = await rpcOk(RPC[chain], 'eth_getCode', [addr, 'latest']);
      out.codeAt[chain][label] = { address: addr, bytes: codeLen(code), empty: codeLen(code) === 0, eip7702: typeof code === 'string' && code.startsWith('0xef0100') };
    } catch (e) {
      out.codeAt[chain][label] = { address: addr, error: String(e).slice(0, 160) };
    }
    await sleep(40);
  }
}

out.eoaNative = {};
for (const chain of ['base', 'gnosis']) {
  const bal = await rpcOk(RPC[chain], 'eth_getBalance', [LIVE_EOA, 'latest']);
  out.eoaNative[chain] = { wei: BigInt(bal).toString(), eth: ethers.formatEther(bal) };
}
const usdcEoa = await rpcOk(RPC.base, 'eth_call', [{ to: USDC, data: erc20.encodeFunctionData('balanceOf', [LIVE_EOA]) }, 'latest']);
const usdcSafe = await rpcOk(RPC.base, 'eth_call', [{ to: USDC, data: erc20.encodeFunctionData('balanceOf', [SMART_ACCOUNT]) }, 'latest']);
out.usdcBase = { eoa: Number(BigInt(usdcEoa)) / 1e6, safe: Number(BigInt(usdcSafe)) / 1e6 };

console.log('EOA ETH base', out.eoaNative.base.eth, 'USDC eoa/safe', out.usdcBase);
console.log('failed proxy empty?', out.codeAt.base.failedPredicted.empty, 'EOA 7702?', out.codeAt.base.eoa.eip7702, 'bytes', out.codeAt.base.eoa.bytes);

// ── 1. eth_call createProxyWithNonce matrix ─────────────────────────────────
out.factoryCalls = [];
function predict(factory, singleton, initializer, saltNonce, proxyCreationCode) {
  const salt = ethers.keccak256(ethers.concat([
    ethers.keccak256(initializer),
    ethers.zeroPadValue(ethers.toBeHex(saltNonce), 32),
  ]));
  const initCode = ethers.concat([proxyCreationCode, ethers.zeroPadValue(singleton, 32)]);
  return ethers.getCreate2Address(factory, salt, ethers.keccak256(initCode));
}

const pcc = {};
for (const [label, factory] of Object.entries({ safe141: FACTORIES.safe141, safe130: FACTORIES.safe130, safe150: FACTORIES.safe150 })) {
  try {
    const raw = await rpcOk(RPC.base, 'eth_call', [{ to: factory, data: factoryIface.encodeFunctionData('proxyCreationCode', []) }, 'latest']);
    pcc[label] = factoryIface.decodeFunctionResult('proxyCreationCode', raw)[0];
    console.log('proxyCreationCode', label, pcc[label].length, 'chars');
  } catch (e) {
    pcc[label] = null;
    console.log('proxyCreationCode FAIL', label, String(e).slice(0, 120));
  }
}

const variants = [
  { id: 'FAILED-salt+2-141', factory: FACTORIES.safe141, factoryLabel: 'safe141', singleton: SINGLETONS.l2_141, init: init141, salt: fleetSaltBase + 2n, fn: 'createProxyWithNonce', skipSubmit: true },
  { id: 'salt+0-141', factory: FACTORIES.safe141, factoryLabel: 'safe141', singleton: SINGLETONS.l2_141, init: init141, salt: fleetSaltBase + 0n, fn: 'createProxyWithNonce' },
  { id: 'salt+1-141', factory: FACTORIES.safe141, factoryLabel: 'safe141', singleton: SINGLETONS.l2_141, init: init141, salt: fleetSaltBase + 1n, fn: 'createProxyWithNonce' },
  { id: 'salt+3-141', factory: FACTORIES.safe141, factoryLabel: 'safe141', singleton: SINGLETONS.l2_141, init: init141, salt: fleetSaltBase + 3n, fn: 'createProxyWithNonce' },
  { id: 'genesis-ii-salt-141', factory: FACTORIES.safe141, factoryLabel: 'safe141', singleton: SINGLETONS.l2_141, init: init141, salt: genesisSalt, fn: 'createProxyWithNonce' },
  { id: 'salt+2-l1singleton', factory: FACTORIES.safe141, factoryLabel: 'safe141', singleton: SINGLETONS.l1_141, init: init141, salt: fleetSaltBase + 2n, fn: 'createProxyWithNonce' },
  { id: 'factory130-l2_130-salt0', factory: FACTORIES.safe130, factoryLabel: 'safe130', singleton: SINGLETONS.l2_130, init: init141, salt: 0n, fn: 'createProxyWithNonce' },
  { id: 'factory130-l2_130-fleet+3', factory: FACTORIES.safe130, factoryLabel: 'safe130', singleton: SINGLETONS.l2_130, init: init141, salt: fleetSaltBase + 3n, fn: 'createProxyWithNonce' },
  { id: 'factory150-l2_150-salt0', factory: FACTORIES.safe150, factoryLabel: 'safe150', singleton: SINGLETONS.l2_150, init: init150, salt: 0n, fn: 'createProxyWithNonce' },
  { id: 'factory150-l2_150-fleet+3', factory: FACTORIES.safe150, factoryLabel: 'safe150', singleton: SINGLETONS.l2_150, init: init150, salt: fleetSaltBase + 3n, fn: 'createProxyWithNonce' },
  { id: 'factory141-chainSpecific-salt+3', factory: FACTORIES.safe141, factoryLabel: 'safe141', singleton: SINGLETONS.l2_141, init: init141, salt: fleetSaltBase + 3n, fn: 'createChainSpecificProxyWithNonce' },
  { id: 'factory150-nonceL2-salt0', factory: FACTORIES.safe150, factoryLabel: 'safe150', singleton: SINGLETONS.l2_150, init: init150, salt: 0n, fn: 'createProxyWithNonceL2' },
];

for (const v of variants) {
  const data = factoryIface.encodeFunctionData(v.fn, [v.singleton, v.init, v.salt]);
  const row = { id: v.id, fn: v.fn, factory: v.factory, singleton: v.singleton, salt: v.salt.toString(), dataLen: (data.length - 2) / 2, skipSubmit: !!v.skipSubmit };
  try {
    const call = await rpc(RPC.base, 'eth_call', [{ from: owner, to: v.factory, data }, 'latest']);
    if (call.error) {
      row.call = { ok: false, error: clip(call.error, 220) };
    } else {
      let predicted = null;
      try { predicted = factoryIface.decodeFunctionResult(v.fn, call.result)[0]; } catch { predicted = call.result; }
      row.call = { ok: true, predicted };
      if (pcc[v.factoryLabel] && v.fn !== 'createChainSpecificProxyWithNonce') {
        try { row.create2 = predict(v.factory, v.singleton, v.init, v.salt, pcc[v.factoryLabel]); } catch (e) { row.create2Error = String(e).slice(0, 80); }
      }
      const addr = predicted && predicted.startsWith('0x') && predicted.length === 42 ? predicted : row.create2;
      if (addr) {
        const code = await rpcOk(RPC.base, 'eth_getCode', [addr, 'latest']);
        row.codeBytes = codeLen(code);
        row.empty = codeLen(code) === 0;
        const q = await fetch(`https://safe-client.safe.global/v1/chains/8453/relay/${addr}`, { headers: RELAY_HEADERS });
        const qj = await q.json().catch(() => ({}));
        row.quota = { remaining: qj.remaining ?? null, limit: qj.limit ?? null, phantom: (qj.remaining > 0) && codeLen(code) === 0 };
      }
    }
  } catch (e) {
    row.call = { ok: false, error: String(e).slice(0, 180) };
  }
  try {
    const gas = await rpc(RPC.base, 'eth_estimateGas', [{ from: owner, to: v.factory, data }]);
    row.gas = gas.error ? { ok: false, error: clip(gas.error, 160) } : { ok: true, gas: parseInt(gas.result, 16) };
  } catch (e) {
    row.gas = { ok: false, error: String(e).slice(0, 120) };
  }
  out.factoryCalls.push(row);
  console.log(`CALL ${v.id}:`, row.call?.ok ? `predicted ${row.call.predicted} empty=${row.empty} gas=${row.gas?.gas ?? row.gas?.error}` : row.call?.error);
  await sleep(120);
}

// ── 2. Gelato sponsoredCall (NOT Rhinestone) ────────────────────────────────
out.gelato = {};
const gelatoTarget = FACTORIES.safe141;
const gelatoData = factoryIface.encodeFunctionData('createProxyWithNonce', [SINGLETONS.l2_141, init141, fleetSaltBase + 3n]);
out.gelato.payloadShape = { target: gelatoTarget, dataLen: (gelatoData.length - 2) / 2, distinctFromFailed: 'different salt (+3) AND Gelato host, not Safe-client Rhinestone' };

out.gelato.v2sponsored = await httpTry('https://api.gelato.digital/relays/v2/sponsored-call', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chainId: 8453, target: gelatoTarget, data: gelatoData }),
});
out.gelato.v2sponsoredWithEmptyKey = await httpTry('https://api.gelato.digital/relays/v2/sponsored-call', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chainId: 8453, target: gelatoTarget, data: gelatoData, sponsorApiKey: '' }),
});
out.gelato.cloudRpcNoKey = await httpTry('https://api.gelato.cloud/rpc', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'relayer_sendTransaction',
    params: { chainId: '8453', to: gelatoTarget, data: gelatoData, payment: { type: 'sponsored' } },
  }),
});
out.gelato.relayDigital = await httpTry('https://relay.gelato.digital/relays/v2/sponsored-call', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chainId: 8453, target: gelatoTarget, data: gelatoData }),
});
out.gelato.bundler8453 = await httpTry('https://api.gelato.digital/bundlers/8453/rpc', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_supportedEntryPoints', params: [] }),
});
console.log('GELATO v2', out.gelato.v2sponsored);
console.log('GELATO cloud', out.gelato.cloudRpcNoKey);
console.log('GELATO relay.digital', out.gelato.relayDigital);

// Rhinestone's own hosts (different task shape than Safe-client POST) — GET/probe only, no Safe slot.
out.rhinestoneHosts = {
  api: await httpTry('https://api.rhinestone.dev'),
  orchestrator: await httpTry('https://orchestrator.rhinestone.wtf'),
  docs: await httpTry('https://docs.rhinestone.wtf'),
};

// ── 3. ERC-4337 initCode + public paymaster ─────────────────────────────────
out.erc4337 = {};
async function candide(method, params) {
  const r = await fetch(CANDIDE, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { return { http: r.status, raw: clip(text, 200) }; }
  return { http: r.status, result: j.result ?? null, error: j.error ?? null };
}
out.erc4337.supportedEntryPoints = await candide('eth_supportedEntryPoints', []);
out.erc4337.supportedTokens = await candide('pm_supportedERC20Tokens', [EP07]);

const newSender = out.factoryCalls.find(r => r.id === 'salt+3-141' && r.call?.ok)?.call.predicted
  || out.factoryCalls.find(r => r.create2)?.create2;
const factoryData = factoryIface.encodeFunctionData('createProxyWithNonce', [SINGLETONS.l2_141, init141, fleetSaltBase + 3n]);
const userOp = {
  sender: newSender || FAILED_PROXY,
  nonce: '0x0',
  factory: FACTORIES.safe141,
  factoryData,
  callData: '0x',
  callGasLimit: '0x30d40',
  verificationGasLimit: '0x7a120',
  preVerificationGas: '0xc350',
  maxFeePerGas: '0x989680',
  maxPriorityFeePerGas: '0x30d40',
  signature: '0x',
};
out.erc4337.userOpSender = userOp.sender;
out.erc4337.pmStubNewAccountUsdc = await candide('pm_getPaymasterStubData', [userOp, EP07, '0x2105', { token: USDC }]);
out.erc4337.pmDataNewAccountUsdc = await candide('pm_getPaymasterData', [userOp, EP07, '0x2105', { token: USDC }]);
out.erc4337.pmStubNewAccountNoToken = await candide('pm_getPaymasterStubData', [userOp, EP07, '0x2105', {}]);
out.erc4337.pmSponsorNewAccount = await candide('pm_sponsorUserOperation', [userOp, EP07, {}]);

const existingOp = { ...userOp, sender: SMART_ACCOUNT, factory: undefined, factoryData: undefined, nonce: '0x0' };
delete existingOp.factory;
delete existingOp.factoryData;
out.erc4337.pmDataExistingSafeUsdc = await candide('pm_getPaymasterData', [existingOp, EP07, '0x2105', { token: USDC }]);

async function pimlico(method, params) {
  const r = await fetch(PIMLICO, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { return { http: r.status, raw: clip(text, 200) }; }
  return { http: r.status, result: j.result ?? null, error: j.error ?? null };
}
out.erc4337.pimlicoPmStub = await pimlico('pm_getPaymasterStubData', [userOp, EP07, '0x2105', {}]);
out.erc4337.pimlicoSponsor = await pimlico('pm_sponsorUserOperation', [userOp, EP07, {}]);
out.erc4337.coinbasePaymaster = await httpTry('https://api.developer.coinbase.com/rpc/v1/base/paymaster', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'pm_getPaymasterStubData', params: [userOp, EP07, '0x2105', {}] }),
});
console.log('4337 candide new-account stub', clip(out.erc4337.pmStubNewAccountUsdc, 220));
console.log('4337 candide existing safe', clip(out.erc4337.pmDataExistingSafeUsdc, 220));
console.log('4337 pimlico', clip(out.erc4337.pimlicoPmStub, 220));

// Coinbase factory createAccount eth_call (different account class)
out.coinbaseFactory = {};
for (const [label, addr] of [['v11', FACTORIES.cbsw11], ['v10', FACTORIES.cbsw10]]) {
  const code = out.codeAt.base[`cbsw${label === 'v11' ? '11' : '10'}`];
  out.coinbaseFactory[label] = { address: addr, deployed: code && !code.empty, bytes: code?.bytes };
  // createAccount(bytes[] owners, uint256 nonce) — owner as ABI-encoded address
  const cbIface = new ethers.Interface(['function createAccount(bytes[] owners, uint256 nonce) returns (address)']);
  const owners = [ethers.AbiCoder.defaultAbiCoder().encode(['address'], [owner])];
  try {
    const data = cbIface.encodeFunctionData('createAccount', [owners, 0n]);
    const call = await rpc(RPC.base, 'eth_call', [{ from: owner, to: addr, data }, 'latest']);
    out.coinbaseFactory[label].call = call.error ? { ok: false, error: clip(call.error, 200) } : { ok: true, result: clip(call.result, 80) };
  } catch (e) {
    out.coinbaseFactory[label].call = { ok: false, error: String(e).slice(0, 160) };
  }
}

// ── 4. Gnosis: quota + ≥$0.20 payer ─────────────────────────────────────────
out.gnosis = { pursueDeploy: false, reason: null };
try {
  const mapPath = path.join(__dirname, '..', 'state', 'wallet-map.json');
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const rows = Array.isArray(map) ? map : Object.values(map).filter(x => x && typeof x === 'object' && x.chain);
  const gnosisRows = rows.filter(r => String(r.chain).toLowerCase() === 'gnosis');
  const payers = gnosisRows.map(r => ({
    address: r.address || r.contract || r.target,
    grade: r.grade || r.payout_grade || r.status,
    net: r.net_usd_per_call ?? r.executable_usd_per_call ?? r.best_net_usd_per_call ?? 0,
    executable: r.executable_usd_per_call ?? 0,
    spot: r.spot_only || r.spot_warning,
  })).filter(r => Number(r.net) >= 0.20 || Number(r.executable) >= 0.20);
  out.gnosis.mapRows = gnosisRows.length;
  out.gnosis.ge20 = payers.slice(0, 8);
  out.gnosis.ge20count = payers.length;
} catch (e) {
  out.gnosis.mapError = String(e).slice(0, 160);
}

// Live Curve FeeCollector on gnosis — documented ~$0.05, re-measure.
const FEE_COLLECTOR = '0xBb7404F9965487a9DdE721B3A5F0F3CcfA9aa4C5';
try {
  const fcCode = await rpcOk(RPC.gnosis, 'eth_getCode', [FEE_COLLECTOR, 'latest']);
  out.gnosis.feeCollector = { address: FEE_COLLECTOR, bytes: codeLen(fcCode) };
  const now = Math.floor(Date.now() / 1000);
  const epochData = '0x5487c577' + now.toString(16).padStart(64, '0');
  const epoch = await rpc(RPC.gnosis, 'eth_call', [{ to: FEE_COLLECTOR, data: epochData }, 'latest']);
  out.gnosis.feeCollector.epochNow = epoch.error ? clip(epoch.error, 120) : Number(BigInt(epoch.result || '0x0'));
} catch (e) {
  out.gnosis.feeCollectorError = String(e).slice(0, 160);
}
out.gnosis.pursueDeploy = (out.gnosis.ge20count || 0) > 0;
out.gnosis.reason = out.gnosis.pursueDeploy
  ? 'map listed ≥$0.20 rows — still need PAYS+executable, not just quoted'
  : 'no ≥$0.20 gnosis payer in wallet-map; curve fee collector is ~$0.05 EURe/BREAD not Base ETH. Do not spend gnosis slots minting.';
console.log('GNOSIS pursue?', out.gnosis.pursueDeploy, out.gnosis.reason, 'ge20', out.gnosis.ge20count, 'epoch', out.gnosis.feeCollector?.epochNow);

// ── 5. Counterfactual census ────────────────────────────────────────────────
out.counterfactual = [];
const fleetPath = path.join(__dirname, '..', 'state', 'fleet-registry.json');
const extra = [];
if (existsSync(fleetPath)) {
  const fleet = JSON.parse(readFileSync(fleetPath, 'utf8'));
  for (const w of fleet.fleet || []) extra.push({ id: `fleet-c2Nonce-${w.c2Nonce}`, address: w.address, owner: w.owner, role: w.role });
}
for (const row of out.factoryCalls) {
  const addr = row.call?.predicted;
  if (addr && addr.startsWith('0x') && addr.length === 42) extra.push({ id: row.id, address: addr, owner });
}
extra.push({ id: 'failed-rhinestone-predicted', address: FAILED_PROXY, owner });
extra.push({ id: 'genesis-ii', address: SMART_ACCOUNT, owner });

const seen = new Set();
for (const item of extra) {
  const key = item.address.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  const rec = { id: item.id, address: item.address, owner: item.owner };
  for (const chain of ['base', 'gnosis']) {
    try {
      const code = await rpcOk(RPC[chain], 'eth_getCode', [item.address, 'latest']);
      const q = await fetch(`https://safe-client.safe.global/v1/chains/${CHAIN_IDS[chain]}/relay/${item.address}`, { headers: RELAY_HEADERS });
      const qj = await q.json().catch(() => ({}));
      rec[chain] = {
        bytes: codeLen(code),
        deployed: codeLen(code) > 0,
        remaining: qj.remaining ?? null,
        limit: qj.limit ?? null,
        phantomQuota: codeLen(code) === 0 && typeof qj.remaining === 'number' && qj.remaining > 0,
      };
    } catch (e) {
      rec[chain] = { error: String(e).slice(0, 100) };
    }
    await sleep(50);
  }
  out.counterfactual.push(rec);
}
const phantoms = out.counterfactual.filter(r => r.base?.phantomQuota);
console.log(`counterfactual: ${out.counterfactual.length} addrs, ${phantoms.length} Base phantom quotas (quota>0, code=0)`);

// ── 6. EIP-7702 / EIP-7708 ──────────────────────────────────────────────────
out.eip7702 = { eoaCodeBytes: out.codeAt.base.eoa.bytes, delegated: !!out.codeAt.base.eoa.eip7702 };
const headHex = await rpcOk(RPC.base, 'eth_blockNumber', []);
const head = parseInt(headHex, 16);
out.eip7702.head = head;
out.eip7702.type4 = [];
out.eip7708 = { live: false, sample: null, note: 'EIP-7708 = native ETH Transfer logs (Glamsterdam). Measure receipts of value-only txs.' };
let valueOnly = 0;
for (let i = 0; i < 6; i++) {
  const n = '0x' + (head - i).toString(16);
  const block = await rpcOk(RPC.base, 'eth_getBlockByNumber', [n, true]);
  const txs = block?.transactions || [];
  for (const tx of txs) {
    const type = tx.type;
    const typeNum = typeof type === 'string' ? parseInt(type, 16) : Number(type);
    if (typeNum === 4) {
      const auths = tx.authorizationList || tx.authorization_list || [];
      const ours = auths.some(a => String(a.address || a.authority || '').toLowerCase() === owner.toLowerCase()
        || String(a.signer || '').toLowerCase() === owner.toLowerCase());
      out.eip7702.type4.push({
        hash: tx.hash, from: tx.from, authCount: auths.length, includesOurEoa: ours,
        sampleAuth: auths[0] ? { address: auths[0].address || auths[0].contractAddress, chainId: auths[0].chainId } : null,
      });
    }
    if (!out.eip7708.sample && BigInt(tx.value || '0x0') > 0n && (!tx.input || tx.input === '0x') && valueOnly < 3) {
      valueOnly++;
      try {
        const rcpt = await rpcOk(RPC.base, 'eth_getTransactionReceipt', [tx.hash]);
        const logs = rcpt?.logs || [];
        const transferLogs = logs.filter(l => l.topics?.[0] === TRANSFER_TOPIC);
        const nativeLooking = transferLogs.filter(l => String(l.address).toLowerCase() === String(tx.from).toLowerCase()
          || String(l.address).toLowerCase() === String(tx.to).toLowerCase()
          || l.address === ethers.ZeroAddress);
        out.eip7708.sample = {
          hash: tx.hash, from: tx.from, to: tx.to, value: tx.value,
          logCount: logs.length, transferLogCount: transferLogs.length,
          nativeTransferLog: nativeLooking.length > 0,
        };
        if (nativeLooking.length > 0) out.eip7708.live = true;
      } catch { /* skip */ }
    }
  }
  await sleep(80);
}
out.eip7702.type4CountIn6Blocks = out.eip7702.type4.length;
out.eip7702.sponsorAttachedDelegationForUs = out.eip7702.type4.some(t => t.includesOurEoa);
out.eip7702.note = out.eip7702.delegated
  ? 'EOA already has 7702 delegation code'
  : 'EOA has empty code. 7702 is live on Base (type-4 txs observed or not below) but the sender pays; no sponsor included our authorization.';
console.log('7702 type4 in 6 blocks', out.eip7702.type4CountIn6Blocks, 'ours?', out.eip7702.sponsorAttachedDelegationForUs);
console.log('7708 sample', out.eip7708.sample);

// EIP-8130 / Cobalt — docs say mainnet TBD; still measure whether the chain advertises it.
out.eip8130 = {
  docs: 'Base Cobalt native AA; mainnet timestamp TBD, only vibenet active.',
  vibenetOnly: true,
};
try {
  const chainCfg = await httpTry('https://safe-client.safe.global/v1/chains/8453', { headers: RELAY_HEADERS });
  out.safeChainConfig = chainCfg;
} catch { /* noop */ }

// ── verdict ─────────────────────────────────────────────────────────────────
const callOkDifferent = out.factoryCalls.filter(r => r.call?.ok && r.id !== 'FAILED-salt+2-141' && r.empty !== false);
const gelatoOpen = [out.gelato.v2sponsored, out.gelato.cloudRpcNoKey, out.gelato.relayDigital]
  .some(x => x && x.http && x.http >= 200 && x.http < 300 && !/key|unauth|api.?key|invalid/i.test(x.body || ''));
const candideSponsorsDeploy = !out.erc4337.pmDataNewAccountUsdc?.error
  && out.erc4337.pmDataNewAccountUsdc?.result?.paymaster;
out.verdict = {
  newAccountWithCodeOnBase: out.counterfactual.filter(r => r.base?.deployed).map(r => r.address),
  remainingEoaQuotaBase: out.quotas.base.eoa,
  remainingSafeQuotaBase: out.quotas.base.genesisII,
  ethCallSuccesses: callOkDifferent.map(r => ({ id: r.id, predicted: r.call.predicted, empty: r.empty, gas: r.gas?.gas, phantom: r.quota?.phantom })),
  gelatoSponsorsWithoutKey: gelatoOpen,
  candideSponsorsNewInitCode: !!candideSponsorsDeploy,
  spendSlot: false,
  spendReason: 'Default budget 0. Gelato needs a key (measured). Candide needs USDC on the NEW sender (measured). Rhinestone createProxyWithNonce is the failed shape — not retried. No different sponsor preflight succeeded.',
};
console.log('\nVERDICT', JSON.stringify(out.verdict, null, 2));

const dest = path.join(__dirname, 'fleet-alt-mint-result.json');
writeFileSync(dest, JSON.stringify(out, null, 2));
console.log('saved', dest);
