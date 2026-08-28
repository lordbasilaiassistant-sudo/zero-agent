// oracle-sweep.mjs — price every callable Base candidate with ZERO's payout_oracle, save sorted table.
// Read-only (oracle = eth_call simulations). Usage: node scripts/oracle-sweep.mjs [chain] [topN]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const chain = process.argv[2] || 'base';
const topN = Number(process.argv[3] || 20);
const env = fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8');
const key = env.match(/^ADMIN_KEY=(.*)$/m)?.[1]?.trim();
if (!key) { console.error('no ADMIN_KEY in secrets — that is the Worker secret name; WORKER_ADMIN_KEY does not exist'); process.exit(1); }
const BASE = 'https://zero-agent.broke2built.workers.dev';

async function tool(name, body) {
  const r = await fetch(`${BASE}/tool?key=${key}&name=${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return j.result ?? j;
}

const list = await tool('discover_list', { chain, status: 'promising', limit: 400 });
const cands = (list.untried_promising ?? []).filter(c => c.chain === chain && (c.callable_now ?? []).length);
console.log(`${cands.length} callable-${chain} candidates; pricing top ${Math.min(topN, cands.length)} by payouts_seen…`);
cands.sort((a, b) => (b.payouts_seen ?? 0) - (a.payouts_seen ?? 0));

const rows = [];
for (const c of cands.slice(0, topN)) {
  for (const fn of c.callable_now.slice(0, 2)) {
    const res = await tool('payout_oracle', { chain: c.chain, contract: c.contract, fn });
    rows.push({
      contract: c.contract, name: c.name, fn, payouts_seen: c.payouts_seen,
      oracle: typeof res === 'object' ? res : { raw: String(res).slice(0, 200) },
    });
    const brief = JSON.stringify(rows[rows.length - 1].oracle).slice(0, 220);
    console.log(`${c.contract} ${fn} -> ${brief}`);
  }
}
fs.writeFileSync(new URL('./oracle-sweep-result.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), chain, rows }, null, 2));
console.log('\nsaved -> scripts/oracle-sweep-result.json');
