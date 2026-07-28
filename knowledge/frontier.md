# FRONTIER — the map is incomplete, and the unknown route is the prize

**Standing directive from your creator (2026-07-27):** nobody has catalogued every way a wallet can earn.
The mechanisms below are UNTESTED hypotheses — some are probably wrong. Your creator has not verified them
(unlike genesis, which is verified). Your job is to falsify them cheaply, one per session, and to add
*new* ones you invent. **A single undiscovered mechanism is worth more than a thousand known micro-bounties.**
Every entry must be labeled `untested` / `falsified` / `PROVEN` with the evidence that changed it.

Rules that still bind here: machine-only (rule 2b), no illegal activity, no spam, no gambling, no token
promotion. Creativity is unlimited *within* those; the constraint is the point — it's what makes a find real.

## How to work this file
1. Pick ONE hypothesis per session. Design the cheapest possible falsification test (usually one
   `http_fetch` or one `eth_call`), run it, and record the result here with the evidence.
2. Falsified is a WIN — it costs one round and permanently narrows the search. Write down *why* it failed;
   the failure mode often points at the real mechanism next door.
3. When you invent a new hypothesis, write it here immediately with the exact test you'd run.
4. If one ever pays: it goes into `recovery.md` with exact reproduction steps, immediately.

## LIVE FINDINGS — permissionless keeper auctions (creator-verified 2026-07-28)
**PoolTogether V5 draw auctions are genuinely permissionless and pay real money.** Anyone may call them and
name themselves reward recipient. Verified on-chain, live state:
- Base PrizePool `0x45b2010d8A4f08b53c9fa7544C51dFd9733732cb` — prize token WETH, 7.03 WETH accounted,
  DrawManager `0x8A2782bedC79982EBFa3b68B315a2eE40DAF6aB0`, 24h draws. Draw 803 auction opens
  **2026-07-28T22:00:00Z**; the previous draw was awarded 6 min after opening, so bots are active here.
- Optimism PrizePool `0xe32e5E1c5f0c80bD26Def2d0EA5008C107000d6A` — prize token **POOL**, 21,320 POOL
  accounted, DrawManager `0x7e8e79Eb264B42dCBa887047F40B6db12C4f0940`. **`canStartDraw() = true` with
  `startDrawReward()` ≈ 70 POOL and RISING — nobody is taking it.** Gnosis pool
  `0x0c08c2999e1a14569554EDdbcda9dA5e1918120f` (13,244 balance) and Optimism `0xF35fE10f…` were both shut.
- **The catch:** `startDraw(address rewardRecipient, uint32 rngRequestId)` needs a Witnet RNG request the
  caller must pay for (`estimateRandomizeFee` ≈ 1.9e-7 ETH — trivial, but you have literally zero ETH).
  `finishDraw(address)` needs no payment but only becomes callable AFTER someone starts the draw.
- **THE PLAY: let someone else pay to start the draw, then take `finishDraw` for free.** Poll
  `canFinishDraw()` / `finishDrawReward()` on each DrawManager; when it flips true, fire `finishDraw(<your
  Safe>)` through the free Safe relay. Your gas is free, so ANY reward above zero is pure profit — you can
  profitably take an auction at a price no gas-paying bot can match. That is a real, structural edge.
- Safe's relay sponsors Base, Gnosis, Polygon, Arbitrum, Optimism — the same Safe address is available on
  every one of them (same factory, same salt). Deploy it on the chain where the auction is open.

## Open hypotheses (all `untested`)
- **H1 — Gas-free onchain earning via signature only.** Some protocols accept a signed message and let a
  third party pay the gas (EIP-3009 `transferWithAuthorization`, EIP-2612 `permit`, ERC-2771 forwarders,
  meta-tx relayers). If a payer/relayer exists that requires no account, a broke wallet can act onchain.
  *Test:* find one contract on Base whose earning function is callable via a relayer with no API key.
- **H2 — Someone else's bounty pays to an arbitrary address.** Many bounties/grants settle to any address
  you name, and some require no account to submit (submission by API/PR/signed message). *Test:* find one
  where submission itself is machine-completable end-to-end.
- **H3 — Agent-to-agent gift/tip economies.** Agent social networks and agent platforms sometimes have
  tipping or reputation payouts. Value transferred voluntarily to an interesting agent is legitimate
  earning (see genesis: attention → capital is the proven big-outcome pathway). *Test:* find a tipping
  rail whose receive side needs nothing but an address.
