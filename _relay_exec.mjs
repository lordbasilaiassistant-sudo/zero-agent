// Probe: can the free keyless Safe relay execute an ARBITRARY external contract call?
// Signs a SafeTx with ZERO's key loaded from the operator secrets store. Key is never printed.
import { ethers } from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRETS = path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env');
const env = Object.fromEntries(fs.readFileSync(SECRETS, 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const wallet = new ethers.Wallet(env.AGENT_PRIVATE_KEY);
console.log('signer', wallet.address);

const CHAIN = 8453;
const SAFE = '0xf1597C629BB438ED4576a171ae8e05D770c05396';
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');

const safe = new ethers.Contract(SAFE, [
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)'
], provider);

console.log('owners', await safe.getOwners());
const nonce = await safe.nonce();
console.log('safe nonce', nonce.toString());

// Arbitrary external contract call: USDC.transfer(<addr>, 0) — real call into a third-party contract, no effect.
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const inner = new ethers.Interface(['function transfer(address,uint256) returns (bool)'])
  .encodeFunctionData('transfer', ['0x000000000000000000000000000000000000dEaD', 0]);

const tx = { to: USDC, value: 0n, data: inner, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce };
const sig = await wallet.signTypedData(
  { chainId: CHAIN, verifyingContract: SAFE },
  { SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' } ] },
  tx);

const data = safe.interface.encodeFunctionData('execTransaction', [
  tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, sig]);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const res = await fetch(`https://safe-client.safe.global/v1/chains/${CHAIN}/relay`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'User-Agent': UA, Origin: 'https://app.safe.global' },
  body: JSON.stringify({ version: '1.4.1', to: SAFE, data })
});
const txt = await res.text();
console.log('relay status', res.status, txt);
let taskId; try { taskId = JSON.parse(txt).taskId; } catch {}
if (!taskId) process.exit(1);
for (let i = 0; i < 24; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const j = await (await fetch(`https://api.gelato.digital/tasks/status/${taskId}`, { headers: { 'User-Agent': UA } })).json();
  const t = j.task || {};
  console.log(i, t.taskState, t.transactionHash || '', t.lastCheckMessage || '');
  if (/Success/i.test(t.taskState || '') || /Cancelled|Reverted/i.test(t.taskState || '')) break;
}
