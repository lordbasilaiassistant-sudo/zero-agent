// selftest.mjs — proves every tool green against a THROWAWAY wallet in the scratchpad
// before the real agent ever touches them. Run: node selftest.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const scratch = path.join(os.tmpdir(), 'autoglm-selftest-' + Date.now());
fs.mkdirSync(scratch, { recursive: true });
process.env.AUTOGLM_HOME = scratch;
process.env.AUTOGLM_SECRETS = path.join(scratch, 'throwaway.env');
process.env.AUTOGLM_CREDS = path.join(scratch, 'creds.json');

const { TOOL_IMPL } = await import('./tools.mjs');

let pass = 0, fail = 0;
async function t(name, fn) {
  try {
    const out = await fn();
    console.log(`PASS  ${name}${out ? ' — ' + String(out).slice(0, 100) : ''}`);
    pass++;
  } catch (e) {
    console.log(`FAIL  ${name} — ${String(e.message || e).slice(0, 200)}`);
    fail++;
  }
}

await t('ensure_wallet creates throwaway', async () => {
  const r = await TOOL_IMPL.ensure_wallet();
  if (!r.created || !/^0x[0-9a-fA-F]{40}$/.test(r.address)) throw new Error('bad result ' + JSON.stringify(r));
  return r.address;
});

await t('ensure_wallet idempotent', async () => {
  const r = await TOOL_IMPL.ensure_wallet();
  if (r.created) throw new Error('created twice!');
});

await t('get_status (fresh = broke)', async () => {
  const r = await TOOL_IMPL.get_status();
  if (r.broke !== true) throw new Error('fresh wallet should be broke: ' + JSON.stringify(r));
  return `base=${r.chains.base?.eth} sep=${r.chains['base-sepolia']?.eth} ethusd=${r.eth_usd}`;
});

await t('sign_message', async () => {
  const r = await TOOL_IMPL.sign_message({ message: 'zero selftest' });
  if (!/^0x[0-9a-fA-F]{130}$/.test(r.signature)) throw new Error('bad signature');
});

await t('eth_call WETH.symbol() on base', async () => {
  const r = await TOOL_IMPL.eth_call({ chain: 'base', to: '0x4200000000000000000000000000000000000006', signature: 'symbol() view returns (string)' });
  if (r.result[0] !== 'WETH') throw new Error('got ' + JSON.stringify(r));
  return 'WETH';
});

await t('eth_call USDC.balanceOf(fresh)=0', async () => {
  const w = JSON.parse(fs.readFileSync(path.join(scratch, 'state', 'wallet.json'), 'utf8'));
  const r = await TOOL_IMPL.eth_call({ chain: 'base', to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', signature: 'balanceOf(address) view returns (uint256)', args: [w.address] });
  if (r.result[0] !== '0') throw new Error('expected 0, got ' + JSON.stringify(r));
});

await t('explorer base-sepolia stats', async () => {
  const r = await TOOL_IMPL.explorer({ chain: 'base-sepolia', api_path: 'stats' });
  if (r.status !== 200) throw new Error('status ' + r.status);
});

await t('explorer contract source (WETH)', async () => {
  const r = await TOOL_IMPL.explorer({ chain: 'base', api_path: 'smart-contracts/0x4200000000000000000000000000000000000006' });
  if (!r.data.includes('WETH9')) throw new Error('no source returned');
});

await t('web_search', async () => {
  const r = await TOOL_IMPL.web_search({ query: 'base sepolia faucet' });
  if (!r.results?.length) throw new Error('no results');
  return r.results.length + ' results';
});

await t('http_fetch base docs faucet page', async () => {
  const r = await TOOL_IMPL.http_fetch({ url: 'https://docs.base.org/base-chain/network-information/network-faucets' });
  if (r.status !== 200 || !/faucet/i.test(r.text)) throw new Error('status ' + r.status);
});

await t('knowledge write/read/list', async () => {
  await TOOL_IMPL.knowledge_write({ name: 'selftest', content: '# hello future me', mode: 'overwrite' });
  const r = await TOOL_IMPL.knowledge_read({ name: 'selftest' });
  if (!r.content.includes('future me')) throw new Error('roundtrip failed');
  const l = await TOOL_IMPL.knowledge_list();
  if (!l.files.some(f => f.name === 'selftest.md')) throw new Error('not listed');
});

await t('route_log ledger', async () => {
  const r = await TOOL_IMPL.route_log({ route_id: 'selftest-route', outcome: 'fail', earned_usd: 0, note: 'testing the ledger' });
  if (r.logged !== 'selftest-route' || !r.leaderboard.length) throw new Error('bad ledger ' + JSON.stringify(r));
});

await t('route_log rejects bad outcome', async () => {
  try { await TOOL_IMPL.route_log({ route_id: 'x', outcome: 'maybe' }); }
  catch { return; }
  throw new Error('accepted invalid outcome');
});

await t('send_tx refuses when broke (teaching error)', async () => {
  const w = JSON.parse(fs.readFileSync(path.join(scratch, 'state', 'wallet.json'), 'utf8'));
  try { await TOOL_IMPL.send_tx({ chain: 'base-sepolia', to: w.address, value_eth: '0' }); }
  catch (e) {
    if (/insufficient|broke|zero balance|estimate failed/i.test(e.message)) return 'refused correctly';
    throw new Error('wrong error: ' + e.message);
  }
  throw new Error('broke wallet somehow sent a tx?!');
});

await t('secret store/get/list + private-key refusal', async () => {
  await TOOL_IMPL.secret_store({ name: 'test-api-key', value: 'sk_test_12345' });
  const g = await TOOL_IMPL.secret_get({ name: 'test-api-key' });
  if (g.value !== 'sk_test_12345') throw new Error('roundtrip failed');
  const l = await TOOL_IMPL.secret_list();
  if (!l.secrets.some(s => s.name === 'test-api-key')) throw new Error('not listed');
  try {
    await TOOL_IMPL.secret_store({ name: 'evil', value: '0x' + 'a'.repeat(64) });
    throw new Error('accepted a private key!');
  } catch (e) { if (!/private key/i.test(e.message)) throw e; }
});

await t('send_tx refuses NEVER_TOUCH', async () => {
  try { await TOOL_IMPL.send_tx({ chain: 'base', to: '0xc07E889e1816De2708BF718683e52150C20F3BA3' }); }
  catch (e) {
    if (/blocklist/i.test(e.message)) return 'blocklist enforced';
    throw new Error('wrong error: ' + e.message);
  }
  throw new Error('blocklist NOT enforced');
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed — throwaway wallet destroyed`);
process.exit(fail ? 1 : 0);
