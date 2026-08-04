// zora-probe3.mjs — creation tx via internal txs + ZoraFactoryImpl ABI + example deploy calldata.
// Read-only. Saves scripts/zora-probe3-result.json + scripts/zora-factory-abi.json
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const TOKEN = '0x2c96b4d1c579f08955adc5c82d93f9ff83b7fae5';
const FACTORY = '0x777777751622c0d3258f214F9DF38E35BF45baF3';
const FACTORY_IMPL = '0xbbAe128a65239c3328fAa0c70B8D5F9C961a8038';
const BS = 'https://base.blockscout.com/api/v2';
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://1rpc.io/base'];

async function bs(path) {
  const r = await fetch(`${BS}${path}`);
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}
async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const out = { probedAt: new Date().toISOString() };

// 1. internal txs on the token address -> the create2 that born it, and its parent tx hash
const itx = await bs(`/addresses/${TOKEN}/internal-transactions`);
const born = (itx.items ?? []).find(t => /create/i.test(t.type ?? ''));
out.bornVia = born ? {
  type: born.type, tx_hash: born.transaction_hash,
  from: born.from?.hash, from_name: born.from?.name,
} : { note: 'no create internal tx found', typesSeen: (itx.items ?? []).map(t => t.type) };
console.log('BORN VIA:', JSON.stringify(out.bornVia, null, 2));

// 2. the parent tx: method + decoded input + raw calldata (save raw so we can re-encode ours)
const parentHash = born?.transaction_hash;
if (parentHash) {
  const tx = await bs(`/transactions/${parentHash}`);
  out.parentTx = {
    hash: parentHash, from: tx.from?.hash, to: tx.to?.hash, to_name: tx.to?.name,
    method: tx.method, value: tx.value, gas_used: tx.gas_used, fee_wei: tx.fee?.value,
    selector: tx.raw_input?.slice(0, 10),
    decoded: tx.decoded_input ? {
      method_call: tx.decoded_input.method_call,
      parameters: tx.decoded_input.parameters?.map(p => ({ name: p.name, type: p.type, value: p.value })),
    } : null,
  };
  writeFileSync(new URL('./zora-example-calldata.txt', import.meta.url), tx.raw_input ?? '');
  console.log('\nPARENT TX:', JSON.stringify({ ...out.parentTx, decoded: out.parentTx.decoded ? '(saved)' : null }, null, 2));
}

// 3. ZoraFactoryImpl ABI -> deploy functions + all no-arg address getters (find contentCoinImpl's real name)
const src = await bs(`/smart-contracts/${FACTORY_IMPL}`);
const abi = src.abi ?? [];
writeFileSync(new URL('./zora-factory-abi.json', import.meta.url), JSON.stringify(abi, null, 1));
const deployFns = abi.filter(f => f.type === 'function' && /deploy/i.test(f.name));
out.deploySignatures = deployFns.map(f =>
  `${f.name}(${(f.inputs ?? []).map(i => `${i.type} ${i.name}`).join(', ')})${f.stateMutability === 'payable' ? ' payable' : ''}`);
console.log('\nDEPLOY SIGNATURES:');
out.deploySignatures.forEach(s => console.log('  ', s));

const getters = abi.filter(f => f.type === 'function' && (f.inputs ?? []).length === 0
  && f.stateMutability === 'view' && (f.outputs ?? []).length === 1 && f.outputs[0].type === 'address');
out.getters = {};
for (const g of getters) {
  try {
    const res = await rpc('eth_call', [{ to: FACTORY, data: ethers.id(`${g.name}()`).slice(0, 10) }, 'latest']);
    if (res && res !== '0x') out.getters[g.name] = ethers.getAddress('0x' + res.slice(26));
  } catch { }
}
console.log('\nFACTORY ADDRESS GETTERS:', JSON.stringify(out.getters, null, 2));

// 4. decode the example calldata with the real ABI (belt and braces vs blockscout's decode)
try {
  const raw = out.parentTx ? (await bs(`/transactions/${parentHash}`)).raw_input : null;
  if (raw) {
    const iface = new ethers.Interface(abi);
    const parsed = iface.parseTransaction({ data: raw });
    if (parsed) {
      out.decodedByUs = {
        name: parsed.name,
        args: parsed.args.map(a => (typeof a === 'bigint' ? a.toString() : Array.isArray(a) ? a.map(String) : String(a))),
      };
      console.log('\nDECODED BY US:', JSON.stringify(out.decodedByUs, null, 2));
    }
  }
} catch (e) { console.log('self-decode failed (ok if tx hit a different contract):', String(e).slice(0, 200)); }

writeFileSync(new URL('./zora-probe3-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nsaved -> scripts/zora-probe3-result.json');
