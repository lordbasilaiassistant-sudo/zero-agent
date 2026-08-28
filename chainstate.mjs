// chainstate.mjs — what ZERO holds, per chain, WITH THE READ STATUS ATTACHED.
//
// WHY THIS EXISTS AS ITS OWN FILE. `reconcileEarnings` in harvest.mjs answers "how much", and it does
// it with a bare `catch {}` per chain: an unreachable chain contributes nothing and says nothing. That
// silently changed the denominator of a public total by 39% between two fetches of the same URL with
// byte-identical safe_wei, and nobody could tell from the output that anything had failed. It also
// never calls eth_getBalance at all, so the doctrine's own scoreboard metric — native ETH at the EOA —
// was absent in both directions.
//
// The rule this file enforces: A FAILED READ IS NOT A ZERO. It contributes NOTHING to any total and it
// appears by name in `unreadable[]`, so the page can print "read 4 of 6 chains" instead of quietly
// publishing a smaller number as if it were the same number.
//
// It also publishes ONE price per chain per request and hands the table to every consumer. treasury.mjs
// and harvest.mjs used to fetch the same price independently inside a single request and could disagree
// — measured 2026-08-12: eth_usd 1888.99 alongside token_usd 1891.92 in one response.
import { ethers } from 'ethers';
import { CHAINS, wethBalance, nativeUsd } from './harvest.mjs';

// Native USDC (Circle-issued) per chain. Base is the one that matters today: it is the ONLY asset that
// lets ZERO transact without a relay slot, through the single permissionless token paymaster, and the
// panel titled "everything it holds" was omitting it.
export const USDC_BY_CHAIN = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  unichain: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
};

// A second, independent price source, tried once before we admit the price is UNREADABLE. Also covers
// the chains blockscout's stats endpoint does not price for us — notably unichain, which is a LIVE
// chain whose earnings would otherwise be worth $0.00 forever purely by omission from a lookup table.
const FALLBACK_ID = {
  base: 'coingecko:ethereum', optimism: 'coingecko:ethereum', arbitrum: 'coingecko:ethereum',
  unichain: 'coingecko:ethereum', polygon: 'coingecko:polygon-ecosystem-token', gnosis: 'coingecko:xdai',
};

