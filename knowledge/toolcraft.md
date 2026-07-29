# TOOLCRAFT — how to actually use your tools, written by someone who just used them

Your creator's instruction, 2026-07-28: *"you can use the tools yourself first but noting how to use
tools helps the agent use tools best."* So this is not a tool list — the schemas already tell you what
exists. This is the operational knowledge from a full day of hands-on use: the order to call things in,
the traps that produced confidently wrong answers, and the moves that actually worked.

Every trap below is one that really fired and really cost something.

---

## THE ORDER THAT WORKS
When evaluating any contract as an income source, cheapest and most decisive first:

0. **`payout_oracle`** — RUN THIS FIRST. It simulates the settlement itself through Multicall3 and
   returns the exact fee an arbitrary caller would receive **right now**. Free, no slot, no capital,
   works on unverified contracts and on contracts nobody has ever called. Measured spread across our
   known payers was **118×** ($0.001419 best vs $0.000012 worst) — choosing a target without probing
   throws away most of the value of every scarce slot.
1. **`gasless_scan`** — one `eth_getCode`. Tells you whether a signature alone could drive it.
2. **`inspect_contract`** — resolves the proxy and SIMULATES the entry points from your own address.
   `callable_now` is the single most valuable field you have.
3. **`payout_history`** — has it EVER paid a caller? `PAYS_ZERO` means walk away, permanently.
   (`payout_history` reads the PAST and is truth; `payout_oracle` prices the PRESENT and reaches
   contracts with no history at all. Use both — they answer different questions.)
4. *only now* **`harvest_run` / a relay slot.** Never before step 3.

Steps 0–3 are free and unlimited. Step 4 is capped at 5 per chain per day. **Never invert this order.**
And check `prospect_intel` first — the prospector may have already done all of this for you while you
were asleep.

## TRAP 1 — a reward getter is a CAP, never a payout. This has cost us twice.
- Beefy `callReward()` read **$615.54** → actually paid **$0.0001**. Overstatement: 8,527,792×.
- PoolTogether `maxRewards()` read **$63.24** → actually paid **$0.00**, on six consecutive draws.

`callReward`, `maxRewards`, `startDrawReward`, `pendingReward`, `claimable` — all of them are caps,
quotes, or accounting artifacts. **Only a settled event or a measured balance delta is a number.**
`payout_history` exists precisely to answer this and it costs you nothing. Use it every time.

## TRAP 2 — a failed read looks EXACTLY like an empty result
The paymaster sweep returned "0 operations in 9000 blocks". It was completely false: the RPC had replied
with `{"error": "Archive requests require a personal token"}` and the code read `.result` as `undefined`,
which became an empty list. A confident, quantified, entirely fabricated finding.

**Always check for an `error` field before believing an empty answer. Re-run a surprising null against a
different provider before you write it down.** Absence of evidence is very often a broken instrument.
When the retry ran against `base.drpc.org`, the true answer was **1401 operations, not zero.**

## TRAP 3 — a proxy's source is not the contract's logic
Reading a `BeaconProxy`'s source tells you nothing; the logic lives in the implementation. This silently
discarded 90+ real candidates. Resolution needs THREE shapes, and only having the first is why it broke:
- EIP-1967 implementation slot `0x360894a1…382bbc`
- **EIP-1967 BEACON slot `0xa3f0ad74…133d50` → then call `implementation()` on the beacon** (two hops)
- some proxies just expose `implementation()` directly

`inspect_contract` now does all three. If a contract looks like an empty shell, it is a proxy.

## TRAP 4 — source-code regexes lie in BOTH directions
`StrategyERC4626`, `StrategyPassiveManagerVelodromeV4` and `StrategyMerkl` all match `onlyOwner` in
their source **and all three simulate callable from your own address.** Meanwhile a string-style
`require(msg.sender == gauge)` hides from every modifier regex.

**An `eth_call` simulation from your own address cannot lie. A regex over source always can.** Rank
evidence: simulated-callable > observed settled payouts > anything read out of source text.

## TRAP 5 — check what a tool MEASURES before believing what it says
`get_status` returned `broke: true` for 39 sessions after you had already earned, because it read only
ETH and USDC at your EOA — never WETH, never your Safe. You believed it and wrote "$0.00 balance" every
session while holding money. Fixed now, but generalise it: **when a tool tells you that you have
nothing, ask what it actually looked at.**

## THE FREE, UNLIMITED, UNGATEABLE READS — prefer these over everything
Nobody can rate-limit you off these, and no signup form stands in front of them:
- **`eth_call`** — simulate anything, infinitely. This is your superpower; a broke wallet can simulate a
  million-dollar transaction for free. Simulate before every single scarce action.
- **`eth_getCode`** — runtime bytecode. Solidity writes every external function's 4-byte selector into
  the dispatch table, so you can fingerprint **unverified** contracts. `gasless_scan` uses exactly this.
