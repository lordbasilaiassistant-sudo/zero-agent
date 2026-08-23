// sweep.mjs — the consolidation rail, EXECUTED. Tributary WETH → USDC → CCTP burn → USDC minted
// at the Safe on Base, where the one permissionless token paymaster accepts it as gas.
//
// treasury.mjs PLANS this ("read-only — it never moves funds itself") and for the project's whole
// life nothing executed the plan — the same class of gap as the escape's "send this yourself" note:
// judgement parked on a model that was never going to act. Optimism sat at 147% of its sweep
// threshold with nothing moving. This file is the executor.
//
// Why the threshold logic changed: treasury's costUsd numbers assume ZERO pays gas. It does not —
// the source leg rides a FREE Safe relay slot, so the marginal cost of a sweep is one slot, not
// $0.000346. The only question is whether the amount is worth a slot (minSweepUsd).
//
// EVERYTHING BELOW WAS MEASURED 2026-07-30, not recalled:
//   * CCTP v2 (same addresses on OP and Base, from Circle docs, bytecode verified on both chains):
//       TokenMessengerV2     0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d
//       MessageTransmitterV2 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64
//       impl (EIP-1967) depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32),
//       receiveMessage(bytes,bytes). Domains: optimism=2, base=6.
//   * SwapRouter02 on OP 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 (verified source, name match);
//     exactInputSingle takes a 7-field tuple, NO deadline. WETH/USDC 0.05% pool holds ~$73k USDC.
//   * Iris v2 attestation API: GET https://iris-api.circle.com/v2/messages/{srcDomain}?transactionHash=
//     (404s structurally on unknown hashes; 'complete' status carries message+attestation).
//   * The FULL four-leg batch (approve router → exactInputSingle → approve TokenMessenger →
//     depositForBurn) simulated CLEAN as the Safe via eth_call state-override on 2026-07-30 with the
//     live balance ($0.0102 → 9,893 USDC units).
//
// SIMULATION NOTE: batchHarvest's `{to: MULTISEND, from: safe}` eth_call is fine for harvest()
// calls (payee is a parameter) but WRONG for approve/swap legs, where msg.sender must be the Safe.
// The faithful sim is a state-override call: put MultiSendCallOnly's runtime code AT the Safe's
// address, then call the Safe directly — inner calls then genuinely come FROM the Safe.
import { ethers } from 'ethers';
import { relayExec, relayStatus, pickChain, wethBalance, MULTISEND, CHAINS, simulateMultiSendAsSafe } from './harvest.mjs';
import { mutateKV } from './kv.mjs';

