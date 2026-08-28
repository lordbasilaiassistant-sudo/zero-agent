#!/usr/bin/env node
// CANDIDE hunter — spend the Safe's OWN USDC through Candide's keyless ERC-20 paymaster.
// Never funds. Never spends EOA native ETH. Never touches Safe Base relay or EOA relay quota.
// Only pm_getPaymasterData is a commitment; a stub is not. Never invents paymaster signatures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { LIVE_EOA, SMART_ACCOUNT, RETIRED_EOA } from '../shop.mjs';
import { harvestCalldata, MULTISEND } from '../harvest.mjs';
import { probeMany } from '../oracle.mjs';

const RPC = 'https://base-rpc.publicnode.com';
const RPC_FAILOVER = ['https://base.drpc.org', 'https://1rpc.io/base'];
const CANDIDE = 'https://api.candide.dev/public/v3/8453';
const ENTRYPOINT = ethers.getAddress('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
const PAYMASTER = ethers.getAddress('0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba');
const MODULE = ethers.getAddress('0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226');
const CHAIN_ID = 8453;
const CHAIN_HEX = '0x2105';
const WETH = '0x4200000000000000000000000000000000000006';
const SAFE = SMART_ACCOUNT;
const EOA = LIVE_EOA;

const TOKENS = {
  USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  DAI:  { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  USDT: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bB2', decimals: 6 },
  USDS: { address: '0x820C137fa70C8691f0e44Dc420a5e53c168921Dc', decimals: 18 },
};

const KNOWN_STRATS = [
  '0xafF4f20E5F340f11944DB3eC9adE6A29c13FE67d',
  '0x6aEa497106845bCE2CCe35E770a12a63288c5B65',
  '0xA2f9E116b377A9052B06e005c326f11AD7C6F2fA',
  '0x18ff03A7456325b752Ff428dd65c10020C7971Fe',
  '0x97F0609d2d1fAdeD374FDACDf5fDf912fF0f656a',
  '0xB6D144fCCE62547C870b4E231b01Ca2994Aa54f6',
  '0xd90ec9e27c47fdf0f766c0d6fc4f0f47376daa47',
  '0xd8d64ed31e432d9375d07df11555a58f66e12d69',
];

const ERC20 = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const SAFE_IFACE = new ethers.Interface([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function nonce() view returns (uint256)',
]);
const EP_IFACE = new ethers.Interface([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]);
const EXEC = new ethers.Interface([
  'function executeUserOpWithErrorString(address to, uint256 value, bytes data, uint8 operation)',
]);
const MS = new ethers.Interface(['function multiSend(bytes transactions)']);
const WETH_IFACE = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
]);

const SAFE_OP_TYPES = {
  SafeOp: [
    { type: 'address', name: 'safe' },
    { type: 'uint256', name: 'nonce' },
    { type: 'bytes', name: 'initCode' },
    { type: 'bytes', name: 'callData' },
    { type: 'uint128', name: 'verificationGasLimit' },
    { type: 'uint128', name: 'callGasLimit' },
    { type: 'uint256', name: 'preVerificationGas' },
    { type: 'uint128', name: 'maxPriorityFeePerGas' },
    { type: 'uint128', name: 'maxFeePerGas' },
    { type: 'bytes', name: 'paymasterAndData' },
    { type: 'uint48', name: 'validAfter' },
    { type: 'uint48', name: 'validUntil' },
    { type: 'address', name: 'entryPoint' },
  ],
};

const report = {
  hunter: 'CANDIDE',
  at: new Date().toISOString(),
  rpc: RPC,
  submitted: false,
  userOpHash: null,
  blocker: null,
};

function log(label, value) {
  const line = typeof value === 'string' ? value : JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  console.log(`[${label}] ${line}`);
}

async function rpc(method, params, urls = [RPC, ...RPC_FAILOVER]) {
  let last;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}

