#!/usr/bin/env node
// Probe Safe relay POST bodies. A 400 does not spend a slot; the first 201 does.
// Loads AGENT_PRIVATE_KEY from ~/.claude/secrets/autoglmwallet.env — never prints it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { RELAY_HEADERS, relayUrl } from '../harvest.mjs';
import { SMART_ACCOUNT } from '../shop.mjs';

if (!process.argv.includes('--spend')) {
  console.error('REFUSED: this POSTs to the live Safe relay. A 201 spends a slot. Pass --spend to run.');
  process.exit(2);
}

const SAFE = SMART_ACCOUNT;
const CHAIN_ID = 8453;
const RPC = 'https://base-rpc.publicnode.com';
const STRAT = '0xB6D144fCCE62547C870b4E231b01Ca2994Aa54f6';

const envf = fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8');
const PK = envf.match(/AGENT_PRIVATE_KEY=(.+)/)?.[1]?.trim();
if (!PK) { console.error('AGENT_PRIVATE_KEY missing'); process.exit(2); }
const wallet = new ethers.Wallet(PK);

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
};

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const inner = new ethers.Interface(['function harvest(address)']).encodeFunctionData('harvest', [SAFE]);
const nonceHex = await rpc('eth_call', [{ to: SAFE, data: '0xaffed0e0' }, 'latest']);
const tx = {
  to: STRAT, value: 0n, data: inner, operation: 0,
  safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
  gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress,
  nonce: BigInt(nonceHex),
};
const domain = { chainId: CHAIN_ID, verifyingContract: SAFE };
const signature = await wallet.signTypedData(domain, SAFE_TX_TYPES, tx);
const safeTxHash = ethers.TypedDataEncoder.hash(domain, SAFE_TX_TYPES, tx);
const exec = new ethers.Interface(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)'])
  .encodeFunctionData('execTransaction', [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signature]);

const to = ethers.getAddress(SAFE);
const variants = [
  { name: 'current-2.5m', body: { version: '1.4.1', to, data: exec, gasLimit: '2500000' } },
  { name: '500k', body: { version: '1.4.1', to, data: exec, gasLimit: '500000' } },
  { name: '1m', body: { version: '1.4.1', to, data: exec, gasLimit: '1000000' } },
  { name: 'no-gasLimit', body: { version: '1.4.1', to, data: exec } },
  { name: '1m+unverified', body: { version: '1.4.1', to, data: exec, gasLimit: '1000000', acceptUnverifiedSimulation: true } },
  { name: '1m+hash', body: { version: '1.4.1', to, data: exec, gasLimit: '1000000', safeTxHash } },
  { name: '1m+hash+unverified', body: { version: '1.4.1', to, data: exec, gasLimit: '1000000', safeTxHash, acceptUnverifiedSimulation: true } },
  { name: '500k+unverified', body: { version: '1.4.1', to, data: exec, gasLimit: '500000', acceptUnverifiedSimulation: true } },
];

console.log(JSON.stringify({
  signer: wallet.address,
  safe: SAFE,
  nonce: nonceHex,
  inner_to: STRAT,
  exec_bytes: exec.length,
}, null, 2));

for (const v of variants) {
  const res = await fetch(relayUrl(CHAIN_ID), {
    method: 'POST',
    headers: RELAY_HEADERS,
    body: JSON.stringify(v.body),
  });
  const text = await res.text();
  console.log(JSON.stringify({ variant: v.name, status: res.status, body: text.slice(0, 240) }));
  if (res.status === 201) {
    console.log('WIN — slot spent. Stop.');
    process.exit(0);
  }
}
console.log('no variant returned 201');
