// sync.mjs — cloud KV is ZERO's canonical memory; local files are a mirror.
//   node sync.mjs pull            → copy the agent's live cloud memory into local files (no creds)
//   node sync.mjs pull genesis    → pull just one
//   node sync.mjs push genesis    → overwrite ONE cloud key from its local file (needs CF creds)
//   node sync.mjs push --all      → overwrite EVERY cloud key. Almost never what you want.
//   node sync.mjs diff            → show which local mirrors differ from live, and by how much
// Pull before reading its journal locally; push only when YOU deliberately edit its knowledge.
//
// ⚠️ WHY `push` NOW DEMANDS A TARGET (changed 2026-08-12, before it bit us).
// `push` used to loop over every mapped file unconditionally. The local mirrors go stale the moment
// the agent writes anything — and the agent writes to journal.md continuously, from the cloud. So a
// bare `push`, run to publish a one-line edit to genesis.md, would ALSO have shipped a 9-day-old
// journal.md straight over the live one and deleted nine days of the agent's memory. Its journal
// feeds its own prompt, so that is not just data loss, it is amnesia with a plausible-looking file
// left behind. A destructive all-keys overwrite must be typed on purpose, never reached by default.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.ZERO_WORKER || 'https://zero-agent.broke2built.workers.dev';
// frontier and phases were missing here, so `push` silently skipped them: the file holding every
// untested hypothesis could be edited locally and never reach the agent. That is how a falsified
// mechanism stayed in its head.
const MAP = [
  { kv: 'knowledge:genesis', file: 'knowledge/genesis.md', endpoint: '/genesis' },
  { kv: 'knowledge:recovery', file: 'knowledge/recovery.md', endpoint: '/recovery' },
  { kv: 'knowledge:journal', file: 'knowledge/journal.md', endpoint: '/journal' },
  { kv: 'knowledge:frontier', file: 'knowledge/frontier.md', endpoint: '/frontier' },
  { kv: 'knowledge:phases', file: 'knowledge/phases.md', endpoint: '/phases' },
  { kv: 'knowledge:method', file: 'knowledge/method.md', endpoint: '/method' },
  { kv: 'knowledge:toolcraft', file: 'knowledge/toolcraft.md', endpoint: '/toolcraft' },
  { kv: 'state:routes', file: 'state/routes.json', endpoint: '/ledger' },
];

const mode = process.argv[2];
const target = process.argv[3];

// "genesis" | "knowledge/genesis.md" | "knowledge:genesis" all select the same entry.
const select = (t) => {
  if (!t || t === '--all') return MAP;
  const hit = MAP.filter(m => m.kv === t || m.file === t || m.endpoint === '/' + t || m.kv.split(':')[1] === t || path.basename(m.file, '.md') === t);
  if (!hit.length) {
    console.error(`no such knowledge target: ${t}\navailable: ${MAP.map(m => m.kv.split(':')[1] || m.kv).join(', ')}`);
    process.exit(1);
  }
  return hit;
};

if (mode === 'diff') {
  let drifted = 0;
  for (const m of MAP) {
    const file = path.join(ROOT, m.file);
    const local = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const live = await (await fetch(BASE + m.endpoint)).text();
    if (local === null) { console.log(`${m.file.padEnd(26)} LOCAL MISSING (live ${live.length}b)`); continue; }
    const same = local.replace(/\r\n/g, '\n') === live.replace(/\r\n/g, '\n');
    if (same) { console.log(`${m.file.padEnd(26)} in sync (${live.length}b)`); continue; }
    drifted++;
    console.log(`${m.file.padEnd(26)} DIFFERS  local ${local.length}b vs live ${live.length}b  (${local.length > live.length ? '+' : ''}${local.length - live.length})`);
  }
  console.log(drifted ? `\n${drifted} mirror(s) differ from live. Pushing one does NOT push the others — name the target.`
                      : '\neverything in sync');
  process.exit(0);
}

if (mode === 'pull') {
  for (const m of select(target)) {
    const res = await fetch(BASE + m.endpoint);
    const text = await res.text();
    const dest = path.join(ROOT, m.file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    console.log(`pulled ${m.endpoint} → ${m.file} (${text.length} bytes)`);
  }
  if (!target) {
    const status = await (await fetch(BASE + '/')).json();
    fs.writeFileSync(path.join(ROOT, 'state', 'cloud-status.json'), JSON.stringify(status, null, 2));
    console.log(`\nwallet ${status.wallet}\nspendable (native ETH, base EOA) $${status.balances?.spendable_liquid_native_eth_on_base_usd ?? '?'}\ntotal holdings $${status.balances?.total_holdings_usd ?? '?'}\nsessions ${status.sessions_completed}`);
  }
} else if (mode === 'push') {
  if (!target) {
    console.error(`REFUSED: "push" with no target would overwrite EVERY cloud key from local mirrors,
including knowledge:journal — which the agent writes to from the cloud continuously, so the local
copy is stale by definition. That silently deletes its memory, and its journal feeds its own prompt.

  node sync.mjs diff              see what actually differs first
  node sync.mjs push genesis      push exactly one
  node sync.mjs push --all        yes, really overwrite everything`);
    process.exit(1);
  }
  for (const m of select(target)) {
    const file = path.join(ROOT, m.file);
    if (!fs.existsSync(file)) { console.log(`skip ${m.file} (missing)`); continue; }
    execFileSync('npx', ['wrangler', 'kv', 'key', 'put', m.kv, '--path', file, '--binding', 'KV', '--remote'], { cwd: ROOT, stdio: 'inherit', shell: true });
    console.log(`pushed ${m.file} → ${m.kv}`);
  }
} else {
  console.log('usage: node sync.mjs pull [target] | push <target|--all> | diff');
  process.exit(1);
}
