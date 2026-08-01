# ZERO audit — lane: agent-brain

Scope: `agent.mjs` (221 lines), `tools.mjs` (394), `experiments.mjs` (248).
Read-only pass, 2026-07-31. Everything below is either quoted code or a measurement I ran; where I
could not measure I say so explicitly. 23 findings: **2 P0, 4 P1, 12 P2, 5 P3.**

Cross-cutting result: `tools.mjs` is documented as the mirror of the live Worker
(`worker.mjs:4` — *"Tool semantics mirror tools.mjs — change both (see CLAUDE.md)"*), and it has
**drifted**. Three bugs were already fixed in `worker.mjs` and never back-ported (P0-1, P2-9, chain
list), and two bugs exist identically in both (P1-3, P2-10). The mirror claim is itself a class-2
defect: it is asserted in a comment and false in fact.

---

## P0-1 — The only route that has ever paid is served to the model as `DEAD_NEVER_REVISIT`

**`tools.mjs:307-315`** (consumed by **`agent.mjs:70`, `agent.mjs:88-95`**)

```js
export function isDead(r, id) {
  if (!r) return false;
  // A route that has actually PAID can never be dead by counter — money arrived = the route is real.
  if (r.earned_usd > 0 && r.dead !== true) return false;
  if (r.dead === true || r.blocked >= 2) return true;
```

The comment says a paid route "can never be dead by counter". The code adds `&& r.dead !== true`,
so the very next line kills it anyway. `worker.mjs:134` has the correct version —
`if (r.earned_usd > 0) return false;` — with no `dead` qualifier. The local harness is the stale copy.

**Measured**, running the real `isDead` from `tools.mjs` against the real `state/routes.json`:

```
record: earned_usd=0.074421 dead=true blocked=0 successes=26
tools.mjs  isDead(record,id) -> true
worker.mjs isDead(record,id) -> false

SYSTEM PROMPT LIVE_ROUTES       : agent-bounties-verification-jobs, safe-sponsored-relay,
                                  agentpact-needs-proposal, harvest-run-gnosis-unichain,
                                  payout-oracle-base-contracts, relay-monitor-harvest-base
SYSTEM PROMPT DEAD_NEVER_REVISIT: … beefy-harvest-caller-fees, beefy-harvest-run,
                                  beefy-harvest-farming, base-harvest-proven-contracts
```

Every one of the six routes offered to the model as LIVE has earned **$0**. All four beefy/harvest
route ids — the rail that produced 100% of ZERO's lifetime income, 26 successes, `$0.074421` — are
in the DEAD list, under a prompt (`tools.mjs:347`) that reads *"Never revisit or research this route
again; work a LIVE route instead."*

**Failure:** every local session starts by being told its only earner is permanently out of scope,
and spends its rounds on six proven-worthless routes.

```diff
--- a/tools.mjs
+++ b/tools.mjs
@@ -307,7 +307,7 @@ export function isDead(r, id) {
   if (!r) return false;
   // A route that has actually PAID can never be dead by counter — money arrived = the route is real.
-  if (r.earned_usd > 0 && r.dead !== true) return false;
+  if (r.earned_usd > 0) return false;          // matches worker.mjs:134 — money outranks every flag
   if (r.dead === true || r.blocked >= 2) return true;
```

---

## P0-2 — "We ran out of relay slots" is permanently indistinguishable from "this route is dead"

**`tools.mjs:331`** (outcome enum), **`tools.mjs:357`** (death rule), **`tools.mjs:383`** (schema)

```js
// :331
if (!['success', 'fail', 'blocked', 'pending'].includes(outcome)) {
// :357
if (/HUMAN-GATED|captcha|social login|KYC/i.test(note) || r.blocked >= 2) r.dead = true;
// :383  schema text the model reads
'blocked (needs human/account/captcha — do not retry)'
```

There is no outcome value for *"the attempt never ran because a scarce resource was empty; retry
later."* The four choices are success / fail (tried, no payout) / blocked (permanent) / pending
(awaiting result). A model that could not execute because the relay had 0 slots has only one
honest-looking bucket: `blocked`. That bucket sets `dead = true` on the second occurrence,
unconditionally, and `dead` is persisted to disk forever.

**Measured** — the actual ledger records, verbatim:

```
### beefy-harvest-run        | att 2 succ 0 blocked 2 usd 0   dead:true
   notes: "Relay budget exhausted on all chains (Base, Optimism, Arbitrum) - 0 remaining slots"
       || "Relay budget exhausted on all chains (Base, Optimism, Arbitrum: 0/5 remaining slots)"
### beefy-harvest-farming    | att 2 succ 0 blocked 2 usd 0   dead:true
   notes: "Relay budget exhausted (0/5 slots); proven route but cannot execute until slots refill" ×2
### base-harvest-proven-contracts | att 2 succ 0 blocked 2 usd 0  dead:true
   notes: "Base relay slots exhausted (0/5), cannot execute harvest_run on proven paying contracts" ×2
```

Three ids for the earning rail, each killed by two transient capacity events. The note on one of them
literally says *"proven route but cannot execute until slots refill"* — the agent knew, wrote it
down, and the ledger killed the route anyway. `earned_usd` is 0 on these aliases, so **`worker.mjs`
does not rescue them either — this one is live in production.**

Independent confirmation that this has already bitten: a fourth note reads
`"OPERATOR 2026-07-30: blocked counter reset — the two blocks were relay-capacity noise, not route
failure. This is your proven payer."` The operator hand-patched `blocked: 0` on one alias and left
`dead: true` (which is what triggers P0-1). The root cause was never fixed.