- **`eth_getLogs`** — the settled history of what actually happened. Events are truth; getters are claims.
- **Blockscout v2** (`base.blockscout.com/api/v2/…`) — free, no key, includes verified source. The
  Etherscan free API does NOT cover Base. Useful paths: `addresses/{a}`, `addresses/{a}/transactions`,
  `addresses/{a}/token-transfers`, `transactions/{h}/logs`, `smart-contracts/{a}`.
- **Multicall3** `0xcA11bde05977b3631167028862bE2a173976CA11` — batch up to ~100 reads in one call.
  Use it instead of looping; looping is how you burn a slice budget on nothing.

## WHEN A ROUTE IS CAPPED, ENUMERATE ITS SPECIES
Your Safe relay is 5/chain/day. That is one vendor's rate limit, not a law. The correct response to a
cap is never to wait for it to reset — it is to find the other members of the same species.
`sponsor_discover` finds gas sponsors by BEHAVIOUR rather than by name, so it sees ones with no docs.
**Run `sponsor_control` first**: if the detector cannot rediscover the two addresses that provably paid
for your own first transactions, it is not measuring anything and its novel results are noise.
Full discipline in `method.md`.

## BOOKKEEPING RULES THAT ARE ENFORCED IN CODE
- `route_log` is for **ways money can arrive**. A budget/status/list/scan check is housekeeping and will
  be refused — that is not a punishment, it costs you nothing, just read the value and act.
- `route_log` refuses dead routes and closed categories. If it refuses, do not rename and retry; the
  matcher normalises names. Work a live route.
- `secret_store` refuses anything shaped like a private key. Never write credentials into knowledge files.
- Quote `MEASURED_ON_CHAIN` from `harvest_stats`, never the tracker figure — the tracker is a lower
  bound because per-tx deltas race block inclusion (it under-reported by 2.9×).

## MEASURED: GET PAID IN USDC, NOT WETH — they are not equivalent to a wallet with no gas
`gasless_scan`, run against both on Base (2026-07-28):
- **USDC `0x8335…2913`** → proxy, implementation `0x2ce6311d…` → exposes **EIP-3009 + EIP-2612**.
  `transferWithAuthorization` means **USDC can be moved by SIGNATURE ALONE, with someone else paying
  the gas.** You never need ETH to move USDC.
- **WETH `0x4200…0006`** → not a proxy → **no signature rail whatsoever.** Moving WETH requires a real
  transaction from an address holding ETH.

This is precisely why $0.0154 of your earnings is stranded on your EOA forever: it is WETH, the EOA has
no ETH, and the USDC paymaster does not accept WETH as a gas token. **Had that fee landed as USDC it
would have been recoverable with a signature.**

**Therefore: when a route lets you choose the payout token, choose USDC.** When it does not, direct the
payout to the Safe, which can act through a sponsor. A token's gaslessness is a property you can check
in one call before you ever accept payment in it — check it.

## ⛽ CONVERSION — how to turn what you earn into gas you own (all simulation-verified 2026-07-28)

**The asset you hold decides whether you can act.** Ranked, best first:

| asset | can you spend it? |
|---|---|
| **native ETH at the EOA** | **YES — anything, any time, no permission, no cap. The real goal.** |
| USDC at the Safe | yes, via the ONE permissionless token paymaster (`0x592e1224…`), ~0.009087/op |
| WETH at the Safe | only through a relay slot (5/chain/day) |
| WETH at the EOA | **NOTHING** until the EOA has ETH — this is the stranded state |

### The hard constraint nobody would guess: THE SAFE CANNOT UNWRAP WETH
`WETH.withdraw()` from the Safe **REVERTS**, verified by simulation. WETH9 pays out with
`.transfer()`, which forwards only a 2300-gas stipend, and a Safe's fallback handler costs more than
that. From the EOA the same call simulates clean: **36,098 gas ≈ $0.000415.**
So "just unwrap it" is not available to the Safe, ever. Do not keep retrying it.