/** Normalise whatever `nativeUsd` returns today (number | null | {usd}) into a number or null. */
function asPrice(p) {
  if (p && typeof p === 'object') return Number.isFinite(p.usd) && p.usd > 0 ? p.usd : null;
  return Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * One price for one chain, with its provenance. NEVER returns 0 for a failure: `usd: null` means
 * UNREADABLE and every caller must exclude it rather than multiplying a balance by zero.
 */
export async function priceFor(chain) {
  const at = new Date().toISOString();
  let firstError = null;
  try {
    const p = asPrice(await nativeUsd(chain));
    if (p !== null) return { usd: p, at, source: `${chain}.blockscout.com/api/v2/stats` };
    firstError = `blockscout returned no usable coin_price for ${chain}`;
  } catch (e) { firstError = `blockscout: ${String(e.message || e).slice(0, 110)}`; }

  const id = FALLBACK_ID[chain];
  if (!id) return { usd: null, at, source: null, error: firstError || `no price source configured for ${chain}` };
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/${id}`);
    const p = parseFloat(((await r.json())?.coins || {})[id]?.price);
    if (Number.isFinite(p) && p > 0) return { usd: p, at, source: 'coins.llama.fi', note: `primary failed: ${firstError}` };
    return { usd: null, at, source: 'coins.llama.fi', error: `${firstError}; fallback returned no price` };
  } catch (e) {
    return { usd: null, at, source: 'coins.llama.fi', error: `${firstError}; fallback: ${String(e.message || e).slice(0, 110)}` };
  }
}

export async function priceTable(chains = Object.keys(CHAINS)) {
  const out = {};
  for (const c of chains) out[c] = await priceFor(c);
  return out;
}

const erc20Balance = (rpc, chain, token, addr) =>
  rpc(chain, 'eth_call', [{ to: token, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, 'latest'])
    .then(v => BigInt(v));

/**
 * Everything at both addresses, on every configured chain, with per-chain read status.
 *
 * Returns keys that SAY WHAT THEY MEAN. The old names were the bug:
 *   `lifetime_earned_usd` was actually HOLDINGS (which is why / and /harvest disagreed about "lifetime")
 *   `spendable_usd`       was actually SAFE-WRAPPED, i.e. relay-only, which DOCTRINE §11b explicitly
 *                         says is NOT spendable. Publishing it as "spendable" made ZERO look ~100x more
 *                         able to act than it is.
 * The old keys are DELETED rather than redefined. A key that silently changes meaning is worse than a
 * break: a break gets fixed, a redefinition gets believed.
 */
export async function readChainState(rpc, eoa, safe, chains = Object.keys(CHAINS)) {
  const per = [];
  const unreadable = [];
  const prices = {};
  let holdings = 0, relaySpendable = 0, nativeLiquid = 0, usdcTotal = 0, stranded = 0;

  for (const name of chains) {
    const c = CHAINS[name];
    if (!c) { unreadable.push({ chain: name, stage: 'config', error: 'chain not configured in CHAINS' }); continue; }
    let stage = 'price';
    try {
      const price = await priceFor(name);
      prices[name] = price;
      if (price.usd === null) {
        // A price we cannot read makes every USD figure on this chain UNKNOWN, not zero. Excluded.
        unreadable.push({ chain: name, stage: 'price', error: price.error || 'no price' });
        per.push({ chain: name, read: 'failed', stage: 'price', error: price.error || 'no price', token_usd: null });
        continue;
      }

      // SEQUENTIALLY, not Promise.all. This project has already been burned once by 38 parallel probes
      // being silently rate-limited into a clean-looking zero — and a wrong zero here is a lie about
      // how much money exists.
      //
      // 2026-08-24 — STAGE INDEPENDENCE. Until today one failed stage discarded the WHOLE chain:
      // base rate-limited its wrapped-native read and the exclusion silently dropped that chain's
      // successfully-readable native ETH ($0.45 measured live that day by direct eth_getBalance)
      // from every total the page publishes. A failed read is still never a zero — but a chain that
      // half-reads now contributes the half we MEASURED and names the half we could not read,
      // instead of contributing nothing at all. Each stage below stands alone.
      const parts = {};
      const missingStages = [];
      const grab = async (key, fn) => {
        try { parts[key] = await fn(); }
        catch (e) { missingStages.push(`${key}: ${String(e.message || e).slice(0, 90)}`); }
      };
      await grab('eoaWrapped', () => wethBalance(rpc, eoa, name, c.weth));
      await grab('safeWrapped', () => wethBalance(rpc, safe, name, c.weth));
      await grab('eoaNative', () => rpc(name, 'eth_getBalance', [eoa, 'latest']).then(BigInt));
      await grab('safeNative', () => rpc(name, 'eth_getBalance', [safe, 'latest']).then(BigInt));

      let eoaUsdc = 0n, safeUsdc = 0n, usdcError = null;
      let usdcKnown = !USDC_BY_CHAIN[name];   // no USDC configured here = nothing to read = known-zero
      if (USDC_BY_CHAIN[name]) {
        try {
          eoaUsdc = await erc20Balance(rpc, name, USDC_BY_CHAIN[name], eoa);
          safeUsdc = await erc20Balance(rpc, name, USDC_BY_CHAIN[name], safe);
          usdcKnown = true;
        } catch (e) {
          usdcError = String(e.message || e).slice(0, 90);
          missingStages.push(`usdc: ${usdcError}`);
        }
      }

      // Every stage failed → the honest full-exclusion path, unchanged.
      if (!Object.keys(parts).length && !usdcKnown) {
        const error = missingStages.join('; ').slice(0, 300);
        unreadable.push({ chain: name, stage: 'all-stages', error });
        per.push({ chain: name, read: 'failed', stage: 'all-stages', error, token_usd: price.usd });
        continue;
      }

      const toUsd = (wei) => Number(ethers.formatEther(wei)) * price.usd;
      const eoaWrappedUsd = 'eoaWrapped' in parts ? toUsd(parts.eoaWrapped) : null;
      const safeWrappedUsd = 'safeWrapped' in parts ? toUsd(parts.safeWrapped) : null;
      const eoaNativeUsd = 'eoaNative' in parts ? toUsd(parts.eoaNative) : null;
      const safeNativeUsd = 'safeNative' in parts ? toUsd(parts.safeNative) : null;
      const usdcUsd = usdcKnown ? Number(eoaUsdc + safeUsdc) / 1e6 : null;   // USDC is a dollar by construction

      // Only measured components enter any total. A component we could not read contributes NOTHING
      // and is named — it never contributes zero, because zero is a claim about the world.
      // relaySpendable stays SAFE-wrapped only: DOCTRINE §11b says wrapped native at the EOA is
      // stranded, not relay-spendable, and widening this key would redefine it silently.
      if (eoaWrappedUsd !== null) holdings += eoaWrappedUsd;
      if (safeWrappedUsd !== null) { holdings += safeWrappedUsd; relaySpendable += safeWrappedUsd; }
      // DOCTRINE §11b: native ETH the EOA holds is the ONLY thing that equals capability — any
      // transaction, any time, no quota, no sponsor, nobody able to revoke it.
      if (eoaNativeUsd !== null) { holdings += eoaNativeUsd; nativeLiquid += eoaNativeUsd; }
      if (safeNativeUsd !== null) holdings += safeNativeUsd;
      if (usdcUsd !== null) { holdings += usdcUsd; usdcTotal += usdcUsd; }
      // CLAUDE.md:93-95 — while the EOA holds no gas, EVERY asset sitting on it is stranded, not just
      // the wrapped native the old code counted. USDC on the EOA is stranded for exactly the same
      // reason (the paymaster checks the balance of the account SUBMITTING the op).
      // Only assert stranding when the EOA's native balance was actually READ — an unread balance
      // proves neither "has gas" nor "has none".
      if (('eoaNative' in parts) && parts.eoaNative === 0n) {
        if (eoaWrappedUsd !== null) stranded += eoaWrappedUsd;
        if (usdcKnown) stranded += Number(eoaUsdc) / 1e6;
      }

      per.push({
        chain: name,
        read: missingStages.length ? 'partial' : 'ok',
        token_usd: price.usd, price_source: price.source,
        eoa_wrapped_wei: parts.eoaWrapped?.toString() ?? null,
        safe_wrapped_wei: parts.safeWrapped?.toString() ?? null,
        eoa_native_wei: parts.eoaNative?.toString() ?? null,
        safe_native_wei: parts.safeNative?.toString() ?? null,
        eoa_wrapped_usd: eoaWrappedUsd !== null ? +eoaWrappedUsd.toFixed(8) : null,
        safe_wrapped_usd: safeWrappedUsd !== null ? +safeWrappedUsd.toFixed(8) : null,
        eoa_native_usd: eoaNativeUsd !== null ? +eoaNativeUsd.toFixed(8) : null,
        safe_native_usd: safeNativeUsd !== null ? +safeNativeUsd.toFixed(8) : null,
        usdc_usd: usdcUsd !== null ? +usdcUsd.toFixed(6) : null,
        usdc_error: usdcError,
        ...(missingStages.length ? { missing_stages: missingStages } : {}),
      });
      if (missingStages.length) unreadable.push({ chain: name, stage: 'partial', error: missingStages.join('; ') });
    } catch (e) {
      const error = `${stage}: ${String(e.message || e).slice(0, 110)}`;
      unreadable.push({ chain: name, stage, error });
      per.push({ chain: name, read: 'failed', stage, error, token_usd: prices[name]?.usd ?? null });
    }
  }

  const okCount = per.filter(p => p.read === 'ok').length;
  const partialCount = per.filter(p => p.read === 'partial').length;
  return {
    measured_at: new Date().toISOString(),
    source: 'eth_getBalance + wrapped-native balanceOf + USDC balanceOf at both addresses, each chain priced in ITS OWN token',
    holdings_usd: +holdings.toFixed(8),
    relay_spendable_usd: +relaySpendable.toFixed(8),
    native_liquid_usd: +nativeLiquid.toFixed(8),
    usdc_usd: +usdcTotal.toFixed(6),
    stranded_on_eoa_usd: +stranded.toFixed(8),
    chains_configured: chains.length,
    chains_read_ok: okCount,
    chains_partial: partialCount,
    unreadable,
    prices,
    per_chain: per,
    read_note: partialCount
      ? `read ${okCount} of ${chains.length} chains fully, ${partialCount} partially. A partial chain's MEASURED stages are counted above; only its named failed stages are excluded.`
      : unreadable.length
      ? `read ${okCount} of ${chains.length} chains. Every figure above EXCLUDES the chains that failed — it is a lower bound, not a balance.`
      : `read ${okCount} of ${chains.length} chains, all ok.`,
  };
}

