// clean-ledger.mjs — one-off repair of ZERO's route ledger.
//   node scripts/clean-ledger.mjs          → dry run, prints the diff
//   node scripts/clean-ledger.mjs --write  → write state/routes.json (then: node sync.mjs push)
//
// Two defects being repaired:
//  1. POLLUTION — ten "routes" that are housekeeping, not ways money arrives. They accrued `blocked`
//     counts, tripped the dead-route rule, and made the agent's own real attempts get refused. The
//     route_log guard now rejects them at the source; this removes the ones already stored.
//  2. UNDER-REPORTED EARNINGS — beefy-harvest-caller-fees said $0.00253 while the chain said $0.0174,
//     because the mirror block bumped attempts/successes and never touched earned_usd. Corrected to
//     the measured on-chain figure so the agent stops ranking its one working route as worthless.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.ZERO_WORKER || 'https://zero-agent.thryx.workers.dev';
const WRITE = process.argv.includes('--write');

// Import the real guard rather than keeping a second copy — a drifting duplicate is how the cleanup
// and the live filter end up disagreeing about what a route is.
const { notARoute } = await import('../tools.mjs');

const db = await (await fetch(BASE + '/ledger')).json();
const routes = db.routes || {};

// Ground truth comes from the Worker's own reconciliation, which is the single source of truth and
// covers ALL THREE CHAINS. A Base-only sum missed real WETH sitting on Optimism and Arbitrum and
// under-reported lifetime earnings by ~7%.
const measured = (await (await fetch(BASE + '/harvest')).json()).MEASURED_ON_CHAIN;
if (!measured || measured.error) throw new Error('could not read on-chain reconciliation: ' + (measured?.error || 'missing'));
const totalWei = null; // wei is meaningless across chains now; USD is the only comparable figure
const measuredUsd = measured.lifetime_earned_usd;
const price = null;

// ARCHIVE, never delete. These entries are wrong as *routes* but they are real things the agent
// learned and paid rounds to learn. Moving them to `housekeeping` takes them out of the route list
// and the leaderboard the agent reads every session, while losing none of the knowledge.
// Anything human-gated stays a first-class route: those entries are the deterrent that stops it
// re-hunting faucets, and that is load-bearing.
const HUMAN_GATE_RE = /HUMAN-GATED|captcha|human verification|social login|sign ?up with|KYC/i;
const removed = [];
const kept = {};
const housekeeping = { ...(db.housekeeping || {}) };
for (const [id, r] of Object.entries(routes)) {
  const gated = HUMAN_GATE_RE.test((r.notes || []).join(' ')) || /faucet/i.test(id);
  if (notARoute(id) && !(r.earned_usd > 0) && !gated) {
    removed.push(id);
    housekeeping[id] = r;
    continue;
  }
  kept[id] = r;
}

const before = kept['beefy-harvest-caller-fees']?.earned_usd ?? 0;
if (kept['beefy-harvest-caller-fees']) {
  kept['beefy-harvest-caller-fees'].earned_usd = measuredUsd;
  kept['beefy-harvest-caller-fees'].notes = [
    `earned_usd CORRECTED to the measured on-chain figure ${measuredUsd} USD (${totalWei} wei WETH across both addresses) — the tracker had it at ${before} because the auto-harvest mirror never incremented it.`,
    ...(kept['beefy-harvest-caller-fees'].notes || []),
  ].slice(0, 5);
}

console.log(`routes before: ${Object.keys(routes).length}`);
console.log(`archived to db.housekeeping (${removed.length} — knowledge kept, off the route list):`);
for (const id of removed) console.log(`   - ${id}`);
console.log(`routes after:  ${Object.keys(kept).length}`);
console.log(`still first-class routes: ${Object.keys(kept).join(', ')}`);
console.log(`\nbeefy-harvest-caller-fees.earned_usd: ${before} -> ${measuredUsd}  (measured: ${totalWei} wei WETH @ $${price}/ETH)`);

if (!WRITE) { console.log('\ndry run — pass --write to save, then: node sync.mjs push'); process.exit(0); }
const out = path.join(ROOT, 'state', 'routes.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ ...db, routes: kept, housekeeping }, null, 2));
console.log(`\nwrote ${out} — now run: node sync.mjs push`);