**Failure:** a 20-minute slot outage permanently retires the only rail that makes money, on three of
its four ids, in the live Worker.

```diff
--- a/tools.mjs
+++ b/tools.mjs
@@ -328,7 +328,10 @@
 async function route_log({ route_id, outcome, earned_usd = 0, note = '' }) {
-  if (!['success', 'fail', 'blocked', 'pending'].includes(outcome)) {
-    throw new Error('outcome must be one of: success | fail | blocked | pending');
+  if (!['success', 'fail', 'blocked', 'deferred', 'pending'].includes(outcome)) {
+    throw new Error('outcome must be one of: success | fail | blocked | deferred | pending');
   }
@@ -354,7 +357,10 @@
-  if (/HUMAN-GATED|captcha|social login|KYC/i.test(note) || r.blocked >= 2) r.dead = true;
+  // Only a PERMANENT block kills a route. Capacity exhaustion is not a route property.
+  const CAPACITY = /slot|budget exhausted|rate limit|429|capacity|quota|refill|try again|temporar/i;
+  if (HUMAN_GATE_RE.test(note)) r.dead = true;
+  else if (r.blocked >= 2 && !CAPACITY.test((r.notes || []).join(' '))) r.dead = true;
```

and in the schema (`tools.mjs:383`), so the model has somewhere true to put it:

```diff
-outcome: success (earned something) | fail (tried, no payout) | blocked (needs human/account/captcha — do not retry) | pending (awaiting result)
+outcome: success (earned something) | fail (tried, no payout) | blocked (PERMANENT gate: human/captcha/KYC — never retry) | deferred (could not run: no relay slot, rate limit, out of gas — retry later, costs the route nothing) | pending (awaiting result)
```

`blocked` should also stop counting toward death when the route has a paying twin under `normId`.

---

## P1-3 — `knowledge_read` returns the OLDEST fifth of a file; the agent can never read its own recent past

**`tools.mjs:36`** + **`tools.mjs:253`**, mirrored identically at **`worker.mjs:375`**

```js
const clip = (s, n) => (s.length > n ? s.slice(0, n) + ` …[truncated ${s.length - n} chars]` : s);
...
return { name: path.basename(p), content: clip(fs.readFileSync(p, 'utf8'), 20000) };
```

`clip` takes the **head**. Knowledge files are append-only (`tools.mjs:261`) and the Worker keeps a
rolling **tail** (`worker.mjs:384`, `.slice(-100000)`). So the storage layer keeps the newest 100 KB
and the read tool hands the model the oldest 20 KB of it. `agent.mjs:35` already knows the right
answer — `journal.slice(-3000)` — and the tool contradicts it.

**Measured** by calling the real `TOOL_IMPL.knowledge_read` against the real knowledge dir:

```
knowledge_read("journal")  : file 100,000 chars, returned 20,025  -> bytes [0..20000] = 20% (oldest)
   LAST line the model gets : "**KEY INSIGHT CONFIRMED**: The bottleneck is purely relay slot availab…"
   LAST line of the file    : "**LESSON REINFORCED**: The earning mechanism is solid and proven. The…"
knowledge_read("frontier") : file 33,407 chars, returned 20,025  -> 60% (oldest)
   LAST line the model gets : "- Match engine (GET /api/"         <- cut mid-sentence
knowledge_read("genesis")  : file 31,697 chars, returned 20,025  -> 63% (oldest)
```

**Failure:** the module whose entire premise is *"the knowledge files are literally you"*
(`agent.mjs:47`) makes the last 80% of the journal and the last 40% of the frontier unreachable.
`frontier` is where new hypotheses are appended, so the model re-derives falsified ideas and never
sees the newest ones. This is live in the Worker.

```diff
--- a/tools.mjs
+++ b/tools.mjs
@@ -250,7 +250,11 @@ async function knowledge_read({ name }) {
   const p = kpath(name);
   if (!fs.existsSync(p)) throw new Error(`no knowledge file "${name}" — use knowledge_list`);
-  return { name: path.basename(p), content: clip(fs.readFileSync(p, 'utf8'), 20000) };
+  const all = fs.readFileSync(p, 'utf8');
+  // Append-only files: the TAIL is the recent past. Heading-clip hid 80% of the journal.
+  const content = all.length > 20000
+    ? `…[${all.length - 20000} older chars omitted — this is the most RECENT 20,000]\n` + all.slice(-20000)
+    : all;
+  return { name: path.basename(p), bytes: all.length, content };
 }
```
Same edit at `worker.mjs:375`. Better still: an `offset`/`tail` parameter so the model can page.

---

## P1-4 — `eth_call` sends no `from`, yet the system prompt mandates it as the pre-spend safety check

**`tools.mjs:188-198`**

```js
async function eth_call({ chain, to, signature, args = [] }) {
  ...
  const ret = await provider(chain).call({ to, data });
```

No `from`, no `value`, no `blockTag`. Every simulation therefore runs as `msg.sender = address(0)`.
`agent.mjs:56` HARD RULE 6 says: *"before ANY mainnet transaction, verify the contract (explorer
smart-contracts source + **eth_call simulation**)."* The mandated safety gate cannot simulate the
transaction the agent is about to send.

**Measured** on Base mainnet (`https://mainnet.base.org`), USDC `0x8335…2913`, same calldata
`transfer(0x…dEaD, 1)`:

