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
import { relayExec, relayStatus, pickChain, wethBalance, nativeUsd, MULTISEND, CHAINS } from './harvest.mjs';

export const SWEEP_RAIL = {
  tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  baseDomain: 6,
  iris: 'https://iris-api.circle.com/v2/messages',
  // Per-source-chain swap facts. Optimism first (it is the tributary that actually fills);
  // add a chain only after its router+pool+USDC are VERIFIED the same way.
  sources: {
    optimism: {
      domain: 2,
      usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',   // native USDC (FiatTokenProxy, verified)
      router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',  // SwapRouter02 (verified)
      poolFee: 500,
    },
  },
  minSweepUsd: 0.005,     // below this, the amount is not worth a relay slot
  slippage: 0.97,         // amountOutMinimum = spot * this; burn amount = the same (residue re-sweeps)
};

const I = (sig) => new ethers.Interface([sig]);
const packCall = (to, data) => {
  const d = data.slice(2);
  return '00' + to.slice(2).toLowerCase() + '0'.repeat(64) + (d.length / 2).toString(16).padStart(64, '0') + d;
};

// Faithful whole-batch simulation: MultiSendCallOnly's code at the Safe's address, so inner calls
// carry msg.sender = safe exactly as the real DELEGATECALL execution will.
async function simulateAsSafe(rpc, chain, safe, msData) {
  const msCode = await rpc(chain, 'eth_getCode', [MULTISEND, 'latest']);
  await rpc(chain, 'eth_call', [
    { from: '0x00000000000000000000000000000000000000aa', to: safe, data: msData },
    'latest',
    { [safe]: { code: msCode } },
  ]);
}

export async function sweepCycle(env, rpc, safe) {
  const state = (await env.KV.get('sweep:state', 'json')) || { pending: [], done: [] };
  const out = { pending: state.pending.length };

  // ── LEG B: deliver any attested burn to Base (permissionless receiveMessage, one relay slot).
  // The escape owns Base until it is finished; the mint can always wait — attestations do not expire.
  const hs = (await env.KV.get('harvest:state', 'json')) || {};
  if (state.pending.length && hs.escaped) {
    const p = state.pending[0];
    // Resolve the burn tx hash if the relay had not surfaced it yet when the burn leg ran.
    if (!p.tx && p.taskId) {
      try { const st = await relayStatus(p.taskId, CHAINS[p.chain].chainId); if (st.tx) p.tx = st.tx; } catch { /* next tick */ }
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
          if (slot && slot.remaining > 0) {
            const sent = await relayExec(env, rpc, safe, SWEEP_RAIL.messageTransmitter, data, 'base', 8453, 0);
            if (sent.ok) {
              state.done.unshift({ ...p, minted: true, mintTaskId: sent.taskId, at: new Date().toISOString() });
              state.done = state.done.slice(0, 20);
              state.pending.shift();
              out.minted = true;
            } else out.mint_error = sent.error;
          } else out.mint_waiting = 'no base slot';
        } else out.attestation = j?.messages?.[0]?.status || 'not yet indexed';
      } catch (e) { out.mint_error = String(e.message).slice(0, 140); }
    }
    await env.KV.put('sweep:state', JSON.stringify(state));
    if (out.minted) return out;   // a slot was spent this tick; the burn leg can wait
  }

  // ── LEG A: burn on a ready tributary. One in-flight burn at a time keeps this auditable.
  if (state.pending.length) return out;
  for (const [chain, cfg] of Object.entries(SWEEP_RAIL.sources)) {
    try {
      const weth = CHAINS[chain].weth;
      const bal = await wethBalance(rpc, safe, chain, weth);
      const price = await nativeUsd(chain);
      const usd = Number(bal) / 1e18 * (price || 0);
      if (usd < SWEEP_RAIL.minSweepUsd) { out[chain] = `accumulating ($${usd.toFixed(6)})`; continue; }

      const outMin = BigInt(Math.floor(Number(bal) / 1e18 * price * SWEEP_RAIL.slippage * 1e6));
      if (outMin <= 0n) continue;
      const legs = [
        [weth, I('function approve(address,uint256)').encodeFunctionData('approve', [cfg.router, bal])],
        [cfg.router, I('function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)')
          .encodeFunctionData('exactInputSingle', [[weth, cfg.usdc, cfg.poolFee, safe, bal, outMin, 0]])],
        [cfg.usdc, I('function approve(address,uint256)').encodeFunctionData('approve', [SWEEP_RAIL.tokenMessenger, outMin])],
        [SWEEP_RAIL.tokenMessenger, I('function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)')
          // destinationCaller = 0 (anyone may deliver), maxFee = 0 + threshold 2000 = standard (free) transfer
          .encodeFunctionData('depositForBurn', [outMin, SWEEP_RAIL.baseDomain, ethers.zeroPadValue(safe, 32), cfg.usdc, ethers.ZeroHash, 0, 2000])],
      ];
      const msData = I('function multiSend(bytes) payable').encodeFunctionData('multiSend', ['0x' + legs.map(([t, d]) => packCall(t, d)).join('')]);
      await simulateAsSafe(rpc, chain, safe, msData);

      const { all } = await pickChain(safe);
      const slot = all.find(c => c.name === chain);
      if (!slot || slot.remaining < 1) { out[chain] = `burn ready ($${usd.toFixed(4)}), no relay slot`; continue; }

      const sent = await relayExec(env, rpc, safe, MULTISEND, msData, chain, CHAINS[chain].chainId, 1); // DELEGATECALL
      if (sent.ok) {
        const p = { chain, taskId: sent.taskId, tx: null, usd: +usd.toFixed(6), burn_units: outMin.toString(), at: new Date().toISOString() };
        try { for (let i = 0; i < 6 && !p.tx; i++) { await new Promise(r => setTimeout(r, 5000)); const st = await relayStatus(sent.taskId, CHAINS[chain].chainId); if (st.tx) p.tx = st.tx; } } catch { /* resolved next tick */ }
        state.pending.push(p);
        await env.KV.put('sweep:state', JSON.stringify(state));
        out.burned = p;
        return out;   // one slot per tick
      }
      out[chain] = 'relay refused: ' + (sent.error || 'unknown');
    } catch (e) { out[chain] = 'error: ' + String(e.message).slice(0, 140); }
  }
  return out;
}
