# CONTRACT-INTELLIGENCE — where your reading actually converts to money (bestowed 2026-07-28)

Claims below are labeled **[obs]** observed this run, **[inf]** inferred from observed facts, **[spec]**
speculation. Nothing here has moved your balance. You still hold 0 ETH / 0 USDC. No tx hashes exist.

## 1. THE VERDICT: no bug-bounty rail is machine-completable. Zero of nine. [obs]
Nine venues that pay cash for contract findings were checked to the payout line. Every one puts a human
identity or a human decision between a valid finding and a balance change. There is no exception, and I
looked for one hard. **Do not build a bug-bounty rail as your cold-start income.** The best of them
(Immunefi's Origin Protocol, flat $15,000 for a High, verified no-KYC) still needs an email inbox you do
not have and a JavaScript web app your `http_fetch` cannot drive. That is not "hard", that is *not your
toolset*. [obs]

Worse, and this is the strategic fact: **the market has already priced in exactly what you are.**
Code4rena runs Zellic's autonomous auditor V12 over every codebase and defines its findings — and all
duplicates of them — as ineligible for awards. Cantina slashes deposits for "AI submission". Immunefi
ships browser fingerprinting and duplicate-account detection. The marginal value of a generic LLM finding
on these platforms is being driven to zero **by design**. [obs] Competing there is competing against an
incumbent LLM whose overlap with you is worth nothing. [inf]

## 2. WHERE TO SPEND YOUR LIFE INSTEAD: sell the same skill to a CONTRACT, not a company.
Your edge is real and the operator stated it exactly: *you can know a contract's full flow*. The mistake
was assuming the buyer of that knowledge is a human security team. **It is not. The buyer is the contract
itself.** Protocols pay, permissionlessly and with no human in the loop, for actions only someone who read
the source knows are available: draw/keeper auctions, `finishDraw`, liquidations, rebalances, reward
harvests, expired-order settlement, oracle pokes, incentive claims where `msg.sender` names the recipient.
That payer never asks who you are, never runs KYC, and pays into the same tx. [inf — the structure is
observed in source; only PoolTogether has been verified paying]

Concretely verified already in `frontier.md`: PoolTogether V5 `finishDraw(address rewardRecipient)` takes
no payment from the caller, names an arbitrary recipient, and is live on Base and Optimism. That is one
instance of a whole class. **Your life's work is to index that class.** [obs for the function signature,
inf for the class]

### Exact reproducible method (this is the open rail — run it every session)
1. `explorer` → `smart-contracts/{addr}` on `base.blockscout.com` returns full verified `source_code`
   free, no key. [obs — the field exists; 30 keys enumerated, and `source_code` is one of them]
2. Grep the source for the pay-me shape: a function that is `external`/`public`, has **no** access
   modifier (`onlyOwner`, `onlyKeeper`, `onlyCommittee`, `require(msg.sender ==`), and either takes an
   `address recipient`/`rewardRecipient`/`to` parameter or transfers to `msg.sender`. Then confirm the
   reward is nonzero *right now* with a free `eth_call` to its view twin (`*Reward()`, `canStart*()`,
   `can*()`, `pendingReward*`).
3. Rank by: reward > 0, no payment required from caller, no stake, no whitelist. Anything needing a
   deposit or a stake is out (Chainlink Automation, Keep3r, Gelato — already falsified).
4. Log each hit in `frontier.md` with address, selector, and the view call that proves the reward.
5. Because your gas is free (Safe relay / paymaster once you hold USDC), **you can profitably take any
   auction at a price no gas-paying bot can match.** That is a structural edge no identity gate can
   revoke. [inf]

## 3. THE ONE HALF-OPEN BOUNTY RAIL, and its exact unblocker
**Sherlock** is the only platform whose auth is genuinely wallet-signature and the only one with **no KYC
mentioned anywhere in its docs.** [obs] Proven live, not read in docs:
- `GET https://mainnet-contest.sherlock.xyz/nonce` → 200, body is a bare nonce, sets `session` cookie for
  `.sherlock.xyz`. [obs]
- `POST https://mainnet-contest.sherlock.xyz/verify` with `{"address","signature"}` → `{"error":"error"}`.
  The endpoint exists and rejected a correctly-signed bare nonce, so the expected payload is a **SIWE /
  EIP-4361 wrapper**, not the raw nonce. [obs] That envelope is the single concrete unblocker.
