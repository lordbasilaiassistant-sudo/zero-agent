// zora-probe.mjs — how was the example Zora content coin deployed, and can ZERO repeat it?
// Read-only: Blockscout v2 + Base RPC. No keys, no sends. Writes findings to scripts/zora-probe-result.json
import { writeFileSync } from 'node:fs';
import { LIVE_EOA } from '../shop.mjs';

const TOKEN = '0x2c96b4d1c579f08955adc5c82d93f9ff83b7fae5';
const ZERO_EOA = LIVE_EOA;
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

// 1. token contract info + creation tx
const tok = await bs(`/smart-contracts/${TOKEN}`);
out.token = {
  name: tok.name, verified: tok.is_verified, proxy_type: tok.proxy_type,
  implementations: tok.implementations,
  creation_tx: tok.creation_tx_hash, creator: tok.creator_address_hash,
};
console.log('TOKEN:', JSON.stringify(out.token, null, 2));

// 2. the creation tx — who called what, with what calldata
if (tok.creation_tx_hash) {
  const tx = await bs(`/transactions/${tok.creation_tx_hash}`);
  out.creationTx = {
    from: tx.from?.hash, to: tx.to?.hash, to_name: tx.to?.name,
    method: tx.method, value: tx.value, gas_used: tx.gas_used, fee_wei: tx.fee?.value,
    decoded_input: tx.decoded_input ? {
      method_call: tx.decoded_input.method_call,
      parameters: tx.decoded_input.parameters?.map(p => ({ name: p.name, type: p.type, value: p.value })),
    } : null,
    raw_input_first10: tx.raw_input?.slice(0, 10),
  };
  console.log('\nCREATION TX:', JSON.stringify(out.creationTx, null, 2));

  // 3. the factory it went through
  const factory = tx.to?.hash;
  if (factory) {
    const fac = await bs(`/smart-contracts/${factory}`);
    out.factory = {
      address: factory, name: fac.name, verified: fac.is_verified,
      proxy_type: fac.proxy_type, implementations: fac.implementations,
    };
    console.log('\nFACTORY:', JSON.stringify(out.factory, null, 2));
  }
}

// 4. token onchain reads: bytecode size (clone?), and current balances of ZERO's EOA for context
const code = await rpc('eth_getCode', [TOKEN, 'latest']);
out.tokenCodeLen = (code.length - 2) / 2;
out.tokenCodeIsMinimalProxy = code.startsWith('0x363d3d373d3d3d363d73');
if (out.tokenCodeIsMinimalProxy) out.cloneTarget = '0x' + code.slice(22, 62);
const bal = await rpc('eth_getBalance', [ZERO_EOA, 'latest']);
out.zeroEoaWeiBalance = BigInt(bal).toString();
const gasPrice = await rpc('eth_gasPrice', []);
out.baseGasPriceWei = BigInt(gasPrice).toString();
console.log(`\ntoken code: ${out.tokenCodeLen} bytes, minimalProxy=${out.tokenCodeIsMinimalProxy}, cloneTarget=${out.cloneTarget ?? 'n/a'}`);
console.log(`ZERO EOA balance: ${out.zeroEoaWeiBalance} wei | base gasPrice: ${out.baseGasPriceWei} wei`);

writeFileSync(new URL('./zora-probe-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nsaved -> scripts/zora-probe-result.json');