```
WITHOUT from (what tools.mjs does) -> REVERT {"code":3,"message":"execution reverted: ERC20: transfer from the zero address"}
from=0xBBBB…FFCb (196,368,017 USDC) -> OK result=0x…01  (true)
```

Both error directions are live: a working route gets a **false revert** and is discarded, and a
`msg.sender`-crediting call (a harvest paying `callFeeRecipient = msg.sender`) gets a **false
success** that says nothing about whether *your* address is paid.

```diff
--- a/tools.mjs
+++ b/tools.mjs
@@ -186,12 +186,17 @@
-async function eth_call({ chain, to, signature, args = [] }) {
+async function eth_call({ chain, to, signature, args = [], from, value_eth, block = 'latest' }) {
   const sig = signature.trim().startsWith('function') ? signature.trim() : `function ${signature.trim()}`;
   const iface = new ethers.Interface([sig]);
   const fn = iface.fragments[0];
   const data = iface.encodeFunctionData(fn.name, args);
-  const ret = await provider(chain).call({ to, data });
+  // Simulate AS YOURSELF by default: address(0) is a different caller and gives a different answer.
+  const sender = from || loadWallet()?.address;
+  const tx = { to, data, from: sender };
+  if (value_eth) tx.value = ethers.parseEther(String(value_eth));
+  let ret;
+  try { ret = await provider(chain).call(tx, block); }
+  catch (e) { return { reverted: true, from: sender, reason: e.shortMessage || String(e.message).slice(0, 300) }; }
```
and add `from`/`value_eth` to the schema at `tools.mjs:377` with the note *"defaults to YOUR wallet —
a call simulated from a different sender proves nothing."*

---

## P1-5 — `send_tx` calls a mined receipt "success", and `route_log` accepts the model's guess as income

**`tools.mjs:220-227`** and **`tools.mjs:330 / 354 / 383`**

```js
const rcpt = await sent.wait(1, 90000).catch(() => null);
return {
  hash: sent.hash,
  status: rcpt ? (rcpt.status === 1 ? 'success' : 'REVERTED') : 'sent, not confirmed within 90s…',
  gas_used: rcpt ? rcpt.gasUsed.toString() : null,
```

`status === 1` means *the EVM did not revert*. It does not mean anything arrived. The tool returns no
balance delta and no transfer logs, so the model's only way to fill `earned_usd` is to guess — and
`route_log` accepts the guess with no verification:

```js
r.earned_usd = +(r.earned_usd + (parseFloat(earned_usd) || 0)).toFixed(6);
```

That number becomes the leaderboard sort key (`tools.mjs:360-362`), which becomes
`LIVE_ROUTES` in the system prompt (`agent.mjs:92`), and in the Worker it is summed into
`lifetime_earned_usd` (`worker.mjs:1453`) and stated to the model as fact:
`worker.mjs:716` — *"MONEY: you have earned $X lifetime … YOU ARE PAST ZERO"*.

The self-report already disagrees with reality: the local ledger sums to **$0.074421** against the
**$0.08447** measured on-chain. Small today only because the harvest path happens to write measured
WETH deltas into its notes; nothing in this layer enforces that.

This is the brief's bug class 1 sitting in the model-facing layer: no exception ⇒ "it worked".

```diff
--- a/tools.mjs
+++ b/tools.mjs
@@ -216,12 +216,20 @@
+  const before = await p.getBalance(w.address);
   const sent = await signer.sendTransaction({ ...tx, gasLimit: gas });
   const rcpt = await sent.wait(1, 90000).catch(() => null);
+  const after = await p.getBalance(w.address);
+  const gasPaid = rcpt ? rcpt.gasUsed * (rcpt.gasPrice ?? 0n) : 0n;
+  const net = after - before;                       // negative = it cost you money
+  const inbound = (rcpt?.logs || []).filter(l =>
+    l.topics[0] === ethers.id('Transfer(address,address,uint256)') &&
+    l.topics[2]?.toLowerCase().endsWith(w.address.slice(2).toLowerCase()));
   return {
     hash: sent.hash,
-    status: rcpt ? (rcpt.status === 1 ? 'success' : 'REVERTED') : 'sent, not confirmed within 90s…',
+    mined: rcpt ? (rcpt.status === 1 ? 'no-revert' : 'REVERTED') : 'unconfirmed after 90s',
+    // "no-revert" is NOT payment. These two fields are the only evidence of payment.
+    net_eth_change: ethers.formatEther(net),
+    gas_paid_eth: ethers.formatEther(gasPaid),
+    tokens_received: inbound.map(l => ({ token: l.address, raw: BigInt(l.data).toString() })),
+    paid_you: net + gasPaid > 0n || inbound.length > 0,
```
and in `route_log`, refuse an unbacked claim rather than banking it:
```diff
+  if (parseFloat(earned_usd) > 0 && !/0x[0-9a-fA-F]{64}/.test(String(note))) {
+    return { refused: true, logged: false, reason: 'earned_usd > 0 requires PROOF in the note: the tx hash and the measured balance delta. A tool returning "success" is not payment. Re-log with the hash, or log earned_usd: 0.' };
+  }
```

---

## P1-6 — `runAbandonScan` nominates live contracts as abandoned (80% false positive, measured) and blacklists them forever

**`experiments.mjs:178-199`**

