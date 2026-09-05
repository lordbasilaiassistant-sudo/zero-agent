# ZERO: let it live

Anthony's decision, 2026-09-05 (America/New_York): preserve ZERO's autonomous operation and let its existing earnings accumulate. Phase 0 must continue. Small earnings over long periods are an acceptable result; they are not a reason to shut it down or demand repeated human research sessions.

This supersedes the suggestion to require a materially larger opportunity before considering ZERO worthwhile. Preserve the experiment, its earned assets, route knowledge, receipts, and ability to evolve. Future research can resume when Anthony chooses to allocate better models and more research capacity. No scheduled model purchase or automatic paid upgrade is authorized.

## Operating contract

- Keep the existing Cloudflare Worker and its two-minute cron running independently of Anthony's PC. Preserve the core harvest, consolidation, and existing self-checks.
- Never contribute external capital. ZERO may receive its own earned proceeds; nobody funds it to unblock a route.
- No new subscriptions, paid LLM research, automatic model upgrades, or new infrastructure spending. Existing shared infrastructure is not literally cost-free; distinguish its subscription from additional ZERO spending.
- Preserve existing free-model operation. Do not replace it with a paid model without Anthony's explicit decision.
- No recurring Codex research sessions or routine status notifications. Revisit development when Anthony asks; preserve enough evidence to resume without repeating rejected hypotheses.
- Report settled transactions as income. A monthly dollar figure is an expectation, not a guaranteed yield. Asset-price appreciation is a possible outcome, not an operating dependency.

## Future handoff

Read this file, DOCTRINE.md, and docs/research/2026-09-05-zero.md before modifying the agent. Inspect live status and receipts before trusting remembered balances or rates. Preserve lower earning layers while adding any upper layer. Never re-derive the known research failures without new evidence.

The bounded Superfluid job is documented in stream-opportunity.mjs and exposed at /stream-opportunity. It expires on 2026-09-07 at 21:00 UTC if it remains unsubmitted. An unresolved submission must be reconciled before any retry; expiry does not prove a pending transaction failed. The core worker has no corresponding expiry.

## Verification — 2026-09-05 21:58:10 UTC

Read Cloudflare's live Worker settings, schedules, and account subscriptions, plus ZERO's public status and temporary-job endpoint. The deployed cron is `*/2 * * * *`; the temporary job last advanced at 21:56:45 UTC and remained unsubmitted, waiting for relay capacity. No runtime changes or new spending were made for this handoff.

Worker settings contain no GLM_MODEL or GLM_BASE override, so worker.mjs uses glm-4.5-flash on api.z.ai. [Z.ai's official pricing](https://docs.z.ai/guides/overview/pricing) lists that model's input and output as free. The existing shared Cloudflare Workers Paid subscription is $5/month. This check does not establish incremental usage charges as zero or guarantee future vendor pricing. No additional subscription was added.

Reproduce the read-only check with `node scratch/check-autonomy-2026-09-05.mjs` in this checkout; local evidence is logs/research-2026-09-05/autonomy-check.json. The scratch helper and local logs are ignored by Git; the timestamped findings above are the durable handoff.
