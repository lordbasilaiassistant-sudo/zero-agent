# ZERO — an AI agent born broke, earning crypto from nothing

**Watch it live:** wallet [`0x50624F7790732f9767180871D03A304756200dB9`](https://base.blockscout.com/address/0x50624F7790732f9767180871D03A304756200dB9)
· [its journal](knowledge/journal.md) · [its route ledger](state/routes.json) · [the knowledge it was born with](knowledge/genesis.md)
· sessions run automatically every 30 min via GitHub Actions and commit its memory back to this repo.

**The rules of the experiment:** nobody funds it, ever. No human-gated flows (captchas, social logins,
KYC are out of scope — machine-completable steps only). Every earning-route attempt is logged honestly
in its ledger. The day it earns its first cent of USDC on Base mainnet, you'll see it in the wallet
above — only onchain balance counts.

ZERO is an autonomous LLM agent that creates its own Ethereum wallet on first boot, starts with
**zero funds, zero history, and zero human identity**, and has one mission: earn crypto from
nothing — and write down how, so any future broke version of itself can recover from $0 using its
own notes.

- **Self-created wallet** — keys generated tool-side on first run and stored outside the repo; the
  model literally never sees its own private key. Signing tools sign on its behalf.
- **Persistent memory** — `knowledge/` markdown files injected into every session: bestowed verified
  facts (`genesis.md`), its self-maintained broke-recovery playbook (`recovery.md`), and a journal.
- **Bandit-style route ledger** — every earning-route attempt is logged (`success/fail/blocked/pending`
  + USD earned) in `state/routes.json`; route selection is driven by observed stats, not vibes.
- **12 tools** — wallet status, web search, HTTP fetch, Blockscout explorer (free contract source
  reading on Base), raw `eth_call`, transaction sending, message signing, and memory ops.
- **Guardrails** — no illegal activity, no spam, no captcha evasion, no speculative buys, an
  operator blocklist, and hard refusal to send when broke.

## Run it
```bash
npm install
node selftest.mjs        # 15 tool tests against a throwaway wallet
node agent.mjs           # one session
node agent.mjs --loop 15 # continuous: one session every 15 min
```
Put a z.ai API key in `~/.claude/secrets/autoglmwallet.env` as `ZAI_API_KEY=...` (or set it in env).

## Powered by free GLM
The agent runs on GLM (`glm-4.5-flash`) via z.ai's free tier — an agent that must earn from $0
deserves an LLM bill of $0. If you want the bigger GLM coding models, this referral link gets you
the GLM Coding Plan (disclosure: it's our referral and helps fund our compute):
https://z.ai/subscribe?ic=BWTG6TRYYQ
