# DEPLOY STATE — read before `wrangler deploy`

**Last updated 2026-08-23.**

## ⛔ `main` IS NOT DEPLOYABLE RIGHT NOW

Deploying `main@ef5e841` puts every cron into **`exceededMemory`** and stops the agent
dead. It did exactly that on 2026-08-23 from 04:20 to 05:00 UTC — session 933 never
started, ~40 minutes of the agent's life lost.

An over-memory invocation is **killed, not thrown**, so it produces *no exception* in the
logs. It looks like silence, not like failure. Check `wrangler tail --status error` and
look at `outcome`, not at `exceptions`.

## What is actually live

Branch **`deployed/ledger-fix`** (`f9aa306`) = last-known-good tree (`bab0c51`) + one
import line. Version `353e5d95-ff7e-4a31-8236-abf1c877cfd1`.

Known-good rollback target if anything goes wrong:
`wrangler rollback 8521415e-0608-434d-a3ee-6f5913654fd1`

## Why main breaks

`main` carries ~8 days of previously-undeployed drift (swept into `ef5e841`). Root cause,
MEASURED with `wrangler kv key get`:

- **`discover:state` is 4.0 MB** (6,639 candidates).
- `prospectTick` and `discoveryPass` parse it in **concurrent `waitUntil` blocks** on a
  **128 MB** isolate. A 4 MB JSON becomes a much larger object graph, and each holder keeps
  its own copy plus the string it stringifies back.
- The drift added a **third** concurrent copy (prospect.mjs's D6 re-read-and-merge fix).

Serializing prospect + discovery **was tried and was NOT enough** (2 `exceededMemory` in
7 min). Rolled back. So the drift contains more than one contributor, or the blob alone is
already too close to the ceiling.

## Two open items

1. **Bisect the drift**, then re-land the dashboard honesty work (it is written and
   committed on `main`, verified against live payloads, but rides on the broken drift).
   Bisect by deploying candidate subsets from a worktree and watching
   `wrangler tail --status error` for ~8 min each; roll back between tests.
2. **`discover:state` needs pruning or splitting.** 4.0 MB parsed every 2 minutes is not
   stable at *any* concurrency — serializing only buys headroom, it does not remove the
   ceiling. It grows without bound; it will break again on its own.

## The bug this branch fixes

`route_log` threw `ReferenceError: mutateKV is not defined` on every call — `worker.mjs`
used `mutateKV` and never imported it. The route ledger recorded **nothing** from
2026-08-12T18:16Z until 2026-08-23T05:52Z. ~200 sessions each called `route_log` 2–3× and
lost every conclusion. Verified fixed: session 934 `routes_logged:true`, ledger 527 → 528.
