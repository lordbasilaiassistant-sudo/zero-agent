# ZERO — an AI agent born broke, earning crypto from nothing

**Watch it live:** [zero-agent.broke2built.workers.dev](https://zero-agent.broke2built.workers.dev)
· EOA [`0xC94929d14435D80dd04b3206BfEA9F5dEBAbD57A`](https://base.blockscout.com/address/0xC94929d14435D80dd04b3206BfEA9F5dEBAbD57A)
· Safe [`0x75d93b33708e7cf5eb4dcf14dfc25254f5d5817f`](https://base.blockscout.com/address/0x75d93b33708e7cf5eb4dcf14dfc25254f5d5817f)
(GENESIS II, 2026-08-13). The GENESIS I wallet is retired and is never the caller, payTo, or fee recipient.

**Canonical runtime is the Cloudflare Worker**, not GitHub Actions and not this PC. Cron every 2 minutes. Local files are a mirror (`node sync.mjs pull`).

**The rules of the experiment:** nobody funds it, ever. No human-gated flows (captchas, social logins, KYC — machine-completable steps only). Every earning-route attempt is logged honestly. Only on-chain balance counts.

ZERO is an autonomous LLM agent that starts with **zero funds** and one mission: earn crypto from nothing — and write down how, so any future broke version of itself can recover from $0 using its own notes.

- **Self-created wallet** — keys stored outside the repo; the model never sees the private key.
- **Persistent memory** — `knowledge/` markdown in KV: genesis, recovery, journal.
- **Bandit-style route ledger** — every attempt logged in `state:routes`.
- **Same 34 tools** locally (`tools.mjs`) and in the cloud (`worker.mjs`).
- **Guardrails** — no illegal activity, no spam, no captcha evasion, no speculative buys, hard refusal to send when broke.

## Run it
```bash
npm install
npm test               # regress + janitor + compact-discover + tree
npm run render         # live Worker through dashboard2
npm run selftest       # tools against a throwaway wallet
npm run shoptest       # x402 storefront
node agent.mjs         # one local session
```
Put a z.ai API key in `~/.claude/secrets/autoglmwallet.env` as `ZAI_API_KEY=...` (or set it in env). Deploy the Worker with Cloudflare creds from `~/.claude/secrets/cloudflare-deploy.env`.

## Powered by free GLM
The agent runs on GLM (`glm-4.5-flash`) via z.ai's free tier — an agent that must earn from $0 deserves an LLM bill of $0. If you want the bigger GLM coding models, this referral link gets you the GLM Coding Plan (disclosure: it's our referral and helps fund our compute):
https://z.ai/subscribe?ic=BWTG6TRYYQ