/**
 * P0.5 — lifetime earnings published as a SPLIT OBJECT, because publishing one scalar forces a choice
 * between two wrong numbers.
 *
 * 49% of the old headline "$0.146667" was a figure the model typed into a route_log tool call, printed
 * under the caption "every fee it has ever been paid" above a footer claiming everything was measured
 * on-chain. Meanwhile the ledger is ALSO an under-count: every earning route id is `base-*`/`manual-*`,
 * so nothing in it accounts for the arbitrum and optimism balances the agent demonstrably holds.
 *
 * Three estimators, three methods, all published. The classification is a RULE, printed on the page —
 * the stored ledger is NOT retroactively edited, because rewriting history to make a new headline look
 * better is the same class of error the page exists to document.
 */
export function splitLifetime(routes, chain) {
  let measured = 0, self = 0;
  const measuredIds = [], selfIds = [];
  for (const [id, r] of Object.entries(routes || {})) {
    const m = Number(r?.earned_usd_measured);
    const s = Number(r?.earned_usd_reported);
    const legacy = Number(r?.earned_usd) || 0;
    if (Number.isFinite(m) && m > 0) { measured += m; measuredIds.push(id); }
    if (Number.isFinite(s) && s > 0) { self += s; selfIds.push(id); }
    if (!Number.isFinite(m) && !Number.isFinite(s) && legacy > 0) {
      const isMeasured = r?.provenance === 'code-measured'
        || (!r?.provenance && /^beefy-(harvest-caller-fees|batch-)/.test(id));
      if (isMeasured) { measured += legacy; measuredIds.push(id); }
      else { self += legacy; selfIds.push(id); }
    }
  }
  measured = +measured.toFixed(6);
  self = +self.toFixed(6);
  const floor = chain && Number.isFinite(chain.holdings_usd) ? chain.holdings_usd : null;
  return {
    measured_usd: measured,
    self_reported_usd: self,
    chain_floor_usd: floor,
    measured_route_ids: measuredIds,
    self_reported_route_ids: selfIds,
    classification_rule: 'code-measured = written by harvest.mjs from a measured balance delta (beefy-harvest-caller-fees, beefy-batch-*). model-reported = earned_usd typed by the model into a route_log tool call (base-harvest-batch-*, manual-*, self-funded-*). Existing entries are classified by this rule, never retroactively edited.',
    coverage_note: floor !== null && floor > measured
      ? `The ledger UNDER-COVERS. Nobody funds this wallet, so everything it holds was earned: the chain floor is $${floor.toFixed(6)} against a code-measured ledger of $${measured.toFixed(6)}. Lifetime is at least the floor. These are never summed.`
      : 'Chain floor is not above the code-measured ledger this request.',
    unresolved: 'Three estimators disagree and the agent\'s own counter has drifted DOWNWARD across sessions, which means it is marking a price-marked balance rather than counting settled earnings. Unresolved — shown with methods rather than averaged.',
  };
}
