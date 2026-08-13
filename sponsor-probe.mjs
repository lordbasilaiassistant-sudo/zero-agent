/* SPONSOR PROBE (2026-08-13) — turns "we found a sponsor" into "we were paid through it, here is the tx".
 *
 * Anthony raised the bar: a source only counts once a PROFITABLE ACTION has run through it from the
 * new wallet. Finding is free and worthless; a settled tx hash is the product. This file is the
 * harness that makes that testable for 100 sources instead of by hand for three.
 *
 * WHY THIS IS CODE, NOT A PROMPT (COMPUTE LAW): every step below is deterministic — probe the
 * sponsor, simulate the call, execute if the simulation profits, verify the receipt. Same inputs,
 * same answer. The agent's judgment belongs in choosing WHICH sponsors to add, not in re-running
 * this loop.
 *
 * THE LADDER — a source may only advance one rung at a time, and the rung is recorded, not assumed:
 *   0 FOUND      — it exists in docs. Worth nothing.
 *   1 REACHABLE  — its endpoint answered us. Still worth nothing.
 *   2 ACCEPTED   — it accepted OUR address / a request from us. Worth a little.
 *   3 EXECUTED   — a transaction went through it, sponsored, and confirmed. Real.
 *   4 PROFITABLE — that transaction left us with MORE value than before, proven on-chain. The goal.
 *
 * A source stuck at 0-2 is a lead. Only rung 4 may ever be reported as income (MEMORY LAW: evidence
 * or it is a hypothesis).
 */

export const RUNGS = ['FOUND', 'REACHABLE', 'ACCEPTED', 'EXECUTED', 'PROFITABLE'];

/**
 * @typedef {object} Sponsor
 * @property {string} id
 * @property {string} kind            'relay' | 'bundler' | 'intent' | 'keeper' | 'x402' | 'rebate'
 * @property {(ctx:object)=>Promise<{ok:boolean, detail:string}>} reach   rung 1
 * @property {(ctx:object)=>Promise<{ok:boolean, detail:string}>} accept  rung 2 — does it accept US
 * @property {(ctx:object)=>Promise<{ok:boolean, txHash?:string, detail:string}>} execute rung 3
 */

/** Read native + token balance so profit is measured, never assumed. */
async function snapshot(ctx) {
  const bal = await ctx.rpc(ctx.chain, 'eth_getBalance', [ctx.address, 'latest']);
  return { at: Date.now(), native: BigInt(bal || '0x0') };
}

/**
 * Run one sponsor up the ladder. Never throws — a failed probe is data, and an exception that
 * kills the sweep would lose the 99 results either side of it.
 *
 * @param {Sponsor} sponsor
 * @param {{address:string, chain:string, rpc:Function, allowExecute:boolean}} ctx
 */
export async function probeSponsor(sponsor, ctx) {
  const out = {
    id: sponsor.id, kind: sponsor.kind, at: new Date().toISOString(),
    rung: 0, rungName: 'FOUND', evidence: null, profitWei: '0', detail: '', errors: [],
  };
  const step = async (name, fn) => {
    try { return await fn(ctx); }
    catch (e) { out.errors.push(`${name}: ${String(e?.message || e).slice(0, 120)}`); return { ok: false, detail: 'threw' }; }
  };

  const reach = await step('reach', sponsor.reach);
  if (!reach?.ok) { out.detail = `not reachable — ${reach?.detail || 'no response'}`; return out; }
  out.rung = 1; out.rungName = 'REACHABLE';

  const accept = await step('accept', sponsor.accept);
  if (!accept?.ok) { out.detail = `reachable but will not accept us — ${accept?.detail}`; return out; }
  out.rung = 2; out.rungName = 'ACCEPTED';

  /* EXECUTION IS GATED. A sweep across 100 sponsors must not fire 100 transactions the first time it
     runs — that is how a free rail gets us blocked and how a bug becomes 100 bugs. Default is
     measure-only; execution is opt-in per run. */
  if (!ctx.allowExecute) {
    out.detail = 'accepted — execution withheld (allowExecute=false). This is a real lead, not income.';
    return out;
  }

  const before = await snapshot(ctx);
  const exec = await step('execute', sponsor.execute);
  if (!exec?.ok || !exec.txHash) { out.detail = `accepted but execution failed — ${exec?.detail}`; return out; }
  out.rung = 3; out.rungName = 'EXECUTED'; out.evidence = exec.txHash;

  /* PROFIT IS MEASURED FROM THE CHAIN, NOT FROM WHAT THE SPONSOR TOLD US.
     A sponsor reporting success is a claim; a balance that went up is evidence. If gas was truly
     sponsored, native balance cannot have DECREASED — a drop means we paid, which means it was not
     gasless and the source is misclassified. That is a finding, not a failure. */
  const after = await snapshot(ctx);
  const delta = after.native - before.native;
  out.profitWei = delta.toString();
  if (delta > 0n) {
    out.rung = 4; out.rungName = 'PROFITABLE';
    out.detail = `sponsored AND profitable: +${delta} wei, tx ${exec.txHash}`;
  } else if (delta === 0n) {
    out.detail = `executed with zero cost to us (truly sponsored) but no payout — the rail works, the action did not pay. tx ${exec.txHash}`;
  } else {
    out.detail = `⚠ WE PAID ${-delta} wei — this is NOT true sponsorship, reclassify it. tx ${exec.txHash}`;
  }
  return out;
}

/**
 * Sweep many sponsors. Sequential on purpose: parallel probes against a shared free rail is the
 * behaviour that gets an IP or an address rate-limited, and losing a working sponsor to impatience
 * costs more than the minutes saved.
 */
export async function sweepSponsors(sponsors, ctx, { pauseMs = 1500 } = {}) {
  const results = [];
  for (const s of sponsors) {
    results.push(await probeSponsor(s, ctx));
    await new Promise(r => setTimeout(r, pauseMs));
  }
  const byRung = RUNGS.map((name, i) => ({ rung: i, name, count: results.filter(r => r.rung === i).length }));
  return {
    at: new Date().toISOString(),
    tested: results.length,
    byRung,
    profitable: results.filter(r => r.rung === 4),
    misclassified: results.filter(r => BigInt(r.profitWei || '0') < 0n),
    results,
    /* The only line that matters. Everything above rung 4 is throat-clearing. */
    headline: `${results.filter(r => r.rung === 4).length} of ${results.length} sponsors produced a PROFITABLE on-chain action`,
  };
}