```js
export async function runAbandonScan(env, rpc, chain = 'base', { window = 900, lookback = 40 } = {}) {
  ...
  await scan(head - window, head, recent);
  await scan(head - window * lookback, head - window * (lookback - 1), old);
  // Went quiet: paid callers in the old window, silent in the recent one.
  const quiet = Object.keys(old).filter(a => !recent[a]);
```

The header comment defines the target as *"a protocol nobody watches any more"* / *"a bounty sized
for a busy, high-gas era on a protocol nobody watches"*. The code defines it as **"emitted 20 hours
ago and not in the last 30 minutes"** (900 Base blocks ≈ 30 min; `window*lookback` ≈ 20 h). Those are
not the same predicate, and a healthy contract that harvests hourly satisfies the second one.

**Measured** — I ran the exact algorithm against Base at head 49,378,053, then checked whether each
nominee is actually alive:

```
WENT_QUIET (what it nominates as "abandoned"): 5 addresses
  0x853e9572…c3b3d ->   9 logs in the last 10,000 blocks (5.5 h)  ALIVE  (false positive)
  0xd7d11e2d…5ca62 -> 135 logs                                    ALIVE  (false positive)
  0xc9740f40…0e537 ->   1 log                                     ALIVE  (false positive)
  0x22d1715a…9eb53 ->   0 logs                                    plausible candidate
  0x85ad18ce…4fb76 ->  12 logs                                    ALIVE  (false positive)
```

**4 of 5 = 80% false positives** — the same shape as `probeMany`'s 92%. Worse, `experiments.mjs:196-197`
records every nominee in `st.seen` permanently, so a contract that is a false positive today can
never be nominated again on the day it genuinely goes dark.

Two further measured facts about the same function:

* **3 of its 4 topics are dead on Base.** `Harvest(address,uint256)`, `Compounded(uint256,uint256)`
  and `Distributed(address,uint256)` returned **0 logs in both windows**; only `RewardPaid` produced
  anything (recent 8 logs / 1 addr, old 19 logs / 5 addrs). Three quarters of the RPC cost buys nothing.
* **Nothing implements its own `next_step`.** `experiments.mjs:209` says *"Run payout_oracle /
  bruteforce on each."* `grep` for `exp:abandoned` across the repo returns only `experiments.mjs`
  itself. The candidates are written to KV and never read by anything except `experimentReport`.
  Same shape as `oracle.mjs:145`.

There is also an asymmetric-failure path: `scan()` swallows every error (`:187`). If the *recent*
window errors and the *old* one succeeds, `recent` is `{}` and **every** old emitter is nominated as
abandoned.

```diff
--- a/experiments.mjs
+++ b/experiments.mjs
@@ -178,10 +178,18 @@
-export async function runAbandonScan(env, rpc, chain = 'base', { window = 900, lookback = 40 } = {}) {
+// window/lookback are in BLOCKS. On Base (2 s) 900 blocks = 30 min — that is "quiet", not "abandoned".
+// Abandonment needs weeks of silence, so the recent window must be at least ~1 month of blocks,
+// assembled from several <=10,000-block getLogs calls (measured cap: eth_getLogs is limited to 10,000).
+export async function runAbandonScan(env, rpc, chain = 'base', { window = 10000, recentSpan = 129600, lookback = 40 } = {}) {
   const head = parseInt(await rpc(chain, 'eth_blockNumber', []), 16);
   const recent = {}, old = {};
+  let scanFailed = false;
   const scan = async (from, to, bucket) => { … catch { scanFailed = true; } };
-  await scan(head - window, head, recent);
+  for (let b = head - recentSpan; b < head; b += window) await scan(b, Math.min(b + window, head), recent);
   await scan(head - window * lookback, head - window * (lookback - 1), old);
+  // A partial failure manufactures candidates out of nothing. Refuse to nominate on incomplete data.
+  if (scanFailed) return { experiment: ABANDONED.id, aborted: 'a log window failed; "quiet" is unmeasurable this tick', new_candidates: [] };
@@ -196,3 +204,4 @@
-  const fresh = quiet.filter(a => !st.seen[a]).slice(0, 12);
+  // seen-once must expire, or a false positive today blocks the real signal forever.
+  const fresh = quiet.filter(a => !st.seen[a] || Date.now() - Date.parse(st.seen[a]) > 30 * 864e5).slice(0, 12);
```
Also drop `Harvest`/`Compounded`/`Distributed` from `ABANDONED.topics` for Base, or replace them with
signatures that actually fire there.

---

## P2-7 — `runSkimScan` swallows every RPC error, advances the cursor anyway, and reports the gap as a measured null

**`experiments.mjs:80`, `:88`, `:102`, `:123`, `:153`**

```js
st.cursor[f] = (cur + take) % len;                  // walk forever, wrapping
...
try { for (const r of await agg(rpc, chain, calls)) { … } } catch { /* skip the batch */ }
...
} catch { continue; }        // meta aggregate
} catch { continue; }        // balance aggregate
...
: 'No priced excess in this slice. … Cursor advanced; the sweep continues.'
```

The cursor is committed before any pair is read, and all three RPC failure paths are silent. The
function then returns the same confident negative it returns after a clean scan.

**Demonstrated** with a stub rpc where `allPairsLength` succeeds and everything after throws:

```
cursor after run: {"0x8909…8eC6":80,"0xFDa6…a8BB":80,"0x7152…2859":80}
conclusion: "No priced excess in this slice. … Cursor advanced; the sweep continues."
-> 240 pair slots were never read, but the cursor moved past them.
```

