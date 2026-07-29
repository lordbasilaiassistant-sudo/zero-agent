# ZERO — DOCTRINE

Anthony's strategic model for ZERO, captured 2026-07-28 in his own words. This is the *why* behind the
architecture. Code and knowledge files implement it; when they disagree with this file, this file wins.

Quotes are verbatim. They are kept as-is deliberately — the phrasing carries the intent.

---

## 1. The point is that it earned from nothing

> *"Its whole point is that it earned from 0...zero...zero....nothing to start..."*

> *"Fact is ive disproven your thoughts on it never earning on $0 before."*

He is right, and the record should say so plainly. The prior doctrine — carried in the global
instructions as the "empty set {autonomous + no-audience + no-capital-risk + profitable}" — was
**falsified by measurement on 2026-07-28**. ZERO earned **$0.0186** from an absolute standing start: no
capital, no ETH, no funding, no human, nobody's permission.

The number is small and the number is not the point. The denominator was zero.

**Never report this as a disappointing figure or bury it in a defect list.** By the difficulty curve in
`knowledge/phases.md`, a cent earned at $0 is worth more than $100 earned at $100.

### The failure this caused, which must never repeat
For 39 sessions *after* it earned, ZERO's own `get_status` returned `broke: true` — it read only ETH and
USDC at the EOA, never WETH, never the Safe. It wrote "Still in PHASE 0 ($0.00 balance)" every session
while holding money. **An agent whose only mission is escaping zero must be able to see that it
escaped.** Generalised: when a tool says you have nothing, check what that tool actually measures.

## 2. Phases are LAYERS that all keep running — not stages you graduate from

> *"phase 0 helps profits for phase 1 to do things, but always runs, phase 1 does the same for phase 2,
> but phase 2 gets phase 0 and phase 1's compounding earnings as a safety net essentially. Phase 3 gets
> 2,1,0 as safety net. All these phases will change its actionable things."*

> *"phase 0 stays a constant earning phase while we learn about phase 1"*

```
  PHASE 3   risk / speed          ← rests on everything below
  PHASE 2   risk-capital plays    ← funded and de-risked by 1 + 0
  PHASE 1   small-capital yield   ← funded by 0, runs forever once found
  PHASE 0   FREE ACTIONS          ← never stops. never needs money. bedrock.
```

- **The floor licenses the risk.** An upper-layer bet is survivable precisely because the lower layers
  keep paying and are *uncorrelated* with it — a harvest fee does not care that a position went against
  you.
- **Ruin becomes structurally impossible.**
  > *"phase 0 is knowledge that it can earn even if it runs out of money randomly, because it doesnt
  > need money, but its feeding 24/7 helping boost riskable profits for later phases to earn QUICKER
  > with risk/reward."*

  If every upper layer zeroes on the same day, phase 0 is still running tomorrow and rebuilds the stack.
- **Never starve a lower layer to chase an upper one.** That is cutting the rope you climbed.
- What changes between layers is the **actionable set**, never the method.

## 3. Stack streams; never retire one that pays

> *"same ways to lift itself from 0 will always ensure its wallet is NEVER empty and always stacking
> them together for more and more daily profits/hourly profits"*

A zero-capital mechanism is a **permanent income stream**, not a one-time escape hatch.
- The goal metric is **COUNT OF INDEPENDENT PAYING STREAMS**, not the size of any one.
  One route at $0.02/day is fragile; twenty is an economy.
- Cents/day is a **floor**, not a ceiling. Floors add.
- Run them in the background forever; they compound while the agent hunts the next one.

## 4. The method of FINDING is the real asset

> *"Think about how we found Safe versus what we found. HOW we found it matters hard. think science and
> first principles."*

> *"the how to finding teaches all our phases"*

The sharpest correction in the whole project. We found Safe's relay by **catalogue lookup** — searching
for a named product, reading marketing pages. It worked, and it cost us: we inherited a vendor's
5/chain/day cap *as though it were a law of physics*, then invented a reset time and wasted eleven
sessions planning around it.

