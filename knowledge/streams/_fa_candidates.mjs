// _fa_candidates.mjs — build the faucet/airdrop candidate universe FROM THE CHAIN.
// READ-ONLY. Blockscout public API (no key) + eth_getCode. Never signs anything.
//
// Three independent sources so a dead one cannot silently zero the lane:
//   1. Blockscout keyword search  — names people actually give giveaway contracts
//   2. Recently verified contracts — someone bootstrapping a token verifies it first
//   3. Recent-block contract creations — the freshest deployments, before anyone drains them
import fs from 'fs';
import path from 'path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(HERE, '_fa_universe.json');

export const BS = {
  base: 'https://base.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  polygon: 'https://polygon.blockscout.com',
  gnosis: 'https://gnosis.blockscout.com',
  unichain: 'https://unichain.blockscout.com',
};

// Words that appear in the NAME of a contract whose author meant to give things away.
const KEYWORDS = [
  'faucet', 'airdrop', 'claim', 'drip', 'giveaway', 'dispenser', 'free',
  'freemint', 'testtoken', 'reward', 'distributor', 'merkle', 'tap',
];
const NAME_RE = /faucet|airdrop|claim|drip|giveaway|dispens|free|reward|distribut|merkle|tap\b|test/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jget(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(1500 * (t + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(600 * (t + 1)); }
  }
  return null;
}

/** Source 1: keyword search. Blockscout indexes token + contract names. */
async function fromSearch(chain) {
  const host = BS[chain]; const out = [];
  for (const kw of KEYWORDS) {
    const j = await jget(`${host}/api/v2/search?q=${encodeURIComponent(kw)}`);
    for (const it of (j?.items || [])) {
      const addr = it.address || it.address_hash;
      if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
      if (it.type !== 'token' && it.type !== 'contract') continue;
      out.push({ chain, address: addr, name: it.name || null, type: it.type,
        verified: !!it.is_smart_contract_verified, src: `search:${kw}` });
    }
    await sleep(120);
  }
  return out;
}

/** Source 2: recently verified contracts, name-filtered. */
async function fromVerified(chain, pages = 6) {
  const host = BS[chain]; const out = [];
  let next = null;
  for (let p = 0; p < pages; p++) {
    const q = next ? '?' + new URLSearchParams(next).toString() : '';
    const j = await jget(`${host}/api/v2/smart-contracts${q}`);
    if (!j?.items?.length) break;
    for (const it of j.items) {
      const addr = it.address?.hash;
      const name = it.address?.name || it.name || null;
      if (!addr) continue;
      if (name && NAME_RE.test(name)) {
        out.push({ chain, address: addr, name, type: 'contract', verified: true, src: 'verified-recent' });
      }
    }
    next = j.next_page_params;
    if (!next) break;
    await sleep(180);
  }
  return out;
}

/** Source 3: contract creations in the newest blocks — freshest, least-drained. */
async function fromRecentCreations(chain, blocks = 12) {
  const host = BS[chain]; const out = [];
  const head = await jget(`${host}/api/v2/main-page/blocks`);
  if (!Array.isArray(head) || !head.length) return out;
  const top = head[0].height;
  for (let i = 0; i < blocks; i++) {
    const j = await jget(`${host}/api/v2/blocks/${top - i}/transactions`);
    for (const tx of (j?.items || [])) {
      // A creation has no `to`; Blockscout exposes the new address on the tx.
      const created = tx.created_contract?.hash;
      if (created) out.push({ chain, address: created, name: tx.created_contract?.name || null,
        type: 'contract', verified: !!tx.created_contract?.is_verified, src: `creation:${top - i}` });
    }
    await sleep(150);
  }
  return out;
}

/** Source 4: tokens with many holders but young — a giveaway that worked leaves holders behind. */
async function fromTokens(chain, pages = 3) {
  const host = BS[chain]; const out = [];
  let next = null;
  for (let p = 0; p < pages; p++) {
    const params = new URLSearchParams({ type: 'ERC-20', ...(next || {}) });
    const j = await jget(`${host}/api/v2/tokens?${params}`);
    if (!j?.items?.length) break;
    for (const it of j.items) {
      const name = `${it.name || ''} ${it.symbol || ''}`.trim();
      if (NAME_RE.test(name)) {
        out.push({ chain, address: it.address_hash || it.address, name, type: 'token',
          verified: true, holders: Number(it.holders_count || it.holders || 0), src: 'token-list' });
      }
    }
    next = j.next_page_params;
    if (!next) break;
    await sleep(180);
  }
  return out;
}

export async function harvest(chains) {
  const seen = new Map();
  for (const chain of chains) {
    const parts = await Promise.all([
      fromSearch(chain).catch(() => []),
      fromVerified(chain).catch(() => []),
      fromRecentCreations(chain).catch(() => []),
      fromTokens(chain).catch(() => []),
    ]);
    let n = 0;
    for (const list of parts) for (const c of list) {
      const k = `${c.chain}:${c.address.toLowerCase()}`;
      if (seen.has(k)) { seen.get(k).src += '|' + c.src; continue; }
      seen.set(k, { ...c, address: c.address });
      n++;
    }
    console.log(`${chain}: search=${parts[0].length} verified=${parts[1].length} creations=${parts[2].length} tokens=${parts[3].length} -> +${n} unique`);
  }
  return [...seen.values()];
}

if (process.argv[1] && process.argv[1].endsWith('_fa_candidates.mjs')) {
  const chains = (process.argv[2] || 'base,optimism,arbitrum,polygon,gnosis,unichain').split(',');
  const all = await harvest(chains);
  fs.writeFileSync(OUT, JSON.stringify(all, null, 1));
  console.log(`\nTOTAL ${all.length} candidates -> ${OUT}`);
}
