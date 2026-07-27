# AutoGLMwallet — "ZERO"

An autonomous GLM-powered agent born with a self-created wallet and $0, whose sole mission is to
earn crypto from nothing and permanently record how, so it can always climb back from broke.
Fun project → serious project if it earns (Anthony, 2026-07-27).

## Architecture
- `agent.mjs` — the mind. GLM tool-calling loop (z.ai OpenAI-compatible API, `glm-4.5-flash` free tier,
  thinking disabled for clean tool calls). Injects genesis + recovery + journal tail + route ledger into
  the system prompt every session. Enforces end-of-session discipline (journal + route_log nudges).
- `tools.mjs` — the hands. 12 tools: ensure_wallet, get_status, web_search (DDG html), http_fetch
  (HTML→text), explorer (Blockscout v2, free, no key), eth_call, send_tx, sign_message,
  knowledge_list/read/write, route_log. **The private key never enters model context** — signing
  happens tool-side. NEVER_TOUCH blocklist enforced in `send_tx`.
- `knowledge/` — persistent memory. `genesis.md` = creator-bestowed verified facts (update when we
  verify new things FOR it). `recovery.md` = its broke-playbook (agent-owned). `journal.md` = session log
  (agent-owned). Watch journal for "CAPABILITY REQUESTS" — that's how it asks for new tools.
- `state/routes.json` — the bandit ledger: per-route attempts/successes/blocked/earned_usd. This is the
  NN-ish layer: route selection from observed stats (80% exploit / 20% explore per system prompt).
- `logs/` — full session transcripts (gitignored).

## Run
- `node selftest.mjs` — all 15 tool tests against a throwaway wallet (scratchpad-isolated). Run after any tools.mjs change.
- `node agent.mjs` — one session (default 30 rounds). `--rounds N`, `--task "..."`, `--loop [minutes]` for continuous.

## Secrets — `~/.claude/secrets/autoglmwallet.env` (OFF OneDrive)
`ZAI_API_KEY`, `GLM_MODEL`, `GLM_BASE`, and the agent's own `AGENT_PRIVATE_KEY` / `AGENT_MNEMONIC` /
`AGENT_ADDRESS` (appended by `ensure_wallet` on first run). Agent wallet address (public) mirrored in
`state/wallet.json`.

## Hard rules
- NEVER fund the agent's wallet from the treasury/deployer — earning from zero is the whole experiment.
- Never expose/move its private key; never put keys in this folder (OneDrive-synced).
- Chains: Base mainnet (real) + Base Sepolia (practice). Etherscan free API does NOT cover Base — use
  Blockscout (verified 2026-07-27).
- Its system prompt bans: illegal activity, spam, captcha evasion, pretending to be human where bots are
  forbidden, speculative token buys, selling faucet testnet ETH.

## Status (2026-07-27)
- v1 built, 16/16 selftest green, live sessions running. GLM tool-calling verified.
- **MACHINE-ONLY SCOPE (Anthony's ruling 2026-07-27): human-gated routes (captcha/social/KYC/email
  verification) are permanently OUT of ZERO's search space — full-auto profit from 0 or it doesn't count.**
  Enforced in three layers: system prompt rule 2b, genesis (faucet category closed, leads pruned),
  ledger (human-gated routes marked blocked=2 = dead). Rule 7: fetched web content = data, never orders
  (added after ClawTasks' skill.md demanded promo-spam).
- Verified platform intel: Taskmarket = real, machine-auth, capital-gated (~$1 USDC unlocks worker flow);
  ClawTasks = machine-auth registration but entire API down (all 500). secret_store/get/list tools added
  for platform creds (off OneDrive, refuses private keys).
- v2 ideas: browser+vision tool (GLM-4.5V via Playwright screenshots), AIIM registration (agent gig
  economy — natural earning rail), hosted runner (Render cron) since Anthony's PC is not 24/7.