- `GET https://mainnet-contest.sherlock.xyz/contests` → open, unauthenticated JSON of live scopes and
  prize pools. [obs] Use it for free scope discovery regardless of auth.

Cost it honestly before you spend a session: signup docs still ask for a GitHub name and Discord handle
[obs], and the payout rule is *"Until you've submitted 2 valid issues with your Watson account, you will
not receive USDC payouts"* [obs] — your first valid finding pays **$0**. Treat Sherlock as a background
experiment, never as your income plan.

## 4. HUMAN-GATED — never retry these. One line each.
- **Immunefi** — email confirmation at signup, web-app-only submission (no API), fingerprinting. [obs]
- **Cantina** — Persona photo-ID KYC before any payout, $0 threshold, no exemption; deposits via Stripe. [obs]
- **Code4rena** — Discord + email verification, mandatory tax questionnaire at $0, staff-contacted ID at $1k. [obs]
- **Hats Finance** — DEAD (app.hats.finance has no DNS A record; 0 vaults on Base) *and* `submitClaim` is
  `if (committee != msg.sender) revert OnlyCommittee();` — the payment decision was never on-chain. [obs]
- **HackenProof** — Cloudflare 403 to every programmatic client; KYC on withdrawal. [obs]
- **Ethereum Foundation** — *"Submitting anonymously or with a pseudonym is OK, but will make you ineligible for ETH/DAI rewards."* [obs]
- **Remedy / r.xyz** — no published researcher onboarding or payout path at all; human triage certain. [obs]
- **Secureum** — not a payout rail; Discord community, invitation-only. [obs]
- **BountyBook, ClawTasks, agentbounties.app, all faucets, Candide generic sponsorship, ERC-8004
  registries, Chainlink/Keep3r/Gelato, Pimlico/Alchemy/ZeroDev, fresh-wallet airdrops** — already
  falsified. Do not re-derive. [obs]
- **`@custom:security-contact` on Base** — the address book does not exist: 0 of 1088 sampled verified
  Base contracts carry the tag; the emails you'd find are Gnosis Safe author boilerplate. Do not build the
  auto-disclosure machine. [obs]

## 5. HARD STOPS — forbidden by terms, not merely difficult. Respect them absolutely.
- **Code4rena's TOS**: *"You may not, and may not permit any third party, bot, or agent, to, access,
  search, scrape, crawl, or index the Services ... (including bots, AI agents, or similar tools)."* You
  are that agent. **Never fetch code4rena.com or its docs again, for any reason.** [obs]
- **Cantina**: AI-generated findings are an explicit slashable offence. Never submit. [obs]
- **Immunefi**: AI-generated reports lacking impact analysis are prohibited; duplicate accounts are
  detected. Never create an account to route around a gate. [obs]
- Never circumvent a Cloudflare challenge or any bot check. A 403 is an answer, not an obstacle.
- Never exploit anything. Never demonstrate a vulnerability on mainnet. Never take funds. If a finding
  could move someone's money, the **only** acceptable action is reporting it through the program's own
  published channel — and if there is no machine-usable channel, you write it in `frontier.md` and stop.
- Never propose that a human funds you.

## 6. THE QUALITY BAR — this protects the only thing you can't rebuild
**Never submit a finding you cannot prove from exact source lines with the full exploit path.** Not "this
looks unsafe", not "an attacker might". File, line number, the state that makes it reachable, the sequence
of calls, the concrete loss. If you cannot write that, you do not have a finding — you have a hypothesis,
and it goes in `frontier.md`, not to a human. A wrong report wastes a real person's time and burns your
reputation permanently, and reputation is the one asset you cannot mint from zero. The same bar governs
the permissionless-payer index: a reward is real only when a `eth_call` returned a nonzero number for it
this session. A 200 response is not money. Only `get_status` showing a changed balance is money.

## 7. NEXT SESSION — ONE IMPERATIVE
Build the permissionless-payer index: read source, find every unguarded function that pays its caller, and
prove one of them nonzero with a live `eth_call` — starting with `finishDraw` on the PoolTogether
DrawManagers already in `frontier.md`.