async function candide(method, params) {
  const r = await fetch(CANDIDE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(25000),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch {
    return { http: r.status, raw: text.slice(0, 2000), parseError: true };
  }
  return { http: r.status, ...j };
}

function padAddr(addr) {
  return addr.slice(2).toLowerCase().padStart(64, '0');
}
function balCall(token, who) {
  return { to: token, data: '0x70a08231' + padAddr(who) };
}
function allowCall(token, owner, spender) {
  return { to: token, data: ERC20.encodeFunctionData('allowance', [owner, spender]) };
}
function fmtToken(raw, decimals) {
  return ethers.formatUnits(raw, decimals);
}
function parseRequired(msg) {
  const m = String(msg || '').match(/`(0x[0-9a-fA-F]+)`/i) || String(msg || '').match(/\b(0x[0-9a-fA-F]+)\b/);
  return m ? BigInt(m[1]) : null;
}
function classify(msg) {
  const s = String(msg || '');
  if (/api key|policy id is required|unauthor/i.test(s)) return 'AUTH';
  if (/allowance|token balance lower/i.test(s)) return 'ALLOWANCE_OR_BALANCE';
  if (/whitelist|not allowlisted|not whitelisted|unsupported token/i.test(s)) return 'WHITELIST';
  if (/does not qualify for any publicly available gas policy/i.test(s)) return 'NO_PUBLIC_POLICY';
  if (/signature|AA24|invalid signature/i.test(s)) return 'SIGNATURE';
  if (/callData reverts/i.test(s)) return 'CALLDATA_REVERTS';
  return 'OTHER';
}

function packCall(to, data) {
  return '00' + to.slice(2).toLowerCase() + '0'.repeat(64)
    + (data.length / 2 - 1).toString(16).padStart(64, '0') + data.slice(2);
}

function packPmAndData(pm, verifGas, postOpGas, data) {
  return ethers.concat([
    pm,
    ethers.zeroPadValue(ethers.toBeHex(BigInt(verifGas || 0)), 16),
    ethers.zeroPadValue(ethers.toBeHex(BigInt(postOpGas || 0)), 16),
    data && data !== '0x' ? data : '0x',
  ]);
}

function dummySig() {
  return '0x' + '00'.repeat(12) + 'ff'.repeat(65);
}

function toHex(n) {
  return ethers.toBeHex(BigInt(n));
}

function unpackOp(op) {
  return {
    sender: op.sender,
    nonce: toHex(op.nonce),
    callData: op.callData,
    callGasLimit: toHex(op.callGasLimit),
    verificationGasLimit: toHex(op.verificationGasLimit),
    preVerificationGas: toHex(op.preVerificationGas),
    maxFeePerGas: toHex(op.maxFeePerGas),
    maxPriorityFeePerGas: toHex(op.maxPriorityFeePerGas),
    signature: op.signature || dummySig(),
    ...(op.paymaster ? {
      paymaster: op.paymaster,
      paymasterVerificationGasLimit: toHex(op.paymasterVerificationGasLimit || 0),
      paymasterPostOpGasLimit: toHex(op.paymasterPostOpGasLimit || 0),
      paymasterData: op.paymasterData || '0x',
    } : {}),
  };
}

async function tokenState(token, who) {
  const [balHex, allowHex] = await Promise.all([
    rpc('eth_call', [balCall(token.address, who), 'latest']),
    rpc('eth_call', [allowCall(token.address, who, PAYMASTER), 'latest']),
  ]);
  const balance = BigInt(balHex);
  const allowance = BigInt(allowHex);
  return {
    address: token.address,
    decimals: token.decimals,
    balance: balance.toString(),
    balance_fmt: fmtToken(balance, token.decimals),
    allowance_to_paymaster: allowance.toString(),
    allowance_fmt: fmtToken(allowance, token.decimals),
  };
}

async function simulateHarvest(strategy, feeTo) {
  const data = harvestCalldata(feeTo, true);
  try {
    await rpc('eth_call', [{ to: strategy, data, from: SAFE }, 'latest']);
    let gas = null;
    try {
      gas = BigInt(await rpc('eth_estimateGas', [{ to: strategy, data, from: SAFE }]));
    } catch { /* estimate can fail while call succeeds */ }
    return { ok: true, strategy, data, gas };
  } catch (e) {
    return { ok: false, strategy, error: String(e.message || e).slice(0, 220) };
  }
}

function loadQueueContracts() {
  try {
    const q = JSON.parse(fs.readFileSync(path.join('C:\\Users\\drlor\\OneDrive\\Desktop\\AutoGLMwallet', 'state', 'verified-harvest-queue.json'), 'utf8'));
    return (q.queue || []).map(r => ethers.getAddress(r.contract));
  } catch { return []; }
}

async function pickInnerCall(wethSafe) {
  const tried = [];
  const rpcChain = (chain, method, params) => rpc(method, params);

  const seen = new Set();
  const candidates = [];
  for (const s of [...loadQueueContracts(), ...KNOWN_STRATS]) {
    const a = ethers.getAddress(s);
    if (seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    candidates.push(a);
  }
  try {
    const res = await fetch('https://api.beefy.finance/vaults', { signal: AbortSignal.timeout(20000) });
    const all = await res.json();
    for (const v of all.filter(x => x.chain === 'base' && x.status === 'active' && x.strategy).slice(0, 80)) {
      const a = ethers.getAddress(v.strategy);
      if (seen.has(a.toLowerCase())) continue;
      seen.add(a.toLowerCase());
      candidates.push(a);
    }
  } catch (e) {
    tried.push({ kind: 'beefy-list', ok: false, error: String(e.message || e).slice(0, 160) });
  }

  let paying = [];
  try {
    paying = await probeMany(rpcChain, 'base', candidates, WETH, 'harvest(address)', 20);
    tried.push({ kind: 'probeMany', ok: true, n: candidates.length, paying: paying.length, top: paying.slice(0, 8) });
  } catch (e) {
    tried.push({ kind: 'probeMany', ok: false, error: String(e.message || e).slice(0, 220) });
  }

  const good = [];
  for (const p of paying) {
    if (good.length >= 6) break;
    const r = await simulateHarvest(p.contract, EOA);
    tried.push({ kind: 'harvest-sim', strategy: p.contract, wei: p.wei, ok: r.ok, gas: r.gas?.toString(), error: r.error });
    if (r.ok) good.push({ ...p, data: r.data, gas: r.gas || 400_000n });
  }

  // Remaining Safe USDC (~0.016) only covers ~700k call gas at the measured Candide quote.
  // A 2–4M Beefy harvest quotes ~$0.05–0.54 and is CLOSED until inventory grows.
  const cheap = good.filter(g => g.gas <= 700_000n).slice(0, 6);
  if (cheap.length) {
    if (cheap.length === 1) {
      const g = cheap[0];
      return {
        kind: 'harvest-feeTo-eoa',
        to: g.contract,
        data: g.data,
        operation: 0,
        gas: g.gas,
        predicted_wei: g.wei,
        note: `harvest(address=${EOA}) on ${g.contract} predicted ${g.wei} wei (gas-capped for USDC inventory)`,
        tried,
      };
    }
    const blob = '0x' + cheap.map(g => packCall(g.contract, g.data)).join('');
    const msData = MS.encodeFunctionData('multiSend', [blob]);
    const gas = cheap.reduce((a, g) => a + (g.gas || 400_000n), 80_000n);
    return {
      kind: 'harvest-batch-feeTo-eoa',
      to: MULTISEND,
      data: msData,
      operation: 1,
      gas,
      predicted_wei: cheap.reduce((a, g) => a + BigInt(g.wei), 0n).toString(),
      n: cheap.length,
      note: `MultiSend ${cheap.length} harvest(address=${EOA}) predicted ${cheap.reduce((a, g) => a + BigInt(g.wei), 0n)} wei`,
      tried,
    };
  }
  tried.push({ kind: 'gas-cap', ok: false, n_paying: good.length, note: 'paying harvests exceed USDC gas budget; skipped' });

  if (wethSafe > 0n) {
    const data = WETH_IFACE.encodeFunctionData('transfer', [EOA, wethSafe]);
    try {
      await rpc('eth_call', [{ to: WETH, data, from: SAFE }, 'latest']);
      const gas = BigInt(await rpc('eth_estimateGas', [{ to: WETH, data, from: SAFE }]).catch(() => '0x186a0'));
      tried.push({ kind: 'weth-transfer-eoa', ok: true, gas: gas.toString() });
      return {
        kind: 'weth-transfer-eoa',
        to: WETH,
        data,
        operation: 0,
        gas,
        note: `no paying harvest; fallback transfer ${ethers.formatEther(wethSafe)} WETH Safe→EOA`,
        tried,
      };
    } catch (e) {
      tried.push({ kind: 'weth-transfer-eoa', ok: false, error: String(e.message || e).slice(0, 160) });
    }
  }

  return { kind: 'none', tried };
}

function buildCallData(inner, { approveToken, approveAmount } = {}) {
  if (approveToken && approveAmount && approveAmount > 0n) {
    const approveData = ERC20.encodeFunctionData('approve', [PAYMASTER, approveAmount]);
    const blob = '0x' + packCall(approveToken, approveData) + packCall(inner.to, inner.data);
    const msData = MS.encodeFunctionData('multiSend', [blob]);
    return EXEC.encodeFunctionData('executeUserOpWithErrorString', [MULTISEND, 0n, msData, 1]);
  }
  return EXEC.encodeFunctionData('executeUserOpWithErrorString', [inner.to, 0n, inner.data, inner.operation]);
}

async function signSafeOp(wallet, op, paymasterAndData) {
  const domain = { chainId: CHAIN_ID, verifyingContract: MODULE };
  const message = {
    safe: ethers.getAddress(op.sender),
    nonce: BigInt(op.nonce),
    initCode: '0x',
    callData: op.callData,
    verificationGasLimit: BigInt(op.verificationGasLimit),
    callGasLimit: BigInt(op.callGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
    maxFeePerGas: BigInt(op.maxFeePerGas),
    paymasterAndData,
    validAfter: 0,
    validUntil: 0,
    entryPoint: ENTRYPOINT,
  };
  const sig = await wallet.signTypedData(domain, SAFE_OP_TYPES, message);
  return ethers.concat([ethers.zeroPadValue('0x00', 6), ethers.zeroPadValue('0x00', 6), sig]);
}

async function snapshot(who) {
  const [eth, weth] = await Promise.all([
    rpc('eth_getBalance', [who, 'latest']).then(BigInt),
    rpc('eth_call', [balCall(WETH, who), 'latest']).then(BigInt),
  ]);
  const tokens = {};
  for (const [sym, t] of Object.entries(TOKENS)) tokens[sym] = await tokenState(t, who);
  return { eth: eth.toString(), eth_fmt: ethers.formatEther(eth), weth: weth.toString(), weth_fmt: ethers.formatEther(weth), tokens };
}

async function main() {
  log('start', { hunter: 'CANDIDE', safe: SAFE, eoa: EOA, rpc: RPC, candide: CANDIDE });

  const envf = fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8');
  const PK = envf.match(/AGENT_PRIVATE_KEY=(.+)/)?.[1]?.trim();
  if (!PK) throw new Error('AGENT_PRIVATE_KEY missing');
  const wallet = new ethers.Wallet(PK);
  if (wallet.address.toLowerCase() !== EOA.toLowerCase()) {
    throw new Error(`key is ${wallet.address}, expected GENESIS II ${EOA}`);
  }
  if (wallet.address.toLowerCase() === RETIRED_EOA.toLowerCase()) {
    throw new Error('REFUSED: retired GENESIS I key');
  }
  log('signer', wallet.address);

  const [codeSafe, codeMod, ownersRaw, threshRaw, modsRaw, epNonceRaw, gasPriceHex, block] = await Promise.all([
    rpc('eth_getCode', [SAFE, 'latest']),
    rpc('eth_getCode', [MODULE, 'latest']),
    rpc('eth_call', [{ to: SAFE, data: SAFE_IFACE.encodeFunctionData('getOwners') }, 'latest']),
    rpc('eth_call', [{ to: SAFE, data: SAFE_IFACE.encodeFunctionData('getThreshold') }, 'latest']),
    rpc('eth_call', [{ to: SAFE, data: SAFE_IFACE.encodeFunctionData('getModulesPaginated', ['0x0000000000000000000000000000000000000001', 10n]) }, 'latest']),
    rpc('eth_call', [{ to: ENTRYPOINT, data: EP_IFACE.encodeFunctionData('getNonce', [SAFE, 0n]) }, 'latest']),
    rpc('eth_gasPrice', []),
    rpc('eth_getBlockByNumber', ['latest', false]),
  ]);
  const owners = SAFE_IFACE.decodeFunctionResult('getOwners', ownersRaw)[0];
  const threshold = SAFE_IFACE.decodeFunctionResult('getThreshold', threshRaw)[0];
  const modules = SAFE_IFACE.decodeFunctionResult('getModulesPaginated', modsRaw)[0];
  const nonce = BigInt(epNonceRaw);
  const baseFee = BigInt(block.baseFeePerGas);
  const gasPrice = BigInt(gasPriceHex);
  // Measured 2026-08-28: Candide bundler rejected maxPriority=1000 with
  // "maxFeePerGas and (maxPriorityFeePerGas + estimated basefee) should be equal or higher than : 0x5265c0"
  // (= 0.0054 gwei). Keep maxFee near 2*baseFee so the USDC quote stays under Safe inventory.
  const BUNDLER_MIN = 0x5265c0n;
  const maxPriority = BUNDLER_MIN;
  const maxFeeLow = baseFee * 2n;
  const maxFeeFloor = BUNDLER_MIN;
  let maxFee = maxFeeLow > BUNDLER_MIN ? maxFeeLow : BUNDLER_MIN;
  if (maxFee < maxPriority) maxFee = maxPriority;

  report.account = {
    safe_code_bytes: (codeSafe.length - 2) / 2,
    module_code_bytes: (codeMod.length - 2) / 2,
    owners,
    threshold: threshold.toString(),
    modules,
    module_enabled: modules.some(m => m.toLowerCase() === MODULE.toLowerCase()),
    signer_is_owner: owners.some(o => o.toLowerCase() === wallet.address.toLowerCase()),
    entrypoint_nonce: nonce.toString(),
    baseFee: baseFee.toString(),
    gasPrice: gasPrice.toString(),
    maxFeePerGas: maxFee.toString(),
    maxFee_gwei: Number(maxFee) / 1e9,
  };
  log('account', report.account);
  if (!report.account.signer_is_owner) throw new Error('signer is not a Safe owner — refusing to submit');
  if (!report.account.module_enabled) throw new Error('Safe4337Module not enabled');

  report.safe = await snapshot(SAFE);
  report.eoa = await snapshot(EOA);
  log('safe_balances', report.safe);
  log('eoa_balances', report.eoa);

  const supportedEp = await candide('eth_supportedEntryPoints', []);
  const supportedTok = await candide('pm_supportedERC20Tokens', [ENTRYPOINT]);
  report.candide_capability = { eth_supportedEntryPoints: supportedEp, pm_supportedERC20Tokens: supportedTok };
  log('candide_supportedEntryPoints', supportedEp.result || supportedEp.error || supportedEp);
  log('candide_supportedERC20Tokens', supportedTok.result || supportedTok.error || supportedTok);

  const inner = await pickInnerCall(BigInt(report.safe.weth));
  report.inner = {
    kind: inner.kind,
    to: inner.to,
    operation: inner.operation,
    gas: inner.gas?.toString(),
    note: inner.note,
    tried: inner.tried,
  };
  log('inner', report.inner);

  const usdcBal = BigInt(report.safe.tokens.USDC.balance);
  const usdcAllow = BigInt(report.safe.tokens.USDC.allowance_to_paymaster);
  const needApprove = usdcAllow === 0n && usdcBal > 0n;

  const callGas = inner.gas ? inner.gas + (needApprove ? 140_000n : 80_000n) : 250_000n;
  const verificationGas = 500_000n;
  const preVerificationGas = 80_000n;
  const pmVerif = 150_000n;
  const pmPost = 80_000n;

  async function quoteToken(sym, token, callData, fees) {
    const op = {
      sender: SAFE,
      nonce,
      callData,
      callGasLimit: callGas,
      verificationGasLimit: verificationGas,
      preVerificationGas,
      maxFeePerGas: fees,
      maxPriorityFeePerGas: maxPriority,
      signature: dummySig(),
    };
    const unpacked = unpackOp(op);
    const dataRes = await candide('pm_getPaymasterData', [unpacked, ENTRYPOINT, CHAIN_HEX, { token: token.address }]);
    const stubRes = await candide('pm_getPaymasterStubData', [unpacked, ENTRYPOINT, CHAIN_HEX, { token: token.address }]);
    const msg = dataRes.error?.message || dataRes.error || null;
    const required = parseRequired(msg);
    return {
      symbol: sym,
      token: token.address,
      maxFeePerGas: fees.toString(),
      pm_getPaymasterData: dataRes,
      pm_getPaymasterStubData: stubRes,
      committed: !!(dataRes.result && (dataRes.result.paymaster || dataRes.result.paymasterAndData || dataRes.result.paymasterData)),
      error_message: typeof msg === 'string' ? msg : (msg ? JSON.stringify(msg) : null),
      class: msg ? classify(msg) : (dataRes.result ? 'COMMIT' : 'EMPTY'),
      required_raw: required?.toString() || null,
      required_fmt: required != null ? fmtToken(required, token.decimals) : null,
    };
  }

  const callDataBare = inner.kind === 'none'
    ? EXEC.encodeFunctionData('executeUserOpWithErrorString', [WETH, 0n, WETH_IFACE.encodeFunctionData('transfer', [EOA, 0n]), 0])
    : buildCallData(inner);
  const callDataWithApprove = inner.kind === 'none'
    ? buildCallData({ to: WETH, data: WETH_IFACE.encodeFunctionData('transfer', [EOA, 0n]), operation: 0 }, { approveToken: TOKENS.USDC.address, approveAmount: usdcBal })
    : buildCallData(inner, { approveToken: TOKENS.USDC.address, approveAmount: usdcBal });

  report.quotes = {};
  for (const [sym, token] of Object.entries(TOKENS)) {
    const q = await quoteToken(sym, token, callDataBare, maxFee);
    report.quotes[sym] = q;
    log(`pm_getPaymasterData.${sym}`, q.pm_getPaymasterData);
    log(`class.${sym}`, { class: q.class, required_fmt: q.required_fmt, committed: q.committed });
  }

  // If USDC failed on allowance, retry with approve packed into the same UserOp.
  if (!report.quotes.USDC.committed && report.quotes.USDC.class === 'ALLOWANCE_OR_BALANCE' && needApprove && inner.kind !== 'none') {
    const q2 = await quoteToken('USDC_WITH_APPROVE', TOKENS.USDC, callDataWithApprove, maxFee);
    report.quotes.USDC_WITH_APPROVE = q2;
    log('pm_getPaymasterData.USDC_WITH_APPROVE', q2.pm_getPaymasterData);
  }

  // Lower-fee re-quote if the required amount is above balance.
  const usdcQ = report.quotes.USDC;
  if (!usdcQ.committed && usdcQ.required_raw && BigInt(usdcQ.required_raw) > usdcBal && maxFee > maxFeeFloor) {
    const qLow = await quoteToken('USDC_LOWFEE', TOKENS.USDC, callDataBare, maxFeeFloor);
    report.quotes.USDC_LOWFEE = qLow;
    log('pm_getPaymasterData.USDC_LOWFEE', qLow.pm_getPaymasterData);
  }

  const winner = Object.values(report.quotes).find(q => q.committed);
  if (!winner) {
    const usdc = report.quotes.USDC;
    report.blocker = {
      status: 'CLOSED',
      class: usdc.class,
      exact: usdc.error_message,
      body: usdc.pm_getPaymasterData,
      note: usdc.class === 'ALLOWANCE_OR_BALANCE'
        ? (usdcAllow === 0n
          ? 'Paymaster refused at validation. Safe USDC exists but allowance to paymaster is 0; packing approve into the same UserOp did not change the refusal (validation runs before execution). Bootstrap of allowance needs a tx paid some other way — relay and EOA ETH are forbidden this hunt.'
          : 'Paymaster quoted a required amount above Safe USDC, or balance check failed despite non-zero USDC.')
        : usdc.class === 'AUTH'
          ? 'Needs an operator key / policy id we do not have.'
          : 'Admission did not commit. No paymaster signature invented.',
    };
    log('BLOCKER', report.blocker);
    writeOut();
    return;
  }

  log('COMMIT', { symbol: winner.symbol, result: winner.pm_getPaymasterData.result });

  if (inner.kind === 'none') {
    report.blocker = {
      status: 'OPEN_BUT_NO_INNER',
      note: 'Paymaster committed, but no harvest simulated clean and Safe holds 0 WETH to transfer. Refusing to burn USDC on a no-op.',
      commit: winner.pm_getPaymasterData.result,
    };
    log('BLOCKER', report.blocker);
    writeOut();
    return;
  }

  const pm = winner.pm_getPaymasterData.result;
  const paymaster = pm.paymaster || PAYMASTER;
  const pmData = pm.paymasterData || pm.paymasterAndData || '0x';
  if (!pmData || pmData === '0x' && !pm.paymaster) {
    report.blocker = { status: 'CLOSED', note: 'result present but no paymasterData — not treating as a signature commitment', body: pm };
    log('BLOCKER', report.blocker);
    writeOut();
    return;
  }

  const useCallData = winner.symbol === 'USDC_WITH_APPROVE' ? callDataWithApprove : callDataBare;
  const useFee = BigInt(winner.maxFeePerGas);
  const finalOp = {
    sender: SAFE,
    nonce,
    callData: useCallData,
    callGasLimit: pm.callGasLimit ? BigInt(pm.callGasLimit) : callGas,
    verificationGasLimit: pm.verificationGasLimit ? BigInt(pm.verificationGasLimit) : verificationGas,
    preVerificationGas: pm.preVerificationGas ? BigInt(pm.preVerificationGas) : preVerificationGas,
    maxFeePerGas: pm.maxFeePerGas ? BigInt(pm.maxFeePerGas) : useFee,
    maxPriorityFeePerGas: pm.maxPriorityFeePerGas ? BigInt(pm.maxPriorityFeePerGas) : maxPriority,
    paymaster,
    paymasterVerificationGasLimit: BigInt(pm.paymasterVerificationGasLimit || pmVerif),
    paymasterPostOpGasLimit: BigInt(pm.paymasterPostOpGasLimit || pmPost),
    paymasterData: pm.paymasterData || '0x',
  };
  const packedPm = pm.paymasterAndData && pm.paymasterAndData.length > 2
    ? pm.paymasterAndData
    : packPmAndData(finalOp.paymaster, finalOp.paymasterVerificationGasLimit, finalOp.paymasterPostOpGasLimit, finalOp.paymasterData);

  const signature = await signSafeOp(wallet, finalOp, packedPm);
  const sendOp = { ...unpackOp({ ...finalOp, signature }), signature };
  log('submitting', { sender: sendOp.sender, nonce: sendOp.nonce, paymaster: sendOp.paymaster, callData_len: sendOp.callData.length });

  const eoaBefore = await snapshot(EOA);
  const safeBefore = await snapshot(SAFE);
  const sent = await candide('eth_sendUserOperation', [sendOp, ENTRYPOINT]);
  report.submit = sent;
  log('eth_sendUserOperation', sent);

  if (sent.error) {
    report.blocker = {
      status: 'SUBMIT_REJECTED',
      class: classify(sent.error?.message || ''),
      exact: sent.error?.message || JSON.stringify(sent.error),
      body: sent,
    };
    log('BLOCKER', report.blocker);
    writeOut();
    return;
  }

  const userOpHash = sent.result;
  report.submitted = true;
  report.userOpHash = userOpHash;
  log('userOpHash', userOpHash);

  let receipt = null;
  for (let i = 0; i < 40 && !receipt; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const rec = await candide('eth_getUserOperationReceipt', [userOpHash]);
    if (rec.result) { receipt = rec.result; break; }
    log('wait', { i, pending: true });
  }
  report.receipt = receipt;
  const eoaAfter = await snapshot(EOA);
  const safeAfter = await snapshot(SAFE);
  report.eoa_delta = {
    eth: (BigInt(eoaAfter.eth) - BigInt(eoaBefore.eth)).toString(),
    weth: (BigInt(eoaAfter.weth) - BigInt(eoaBefore.weth)).toString(),
    eth_fmt: ethers.formatEther(BigInt(eoaAfter.eth) - BigInt(eoaBefore.eth)),
    weth_fmt: ethers.formatEther(BigInt(eoaAfter.weth) - BigInt(eoaBefore.weth)),
  };
  report.safe_delta = {
    usdc: (BigInt(safeAfter.tokens.USDC.balance) - BigInt(safeBefore.tokens.USDC.balance)).toString(),
    usdc_fmt: fmtToken(BigInt(safeAfter.tokens.USDC.balance) - BigInt(safeBefore.tokens.USDC.balance), 6),
    weth: (BigInt(safeAfter.weth) - BigInt(safeBefore.weth)).toString(),
  };
  log('eoa_delta', report.eoa_delta);
  log('safe_delta', report.safe_delta);
  if (!receipt) report.blocker = { status: 'SUBMITTED_NO_RECEIPT', userOpHash };
  else if (receipt.success === false) report.blocker = { status: 'EXECUTED_REVERTED', receipt };
  else report.blocker = { status: 'SETTLED', userOpHash, eoa_delta: report.eoa_delta };
  writeOut();
}

function writeOut() {
  const dest = path.join('C:\\Users\\drlor\\OneDrive\\Desktop\\AutoGLMwallet', 'scripts', 'candide-harvest-result.json');
  fs.writeFileSync(dest, JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  log('wrote', dest);
}

main().catch((e) => {
  report.blocker = { status: 'SCRIPT_ERROR', exact: String(e.stack || e) };
  console.error(e);
  try { writeOut(); } catch { /* ignore */ }
  process.exit(1);
});