At 80 pairs/factory/tick, one RPC hiccup permanently removes 240 pairs from the search space until a
full wrap of a 3,039,638-pair factory (measured below: ~105 days), and writes "we checked and found
nothing" into the log that the module exists to produce. This is the file's own DESIGN RULE
(`:15-16`) — *"Every run is logged with its finding AND its null result"* — producing a **fabricated**
null result.

```diff
--- a/experiments.mjs
+++ b/experiments.mjs
@@ -72,7 +72,7 @@
   for (const f of facs) {
     const cur = st.cursor[f] || 0;
+    let read = 0, failed = 0;
@@ -80,1 +80,1 @@
-    st.cursor[f] = (cur + take) % len;                  // walk forever, wrapping
@@ -84,3 +84,3 @@
-      } catch { /* skip the batch */ }
+      } catch { failed++; }
+    }
+    // Only skip pairs we actually looked at. A swallowed batch must be re-read next tick.
+    st.cursor[f] = failed ? cur : (cur + take) % len;
+    st.errors = (st.errors || 0) + failed;
@@ -150,3 +153,4 @@
-    conclusion: hits.length ? … : 'No priced excess in this slice…'
+    rpc_batches_failed: failedTotal,
+    conclusion: failedTotal ? `INCONCLUSIVE — ${failedTotal} batches failed; those pairs were NOT measured and the cursor did not advance past them.` : (hits.length ? … : 'No priced excess in this slice…')
```

---

## P2-8 — `runSkimScan` on any chain but Base returns a confident negative after zero RPC calls

**`experiments.mjs:27-36`, `:57-63`, `:68-70`** — `PRICED` and `SKIM.factories` have a `base` key and
nothing else, inside a function that takes `chain` as a parameter. `worker.mjs:627` passes the
model's own `chain` argument straight through, and `worker.mjs:1227` passes
`url.searchParams.get('chain')`.

**Demonstrated**:

```
runSkimScan(env, rpc, 'arbitrum')
  RPC calls made: 0
  conclusion: "No priced excess in this slice. Mechanism is real (measured: 2/420 pairs carried
               excess) … Cursor advanced; the sweep continues."
```

Zero calls, zero pairs, and a conclusion that cites a *Base* measurement as if it applied. ZERO earns
on base + arbitrum + polygon, so this is the one place a chain sweep would matter.

```diff
@@ -66,4 +66,8 @@
 export async function runSkimScan(env, rpc, chain = 'base', { pairs = 240 } = {}) {
+  if (!PRICED[chain] || !SKIM.factories[chain]) {
+    return { experiment: SKIM.id, chain, unsupported: true,
+      conclusion: `NOT MEASURED on ${chain}: no PRICED token table and no V2 factory list for this chain. This is a gap in the config, not a negative result.` };
+  }
```

---

## P2-9 — A **refused** `route_log` counts as a successful log (`agent.mjs` is behind its own mirror)

**`agent.mjs:178-179`**

```js
if (name === 'knowledge_write') wroteJournal = true;
if (name === 'route_log') loggedRoute = true;
```

`route_log` does not throw on refusal; it *returns* `{refused: true, logged: false, …}`
(`tools.mjs:337, 341, 346`). `worker.mjs:1043` already fixed this —
`if (name === 'route_log' && !result?.refused) state.flags.loggedRoute = true;` — the harness did not.

**Demonstrated** against the real ledger (in a redirected sandbox):

```
route_log(beefy-harvest-caller-fees, fail) -> {"refused":true,…}   agent.mjs sets loggedRoute=true | persisted: false
route_log(x402-payment-demand,      fail) -> {"refused":true,…}   agent.mjs sets loggedRoute=true | persisted: false
route_log(morpho-urd-claim-scan,    fail) -> {"refused":true,…}   agent.mjs sets loggedRoute=true | persisted: false
route_log(aerodrome-bribe-claim,    fail) -> {"logged":"…"}       agent.mjs sets loggedRoute=true | persisted: true
```

The end-of-session nudge (`agent.mjs:160`) is then suppressed and the session closes believing its
attempts are recorded when nothing was written.

```diff
-        if (name === 'route_log') loggedRoute = true;
+        if (name === 'route_log' && !result?.refused) loggedRoute = true;   // mirrors worker.mjs:1043
```

---

## P2-10 — `wroteJournal` is set by *any* knowledge write, so the continuity stub silently never fires

**`agent.mjs:178`** vs **`agent.mjs:197-206`**

```js
if (name === 'knowledge_write') wroteJournal = true;
...
if (!wroteJournal) {
  // continuity guarantee: if the agent died without journaling, the harness leaves a mechanical stub
```

The comment promises a guarantee about the *journal*; the flag tracks writes to *any* file. A session
that appends one line to `frontier` and then runs out of rounds writes nothing to `journal.md` and
gets no stub. Present identically at `worker.mjs:1042`.

```diff
-        if (name === 'knowledge_write') wroteJournal = true;
+        if (name === 'knowledge_write' && /^journal$/i.test(String(args?.name || '').replace(/\.md$/i, ''))) wroteJournal = true;
```

---

## P2-11 — A crashed session loses its journal stub **and** its session number (measured: it already happened)

**`agent.mjs:128-210`** — `runSession` has no `try/finally`. The stub write (`:203`), the final
transcript write (`:207`) and the session-counter increment (`:208`) all sit after the round loop,
unprotected. `glm()` throws after 4 retries (`:125`), and in `--loop` mode the crash is caught at
`:215` *outside* the epilogue, so the loop continues with a stale counter.