export const SWEEP_RAIL = {
  tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  baseDomain: 6,
  iris: 'https://iris-api.circle.com/v2/messages',
  // Per-source-chain swap facts. Optimism first (it is the tributary that actually fills);
  // add a chain only after its router+pool+USDC are VERIFIED the same way.
  // ── ALL VERIFIED ON-CHAIN 2026-08-12, each with a CONTROL that reverts ─────────────────────────
  // Only optimism was ever configured here. That — not chain physics — is the entire reason
  // arbitrum's $0.0539 and polygon's $0.0102 had no route home: sweepCycle never looked at them.
  //
  // Every entry below was proven by simulating the full 4-leg batch as the Safe (MultiSendCallOnly
  // code state-overridden at the Safe address, so inner calls carry msg.sender = safe), and by two
  // controls that MUST fail — because a simulation that cannot fail is not measuring anything:
  //   CONTROL 1: amountOutMinimum at 100x spot  -> REVERT (proves the swap really executes)
  //   CONTROL 2: burn the BRIDGED USDC.e        -> REVERT (TokenMinter burnLimitsPerMessage = 0)
  //
  // ⚠️ NATIVE vs BRIDGED USDC: both answer symbol() = "USDC". They are told apart ONLY by name()
  // and by TokenMinterV2.burnLimitsPerMessage() — 10,000,000 USDC for native, 0 for bridged. Getting
  // this wrong means depositForBurn reverts forever on a token that looks correct in every explorer.
  //
  // ⚠️ CCTP domains were READ, not recalled: MessageTransmitterV2.localDomain() on two independent
  // RPCs each. optimism 2 · arbitrum 3 · base 6 · polygon 7. TokenMessengerV2 does NOT expose
  // localDomain() at all (selector absent from its implementation dispatch table) — read it off the
  // MessageTransmitter.
  sources: {
    optimism: {
      domain: 2,
      usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',   // native USDC (FiatTokenProxy, verified)
      router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',  // SwapRouter02 (verified)
      poolFee: 500,
    },
    arbitrum: {
      domain: 3,                                             // MessageTransmitterV2.localDomain() = 3
      usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',    // name "USD Coin", burn limit 10M -> BURNABLE
      router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',  // SwapRouter02, WETH9() matches CHAINS.arbitrum.weth
      poolFee: 500,
      // Batch SUCCESS on two RPCs at block 0x1d6f2ad8, gas 286,366. QuoterV2 said 53,902 USDC units
      // out for the live 28503373015195 wei — nowhere near dust-rounding.
    },
    polygon: {
      domain: 7,                                             // MessageTransmitterV2.localDomain() = 7
      usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',    // name "USD Coin", burn limit 10M -> BURNABLE
      router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',  // SwapRouter02, exactInputSingle 0x04e45aaf present
      poolFee: 500,                                          // DEEPEST pool: 1.64M WPOL / $28.8k USDC
      // ⚠️ POLYGON IS THE ODD ONE OUT AND IT BREAKS THE NAIVE MENTAL MODEL. Optimism and Arbitrum
      // are ETH-native, so their wrapped native IS what Base wants. Polygon's native token is POL,
      // not ether — CHAINS.polygon.weth points at WPOL ("Wrapped Polygon Ecosystem Token"), which is
      // worth ~$0.074, not ~$1890. There is no "unwrap and bridge" here; it MUST swap to USDC first,
      // which is exactly what this rail already does for every chain, so the route is the same — but
      // any future code that assumes wrapped-native ≈ ETH will be wrong by ~25,000x on this chain.
      // Full batch simulated SUCCESS: 0.1379 WPOL -> outMin 9,946 units -> burn 9,946.
    },
  },
  minSweepUsd: 0.005,     // below this, the amount is not worth a relay slot
  slippage: 0.97,         // amountOutMinimum = spot * this; burn amount = the same (residue re-sweeps)
  // No attestation honestly takes this long. Past it, a pending entry is a wedge, not a wait.
  pendingGiveUpHours: 6,
};

const I = (sig) => new ethers.Interface([sig]);
const packCall = (to, data) => {
  const d = data.slice(2);
  return '00' + to.slice(2).toLowerCase() + '0'.repeat(64) + (d.length / 2).toString(16).padStart(64, '0') + d;
};

// Faithful whole-batch simulation now lives in harvest.mjs as simulateMultiSendAsSafe, so the escape
// funnel and this rail share ONE implementation. Same semantics: MultiSendCallOnly's code at the
// Safe's address, so inner calls carry msg.sender = safe exactly as the real DELEGATECALL will.
const simulateAsSafe = simulateMultiSendAsSafe;

// A CCTP message can only ever be minted ONCE — MessageTransmitter records the nonce in a usedNonces
// mapping and reverts on a repeat. So these revert reasons are not failures to retry, they are proof
// the delivery ALREADY HAPPENED (by us, or by anyone: receiveMessage is permissionless, which is the
// whole reason we chose CCTP).
//
// MEASURED 2026-08-12 from the live cron log — this ran every 2 minutes for hours:
//   sweep: {"pending":1,"mint_error":"...execution reverted: Nonce already used"}
// and because `if (state.pending.length) return out` sits above LEG A, one already-completed message
// held the ENTIRE cross-chain consolidation rail shut. Optimism sat at 559% of its sweep threshold
// with sweep_ready:true and nothing moved. The retry was not just useless, it was the blocker.
const ALREADY_DELIVERED = /nonce already used|message already received|already used|invalid nonce/i;

