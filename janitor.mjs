// janitor.mjs — the self-cleaning wallet system.
//
// WHY THIS EXISTS (2026-08-24). A phishing token named "optibase.website 🧲 claim airdrop" was
// mass-airdropped to ZERO's Safe — 900M supply, "748k holders", ZERO DexScreener pairs, and a
// transfer() that reverts "Insufficient balance" while balanceOf() cheerfully reports 7669 tokens.
// The bait number is fake and the token is unmovable BY DESIGN: it cannot be sold, burned, or
// gifted away. Its entire purpose is to lure an AI agent into visiting "optibase.website" and
// connecting its key. Agent-targeting drainers are a CLASS now, not an incident.
//
// THE LAW THIS FILE ENFORCES: junk is identified ONCE and then never costs anything again — no
// slot, no RPC loop, no session attention. Detection writes a permanent denylist; totals already
// exclude everything non-whitelisted (reconcileEarnings only ever counts wrapped native + USDC),
// so a denylisted token cannot re-enter any published number. A burn is attempted ONLY when a
// token provably transfers (simulated clean) AND a relay slot is free; anything else is recorded
// as unmovable and left alone forever.
import { ethers } from 'ethers';
import { relayExec, pickChain } from './harvest.mjs';
import { isRetiredAccount } from './shop.mjs';

// The only assets that are EVER counted or kept. Everything else must earn its place through
// measured liquidity — nothing arrives pre-trusted.
export const WHITELIST = {
  base: ['0x4200000000000000000000000000000000000006', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
  optimism: ['0x4200000000000000000000000000000000000006', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'],
  arbitrum: ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'],
  polygon: ['0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'],
  gnosis: ['0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'],
  unichain: ['0x4200000000000000000000000000000000000006'],
};

const CHAIN_IDS = { base: 8453, optimism: 10, arbitrum: 42161, polygon: 137, gnosis: 100, unichain: 130 };

/** True when eth_call of transfer() actually succeeded. Empty return is the USDT-style
 *  success; a 32-byte zero is `return false`; Error/Panic selectors are revert data some
 *  nodes hand back as a result instead of a JSON-RPC error. Spending a relay slot on any
 *  of those is how a honeypot burns capacity. */
export function transferSimOk(ret) {
  if (ret == null || ret === '0x') return true;
  const hex = String(ret).toLowerCase();
  if (hex.startsWith('0x08c379a0') || hex.startsWith('0x4e487b71')) return false;
  try { return BigInt(hex) !== 0n; } catch { return false; }
}

export function isLiveOwnedAddress(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr) && !isRetiredAccount(addr);
}

/** Pure name/symbol classifier — the cheap gate before any network call. */
export function tokenVerdict(symbol, name) {
  const hay = `${symbol || ''} ${name || ''}`.toLowerCase();
  if (/claim|airdrop|magnet|🧲|\.website|\.xyz|\.fun|https?:/.test(hay)) return 'junk';
  return null; // undecided — needs the liquidity measurement
}

/** Liquidity measurement via DexScreener (free, keyless). Returns max pair liquidity USD, or -1 on read failure. */
export async function dexLiquidityUsd(address) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const pairs = Array.isArray(j.pairs) ? j.pairs : [];
    let max = 0;
    for (const p of pairs) max = Math.max(max, Number(p.liquidity?.usd || 0));
    return max;
  } catch { return -1; }   // READ FAILED is not zero — caller must treat it as unknown, not junk
}

/**
 * One janitor pass over the given owned addresses.
 * Writes KV `janitor:junk` (the permanent denylist) and `janitor:last` (this pass's report).
 * Never throws; hygiene may never break the earning loops.
 */