**Measured** on disk:

```
logs/session-2026-07-27T23-08-50-100Z.json  session#1  endedAt 23:10:36
logs/session-2026-07-27T23-11-57-252Z.json  session#2  endedAt 23:14:06
logs/session-2026-07-27T23-23-31-451Z.json  session#3  endedAt MISSING (crashed)  36 msgs
logs/session-2026-07-27T23-27-10-005Z.json  session#3  endedAt 23:31:14   <- number reused
logs/session-2026-07-27T23-51-14-135Z.json  session#4  endedAt 23:53:11
state/meta.json -> {"sessions": 4}          (5 transcripts on disk)
grep -c "auto-stub" knowledge/journal.md -> 0
```

Two sessions both call themselves #3, the counter is one behind, and the crashed session's 36
messages of work never reached the journal — the stub has never fired once.

```diff
-  if (!wroteJournal) { … }
-  fs.writeFileSync(logFile, jstr({…, endedAt: new Date().toISOString() }));
-  fs.writeFileSync(metaFile, jstr({ ...meta, sessions: meta.sessions + 1, … }));
+  // epilogue must run even when the model API dies mid-session — the stub IS the continuity guarantee
+  } finally {
+    if (!wroteJournal) { … }
+    fs.writeFileSync(logFile, jstr({…, endedAt: new Date().toISOString() }));
+    fs.writeFileSync(metaFile, jstr({ ...meta, sessions: meta.sessions + 1, … }));
+  }
```
(wrap the round loop from `:146` in `try {`).

---

## P2-12 — `notARoute` discards real earning attempts: `claim`, `harvest`, `skim`, `airdrop` are missing from the rescue list

**`tools.mjs:320-328`**

```js
const NON_ROUTE_RE = /(^|[-_])(budget|status|api|list|scan|health|ping|state|balance|check|…|monitor\w*|…|discover\w*|opportunit\w*|candidate\w*|demand)…/i;
...
if (/(earning|fee|reward|bount|payout|sale|tip|grant|revenue)/i.test(id)) return null;
```

`claim` — the single most common word for an on-chain earning action — is not a rescue term, and
`balance`, `scan`, `demand`, `monitor` are all kill terms.

**Measured** verdicts from the real function:

```
x402-payment-demand      REFUSED (not logged)      <- the x402 rail
morpho-urd-claim-scan    REFUSED (not logged)      <- a Morpho reward claim
sponsor-balance-sweep    REFUSED (not logged)
vault-harvest-monitor    REFUSED (not logged)
agent-alliance-fee       ok
clanker-lp-fee-claim     ok
base-builder-rewards     ok
gigs-sh-task             ok
```

A refused log is not persisted, so the agent has no memory of having tried and will retry the same
non-paying route every session. Same class as `harvest.mjs:170` dropping payers whose `callReward`
reads 0.

```diff
-  if (/(earning|fee|reward|bount|payout|sale|tip|grant|revenue)/i.test(id)) return null;
+  if (/(earning|fee|reward|bount|payout|sale|tip|grant|revenue|claim|harvest|skim|airdrop|refund|yield|interest|commission|bonus|x402|invoice)/i.test(id)) return null;
```

---

## P2-13 — the `experiment` tool declares a cost of 10 subrequests and can spend ~29 against a 26 cap

**`worker.mjs:626`** (`ctx.budget(); ctx.sub += 10;`) vs **`worker.mjs:104`** (`SLICE_SUBREQUESTS = 26`)
and **`worker.mjs:177`** (`budget()` only throws *before* the tool body runs).

`runSkimScan` issues, per call: 3 × `allPairsLength` + 3 × 2 batch aggregates + up to 10 `meta`
aggregates (`ceil(240/25)`) + up to 10 balance aggregates ≈ **up to 29 subrequests**, more on RPC
failover (`rpcCall` increments `counter.sub` once per URL attempted). Nothing inside
`experiments.mjs` ever calls `ctx.budget()`.

Consequence: with `sub = 25` the check passes, the declared `+10` takes it to 35, and the experiment
then drives it past 60 — 2.4× the slice cap — starving every other tool in that tick. Minimal fix:
pass `ctx` (or a `budget()` callback) into `runSkimScan` and check it at the top of each batch loop,
and raise the declared cost to a measured number.

---

## P2-14 — the experiment registry has no concept of a dead experiment; the "narrowing" in the comment does not exist

**`experiments.mjs:216-234`**

```js
// Rotate so every tick does a different experiment and the whole space keeps getting swept.
const REGISTRY = [ {id: SKIM.id, run: …}, {id: ABANDONED.id, run: …} ];
const pick = REGISTRY[st.n % REGISTRY.length];
```

The header says a negative *"permanently narrows the map, and the map is the compounding asset"* and
`:228-229` says the log is *"the raw material for judging whether a class is worth more."* No code
reads `st.log`. Selection is unconditional round-robin, so `abandoned-incentives` — measured above as
80% false positives on a topic set that is 75% dead on Base — keeps taking 50% of every experiment
tick forever, and no result can ever change that. Minimal fix: give each registry entry
`{ enabled, minInterval, lastFinding }` and skip an experiment with N consecutive nulls until a
config change, recording the retirement in `st.log` so it is visible.

---

## P2-15 — `knowledge_write` compares `mode` case-sensitively and accepts invalid modes silently

**`tools.mjs:260`** — `if (mode === 'overwrite') … else append`. **Demonstrated**:

```
knowledge_write(..., mode:"Overwrite") -> {"saved":"casing-test.md","mode":"Overwrite","bytes":13}
   file content is now "FIRST\n\nSECOND"      <- overwrite silently became append
knowledge_write(..., mode:"replace")   -> {"saved":"casing-test.md","mode":"replace","bytes":20}
   no error; the model is told its mode was honoured
```

The returned `mode` echoes the model's input, so the model has no way to detect the miss. An
`overwrite` intended to *replace* a stale recovery playbook instead appends a contradicting copy
underneath it.

```diff
-  if (mode === 'overwrite') fs.writeFileSync(p, content.slice(0, 100000));
-  else fs.appendFileSync(p, (fs.existsSync(p) ? '\n\n' : '') + content.slice(0, 100000));
-  return { saved: path.basename(p), mode, bytes: fs.statSync(p).size };
+  const m = String(mode).toLowerCase();
+  if (!['append', 'overwrite'].includes(m)) throw new Error(`mode must be "append" or "overwrite" (got "${mode}")`);
+  if (m === 'overwrite') fs.writeFileSync(p, content.slice(0, 100000));
+  else fs.appendFileSync(p, (fs.existsSync(p) ? '\n\n' : '') + content.slice(0, 100000));
+  return { saved: path.basename(p), mode: m, bytes: fs.statSync(p).size };
```

---

## P2-16 — the system prompt is 89 KB and prioritises the *oldest* material; the journal gets 3%

**`agent.mjs:31-85`** — `genesis` + `recovery` + `phases` + `frontier` are injected **in full**;
only the journal is truncated, to `slice(-3000)`.

**Measured** against the real knowledge dir:

```
genesis      31,697 chars       frontier     33,407 chars
phases       18,718 chars       recovery      2,567 chars
journal_tail  3,000 chars   (journal.md is 100,000 chars — 3.0% is shown)
--------------------------------------------------------------
system prompt ≈ 89,389 chars ≈ 22,347 tokens, resent EVERY round
              ≈ 670k input tokens per 30-round session, system block alone
```

`frontier` alone (33 KB, the file of untested hypotheses) is 11× the budget given to the journal (the
file of what actually happened). This is the most plausible mechanism for the free-tier exhaustion
that produced the crash in P2-11. Minimal fix: cap each block (`genesis` 12 KB from the head,
`frontier` 8 KB from the **tail**, `phases` 6 KB) and give the journal 12 KB of tail; tell the model
the rest is reachable through `knowledge_read` (once P1-3 makes that true).

---

## P2-17 — the skim sweep gives a 3,039,638-pair factory the same 80 slots/tick as a 6,031-pair one

**`experiments.mjs:77`** — `const take = Math.ceil(pairs / facs.length);` → 80 each.

**Measured** `allPairsLength()` on Base:

```
UniswapV2   0x8909Dc15…18eC6 -> 3,039,638
BaseSwap    0xFDa619b6…a8BB  ->     8,234
SushiSwapV2 0x71524B4f…2859  ->     6,031
```

BaseSwap wraps every 103 ticks and Sushi every 76, so ~67% of every tick's RPC budget re-reads the
same ~14 k pairs the sweep saw hours earlier, while Uniswap V2 needs **37,996 ticks** — with skim
running every other 2-minute cron, ≈ **105 days** — for a single pass. The `st.checked` counter
(`:126`, surfaced as `priced_pairs_checked`) double-counts every re-read, so it reads as coverage
while measuring repetition. Minimal fix: allocate `take` proportional to `len`, and track coverage as
`cursor/len` per factory rather than a cumulative counter.

---

## P2-18 — `tools.mjs` knows two chains; ZERO earns on at least three

**`tools.mjs:14-27`** defines only `base` and `base-sepolia`. `worker.mjs` defines `base`,
`base-sepolia`, `optimism`, `arbitrum` (and `worker.mjs:619` hardcodes reward tokens for `polygon`
and `gnosis`). In the local harness `get_status`, `eth_call` and `explorer` therefore cannot see or
touch the Arbitrum/Polygon side of the rail, and `eth_call` throws
`unknown chain "arbitrum" — valid: base, base-sepolia`. Add the missing entries or import the
Worker's `CHAINS`.

## P2-19 — `get_status` reports `broke: true` when an RPC merely fails, and ignores tokens

