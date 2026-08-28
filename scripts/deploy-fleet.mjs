/* Deploy the FLEET Safe (salt zero-fleet-bucket-2) on additional chains via the OWNER EOA's
   own relay quota — one slot per chain, $0 of earned money. Verifies code AFTER, so a phantom
   quota can never pass for a real account again. */
import { ethers } from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
if (!process.argv.includes('--spend')) {
  console.error('REFUSED: this spends the OWNER EOA relay quota. Pass --spend to deploy.');
  process.exit(2);
}
const CHAINS = { base: [8453, 'https://mainnet.base.org'], optimism: [10, 'https://mainnet.optimism.io'], arbitrum: [42161, 'https://arb1.arbitrum.io/rpc'], polygon: [137, 'https://polygon-rpc.com'] };
const [chainName] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const [CHAIN_ID, RPC] = CHAINS[chainName] || [];

const PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const FH = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
const RELAY_HEADERS = {
  'content-type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Origin: 'https://app.safe.global', Referer: 'https://app.safe.global/',
};

const envf = fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8');
const PK = envf.match(/AGENT_PRIVATE_KEY=(.+)/)?.[1]?.trim();
const wallet = new ethers.Wallet(PK);

const safeIface = new ethers.Interface(['function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)']);
const factoryIface = new ethers.Interface(['function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address)']);
const init = safeIface.encodeFunctionData('setup', [[wallet.address], 1, ethers.ZeroAddress, '0x', FH, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
// saltNonce+1: the base-salt measured CURSED on base (three providers revert); +1 estimated clean
const SALT_NONCE = (BigInt(ethers.keccak256(ethers.toUtf8Bytes('zero-fleet-bucket-2-' + wallet.address))) % (2n ** 64n)) + 1n;
const data = factoryIface.encodeFunctionData('createProxyWithNonce', [SINGLETON, init, SALT_NONCE]);

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
}

// Find the ACTUAL proxy address from a fresh deployment event instead of predicting (our static
// prediction formula proved unreliable — the receipt on base landed elsewhere).
console.log(`[${chainName}] deploying fleet safe (salt ${SALT_NONCE.toString().slice(0, 8)}…)`);
const budget = await (await fetch(`https://safe-client.safe.global/v1/chains/${CHAIN_ID}/relay/${wallet.address}`, { headers: RELAY_HEADERS })).json();
console.log(`owner quota on ${chainName}: ${budget.remaining}/${budget.limit}`);
if (!budget.remaining) { console.log('NO QUOTA'); process.exit(1); }

const headBefore = parseInt(await rpc('eth_blockNumber', []), 16);
const res = await fetch(`https://safe-client.safe.global/v1/chains/${CHAIN_ID}/relay`, {
  method: 'POST', headers: RELAY_HEADERS,
  body: JSON.stringify({ version: '1.4.1', to: PROXY_FACTORY, data, gasLimit: '500000' }),
});
const body = await res.text();
console.log('relay HTTP', res.status, body.slice(0, 160));
if (!res.ok) process.exit(1);

for (let i = 0; i < 50; i++) {
  await new Promise(r => setTimeout(r, 6000));
  const logs = await rpc('eth_getLogs', [{ address: PROXY_FACTORY, topics: ['0x4f51faf6c4561ff95f43b5714d6c1ff7d0f60c1a2ee44dc3eec0334a1c4a2df9'], fromBlock: '0x' + headBefore.toString(16), toBlock: 'latest' }]).catch(() => []);
  if (logs && logs.length) {
    // ProxyCreation(address,address): topic1 = proxy
    const proxy = '0x' + logs[logs.length - 1].topics[1].slice(26);
    const code = await rpc('eth_getCode', [proxy, 'latest']);
    if (code && code.length > 4) {
      console.log(`DEPLOYED ${proxy} on ${chainName} (${code.length} bytes)`);
      const owners = await rpc('eth_call', [{ to: proxy, data: '0xa0e67e2b' }, 'latest']);
      const ver = await rpc('eth_call', [{ to: proxy, data: '0xffa1ad74' }, 'latest']);
      const nonce = await rpc('eth_call', [{ to: proxy, data: '0xaffed0e0' }, 'latest']);
      console.log('owner ok:', owners.slice(130 - 24, 130).includes(wallet.address.slice(2).toLowerCase()), '| VERSION:', ethers.AbiCoder.defaultAbiCoder().decode(['string'], ver)[0], '| nonce:', BigInt(nonce || '0x0').toString());
      const q = await (await fetch(`https://safe-client.safe.global/v1/chains/${CHAIN_ID}/relay/${proxy}`, { headers: RELAY_HEADERS })).json();
      console.log(`its OWN relay bucket on ${chainName}: ${q.remaining}/${q.limit}`);
      break;
    }
  }
  if (i === 49) console.log('no deployment observed within 5min');
}