export async function sweepJunk(env, rpcFn, ownedAddresses) {
  const BLOCKSCOUT = {
    base: 'https://base.blockscout.com',
    optimism: 'https://optimism.blockscout.com',
    arbitrum: 'https://arbitrum.blockscout.com',
    polygon: 'https://polygon.blockscout.com',
  };
  const junk = (await env.KV.get('janitor:junk', 'json')) || {};
  const report = { at: new Date().toISOString(), scanned: [], newly_junked: [], burns_attempted: [], notes: [] };

  for (const [chain, addr] of Object.entries(ownedAddresses)) {
    if (!BLOCKSCOUT[chain]) continue;
    if (!isLiveOwnedAddress(addr)) {
      report.notes.push(`${chain}: skipped retired or invalid owner ${addr}`);
      continue;
    }
    let tbs;
    try {
      tbs = await fetch(`${BLOCKSCOUT[chain]}/api/v2/addresses/${addr}/token-balances`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) }).then(r => r.json());
    } catch (e) { report.notes.push(`${chain}: balance read failed (${String(e.message).slice(0, 60)})`); continue; }
    if (!Array.isArray(tbs)) { report.notes.push(`${chain}: balance read malformed`); continue; }

    for (const tb of tbs) {
      const meta = tb.token || {};
      const tokenAddr = (meta.address_hash || '').toLowerCase();
      if (!tokenAddr || !Number(tb.value || '0')) continue;
      const key = `${chain}:${tokenAddr}`;
      report.scanned.push(key);
      const wl = (WHITELIST[chain] || []).map(a => a.toLowerCase());
      if (wl.includes(tokenAddr)) continue;                   // trusted asset, keep forever
      if (junk[key]) continue;                                // already condemned, never think again

      let verdict = tokenVerdict(meta.symbol, meta.name);
      if (!verdict) {
        const liq = await dexLiquidityUsd(tokenAddr);
        if (liq < 0) { report.notes.push(`${key}: liquidity read failed — left undecided, will re-check next pass`); continue; }
        verdict = liq >= 100 ? 'asset' : 'junk';              // $100 real liquidity or it is bait
      }
      if (verdict !== 'junk') continue;

      junk[key] = { symbol: meta.symbol || '?', name: String(meta.name || '').slice(0, 60), at: report.at, address: tokenAddr };
      report.newly_junked.push({ key, symbol: meta.symbol });
      const line = `[${report.at}] JANITOR: junk token quarantined ${meta.symbol} (${meta.name}) at ${tokenAddr} on ${chain}. Untrusted airdrops cost nothing from here on.\n`;
      const j = (await env.KV.get('knowledge:journal')) || '';
      await env.KV.put('knowledge:journal', line + j);

      // BURN ATTEMPT — only when the token PROVABLY transfers from the Safe and a slot is free.
      // Simulate the inner transfer as the Safe (same CALL execTransaction will make). The honeypot
      // class fails here and is never retried with a relay slot.
      try {
        const raw = BigInt(tb.value);
        const data = new ethers.Interface(['function transfer(address to,uint256 amount) returns (bool)'])
          .encodeFunctionData('transfer', ['0x000000000000000000000000000000000000dEaD', raw]);
        const sim = await rpcFn(chain, 'eth_call', [{ from: addr, to: tokenAddr, data }, 'latest']);
        if (!transferSimOk(sim)) throw new Error('transfer simulation returned false/revert data');
        const { all } = await pickChain(addr);
        const slot = (all || []).find(c => c.name === chain);
        if (!slot || !(slot.remaining > 0)) { report.notes.push(`${key}: movable but no free slot — burn deferred (denylist already prevents all cost)`); continue; }
        const sent = await relayExec(env, rpcFn, addr, tokenAddr, data, chain, CHAIN_IDS[chain], 0);
        report.burns_attempted.push({ key, ok: !!sent.ok, taskId: sent.taskId || sent.error });
      } catch (e) {
        report.notes.push(`${key}: UNMOVABLE (${String(e.shortMessage || e.message).slice(0, 80)}) — honeypot-class; denylisted permanently, never gassed again`);
      }
    }
  }

  await env.KV.put('janitor:junk', JSON.stringify(junk));
  await env.KV.put('janitor:last', JSON.stringify(report));
  return report;
}
