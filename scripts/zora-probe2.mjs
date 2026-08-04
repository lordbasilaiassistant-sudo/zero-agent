// zora-probe2.mjs — find the factory + exact deploy calldata behind the example coin.
// Read-only. Saves scripts/zora-probe2-result.json
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const TOKEN = '0x2c96b4d1c579f08955adc5c82d93f9ff83b7fae5';
const IMPL = '0x5DbD43785954D43c1643A0caf2ecEf9E0056Ff13'; // ContentCoin impl (measured, probe 1)
const RECALLED_FACTORY = '0x777777751622c0d3258f214F9DF38E35BF45baF3'; // HYPOTHESIS — verify below
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
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const sel = (sig) => ethers.id(sig).slice(0, 10);

const out = { probedAt: new Date().toISOString() };

// 1. creation tx via the /addresses endpoint (smart-contracts endpoint omitted it)
const addr = await bs(`/addresses/${TOKEN}`);
out.creation_tx_hash = addr.creation_tx_hash ?? addr.creation_transaction_hash ?? null;
out.creator = addr.creator_address_hash ?? null;
console.log('creation tx:', out.creation_tx_hash, '| creator:', out.creator);

// 2. the tx itself: to = factory (or a router), method + decoded input
let factoryAddr = null;
if (out.creation_tx_hash) {
  const tx = await bs(`/transactions/${out.creation_tx_hash}`);
  out.creationTx = {
    from: tx.from?.hash, to: tx.to?.hash, to_name: tx.to?.name, method: tx.method,
    value: tx.value, gas_used: tx.gas_used, fee_wei: tx.fee?.value,
    raw_input_first10: tx.raw_input?.slice(0, 10),
    decoded: tx.decoded_input ? {
      method_call: tx.decoded_input.method_call,
      parameters: tx.decoded_input.parameters?.map(p => ({ name: p.name, type: p.type, value: p.value })),
    } : null,
  };
  factoryAddr = tx.to?.hash;
  console.log('\nCREATION TX:', JSON.stringify(out.creationTx, null, 2));
}

// 3. is the recalled canonical factory real, and does it point at our measured impl?
for (const [label, fa] of [['txTarget', factoryAddr], ['recalled777', RECALLED_FACTORY]]) {
  if (!fa) continue;
  try {
    const info = {};
    const meta = await bs(`/smart-contracts/${fa}`);
    info.name = meta.name; info.verified = meta.is_verified;
    info.proxy_type = meta.proxy_type; info.implementations = meta.implementations;
    for (const sig of ['contentCoinImpl()', 'coinImpl()', 'creatorCoinImpl()', 'coinVersion()', 'implementation()']) {
      try {
        const res = await call(fa, sel(sig));
        if (res && res !== '0x') {
          info[sig] = sig === 'coinVersion()'
            ? ethers.AbiCoder.defaultAbiCoder().decode(['string'], res)[0]
            : '0x' + res.slice(26);
        }
      } catch { /* not this one */ }
    }
    out[label] = { address: fa, ...info };
    console.log(`\n${label}:`, JSON.stringify(out[label], null, 2));
  } catch (e) { out[label] = { address: fa, error: String(e) }; }
}

// 4. grab the factory's (or its impl's) ABI so we can build our own deploy call
const abiTarget = out.txTarget?.implementations?.[0]?.address_hash ?? factoryAddr;
if (abiTarget) {
  try {
    const src = await bs(`/smart-contracts/${abiTarget}`);
    const deployFns = (src.abi ?? []).filter(f => f.type === 'function' && /deploy/i.test(f.name));
    out.deployFunctions = deployFns;
    writeFileSync(new URL('./zora-factory-abi.json', import.meta.url), JSON.stringify(src.abi ?? [], null, 1));
    console.log('\nDEPLOY FUNCTIONS:', JSON.stringify(deployFns, null, 2));
    console.log('full ABI saved -> scripts/zora-factory-abi.json');
  } catch (e) { console.log('ABI fetch failed:', String(e)); }
}

writeFileSync(new URL('./zora-probe2-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nsaved -> scripts/zora-probe2-result.json');
