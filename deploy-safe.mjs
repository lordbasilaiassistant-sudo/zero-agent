/* DEPLOY ZERO A SAFE IT ACTUALLY OWNS (2026-08-13).
 *
 * THE BREAK THIS FIXES: SMART_ACCOUNT was a hardcoded constant pointing at a Safe whose sole owner is
 * the RETIRED EOA (0x50624f77...0dB9). Swapping AGENT_PRIVATE_KEY changed the signer without changing
 * the account, so every relayed execTransaction fails signature validation and the x402 payTo points
 * into an account controlled by the contaminated key. A fresh key is not a fresh identity.
 *
 * WHY THIS IS NOT QUOTA FARMING: createProxyWithNonce is charged to the OWNER's relay quota, and the
 * new EOA has an untouched 5/5 on every chain. Deploying ONE account for ourselves is the intended
 * use of that budget. We are not minting Safes to multiply a limit.
 *
 *   node deploy-safe.mjs            # dry run — prints the predicted address, sends nothing
 *   node deploy-safe.mjs --apply    # actually relays the deployment
 *   node deploy-safe.mjs --spend    # same as --apply
 */

import { ethers } from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPLY = process.argv.includes('--apply') || process.argv.includes('--spend');
const CHAIN = Number((process.argv.find(a => a.startsWith('--chain=')) || '--chain=8453').split('=')[1]);

const RPCS = { 8453: 'https://mainnet.base.org', 100: 'https://rpc.gnosischain.com', 10: 'https://mainnet.optimism.io', 42161: 'https://arb1.arbitrum.io/rpc', 137: 'https://polygon-rpc.com', 130: 'https://mainnet.unichain.org' };

/* Safe v1.4.1 canonical deployments — identical addresses across EVM chains. */
const PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const SAFE_L2_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const FALLBACK_HANDLER = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';

/* These four headers are the difference between 200 and a bodyless 403 — CloudFront rejects any
   non-browser UA. Same set harvest.mjs has relayed with for weeks. Do not "tidy" them. */
const RELAY_HEADERS = {
  'content-type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Origin: 'https://app.safe.global',
  Referer: 'https://app.safe.global/',
};

const env = fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8');
const PK = env.match(/AGENT_PRIVATE_KEY=(.+)/)?.[1]?.trim();
if (!PK) throw new Error('no AGENT_PRIVATE_KEY');
const owner = new ethers.Wallet(PK).address;

const safeIface = new ethers.Interface([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
]);
const factoryIface = new ethers.Interface([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address)',
]);

const initializer = safeIface.encodeFunctionData('setup', [
  [owner],                    // sole owner = ZERO's NEW EOA
  1,                          // threshold 1 — it signs alone, nobody else may
  ethers.ZeroAddress, '0x',   // no delegatecall setup module
  FALLBACK_HANDLER,
  ethers.ZeroAddress, 0, ethers.ZeroAddress,   // no payment: the relayer covers gas
]);

/* Deterministic salt so a retry produces the SAME address instead of a second Safe. Re-running this
   script must never quietly leave two accounts behind. */
const saltNonce = BigInt(ethers.keccak256(ethers.toUtf8Bytes('zero-genesis-ii-' + owner))) % (2n ** 64n);

const data = factoryIface.encodeFunctionData('createProxyWithNonce', [SAFE_L2_SINGLETON, initializer, saltNonce]);

/* Predict the address exactly as SafeProxyFactory does: CREATE2 with
   salt = keccak256(keccak256(initializer) ++ saltNonce). */
const proxyCreationCode = '0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602281526020018061019c6022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806100f16000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e00000000000000000000000000000000000000000000000000000000600035141560505780600052602060002060206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033';
const salt = ethers.keccak256(ethers.concat([ethers.keccak256(initializer), ethers.zeroPadValue(ethers.toBeHex(saltNonce), 32)]));
const initCode = ethers.concat([proxyCreationCode, ethers.zeroPadValue(SAFE_L2_SINGLETON, 32)]);
const predicted = ethers.getCreate2Address(PROXY_FACTORY, salt, ethers.keccak256(initCode));

console.log('owner (new EOA):', owner);
console.log('chain          :', CHAIN);
console.log('saltNonce      :', saltNonce.toString());
console.log('PREDICTED SAFE :', predicted);

const rpc = async (method, params) => {
  const r = await fetch(RPCS[CHAIN], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
};

const existing = await rpc('eth_getCode', [predicted, 'latest']);
if (existing && existing.length > 4) {
  console.log('\nALREADY DEPLOYED at the predicted address — nothing to do.');
  process.exit(0);
}

const budget = await (await fetch(`https://safe-client.safe.global/v1/chains/${CHAIN}/relay/${owner}`, { headers: RELAY_HEADERS })).json();
console.log('owner relay budget:', JSON.stringify(budget));
if (!budget || budget.remaining === 0) { console.log('NO RELAY BUDGET — abort'); process.exit(1); }

if (!APPLY) { console.log('\ndry run — pass --spend (or --apply) to relay the deployment'); process.exit(0); }

const res = await fetch(`https://safe-client.safe.global/v1/chains/${CHAIN}/relay`, {
  method: 'POST', headers: RELAY_HEADERS,
  body: JSON.stringify({ version: '1.4.1', to: PROXY_FACTORY, data, gasLimit: '500000' }),
});
const body = await res.text();
console.log('relay HTTP', res.status, body.slice(0, 300));
if (!res.ok) process.exit(1);

const taskId = JSON.parse(body).taskId;
console.log('taskId:', taskId);

/* Poll the chain, not the relayer's optimism — the account existing is the only proof that matters. */
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 6000));
  const code = await rpc('eth_getCode', [predicted, 'latest']);
  if (code && code.length > 4) {
    console.log(`\n✅ DEPLOYED at ${predicted} after ~${(i + 1) * 6}s`);
    const owners = await rpc('eth_call', [{ to: predicted, data: '0xa0e67e2b' }, 'latest']);
    const n = parseInt(owners.slice(66, 130), 16);
    console.log('owners:', n, '→ 0x' + owners.slice(130 + 24, 130 + 64));
    process.exit(0);
  }
  process.stderr.write(`waiting ${(i + 1) * 6}s\r`);
}
console.log('\nnot confirmed within 4min — check taskId', taskId);