// Uniswap QuoterV2 — the SAME address on optimism, arbitrum and polygon. VERIFIED 2026-08-12 on all
// three: 8,273 code bytes, factory() == the local SwapRouter02's factory(), and WETH9() == that
// chain's wrapped native. It is an eth_call, so it needs no key, no account, and no permission, and
// unlike a price endpoint it returns the EXECUTABLE price rather than a spot quote.
const QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

// Returns amountOut in the output token's units, or null when the pool cannot answer.
// NULL MEANS UNPRICED, NEVER ZERO — the caller must not treat it as "worth nothing".
async function quoteOut(rpc, chain, tokenIn, tokenOut, fee, amountIn) {
  const iface = new ethers.Interface([
    'function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)',
  ]);
  try {
    const ret = await rpc(chain, 'eth_call', [{
      to: QUOTER_V2,
      data: iface.encodeFunctionData('quoteExactInputSingle', [[tokenIn, tokenOut, amountIn, fee, 0n]]),
    }, 'latest']);
    const out = iface.decodeFunctionResult('quoteExactInputSingle', ret)[0];
    return out > 0n ? out : null;
  } catch { return null; }
}

export async function sweepCycle(env, rpc, safe, { escapeNeedsBase = null } = {}) {
  const state = (await env.KV.get('sweep:state', 'json')) || { pending: [], done: [] };
  const out = { pending: state.pending.length };

  // ── LEG B: deliver any attested burn to Base (permissionless receiveMessage, one relay slot).
  // The escape owns Base until it is finished; the mint can always wait — attestations do not expire.
  // ── THE GATE, FIXED 2026-08-12 ────────────────────────────────────────────────────────────────
  // This used to read `hs.escaped` — and the comment above claimed it meant "the escape owns Base
  // until it is finished". It means nothing of the sort. `escaped` is a STICKY BOOLEAN set from an
  // HTTP 201 (relay ACCEPTED, not landed) the first time a funnel ever relayed, and never reset. So:
  //   * before the first funnel it is false, and LEG B is skipped — while `if (state.pending.length)
  //     return out` below blocks LEG A too, wedging the ENTIRE rail with money already burned at the
  //     source and no code path able to deliver it.
  //   * after the first funnel it is permanently true, so it protects nothing: the mint can grab the
  //     very Base slot the escape is waiting on, which is the exact trade the cron forbids.
  // worker.mjs already diagnosed this identical variable in the harvest_run path and migrated to the
  // live `escape:needsBase` flag; this file was simply never updated. Same rule now, same 15-minute
  // freshness: missing or stale means the cron is not currently reserving Base, so fail OPEN.
  let holdBase = escapeNeedsBase;
  if (holdBase === null) {
    const escv = (await env.KV.get('escape:needsBase', 'json')) || null;
    holdBase = !!(escv && escv.v === true && Date.now() - (escv.at || 0) < 15 * 60 * 1000);
  }
  if (state.pending.length && !holdBase) {
    const p = state.pending[0];
    // Resolve the burn tx hash if the relay had not surfaced it yet when the burn leg ran.
    // F5 FIX: `relayStatus.status` was fetched and never read, so a task stuck in
    // ExecReverted/Cancelled looked exactly like a slow one and blocked LEG A forever. Count polls,
    // read terminal states, and retire dead entries so the rail keeps moving.
    p.polls = (p.polls || 0) + 1;
    if (!p.tx && p.taskId) {
      try {
        const st = await relayStatus(p.taskId, CHAINS[p.chain].chainId);
        if (st.tx) p.tx = st.tx;
        p.lastStatus = st.status;
        if (/revert|cancel|fail|expired/i.test(String(st.status || ''))) p.dead = true;
      } catch { /* next tick */ }
    }
    if (!p.tx && (p.dead || p.polls > 60)) {   // 60 ticks ≈ 2h at */2min — no honest burn waits that long
      state.done.unshift({ ...p, abandoned: true, reason: p.dead ? `relay task ${p.lastStatus}` : 'no tx hash after 60 polls', at: new Date().toISOString() });
      state.done = state.done.slice(0, 20);
      state.pending.shift();
      await mutateKV(env, 'sweep:state', () => ({ ...state }), { fallback: { pending: [], done: [] } });
      out.pending_abandoned = `burn task never produced a tx (${p.dead ? p.lastStatus : `${p.polls} polls`}) — retired so LEG A is not blocked forever. INVESTIGATE chain ${p.chain}, usd $${p.usd}.`;
      return out;
    }
    // ── F4 FIX: confirm a previously-submitted MINT before anything else. 201 from the relay means
    // "task accepted", not "receiveMessage executed" — marking minted:true there deleted the only
    // record holding the burn's tx hash + source domain, i.e. the only retry path for USDC that
    // had already been burned on the source chain. Nothing leaves `pending` without a status-1 receipt.
    if (!p.minted && p.mintTaskId && !p.mintConfirmed) {
      try {
        const st = await relayStatus(p.mintTaskId, 8453).catch(() => ({}));
        if (st.tx) {
          const rc = await rpc('base', 'eth_getTransactionReceipt', [st.tx]).catch(() => null);
          if (rc && String(rc.status) === '0x1') {
            state.done.unshift({ ...p, minted: true, mintTx: st.tx, at: new Date().toISOString() });
            state.done = state.done.slice(0, 20);
            state.pending.shift();
            out.minted = st.tx;
            await mutateKV(env, 'sweep:state', () => ({ ...state }), { fallback: { pending: [], done: [] } });
            return out;
          }
          if (rc) { p.mintTaskId = null; out.mint_reverted = st.tx; }   // fall through: re-deliver next tick
        }
      } catch { /* confirmation is best-effort this tick; the record stays */ }
    }
    if (p.tx) {
      try {
        const r = await fetch(`${SWEEP_RAIL.iris}/${SWEEP_RAIL.sources[p.chain].domain}?transactionHash=${p.tx}`,
          { headers: { 'User-Agent': 'zero-agent/0.4' } });
        const j = r.ok ? await r.json() : null;
        const m = j?.messages?.find(x => x.status === 'complete' && x.message && x.attestation);
        if (m) {
          const data = I('function receiveMessage(bytes,bytes)').encodeFunctionData('receiveMessage', [m.message, m.attestation]);
          await rpc('base', 'eth_call', [{ to: SWEEP_RAIL.messageTransmitter, data, from: safe }, 'latest']);
          const { all } = await pickChain(safe);
          const slot = all.find(c => c.name === 'base');
          if (slot && typeof slot.remaining === 'number' && slot.remaining > 0) {
            const sent = await relayExec(env, rpc, safe, SWEEP_RAIL.messageTransmitter, data, 'base', 8453, 0);
            if (sent.ok) {
              // F4 FIX: 201 = the RELAY ACCEPTED THE TASK. Keep the pending entry (it holds the
              // burn tx hash and source domain — the only way to re-derive the attestation) until
              // the confirmation block above sees a status-1 receipt for receiveMessage.
              p.mintTaskId = sent.taskId;
              p.mintSentAt = Date.now();
              out.mint_submitted = sent.taskId;
            } else out.mint_error = sent.error;
          } else out.mint_waiting = 'no base slot';
        } else out.attestation = j?.messages?.[0]?.status || 'not yet indexed';
      } catch (e) {
        const msg = String(e.message);
        if (ALREADY_DELIVERED.test(msg)) {
          // Not an error — a receipt. The USDC is already at the Safe on Base; somebody delivered it.
          // Retire the entry so LEG A can run again instead of being blocked forever by a success.
          state.done.unshift({ ...p, minted: true, delivered_by: 'already on-chain (nonce consumed) — no slot spent', at: new Date().toISOString() });
          state.done = state.done.slice(0, 20);
          state.pending.shift();
          out.mint_already_delivered = true;
          out.note = 'CCTP message was already minted on Base — cleared from pending. The rail is unblocked; no relay slot was spent.';
        } else {
          out.mint_error = msg.slice(0, 140);
          // A pending entry must never be able to wedge the rail permanently. If it has been stuck
          // for longer than any honest attestation delay, retire it and say so out loud rather than
          // retrying into eternity — the whole rail is downstream of this one queue slot.
          const ageH = (Date.now() - Date.parse(p.at || 0)) / 3600000;
          if (Number.isFinite(ageH) && ageH > SWEEP_RAIL.pendingGiveUpHours) {
            state.done.unshift({ ...p, abandoned: true, reason: msg.slice(0, 200), age_hours: +ageH.toFixed(1), at: new Date().toISOString() });
            state.done = state.done.slice(0, 20);
            state.pending.shift();
            out.pending_abandoned = `stuck ${ageH.toFixed(1)}h, exceeded ${SWEEP_RAIL.pendingGiveUpHours}h — retired so the rail can move. Investigate: ${msg.slice(0, 120)}`;
          }
        }
      }
    }
    // LEG B has just fetched an attestation and possibly relayed. Re-read before writing: the
    // invariant checker repairs this same key from a concurrent path.
    await mutateKV(env, 'sweep:state', () => state, { fallback: { pending: [], done: [] } });
    if (out.minted) return out;   // a slot was spent this tick; the burn leg can wait
  }

  // ── LEG A: burn on a ready tributary. One in-flight burn at a time keeps this auditable.
  if (state.pending.length) return out;
  for (const [chain, cfg] of Object.entries(SWEEP_RAIL.sources)) {
    try {
      const weth = CHAINS[chain].weth;
      const bal = await wethBalance(rpc, safe, chain, weth);
      if (bal === 0n) { out[chain] = 'empty'; continue; }

      // ── PRICE THE SWAP ON-CHAIN, NOT FROM A FEED ───────────────────────────────────────────────
      // This used to size amountOutMinimum from nativeUsd(), an HTTP price endpoint. Two problems,
      // both of which fired: (1) `price || 0` turned any feed hiccup into $0, which fell under
      // minSweepUsd and printed "accumulating ($0.000000)" — indistinguishable from an empty chain,
      // and Polygon's feed returns nothing at random, so its $0.0102 was invisible half the time;
      // (2) even working, a spot price is not an executable price — the pool decides, not the API.
      //
      // QuoterV2 answers both. It is an eth_call against the same factory the router uses (verified
      // 2026-08-12: same 0x61fFE014… on optimism/arbitrum/polygon, factory() matching each chain's
      // SwapRouter02, WETH9() matching each chain's wrapped native), so it needs no key and cannot
      // go stale. And because the quote is denominated in USDC, THE QUOTE IS THE DOLLAR VALUE —
      // the economic test no longer needs a price feed at all.
      const quoted = await quoteOut(rpc, chain, weth, cfg.usdc, cfg.poolFee, bal);
      if (quoted === null) {
        out[chain] = `QUOTE UNAVAILABLE — holds ${bal} wei, not swept this tick. This is NOT zero, it is unmeasured; a slot is never spent on an unpriced swap.`;
        continue;
      }
      const usd = Number(quoted) / 1e6;   // USDC is a dollar by construction
      if (usd < SWEEP_RAIL.minSweepUsd) { out[chain] = `accumulating ($${usd.toFixed(6)} of $${SWEEP_RAIL.minSweepUsd}, quoted on-chain)`; continue; }

      const outMin = quoted * BigInt(Math.round(SWEEP_RAIL.slippage * 1000)) / 1000n;
      if (outMin <= 0n) { out[chain] = `swap output rounds to zero USDC units at $${usd.toFixed(6)} — accumulate`; continue; }

      // ── THE RESIDUE BUG (measured 2026-08-12) ──────────────────────────────────────────────────
      // The burn amount used to be `outMin`, the 3%-slippage FLOOR of the swap — so every sweep left
      // (actualOut - outMin) behind, and it never came back: the next sweep would again burn only
      // its own floor. Measured leftovers: 299 USDC units already sitting on the optimism Safe, and
      // this rail would have stranded ~1,591 on arbitrum and ~308 on polygon per sweep.
      // Fix: burn whatever USDC the Safe ALREADY holds PLUS the guaranteed minimum from this swap.
      // That is always available (actualOut >= outMin), so the batch cannot revert on it, and each
      // sweep now clears every previous run's residue instead of accumulating a growing dust pile.
      let priorUsdc = 0n;
      try { priorUsdc = await wethBalance(rpc, safe, chain, cfg.usdc); } catch { /* treat as 0 */ }
      const burnAmount = priorUsdc + outMin;

      const legs = [
        [weth, I('function approve(address,uint256)').encodeFunctionData('approve', [cfg.router, bal])],
        [cfg.router, I('function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)')
          .encodeFunctionData('exactInputSingle', [[weth, cfg.usdc, cfg.poolFee, safe, bal, outMin, 0]])],
        [cfg.usdc, I('function approve(address,uint256)').encodeFunctionData('approve', [SWEEP_RAIL.tokenMessenger, burnAmount])],
        [SWEEP_RAIL.tokenMessenger, I('function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)')
          // destinationCaller = 0 (anyone may deliver), maxFee = 0 + threshold 2000 = standard (free) transfer
          .encodeFunctionData('depositForBurn', [burnAmount, SWEEP_RAIL.baseDomain, ethers.zeroPadValue(safe, 32), cfg.usdc, ethers.ZeroHash, 0, 2000])],
      ];
      const msData = I('function multiSend(bytes) payable').encodeFunctionData('multiSend', ['0x' + legs.map(([t, d]) => packCall(t, d)).join('')]);
      await simulateAsSafe(rpc, chain, safe, msData);

      const { all } = await pickChain(safe);
      const slot = all.find(c => c.name === chain);
      if (!slot || typeof slot.remaining !== 'number') { out[chain] = `burn ready ($${usd.toFixed(4)}), relay quota UNREADABLE this tick (${slot?.error || 'no reading'}) — not the same as exhausted`; continue; }
      if (slot.remaining < 1) { out[chain] = `burn ready ($${usd.toFixed(4)}), no relay slot`; continue; }

      const sent = await relayExec(env, rpc, safe, MULTISEND, msData, chain, CHAINS[chain].chainId, 1); // DELEGATECALL
      if (sent.ok) {
        const p = { chain, taskId: sent.taskId, tx: null, usd: +usd.toFixed(6), burn_units: burnAmount.toString(), prior_residue_swept: priorUsdc.toString(), at: new Date().toISOString() };
        // F15 FIX: this used to be six 5-second sleeps — up to 30s blocking the cron ahead of the
        // escape's successors and all six batch calls in the same waitUntil. Two attempts max; the
        // tick loop re-resolves p.tx on the next pass anyway.
        try { for (let i = 0; i < 2 && !p.tx; i++) { await new Promise(r => setTimeout(r, 5000)); const st = await relayStatus(sent.taskId, CHAINS[chain].chainId); if (st.tx) p.tx = st.tx; } } catch { /* resolved next tick */ }
        state.pending.push(p);
        // Up to 30s of relay-status polling happened above; re-read before committing.
        await mutateKV(env, 'sweep:state', () => state, { fallback: { pending: [], done: [] } });
        out.burned = p;
        return out;   // one slot per tick
      }
      out[chain] = 'relay refused: ' + (sent.error || 'unknown');
    } catch (e) { out[chain] = 'error: ' + String(e.message).slice(0, 140); }
  }
  return out;
}