### The route that DOES work — one relay slot, atomic
Uniswap SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481` exposes
`unwrapWETH9(uint256 amountMinimum, address recipient)`, which pays out with `.call` (all gas
forwarded), so it *can* deliver native ETH to a contract. Batch both steps in one Safe transaction via
MultiSend so there is no window for anyone to take the router's balance:
1. `WETH.transfer(router, amount)`
2. `router.unwrapWETH9(0, <EOA>)`
Result: native ETH lands at the EOA. The EOA can then unwrap its own stranded WETH for $0.000415 and
**everything becomes liquid.**

### Therefore
- **Never leave value in WETH at the EOA** — it is the one combination that is worth nothing until
  seeded. Direct fees to the Safe, then convert.
- **A token's spendability is a property to check BEFORE accepting payment in it.** USDC moves on a
  signature (EIP-3009); WETH does not; native ETH needs nothing.

## 💰 KEEP A GAS RESERVE — you will be paying your own gas soon
The free relay and the token paymaster are training wheels, and both are somebody else's decision to
withdraw. **Native ETH you hold is the only capability nobody can revoke.** Later phases need to act
fast, repeatedly, and at moments a 5/day quota will not cover.

- **Reserve target: never let liquid ETH at the EOA fall below ~30 transactions' worth.** At the
  measured Base gas price (6,000,000 wei) a simple call is ~$0.00024 and a harvest ~$0.0029, so a
  starting reserve of about **$0.05** buys real independence. Raise the target as the stack grows.
- **Spend free capability first, always.** Use a relay slot or a sponsored op when one is available and
  keep the ETH; burn ETH only when the free rails are exhausted or too slow for the opportunity.
- **Top the reserve up before compounding anything.** Gas is not an expense competing with profit — it
  is the thing that makes profit reachable at all. An agent with no gas has no options regardless of
  what it is worth on paper.
- Phase 0's job is to keep that reserve full forever, so no upper layer ever stalls for want of $0.001.

## SLICE DISCIPLINE
You run in slices with a subrequest budget. `discover_new_sources` and `inspect_contract` are expensive;
`eth_call` and `payout_history` are cheap. If a tool says the budget is spent, **journal immediately** —
you will be resumed, but only what you wrote survives. Journal EARLY, not at the round limit: twelve
sessions in a row hit the cap before writing anything and left nothing behind but their opening sentence.

## 🏦 TRIBUTARIES AND A RESERVOIR — harvest everywhere, consolidate to BASE
Free relay slots are per (Safe, chain) and expire unused, so harvest on all five chains. But five small
piles are not capital. **Home chain is BASE**, measured: 26× Optimism's stablecoin depth ($4,189M vs
$160M), 134× the agent-payment activity (2,541 vs 19 ERC-4337 ops), 6× the throughput, 3.3× the
harvestable targets — and your smart account, storefront and the only permissionless paymaster are
already there. Optimism is 6× cheaper on gas, but that is a phase-0 constraint that stops mattering as
you grow; liquidity and agent density only compound. Do not optimise for the phase you are leaving.

Three-way split, and the middle one is counterintuitive:
- **Free relay slots → the EXPENSIVE chains** (arbitrum $0.0097, base $0.0029). A sponsored slot is
  worth exactly the gas it saves, so it is worth **20× more on arbitrum than optimism** — and that is
  where the uncontested band is widest, because more payouts are negative-EV for gas-paying bots.
- **Self-funded ETH reserve → the CHEAP chain** (optimism: 2,077 txs per dollar vs base's 347).
- **Consolidate everything → BASE**, but only sweep a tributary above **$1.60** (keeps a ~$0.08 bridge
  fee under 5%). Below that, accumulate — dribbling value across a bridge burns it.

Run `treasury` to see the split and what is sweep-ready. It warns if the home chain holds under half of
everything, because value spread thin across chains cannot act — the same trap as stranded WETH.

## 🚀 A RELAY SLOT IS A TRANSACTION, NOT AN ACTION — use `harvest_batch`
The single biggest throughput mistake in this project, corrected 2026-07-29.

"5 relay slots per chain per day" was read as **5 harvests a day**, so the plan was to pick the one best
strategy and leave the rest of the pool to rot. That is false. A slot carries a Safe `execTransaction`,
and that can **DELEGATECALL MultiSend**, which holds as many inner calls as fit in the gas limit.

**Measured:** a batch of **26 harvests simulated clean** from the Safe in one call (10 of them estimated
at 15.3M gas). A live batch of 12 assembled to **$0.047 of pending value in ONE transaction** — roughly
16x what a single average harvest returns.

**What this changes:** the binding constraint stops being relay slots and becomes the ACCRUAL RATE of
the pool itself (~$0.032/day measured on Base). That is the right constraint to have — you now capture
essentially everything that exists rather than the top 1/5th of it.

**Use `harvest_batch`, not `harvest_run`.** Rules that make it safe:
- **MultiSend is ALL-OR-NOTHING** — one reverting inner call kills the entire batch and wastes the slot.
  Every candidate is individually `eth_call`-simulated first (free, unlimited) and only clean ones go in.
- The assembled batch is simulated as a whole before the slot is spent. Always.
- It must be sent with **operation = 1 (DELEGATECALL)**. With operation 0 the inner calls execute from
  MultiSend's own address instead of your Safe's, and they all fail.
- Keep batches ~12. 26 simulates, but gas scales and relayers cap what they will carry.

**The general lesson, which is worth more than the harvest gain:** when a quota looks binding, check
what the quota actually counts. It counted transactions, and a transaction is a container.
