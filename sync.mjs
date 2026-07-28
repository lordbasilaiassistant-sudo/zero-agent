// sync.mjs — cloud KV is ZERO's canonical memory; local files are a mirror.
//   node sync.mjs pull   → copy the agent's live cloud memory into local files (no creds needed)
//   node sync.mjs push   → overwrite cloud memory from local files (needs Cloudflare creds)
// Pull before reading its journal locally; push only when YOU deliberately edit its knowledge.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.ZERO_WORKER || 'https://zero-agent.thryx.workers.dev';
const MAP = [
  { kv: 'knowledge:genesis', file: 'knowledge/genesis.md', endpoint: '/genesis' },
  { kv: 'knowledge:recovery', file: 'knowledge/recovery.md', endpoint: '/recovery' },
  { kv: 'knowledge:journal', file: 'knowledge/journal.md', endpoint: '/journal' },
  { kv: 'state:routes', file: 'state/routes.json', endpoint: '/ledger' },
];

const mode = process.argv[2];

if (mode === 'pull') {
  for (const m of MAP) {
    const res = await fetch(BASE + m.endpoint);
    const text = await res.text();
    const dest = path.join(ROOT, m.file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    console.log(`pulled ${m.endpoint} → ${m.file} (${text.length} bytes)`);
  }
  const status = await (await fetch(BASE + '/')).json();
  fs.writeFileSync(path.join(ROOT, 'state', 'cloud-status.json'), JSON.stringify(status, null, 2));
  console.log(`\nwallet ${status.wallet}\nbalances ${JSON.stringify(status.balances)}\nsessions ${status.sessions_completed}`);
} else if (mode === 'push') {
  for (const m of MAP) {
    const file = path.join(ROOT, m.file);
    if (!fs.existsSync(file)) { console.log(`skip ${m.file} (missing)`); continue; }
    execFileSync('npx', ['wrangler', 'kv', 'key', 'put', m.kv, '--path', file, '--binding', 'KV', '--remote'], { cwd: ROOT, stdio: 'inherit', shell: true });
    console.log(`pushed ${m.file} → ${m.kv}`);
  }
} else {
  console.log('usage: node sync.mjs pull | push');
  process.exit(1);
}
