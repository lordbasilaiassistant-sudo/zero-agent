/* INBOUND WATCHER — everything strangers send us, recorded (2026-08-13).
 *
 * Anthony: "anything thats free = free. free crappy 0 worth token is still an expansion... we
 * actually got airdropped randomly by strangers on the first zero wallet somehow... We want to see
 * what it can accomplish and whos eyes are on our wallet too."
 *
 * WHY THIS IS WORTH CODE. I previously audited the old wallet's 12 unsolicited tokens, labelled 11
 * of them drainer bait, and stopped. That was risk-framing masquerading as analysis: it threw away
 * the SIGNAL. An unsolicited transfer answers questions we cannot otherwise ask —
 *   · how long does a brand-new address take to get noticed, and by whom?
 *   · which ecosystems watch fresh wallets, and how fast?
 *   · does anything arrive that is genuinely claimable rather than bait?
 * The new wallet is nonce-0 and was created 2026-08-13, so for the first time we can measure
 * time-to-first-airdrop from a clean start. The old wallet could never tell us that.
 *
 * THE SAFETY LINE, AND IT IS ABSOLUTE:
 *   RECEIVING is free and cannot hurt us — an ERC-20 balance appearing costs nothing and grants
 *   nobody anything. INTERACTING is where wallets die. So this module RECORDS and VALUES, and it
 *   MUST NEVER approve, swap, or call a function on an unknown token. Drainers work by getting you
 *   to sign, not by sending. Anything here is data, never an instruction to act.
 */

const SCOUT = {
  base: 'https://base.blockscout.com',
  gnosis: 'https://gnosis.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  polygon: 'https://polygon.blockscout.com',
  unichain: 'https://unichain.blockscout.com',
};

/* Patterns that mark a token as bait rather than value. Recorded, never acted on — the point is to
   SEE them, because who bothers to bait us is itself intelligence about who is watching. */
const BAIT = [
  /https?:\/\//i,            // a URL in the token name is a phishing lure, always
  /claim|reward|airdrop|bonus|gift|winner|voucher/i,
  /\.(com|io|xyz|net|org|cc|app)\b/i,
  /[Ѐ-ӿ̀-ͯ]/,  // cyrillic / combining marks = homoglyph spoofing (e.g. fake "ETH")
];

const isBait = (name = '', symbol = '') => BAIT.some(re => re.test(name) || re.test(symbol));

/**
 * Read every token that has ever arrived, per chain. Pure measurement: no keys, no signing.
 * @param {string} address
 */
export async function scanInbound(address, { chains = Object.keys(SCOUT) } = {}) {
  const at = new Date().toISOString();
  const perChain = {};
  let firstEver = null, totalUsd = 0, baitCount = 0, realCount = 0;

  for (const chain of chains) {
    const base = SCOUT[chain];
    const row = { reachable: false, transfers: 0, tokens: [], usd: 0 };
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 20000);
      const r = await fetch(`${base}/api/v2/addresses/${address}/token-transfers`, { signal: c.signal });
      clearTimeout(t);
      if (r.ok) {
        row.reachable = true;
        const j = await r.json();
        const items = j.items || [];
        row.transfers = items.length;
        for (const it of items) {
          const tok = it.token || {};
          const name = tok.name || '', sym = tok.symbol || '';
          const dec = Number(tok.decimals || 18);
          const amt = Number(it.total?.value || 0) / Math.pow(10, dec);
          const usd = amt * Number(tok.exchange_rate || 0);
          const bait = isBait(name, sym);
          if (bait) baitCount++; else { realCount++; totalUsd += usd; }
          row.usd += bait ? 0 : usd;   // never count bait toward our worth
          row.tokens.push({
            symbol: sym.slice(0, 20), name: name.slice(0, 48), contract: tok.address_hash,
            amount: amt, usd, bait, at: it.timestamp, from: it.from?.hash,
          });
          if (!firstEver || (it.timestamp && it.timestamp < firstEver.at)) {
            firstEver = { at: it.timestamp, chain, symbol: sym, from: it.from?.hash, bait };
          }
        }
      }
    } catch (e) { row.error = String(e.message).slice(0, 60); }
    perChain[chain] = row;
  }

  return {
    at,
    address,
    /* The headline is deliberately NOT "how much are we worth" — bait tokens quote a price they
       cannot honour, and summing them is how a wallet reports a fortune it cannot sell. */
    real_value_usd: Number(totalUsd.toFixed(6)),
    unsolicited_tokens: realCount + baitCount,
    bait_tokens: baitCount,
    genuine_tokens: realCount,
    first_unsolicited: firstEver,
    perChain,
    law: 'RECEIVING is free and safe. INTERACTING is not. Never approve, swap or call a function on '
       + 'an unknown token — drainers need your signature, not your address. This file records only.',
    watchers_note: 'Who bothers to send us anything, and how fast, is intelligence about who watches '
       + 'fresh wallets. A bait token is a failed attack that told us someone is looking.',
  };
}
