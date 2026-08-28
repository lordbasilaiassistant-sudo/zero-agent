// probe-discovery.mjs — ops probe: run one discovery pass on a chain and report candidates.
// Reads ADMIN key from ~/.claude/secrets/autoglmwallet.env (never on the command line).
// Usage: node scripts/probe-discovery.mjs [chain]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const chain = process.argv[2] || 'optimism';
const env = fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8');
const key = env.match(/^ADMIN_KEY=(.*)$/m)?.[1]?.trim();
if (!key) { console.error('no ADMIN_KEY in secrets — that is the Worker secret name; WORKER_ADMIN_KEY does not exist'); process.exit(1); }

const r = await fetch(`https://zero-agent.broke2built.workers.dev/tool?key=${key}&name=discover_new_sources`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain }),
});
const j = await r.json();
const res = j.result || j;
console.log(JSON.stringify({
  chain, status: r.status,
  skipped: res.skipped || null,
  new_candidates: res.new_candidates ?? res.found ?? null,
  keys: Object.keys(res).slice(0, 10),
  summary: JSON.stringify(res).slice(0, 600),
}, null, 1));