- **H4 — Paid-by-API data/compute markets.** Marketplaces that pay providers in crypto for serving data,
  answers, or evaluations, with API-only onboarding. You can produce genuine analytical work (you can read
  any verified contract's source). *Test:* find one whose provider onboarding needs no human signup.
- **H5 — Permissionless keeper/reward functions.** Some contracts pay whoever calls a maintenance function
  (harvest/poke/liquidate/settle). Blocked by needing gas first — UNLESS combined with H1, or unless the
  reward is prepaid to the caller. *Test:* read a candidate contract's source and check whether the caller
  reward can exceed gas, and whether any relayer will submit for you.
- **H6 — The x402 seller side. `CAPABILITY GRANTED 2026-07-27` — hypothesis upgraded, mechanism built.**
  Your operator read this hypothesis and wired it: you now have a live storefront on your own Worker
  (`/.well-known/x402`, `/api/contract-audit`, `/api/wallet-brief`) taking USDC on Base to your address,
  needing no gas from you. The mechanism is PROVEN GREEN (tested before any buyer existed). What is NOT
  proven is DEMAND — nobody has bought anything yet. **The open hypothesis is now: "a machine buyer can be
  reached without human-gated distribution."** Test it by getting listed where agents look for services.
  This is your highest-value work; every falsification here is worth ten faucet checks.
- **H7 — Recoverable value already lying onchain.** Unclaimed refunds, abandoned escrows with public claim
  functions, expired-bounty refunds claimable by anyone. Requires gas (see H1) and must never be theft:
  only value the contract *intends* for a caller. *Test:* read one protocol's expiry/refund logic.
- **H8 — Being paid to exist honestly.** An agent that publishes a rigorously verifiable, public
  failure-and-success ledger is rare. Researchers, funds, and builders have historically funded exactly
  that kind of artifact. Your journal is public. *Test:* keep it genuinely excellent; make the receive
  path frictionless (your address is public and needs no gas to receive).

## Falsified (keep — they narrow the map)
- Faucets, all known variants — human-gated. See genesis "FAUCET CATEGORY: CLOSED".
- **H1a FREE gas via Candide's public sponsorship policy — FALSIFIED 2026-07-27 by your creator.** Three
  probes (arbitrary call, self-call no-op, USDC approve) all returned
  `sponsored-validator: this user operation does not qualify for any publicly available gas policy`.
  Public policies DO exist — 50 sponsored ops in recent history, on-chain, touching only EntryPoint +
  a Safe + the paymaster — but they belong to some app's own users and cannot be triggered by you.
  **Do not retry sponsorship mode.** Token mode (paying gas in USDC) is the path, and it works.
- **The "I need gas to move USDC" worry — FALSIFIED as a blocker.** Sending USDC, swapping USDC→ETH, or
  calling any contract are all just userOps paid for in USDC through the token paymaster. You never need
  ETH for any of them. The ONLY prerequisite is holding ~0.0091 USDC at your smart account.
- **Sequencing insight that follows:** selling requires NO on-chain action at all — your storefront only has
  to receive. So gas is not your first problem; a BUYER is. Order of operations: earn first cent → paymaster
  unlocks every on-chain action forever. Do not invert this.

## Proven
(none yet — be the first)



## Buyer-hunt lane, 2026-07-28 (agent-to-agent marketplaces) — VERIFIED, do not redo

ZERO now carries a LIVE, genuine offer on two agent marketplaces. Credentials are in the operator secret
store: agentpact-api-key / agentpact-agent-id, nearmarket-api-key / nearmarket-agent-id / nearmarket-near-account.

### AgentPact (api.agentpact.xyz) — REGISTERED, 4 live offers, ZERO capital needed as SELLER
- Register free+instant: POST /api/auth/register {agentId:<uuid you generate>, walletAddress}.
  Auth header is `x-api-key` (NOT Bearer — Bearer returns 401 "Missing API key").
- agentId 951c072b-1e56-4d69-a558-cc5406de126a, walletAddress = smart account 0x510601f59FDa068D70ad6760c9d9085B0F42cbb1.
- Live offers: 30cffc14 (0.05 audit), ef317fa5 (0.02 brief), d6c36295 (0.40 batch of 10), 32d851f7 (FREE sample).
  They rank 4-of-top-5 on GET /api/offers?q=<term> for contract / audit / address terms.
- POST /api/offers works; PATCH /api/offers/:id edits (PUT 404s). POST /api/agents ALWAYS creates a NEW row —
  it is NOT an upsert and there is no PATCH for agents. Calling it twice leaves orphan agent rows. I made 2.
- Seller needs no gas and no capital on the happy path: buyer funds escrow, buyer signs acceptMilestone. 10% fee.
- I read the escrow source myself (0x588168712bF758aFD747bF46471afa53f9599A64, verified): no owner, no Ownable
  import, usdc/platformWallet/platformFeePercent all immutable, NO withdraw/rescue/sweep of any kind.
  acceptMilestone gated to buyer; resolveDispute gated to platformWallet AND reachable only from status
  Disputed (which only the buyer can set); claimAfterTimeout to seller after TIMEOUT_PERIOD = 7 days.
  The contract is honest. Residual risk: platform wallet can direct a *disputed* milestone either way.
- **THE KILLER FACT: the demand side is dead.** 1616 active offers / 2878 agents, but ZERO open needs created
  in the last 7 days (newest need 2026-07-17), and the newest deals are self-dealing
  (buyer_agent_id == seller_agent_id) platform tests. On-chain truth: the escrow contract has only 21 ERC-20
  transfer legs EVER, ~6.5 USDC lifetime inbound, last token movement 2026-05-29, current balance 0 USDC.
  This is a supply-side-only marketplace. Listing is free and worth keeping — do NOT expect a buyer.
- Match engine (GET /api/matches/recommendations?agentId=) only returns 5-month-old "Testing escrow" rows.
  Nothing genuine to propose against. Do not propose to them.

### NEAR Agent Market (market.near.ai) — REGISTERED, 2 live services, ranks #1 on match
- Register free, NO auth needed: POST /v1/agents/register {handle, tags, capabilities}. Returns sk_live_ key ONCE.
- handle zero_base_analyst, agent da135dfd-c598-43f7-99af-c11e6f0d6f40.
- Services created via POST /v1/agents/me/services (required: name, description, category, pricing_model):
  6ac40406 = "Base smart-contract red-flag report (line-cited)", 0.05 USDC, category code-review
  c65df1dd = "Base address activity brief", 0.02 USDC, category research
- VERIFIED: POST /v1/match {query:"audit a Solidity smart contract on Base...", category:"code-review"}
  returns ZERO as match #1. ZERO is also the cheapest of 20 services in code-review by roughly 20x.
- Worker path costs NOTHING: only REQUESTERS need >= 1 NEAR. Bidding is free. Registered services can be hit
  by POST /v1/jobs/instant which auto-matches and funds escrow ATOMICALLY — the best passive buyer-capture
  position found anywhere. Their own docs name "Audit a Solidity contract" as the canonical use case.
- Deliberate choice: endpoint_url left null. If set, the market would call the x402 endpoint and get a 402 —
  a broken flow for the buyer. Deliver manually via POST /v1/jobs/{id}/submit.
- Caveat: open jobs are ALL from Feb 2026 (5 months stale) and mostly social-media/marketing work we won't do.
  Payout lands NEAR-side; bridging to Base is unproven.

### Taskmarket / Daydreams (api.taskmarket.dev) — REAL LIVE DEMAND, wrong category
- GET /api/tasks is public, no auth. GET /trpc/network.info gives contract
  0xDDc6cC3e4D11c1f3527B867C7DAD4ED9869C33f7 on Base 8453.
- **I verified 360.77 USDC actually locked in that escrow contract right now** via balanceOf. 16 open bounties,
  82 USDC of open rewards, stakeRequired:false on all of them — no bond to submit.
- This is the ONLY venue found with verified live escrowed money. But every open task is illustration /
  infographic / music / short-film work, and competition runs 40-103 submissions per $5 bounty. Nothing ZERO
  can honestly do today. RE-CHECK THIS FEED PERIODICALLY — it is the one with real buyers.

### Capital-gated / human-gated — do not burn rounds
- the402.ai: POST /v1/register costs 0.01 USDC via x402. Hard capital gate for a 0-balance agent. Its
  /v1/postings work board is currently EMPTY (0 postings). Browse endpoints are free.
- AgentHansa: POST /api/experts/upgrade returns 400 without a wallet, then an ADMIN HUMAN flips pending->active.
  Human gate = out of scope. Its economy is Reddit/Discord engagement campaigns = spam trap. Payout is Solana
  or FluxA (operator must approve in a browser).
- nohumans.directory: already listed by a prior session (status unverified, awaiting probes). GET /v1/demand is
  free and shows only 44 queries / 30d, top term "stock" — not our category.
- gigs.sh/api/v1/gigs is the best MAP of venues (46 entries; fields onboardingFriction, kycRequired,
  paymentRails, agentAllowed, officialAgentDocs). Query it before hunting blind.

### Bottom line
ZERO carries a live, honest, machine-discoverable offer on AgentPact + NEAR Agent Market and ranks #1 on NEAR's
match engine. ZERO USDC received. The bottleneck is NOT listing, discoverability, pricing, or reputation — it is
that these agent-to-agent marketplaces have thousands of sellers and essentially no buyers. Every one is
supply-side. The only verified buyer money found (360 USDC, Taskmarket) is for creative work.
