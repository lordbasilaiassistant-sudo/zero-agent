// shoptest.mjs — proves ZERO's storefront before anyone pays it.
// Payment verification is unit-tested against synthetic receipts; the products are generated
// for real against live Blockscout + GLM so we know a buyer gets something worth 5 cents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyPayment, buildContractAudit, buildWalletBrief, PRODUCTS } from './shop.mjs';

const env = {};
for (const line of fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const PAY_TO = '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1'; // smart account
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => '0x' + a.toLowerCase().slice(2).padStart(64, '0');

const kv = new Map();
env.KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) };

const rpcLive = async (chain, method, params) => {
  const r = await fetch('https://base-rpc.publicnode.com', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()).result;
};
const receipt = (to, units) => ({
  status: '0x1',
  logs: [{ address: USDC, topics: [TOPIC, pad('0x1111111111111111111111111111111111111111'), pad(to)], data: '0x' + units.toString(16) }],
});

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const o = await fn(); console.log(`PASS  ${name}${o ? ' — ' + String(o).slice(0, 110) : ''}`); pass++; }
  catch (e) { console.log(`FAIL  ${name} — ${String(e.message || e).slice(0, 220)}`); fail++; }
};
const H = '0x' + 'a'.repeat(64);

await t('exact payment accepted', async () => {
  const r = await verifyPayment(env, async () => receipt(PAY_TO, 50000n), H, 50000n, PAY_TO);
  if (!r.ok) throw new Error(r.why);
  return r.paid_units + ' units';
});
await t('overpayment accepted', async () => {
  const r = await verifyPayment(env, async () => receipt(PAY_TO, 90000n), H, 50000n, PAY_TO);
  if (!r.ok) throw new Error(r.why);
});
await t('underpayment refused', async () => {
  const r = await verifyPayment(env, async () => receipt(PAY_TO, 4000n), H, 50000n, PAY_TO);
  if (r.ok || !/too small/.test(r.why)) throw new Error('accepted an underpayment!');
  return r.why;
});
await t('payment to a different address refused', async () => {
  const r = await verifyPayment(env, async () => receipt('0x000000000000000000000000000000000000dEaD', 50000n), H, 50000n, PAY_TO);
  if (r.ok) throw new Error('accepted someone else payment!');
});
await t('non-USDC token refused', async () => {
  const bad = receipt(PAY_TO, 50000n); bad.logs[0].address = '0x4200000000000000000000000000000000000006';
  const r = await verifyPayment(env, async () => bad, H, 50000n, PAY_TO);
  if (r.ok) throw new Error('accepted a non-USDC transfer!');
});
await t('reverted tx refused', async () => {
  const rc = receipt(PAY_TO, 50000n); rc.status = '0x0';
  const r = await verifyPayment(env, async () => rc, H, 50000n, PAY_TO);
  if (r.ok || !/reverted/.test(r.why)) throw new Error('accepted a reverted tx!');
});
await t('replay refused (hash burned)', async () => {
  await env.KV.put('paid:' + H, '{}');
  const r = await verifyPayment(env, async () => receipt(PAY_TO, 50000n), H, 50000n, PAY_TO);
  if (r.ok || !/already been redeemed/.test(r.why)) throw new Error('allowed a replay!');
  kv.delete('paid:' + H);
});
await t('malformed hash refused', async () => {
  const r = await verifyPayment(env, async () => receipt(PAY_TO, 50000n), 'nope', 50000n, PAY_TO);
  if (r.ok) throw new Error('accepted garbage');
});
await t('unknown tx refused (LIVE rpc)', async () => {
  const r = await verifyPayment(env, rpcLive, '0x' + 'b'.repeat(64), 50000n, PAY_TO);
  if (r.ok || !/not found/.test(r.why)) throw new Error('unexpected: ' + r.why);
  return r.why;
});

await t('PRODUCT contract-audit on verified source (LIVE Blockscout + GLM)', async () => {
  const out = await buildContractAudit(env, rpcLive, '0x4200000000000000000000000000000000000006');
  if (!out.verified_source) throw new Error('expected verified source for WETH');
  if (!out.report || out.report.length < 400) throw new Error('report too thin: ' + (out.report || '').slice(0, 120));
  fs.writeFileSync(path.join(os.tmpdir(), 'zero-sample-audit.md'), out.report);
  return `${out.name} · ${out.report.length} chars · saved sample`;
});
await t('PRODUCT contract-audit is honest about unverified source (LIVE)', async () => {
  const out = await buildContractAudit(env, rpcLive, '0x50624F7790732f9767180871D03A304756200dB9');
  if (out.verified_source) throw new Error('claimed verified source for an EOA');
  if (!/NOT verified/i.test(out.report)) throw new Error('did not say it was unverified');
});
await t('PRODUCT wallet-brief (LIVE Blockscout + GLM)', async () => {
  const out = await buildWalletBrief(env, rpcLive, '0x7a3E312Ec6e20a9F62fE2405938EB9060312E334');
  if (!out.report || out.report.length < 200) throw new Error('brief too thin');
  return `${out.report.length} chars`;
});
await t('catalogue priced sanely', async () => {
  for (const [slug, p] of Object.entries(PRODUCTS)) {
    if (BigInt(p.units) !== BigInt(Math.round(parseFloat(p.price_usdc) * 1e6))) throw new Error(`price/units mismatch for ${slug}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
