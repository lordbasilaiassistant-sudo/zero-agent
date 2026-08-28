import { sweepJunk } from '../janitor.mjs';
import { SMART_ACCOUNT } from '../shop.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mem = new Map();
const envf = fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8');
const env = {
  AGENT_PRIVATE_KEY: envf.match(/AGENT_PRIVATE_KEY=(.+)/)?.[1]?.trim(),
  KV: {
    async get(k, type) { const v = mem.get(k); return v === undefined ? null : (type === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { mem.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
  },
};
const RPCS = {
  base: ['https://base-rpc.publicnode.com'],
  optimism: ['https://optimism-rpc.publicnode.com'],
  arbitrum: ['https://arbitrum-one-rpc.publicnode.com'],
  polygon: ['https://polygon-bor-rpc.publicnode.com'],
};
let id = 0;
const rpcFn = async (chain, method, params) => {
  const r = await fetch(RPCS[chain][0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(25000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

const owned = {
  base: process.argv[2] || SMART_ACCOUNT,
  optimism: SMART_ACCOUNT,
  arbitrum: SMART_ACCOUNT,
};
const rep = await sweepJunk(env, rpcFn, owned);
console.log(JSON.stringify(rep, null, 2));
console.log('\nDENYLIST now:', JSON.stringify(JSON.parse(mem.get('janitor:junk')), null, 1));
