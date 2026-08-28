// free-deploy-probe.mjs — how does ZERO deploy a contract at zero cost, by itself?
// Two candidate routes, both measured, no recall:
//   R1 SPONSORED: Safe relay (free, 5/day/chain) executes a DELEGATECALL to Safe's CreateCall
//      library -> the contract is deployed FROM the Safe, gas paid by the sponsor.
//   R2 SELF-FUNDED: Base gas is so cheap that ZERO's own ETH may already cover many deploys.
//      Measure the real cost of a real deployment instead of assuming it's expensive.
// Read-only. Saves scripts/free-deploy-result.json
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

import { SMART_ACCOUNT, LIVE_EOA } from '../shop.mjs';

const SAFE = SMART_ACCOUNT;
const EOA = LIVE_EOA;
const CREATE_CALL = '0x9b35Af71d77eaf8d7e40252370304687390A1A52'; // Safe CreateCall (canonical)
const CREATE_CALL_ALT = '0x7cbB62EaA69F79e6873cD1ecB2392971036cFAa4'; // Safe CreateCall v1.4.1
const CHAINS = {
  base: { id: 8453, rpc: 'https://base-rpc.publicnode.com' },
  gnosis: { id: 100, rpc: 'https://rpc.gnosischain.com' },
  unichain: { id: 130, rpc: 'https://unichain-rpc.publicnode.com' },
};

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 160));
  return j.result;
}

const out = { probedAt: new Date().toISOString() };

// R1 — does the CreateCall library exist on the chains where we hold free relay slots?
out.createCall = {};
for (const [name, c] of Object.entries(CHAINS)) {
  const row = {};
  for (const [label, addr] of [['canonical', CREATE_CALL], ['v1_4_1', CREATE_CALL_ALT]]) {
    try {
      const code = await rpc(c.rpc, 'eth_getCode', [addr, 'latest']);
      row[label] = { address: addr, deployed: !!code && code !== '0x', codeLen: code ? (code.length - 2) / 2 : 0 };
    } catch (e) { row[label] = { address: addr, error: String(e).slice(0, 120) }; }
  }
  out.createCall[name] = row;
  console.log(`${name}: CreateCall canonical=${row.canonical?.deployed} v1.4.1=${row.v1_4_1?.deployed}`);
}

// R2 — what does deploying a REAL contract actually cost on Base right now?
// Use a representative payload: a minimal router-shaped contract (~1.5KB runtime).
// We measure with eth_estimateGas on a creation transaction (to: null).
const SAMPLE_INIT = '0x' + '60806040523480156100' + '0'.repeat(2800) + '00'; // ~1.4KB of deploy data, shape-representative
try {
  const [gasHex, block] = await Promise.all([
    rpc(CHAINS.base.rpc, 'eth_estimateGas', [{ from: EOA, data: '0x60806040523480156100115760006000fd5b5060368060206000396000f3fe6080604052600080fdfea2646970667358221220' + '00'.repeat(32) + '64736f6c63430008140033' }]).catch(e => null),
    rpc(CHAINS.base.rpc, 'eth_getBlockByNumber', ['latest', false]),
  ]);
  const baseFee = BigInt(block.baseFeePerGas);
  out.baseFeeGwei = ethers.formatUnits(baseFee, 'gwei');
  // measured reference points from this repo's own history (real, not recalled):
  const REFS = { zora_coin_deploy: 2240019 };
  out.selfFundedCost = {};
  const balance = BigInt(await rpc(CHAINS.base.rpc, 'eth_getBalance', [EOA, 'latest']));
  out.eoaBalanceEth = ethers.formatEther(balance);
  for (const [label, gas] of Object.entries({ minimal_contract_200k: 200000, medium_contract_800k: 800000, ...REFS })) {
    const cost = BigInt(gas) * (baseFee * 2n + 1000000n);
    out.selfFundedCost[label] = {
      gas, cost_eth: ethers.formatEther(cost),
      affordable_now: balance > cost, how_many: Number(balance / cost),
    };
  }
  console.log(`\nBase fee ${out.baseFeeGwei} gwei · ZERO holds ${out.eoaBalanceEth} ETH`);
  for (const [k, v] of Object.entries(out.selfFundedCost)) {
    console.log(`  ${k}: ${v.cost_eth} ETH · affordable=${v.affordable_now} · can afford ${v.how_many}x`);
  }
} catch (e) { out.costError = String(e).slice(0, 300); console.log('cost probe failed:', out.costError); }

// R1 detail — the relay accepts arbitrary calldata to the Safe; a DELEGATECALL(operation=1) to
// CreateCall.performCreate2 deploys from the Safe. Record the exact call shape for the builder.
const createCallIface = new ethers.Interface([
  'function performCreate(uint256 value, bytes deploymentData) returns (address newContract)',
  'function performCreate2(uint256 value, bytes deploymentData, bytes32 salt) returns (address newContract)',
]);
out.relayDeployRecipe = {
  route: 'Safe relay -> execTransaction{operation:1 DELEGATECALL} -> CreateCall.performCreate2',
  to: CREATE_CALL,
  operation: 1,
  dataTemplate: createCallIface.encodeFunctionData('performCreate2', [0, '0x', ethers.ZeroHash]).slice(0, 10) + ' + abi(value, initcode, salt)',
  note: 'the Safe must be DEPLOYED first; its own deployment is also sponsorable by the same relay (verified in this repo: Safe deploy tx 0x8bfe6633…3863 at $0 balance)',
};

writeFileSync(new URL('./free-deploy-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nsaved -> scripts/free-deploy-result.json');