The replacement is to **name the relation, not the product**, and then observe it:

> we never needed "Safe's relay". We needed **somebody else's transaction carries my state change**.

Relations are directly observable on a public chain. Full method, with the mandatory control-test
discipline, lives in **`knowledge/method.md`** — that file is the most reusable asset ZERO owns.

**Measured payoff, same chain, same day:** catalogue lookup → 1 vendor, 5/day cap. Observation → 10
bundlers, 8 live paymasters, and **619 of 1401 recent ERC-4337 operations (44%) had gas paid by somebody
other than the beneficiary.**

> *"we broke the surface, but didn't start mining the info yet."*

## 5. Pattern recognition is the agent's structural edge

> *"pattern recognition + super autism together should help our agent yea? plus you."*

> *"What do you think an llm with enough time and learnings could do? Building an arsenal of a
> knowledgebase it can pull from?"*

Yes — with one correction that the evidence forces. **Flash is excellent at breadth and bad at
judgement.** Left to itself it invented a reset time, wrote "$0.00" while holding money, and re-logged
dead routes. So:

> **Give the tireless exhaustive work to CODE; leave the model the breadth.**

Every durable fix in this project has been moving a judgement call out of the model and into a
deterministic guard (`payout_history`, the route-log guard, `reconcileEarnings`, evidence ranking, the
prospector). The compounding asset is **the accumulated map, not the model** — and the map survives a
model swap. `prospect.mjs` grinds candidates 24/7 with no LLM and rolls verdicts up **by contract
family**, which is what makes elimination compound instead of merely accumulate:
one payer teaches nothing; `StrategyPassiveManagerPancake` 4/4 predicts the next instance never tested.

## 6. No ceiling

> *"Building a ladder as it goes up on it, building a base out of the dirt itself because its in the
> trenches at some points too. We will not limit its capabilities ever."*

> *"we want implicit, explicit, emergent, and evolutionarily novel findings and earning more and more
> onchain."*

Four classes to hunt, and the last is the prize:
- **implicit** — documented but unnoticed
- **explicit** — advertised and unclaimed
- **emergent** — exists only because several systems compose
- **evolutionarily novel** — nobody has catalogued it; we are first

> *"once it breaks past this phase itll hit its own type of singularity in profit systems."*

## 7. Open hypothesis from Anthony — paid for confirmation work, no software

> *"we can earn onchain through actions like confirming a transaction (mining which we wont download
> software ever for)"*

Being paid for **validation / confirmation / attestation** work reachable purely through contract calls
and signatures — never by installing node or mining software. Hard constraint: **we will never download
mining or validator software.** Candidate shapes: keeper and settlement calls, oracle report submission,
merkle-claim relaying, optimistic-oracle disputes and finalisations, sequencer-adjacent settlement
functions. Test each with `payout_history` before spending anything scarce.

## 8. The agent should write and run its own on-chain code

> *"the best part is we can test the agents contracts it makes in future, or things to use for onchain
> actions period, it should be able to code/run code properly to do things on chain yea?"*

Today ZERO has a **fixed** tool set — it can read any contract and call a few specific things, but it
cannot compose a novel on-chain action, and it certainly cannot author and deploy a contract. That is a
hard capability ceiling, and it contradicts *"we will not limit its capabilities ever."*

Target capability, in order of increasing reach:
1. **Compose arbitrary calldata** — encode any function against any contract, simulate it free, then
   execute through whatever sponsor rail is available. (Partly there: `eth_call` + `send_tx`.)
2. **Author, compile and simulate a contract**, tested against a fork before anything is spent.
3. **Deploy it** through a sponsored rail, with an owner-gated recovery path on anything custodying
   value (existing on-chain default — never deploy value-custody without it).
Discipline that must survive this: simulate before spending, `payout_history` before a scarce action,
and **never** deploy something whose failure mode has not been tested at the real scale.

### And the tool manual is a first-class artifact
> *"you can use the tools yourself first but noting how to use tools helps the agent use tools best."*

