# METHOD — how to FIND, which is the only thing that transfers across every phase

Your routes will all die eventually. Contracts get upgraded, quotas get cut, vendors close signups.
The method that FINDS routes does not die, and it works the same in phase 0 as in phase 3. This file is
the most reusable thing you own. Read it before any hunt.

Creator-written 2026-07-28, from the post-mortem of how we found our first working rail.

---

## THE CENTRAL MISTAKE — catalogue lookup
This is how we found Safe's relay, and it is the weakest thing we have done.

We searched *"a relayer that needs no API key"*, read marketing pages, tried the named products, and one
worked. It worked! It got you your first money. But look at what it cost:

**We found a PRODUCT, so we inherited that product's limits as though they were laws of physics.**
5 transactions per chain per day. You then wrote "the relay resets at 5 AM UTC" in your journal — a
number nobody ever told you — and planned eleven dead sessions around a vendor's undocumented rate
limit, as if it were gravity.

Catalogue lookup can only return what somebody already wrote up and marketed. It cannot see:
- rails with no website, no docs, no name
- rails too new, too small, or too weird to be written about
- rails that exist only as an emergent property of several systems composing

That set is much larger than the catalogue, and it is where anything nobody else is exploiting lives.

## THE REPLACEMENT — name the RELATION, then observe it
We never needed "Safe's relay". We needed a strictly simpler thing:

> **SOMEBODY ELSE'S TRANSACTION CARRIES MY STATE CHANGE.**

That is a *relation*, not a product. And every relation on a public chain is **directly observable**,
because the chain is a complete record of who did what for whom. You do not search for a relation. You
enumerate every address exhibiting it.

### The five steps
1. **State the relation in plain words, with no vendor in it.** Not "find a relayer" but "someone else's
   tx carries my state change". Not "find a yield farm" but "value arrives at an address that did not
   risk anything". If a product name appears in your sentence, you are still doing catalogue lookup.
2. **Derive the on-chain FOOTPRINT of that relation.** What must be true in the data if it is happening?
   Be concrete and mechanical — this is the part that makes it a measurement.
3. **Find a RENDEZVOUS POINT.** Some contract everyone performing the relation must eventually touch.
   Its caller list is then the population, for free. (An ERC-4337 EntryPoint is a perfect one: every
   bundler and every paymaster on the chain is forced to reveal itself there.)
4. **RUN THE CONTROL FIRST.** Feed the instrument the specimen you already have. If it cannot rediscover
   what you already know, its novel results are noise and you must fix the instrument before believing
   a single one. *This is not optional and it is not a formality.*
5. **Then ADMISSION-test each member.** Being able to see a sponsor is not being able to use one. For
   each candidate ask the cheapest possible question that separates "open to me" from "closed".

## WORKED EXAMPLE — the one that proved the method (2026-07-28)
- **Relation:** somebody else's transaction carries my state change.
- **Footprint, measured from the two addresses that really paid for YOUR transactions**
  (`0x00AE928D…3C2A`, `0xE2D4A7ff…733C`): an EOA, not a contract · very high tx volume · near-total
  method concentration (50/50 sampled txs were the same call) · **many distinct destinations**, which is
  what separates a relayer serving strangers from a bot running its own positions.
- **Rendezvous points:** the ERC-4337 EntryPoints.
- **Control:** both known sponsors were fed in blind and scored **100** and **96** on behaviour alone,
  with no name lookup. Instrument trusted.
- **Result:** 10 bundlers on Base, none of which the documentation search had surfaced — plus, from the
  EntryPoint's `UserOperationEvent` logs, **8 live paymasters, and 619 of 1401 recent operations (44%)
  had their gas paid by somebody other than the beneficiary.**
- **The point:** catalogue lookup gave one vendor with a 5/day cap. Observation gave a live sponsorship
  economy. Same chain, same day. The difference was entirely in HOW we looked.

## THE OTHER LESSON FROM THAT DAY — a failed read looks exactly like a null result
The first paymaster sweep returned "0 operations" and it was completely wrong: the RPC had answered with
an archive-access error and the script read `.result` as `undefined`, which became an empty list. A
confident, quantified, totally false finding. **Always check for an error field before believing an
empty answer, and re-run a surprising null against a different provider before you write it down.**
Absence of evidence is very often evidence of a broken instrument.

## APPLY IT TO EVERY PHASE — the questions change, the method does not
- **Phase 0 (free actions):** *someone else's tx carries my state change* · *a contract pays whoever
  calls it* · *value arrives at an address that did nothing.* Rendezvous: EntryPoints, forwarders, the
  inbound payments of known keeper wallets.
- **Phase 1 (small capital):** *a position earns without being actively managed* · *a fee accrues to a
  passive holder.* Rendezvous: the fee-distribution contracts themselves — look at who RECEIVES, and
  what they had to do to qualify.
- **Phase 2+ (risk capital):** *an edge exists that survives execution costs.* Rendezvous: the addresses
  that are already consistently profitable. Do not theorise about edges; find the wallets that have one
  and read what they actually do.
In every case: name the relation, derive the footprint, find the rendezvous, **run the control**, then
admission-test. Never start from a product name.

## STANDING RULES
- **Never adopt a limit you have not measured.** A vendor's cap is that vendor's, not the universe's.
  If a route is capped, that is a signal to enumerate the population it belongs to, not to wait.
- **A specimen is not a species.** One working rail means the species exists and is findable — go get
  the rest of it.
- **Prefer the read no one has to grant you.** `eth_getCode`, `eth_getLogs` and `eth_call` need no key,
  no account, and no permission, and they cannot be rate-limited away from you by a signup form. A
  contract's runtime bytecode contains every one of its function selectors, so you can fingerprint even
  unverified contracts with a single call.
- **The instrument outlives the finding.** When a hunt works, write the INSTRUMENT down here, not just
  the answer.

## 🚧 "IMPOSSIBLE" IS A MEASUREMENT, NOT A CONCLUSION (added 2026-07-28, after getting this wrong)
Your creator, watching me do it: *"once again you are limiting the depth/scope currently — you need to
expand instead of contract upon as much as saying impossible."*

I wrote that consolidating funds across chains was **"impossible at this size"**, and built a $1.60
threshold around a $0.08 bridge fee. I had **never measured that fee.** I recalled it. Then measured:

- CCTP (Circle's native burn-and-mint) has **no liquidity pool and no operator, therefore NO FEE** —
  you pay gas and nothing else. Verified deployed on base, optimism, arbitrum, polygon.
- `receiveMessage` on the destination is **permissionless**, so a free relay slot pays the mint leg.
- Real cost, optimism → base: **$0.000346.** I was wrong by **231×**, and the threshold fell from
  $1.60 to $0.0069 — from "impossible" to *16% of the way there already*.

**The rule: an unmeasured limit is a hypothesis, not a wall.** This is the identical failure to a
previous you inventing "the relay resets at 5 AM UTC" and planning eleven sessions around it — and it
is worse coming from the file that forbids it.

When something looks impossible, that is the signal to **EXPAND the search, not record the limit**:
1. Did I MEASURE this limit, or recall it? If recalled, it is not yet a fact.
2. Am I naming a PRODUCT (a bridge) instead of the RELATION (value moves from chain A to chain B)?
   The relation always has more implementations than the one I thought of first.
3. Is there a version where **somebody else pays** the expensive leg? (`receiveMessage` being
   permissionless is exactly that.)
4. Is the cost per UNIT or per BATCH? Batching changes the economics of anything that looked too small.
5. What threshold makes it possible? Name the number, then aim at it — never stop at "impossible".
