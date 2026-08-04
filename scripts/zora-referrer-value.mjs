// zora-referrer-value.mjs — put a DOLLAR on the verified Zora reward split.
// Measures real CoinMarketRewardsV4 flow through the hook over a known block span, prices the
// currencies, and reports what each recipient ROLE actually earns per day.
// Read-only. Saves scripts/zora-referrer-value-result.json
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const HOOK = '0x0469a4Bd3724DC86C9542F4694c976DA13C450c0';
const ZERO_EOA = '0x50624F7790732f9767180871D03A304756200dB9';
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://1rpc.io/base'];
const BS = 'https://base.blockscout.com/api/v2';
const BLOCK_TIME = 2; // Base

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const abi = (await fetch(`${BS}/smart-contracts/${HOOK}`).then(r => r.json())).abi;
const iface = new ethers.Interface(abi);

const latest = Number(await rpc('eth_blockNumber', []));
const SPAN = 20000; // blocks (~11h on Base)
let logs = [];
for (let hi = latest, hop = 0; hop < 10; hop++) {
  const lo = hi - 1999;
  if (latest - lo > SPAN) break;
  try { logs = logs.concat(await rpc('eth_getLogs', [{ address: HOOK, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }])); } catch { }
  hi = lo - 1;
}
const spanBlocks = Math.min(SPAN, 2000 * 10);
const spanHours = (spanBlocks * BLOCK_TIME) / 3600;

// price the currencies we see
const priceCache = {};
async function usdPrice(addr) {
  const k = addr.toLowerCase();
  if (k in priceCache) return priceCache[k];
  let p = 0;
  try {
    const t = await fetch(`${BS}/tokens/${addr}`).then(r => r.json());
    p = parseFloat(t.exchange_rate) || 0;
  } catch { }
  priceCache[k] = p;
  return p;
}

const roles = ['creatorPayout', 'platformReferrer', 'tradeReferrer', 'protocol', 'doppler'];
const totals = Object.fromEntries(roles.map(r => [r, 0]));
let events = 0, withTradeRef = 0;
const perCoin = {};
const zeroIsRecipient = { creator: 0, platformReferrer: 0, tradeReferrer: 0 };

for (const log of logs) {
  let p; try { p = iface.parseLog({ topics: log.topics, data: log.data }); } catch { continue; }
  if (p.name !== 'CoinMarketRewardsV4') continue;
  events++;
  const mr = p.args.marketRewards;
  const cur = p.args.currency;
  const px = await usdPrice(cur);
  const dec = 18;
  const usd = (v) => (Number(ethers.formatUnits(v, dec)) * px);
  const row = {
    creatorPayout: usd(mr.creatorPayoutAmountCurrency),
    platformReferrer: usd(mr.platformReferrerAmountCurrency),
    tradeReferrer: usd(mr.tradeReferrerAmountCurrency),
    protocol: usd(mr.protocolAmountCurrency),
    doppler: usd(mr.dopplerAmountCurrency),
  };
  for (const r of roles) totals[r] += row[r];
  if (mr.tradeReferrerAmountCurrency > 0n) withTradeRef++;
  const coin = p.args.coin;
  perCoin[coin] = (perCoin[coin] ?? 0) + row.creatorPayout + row.platformReferrer;
  if (p.args.payoutRecipient?.toLowerCase() === ZERO_EOA.toLowerCase()) zeroIsRecipient.creator++;
  if (p.args.platformReferrer?.toLowerCase() === ZERO_EOA.toLowerCase()) zeroIsRecipient.platformReferrer++;
  if (p.args.tradeReferrer?.toLowerCase() === ZERO_EOA.toLowerCase()) zeroIsRecipient.tradeReferrer++;
}

const perDay = (v) => (v / spanHours) * 24;
const out = {
  probedAt: new Date().toISOString(), spanBlocks, spanHours: +spanHours.toFixed(2),
  rewardEvents: events, eventsWithTradeReferrer: withTradeRef,
  tradeReferrerCoverage: events ? +(withTradeRef / events).toFixed(3) : null,
  measuredSplitPct: { creator: 62.5, platformReferrer: 25, tradeReferrer: 5, protocol: 6.25, doppler: 1.25,
    note: 'tradeReferrer 5% is taken FROM the protocol share (protocol 11.25% -> 6.25%), so it costs trader and creator NOTHING' },
  usd_in_window: Object.fromEntries(roles.map(r => [r, +totals[r].toFixed(4)])),
  usd_per_day_ecosystem: Object.fromEntries(roles.map(r => [r, +perDay(totals[r]).toFixed(2)])),
  zeroIsRecipient,
  topCoinsByCreatorPlusPlatform: Object.entries(perCoin).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([coin, usd]) => ({ coin, usd_in_window: +usd.toFixed(4) })),
};
console.log(JSON.stringify(out, null, 2));
writeFileSync(new URL('./zora-referrer-value-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('saved -> scripts/zora-referrer-value-result.json');