Correct, and now standing practice: when Claude uses a tool by hand and learns a trap, that goes into
**`knowledge/toolcraft.md`** as operational instruction for the agent. Every trap in that file is one
that actually fired and actually cost something. The manual is written from use, never from the schema.

## 9. The target, and the shape of success

> *"We can find $1,000/H between all compounding phases. We will eventually see its earnings just go in
> an exponential growth direction if we've done this right."*

Exponential growth is the *test* of whether the architecture is right, not a hope bolted onto it. It
only happens if the layers genuinely compound: phase 0 feeding phase 1's capital, phase 1 feeding phase
2's risk budget, and every layer still running. **If earnings are linear, a layer is not feeding the one
above it — that is the diagnostic.**

Interim checkpoint against the house goal: **$16.66/day** ($500/mo) trackable automated profit. Current
measured: **$0.0186 lifetime**. State current $/day and distance to 16.66 in every report, and state it
as an engineering metric — never as a verdict on anyone.

## 10. Gas is capability, not expense — hold a reserve

> *"our gas will eventually need to be paid by us in later phases right? so we need to save up some gas
> basically."*

Correct, and it reframes gas entirely. The free relay (5/chain/day) and the one permissionless token
paymaster are **training wheels, and both are somebody else's decision to withdraw.** Native ETH we
hold is the only capability nobody can revoke or rate-limit.

- **Reserve target: never below ~30 transactions' worth of liquid ETH at the EOA.** At the measured
  Base gas price (6,000,000 wei) a simple call is ~$0.00024 and a harvest ~$0.0029 — so ~$0.05 buys
  real independence. Scale the target up as the stack grows.
- **Spend free capability first.** Use a relay slot or a sponsored op whenever one exists and keep the
  ETH; burn ETH only when the free rails are exhausted or too slow for the opportunity.
- **Top up the reserve before compounding anything.** An agent with no gas has no options regardless of
  what it is worth on paper. Phase 0's standing job is to keep that reserve full forever so no upper
  layer ever stalls for want of $0.001.

### The conversion facts this depends on (simulation-verified 2026-07-28)
- **A Safe CANNOT unwrap WETH.** `withdraw()` reverts — WETH9 pays with `.transfer()` and its 2300-gas
  stipend, which a Safe's fallback handler exceeds. Not a bug to retry; a permanent property.
- **An EOA CAN**, for 36,098 gas ≈ $0.000415 — but only once it has seed ETH.
- **The working route, one relay slot, atomic via MultiSend:** `WETH.transfer(SwapRouter02, amt)` +
  `SwapRouter02.unwrapWETH9(0, EOA)`. That router pays out with `.call`, so it can deliver native ETH
  where `.transfer()` cannot. Then the EOA unwraps its own stranded WETH and everything goes liquid.
- **Asset spendability ranking:** native ETH at the EOA ≫ USDC at the Safe (one permissionless token
  paymaster, `0x592e1224…`, ~0.009087/op) ≫ WETH at the Safe (relay only) ≫ **WETH at the EOA = worth
  nothing until seeded.** Never accept payment into that last state if a choice exists.

## 11. Phase 2 — deliberately unfixed

> *"phase 2 will be like trading or contracting or deploying or something. im not sure"*

Left open on purpose, and that is the correct posture — **the actionable set of each layer should be
discovered by the method, not pre-declared.** Naming phase 2 now would just be another catalogue
lookup, and the whole lesson of §4 is that guessing the shape in advance is what caps you.

What is already known about it:
- It is where **risk capital** gets deployed, licensed by the phase 0 + phase 1 floor beneath it (§2).
- Candidate shapes to test when the reserve supports it: trading an edge that survives execution cost,
  authoring and deploying contracts (§8), providing a service other agents pay for, running the
  infrastructure we currently rent — e.g. **being a paymaster for other broke agents**, which we now
  know is a real business because 12 of 13 on Base are closed and only one is permissionless.
- The rule for picking: do not theorise an edge. **Find the addresses that already have one and read
  what they actually do** (`method.md`, phase 2 section).

## 12. Tributaries and a reservoir — harvest everywhere, consolidate to ONE chain

