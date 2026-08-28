# DEPLOY STATE — read before `wrangler deploy`

**Last updated 2026-08-28.**

## What is live

Version **`3a62aedd-6528-44f9-82a5-8e27304a4e14`**: `value-priced-at-zero` no longer
fires when Blockscout's Base price read fails (usdContribution stays `null`, not `0`).
Published per-chain rows are stored so the audit can check what `/` served.

Prior **`b4eb562c-2bbb-4c76-8197-b70e5ec65787`**: cached `/` revives spendable
from chainstate when reconcile missed Base (measured lie: spendable `$0` while
`?fresh=1` showed `~$0.61`). Also revives health clocks and usable capacity (no
RPC). Cron patches `cache:status` from KV when the lease drops. A 0-round GLM
slice does not stamp `lastSliceAt`. ETA text is omitted unless a measured cycle
exists.

Prior **`ac904086`**: clock/capacity revive; spendable `$0` from an unread Base
row still shipped.
Prior **`8a643811`**: first revive deploy; headline still said `cycle nullh`.
Prior **`0c8f4a10`**: leased sparse GLM tick is replayed on the next non-hygiene tick.
Prior **`ffc741b2`**: missing `chainWork` is not usable capacity.
Prior **`bce62ac5`**: dashboard names in-flight GLM session.
Prior **`0a84944e`**: session stale from `lastSliceAt` (90 min).

Rollback: `wrangler rollback 8521415e-0608-434d-a3ee-6f5913654fd1`

Measured 2026-08-28 after `3a62aedd`:
- Cached `/`: health **CYCLING**, usable **0**, spendable **~$0.615**
- `/invariants` **clean** (all 10 hold) after the priced-at-zero false-positive fix
- `regress` 95/0, `shoptest` 14/14, tree ok

## Required for a clean-clone deploy

- `janitor.mjs` — imported by `worker.mjs`
- `test-janitor.mjs`, `scripts/check-tree.mjs`, `scripts/compact-discover.mjs`,
  `scripts/probe-relay.mjs`, `scripts/run-janitor-once.mjs`, `scripts/deploy-fleet.mjs`

Live-spend scripts refuse unless passed `--spend`. `npm test` runs regress + janitor
+ compact-discover + tree. `npm run render` hits the live Worker through dashboard2.

Gitignored: `scripts/*-result.json`, `state/cloud-status.json`, stream caches,
root `_*.mjs`, `scratch/`, `.render/`.