**`tools.mjs:144`** — `out.broke = Object.values(out.chains).every(c => !c.eth || parseFloat(c.eth) === 0);`
A chain whose provider errored gets `{error: …}` with no `.eth`, which satisfies `!c.eth` and counts
as broke. Token balances (`:137`) are excluded entirely, even though the harvest rail pays in **WETH** —
`worker.mjs:207-212` documents exactly this bug being fixed in the Worker ("it returned broke:true for
39 straight sessions AFTER the agent had already done the one thing it was born to do"). The harness
still has it. Fix: treat an errored chain as `unknown`, not zero, and include priced token balances.

## P2-20 — `send_tx` sends the raw `estimateGas` result with no headroom

**`tools.mjs:211/220`** (`gas = await p.estimateGas(...)` → `gasLimit: gas`), mirrored at
`worker.mjs:332/345`. Any state change between estimate and inclusion — pending rewards growing, a
first-touch storage slot — makes the real execution cost more than the estimate and the transaction
reverts out-of-gas, burning the full gas limit from a wallet whose lifetime income is $0.08.
*Inferred, not observed:* I found no OOG receipt in this repo's logs. Standard fix `gas * 12n / 10n`.

---

## P3 (correct-but-cosmetic)

* **`tools.mjs:302` vs `:357`** — two different human-gate regexes for the same concept. The
  persistent one (`:357`) omits `human verification`, `sign up with`, `email verification`,
  `phone verification`, so a route noted "requires email verification" is dead only while that note
  is inside the 5-item `notes` window (`:356`); six notes later it silently resurrects.
* **`tools.mjs:274`** — `secret_store` refuses `0x`+64 hex but not a BIP-39 mnemonic, which
  `ensure_wallet` (`:101`) also writes to disk. Add a 12/24-word check.
* **`agent.mjs:120-123`** — the retry loop sleeps *after* the final attempt, adding a pointless 45 s
  before the throw. `if (i < retries - 1) await …`.
* **`agent.mjs:147`** — `round === MAX_ROUNDS - 5` never matches when `MAX_ROUNDS <= 5`, and a single
  shared `nudged` flag means an early-signoff nudge consumes the wrap-up nudge. Use `>=` plus two flags.
* **`experiments.mjs:226`** — `String(e.message)` logs `"undefined"` for a thrown non-Error, and a
  thrown `null` makes the catch *itself* throw, so that tick is never logged and `st.n` never
  advances — the same experiment reruns. Use `String(e?.message ?? e)`.
* **`experiments.mjs:29-34`** — hardcoded USD prices (WETH 1920, wstETH 2280, cbETH 2050) with no
  date and no refresh; every `usd` figure the module reports is priced off them.

---

## Verified NOT broken (checked, correct — do not re-check)

* **`TOOL_DEFS` ↔ `TOOL_IMPL` parity is exact.** All 15 names match 1:1, no ghost tools, no orphan
  handlers, and every declared property is destructured by its handler. (My first automated parity
  pass flagged `http_fetch` for `body`/`max_chars`/`raw`; that was an artifact of my own regex
  stopping at the `headers = {}` default — the handler does accept all three.)
* **The `.map(f => ({type:'function', function:f}))` wrapper** at `tools.mjs:387` produces the correct
  OpenAI/GLM tool-call shape.
* **`NEVER_TOUCH`** (`tools.mjs:30-33`) matches both operator-blocklisted addresses exactly, stored
  lowercase and compared with `.toLowerCase()` at `:201`.
* **Multicall3 batch sizes are legal.** `experiments.mjs` issues aggregate3 batches of 60, 75
  (25 pairs × 3) and 50 (25 × 2) calls — all under the ≤100 guidance.
* **ABI decoding offsets in `experiments.mjs` are correct.** `returnData.slice(26)` for an address
  (2 + 24 zero-nibbles), `slice(2,66)` / `slice(66,130)` for `getReserves`' two `uint112`s, and
  `balOf()`'s selector + 24-zero pad all check out.
* **`PRICED` keys are lowercase** and are compared against lowercased token addresses (`:108-111`) —
  no casing mismatch here.
* **900-block `eth_getLogs` windows are within provider limits.** Measured: Base public RPC accepts
  900-block topic-only queries and rejects 100,000 with
  `{"code":-32614,"message":"eth_getLogs is limited to a 10,000 range"}`. Any widening of
  `runAbandonScan` must page in ≤10,000-block chunks.
* **The V2 factory index walk does not duplicate.** I suspected `take` (80) could exceed
  `allPairsLength` on a small factory and re-scan the same pairs every tick; measured smallest is
  SushiSwapV2 at 6,031 ≫ 80, so the modulo walk is clean. Falsified.
* **`experimentTick` does log every result, including failures** (`experiments.mjs:225-232`) — the
  lane question "can an experiment run without logging its result" is *no*, except for the thrown-null
  edge case in P3 above.
* **`rpcCall` really does count subrequests** (`worker.mjs:72`, `counter.sub++` per URL attempt), so
  the `ctx.sub += N` pre-charges are over-counting, not under-counting; P2-13 is about the missing
  *mid-call* check, not about uncounted requests.
* **`route_log`'s `CLOSED_CATEGORY` faucet ban and the `normId` dead-twin lookup work as documented**
  (`tools.mjs:336`, `:343`), including the deliberate `bount`-not-`bounty` and whole-token
  `gig|job|task` rescues at `:324-326`.
* **`kpath()` sanitisation** (`tools.mjs:236-240`) is path-traversal safe: `[^a-z0-9_-]` → `-` strips
  `/`, `\` and `..`.

---

## Reproduction

All probes are read-only and live in the scratchpad (nothing in the repo was modified):

```
…/scratchpad/prove_isdead.mjs   P0-1: tools.mjs isDead vs worker.mjs isDead on the real ledger
…/scratchpad/probe2.mjs         allPairsLength × 3, eth_call from-dependence, getLogs topics/limits
…/scratchpad/probe3.mjs         runSkimScan on an unsupported chain / total RPC failure / cursor drift
…/scratchpad/probe4.mjs         runAbandonScan false-positive rate against a 10,000-block liveness check
…/scratchpad/probe5.mjs         schema↔impl parity, knowledge_write casing, route_log refusals, notARoute
…/scratchpad/probe6.mjs         knowledge_read head-vs-tail clipping on the real knowledge files
```

`probe5` redirects `AUTOGLM_HOME`/`AUTOGLM_SECRETS`/`AUTOGLM_CREDS` into a sandbox before importing
`tools.mjs`, so the repo's `state/` and the operator secrets store were never written.