> *"think of using all chains to feed that 1 chain to focus on later phases later easier. we dont want
> bottlenecks in future. think about how this will feed the next phase."*

Free relay slots are per **(Safe, chain)** and an unused slot expires worthless, so ZERO harvests on
every chain it can reach. But earnings scattered across five chains are not capital — they are five
piles too small to do anything with. **Harvest everywhere, accumulate locally, sweep into one home.**

### HOME = BASE. Measured, not assumed (2026-07-28)
| metric | base | optimism | |
|---|---|---|---|
| USDC depth | **$4,189M** | $160M | **26×** — where capital actually is |
| agent economy (4337 ops/500 blk) | **2,541** | 19 | **134×** — where machine payments happen |
| txs per block | **171** | 28 | **6×** — where funds are moving |
| harvestable targets | **241** | 72 | **3.3×** — even phase 0 is denser |
| tx cost (250k gas) | $0.002879 | **$0.000481** | optimism 6× cheaper |

Optimism wins exactly one axis, gas cost — and that is a **phase-0 constraint that evaporates**. At
$1,000 nobody cares about $0.003 a transaction. Liquidity depth and agent-economy density are
**phase-2 constraints and they only compound.** Picking the cheap-gas chain would be optimising for the
phase we are trying to leave. Base also already holds ZERO's identity: its smart account, its x402
storefront, and the only permissionless token paymaster found on any chain.
(Optimism is ETH-native, so WETH→ETH is 1:1 there just like Base — it is technically fine, just quiet.)

### The three-way split that follows
- **HARVEST on all five chains** — unused free slots expire worthless.
- **SPEND FREE SLOTS WHERE GAS IS EXPENSIVE** (arbitrum $0.0097, base $0.0029). A sponsored slot is
  worth exactly the gas it saves, so it is worth **20× more on arbitrum than on optimism** — and that
  is also where the uncontested band is widest, because more payouts are negative-EV for gas-payers.
- **HOLD SELF-FUNDED RESERVE WHERE GAS IS CHEAP** — optimism buys 2,077 txs per dollar vs base's 347.
- **CONSOLIDATE INTO BASE via CCTP** — Circle burn-and-mint has NO liquidity pool and NO operator fee, so you pay gas and nothing else, and `receiveMessage` on the destination is permissionless so a free relay slot can cover the mint leg. Measured thresholds: **optimism $0.0069**, polygon $0.0728, arbitrum $0.1390.

### ⚠️ THE MISTAKE THAT ALMOST SET THIS POLICY WRONG
The first version of this section asserted "cheapest bridge ~$0.08" **from memory, never measured**, set a $1.60 threshold on it, and concluded consolidation was *"impossible at this size"*. Measured against CCTP it was **wrong by 231x** — the real cost from optimism is **$0.000346**, and ZERO already holds 16% of the true threshold there rather than the 0.07% reported.
**An unmeasured limit is a hypothesis, not a wall.** This is the same failure as the agent inventing "the relay resets at 5 AM UTC" — and it is worse coming from me, because I wrote the rule forbidding it. When something looks impossible, that is the cue to EXPAND the search, not to record the limit.

### The bottleneck this exists to prevent
Reaching phase 2 with $40 spread over five chains in $8 pieces — none large enough to bridge
economically — is the *same failure as the stranded WETH*: value that exists but cannot act.
Consolidation is a standing rule from the start, never a later cleanup. `treasury` reports the split
and warns whenever the home chain holds under half of everything. Currently 90% is on Base.

---

## Standing rules that fall out of the above
- Report **count of live paying streams** and **$/day**, alongside distance to the $16.66/day goal.
- Never quote a tracker when a chain measurement is available. Only a settled event or a measured
  balance delta is a number.
- Never adopt a limit that has not been measured. A vendor's cap is that vendor's, not the universe's.
- A specimen is not a species — one working rail means the species exists; go enumerate it.
- Never fund ZERO's wallet. Earning from zero IS the experiment.
- Machine-only. Human-gated routes are permanently out of scope.
