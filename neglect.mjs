// neglect.mjs — measure the band nobody else can profitably touch, and prove it empirically.
//
// THE ARGUMENT. "Undiscovered loophole" is usually a wish. There is a version of it that is a
// measurable, structural fact, and this file measures that version.
//
// Every actor on the chain except us must clear their own gas cost before an action is worth taking.
// So for any opportunity paying less than the cost of the transaction that claims it, the expected
// value to a normal actor is NEGATIVE — and it is left alone. Not because it is hidden, not because
// nobody is clever enough, but because taking it loses money for anyone who pays gas.
//
// ZERO's gas is sponsored. Its floor is zero. That makes an entire price band structurally uncontested,
// permanently, by arithmetic rather than by luck. Measured payouts from our own harvests were
// $0.0116, $0.0025, $0.00066, $0.0003 and $0.0001 — and the last three are BELOW the cost of the
// transaction that collected them. We were already earning inside the band without naming it.
//
// THE PROOF OF ABSENCE. The band being theoretically uncontested is an argument; what makes it a
// measurement is TIME SINCE LAST CALL. If a contract pays whoever calls it, is callable right now, and
// nobody has called it in weeks, that is direct empirical evidence that no competitor is working it.
// Neglect is observable. It is the closest thing to a proof that something has not been found.
//
// A high-neglect, proven-paying, callable-now contract is the actual shape of "a loophole nobody found".

const SCOUT = {
  base: 'https://base.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
};
const RPC = {
  base: 'https://base-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
};

const j = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': 'zero-agent/0.4' } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

/**
 * What does a transaction actually COST a normal actor on this chain right now?
 * That number is the ceiling of the uncontested band: everything paying less is left alone by
 * everyone who pays gas.
 */
export async function gasFloor(chain = 'base', gasUnits = 250000) {
  const r = await fetch(RPC[chain], {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
  });
  const jj = await r.json();
  if (jj.error || !jj.result) throw new Error(jj.error?.message || 'no gas price');
  const wei = BigInt(jj.result);
  const costWei = wei * BigInt(gasUnits);
  let usd = null;
  try {
    const s = await j(`${SCOUT[chain]}/api/v2/stats`);
    const price = parseFloat(s.coin_price);
    if (price) usd = +((Number(costWei) / 1e18) * price).toFixed(6);
  } catch { /* price is a nicety */ }
  return {
    chain, gas_price_wei: wei.toString(), assumed_gas_units: gasUnits,
    tx_cost_eth: (Number(costWei) / 1e18).toFixed(12),
    BAND_CEILING_USD: usd,
    meaning: `Any payout below $${usd} is negative-EV for anyone paying gas, and is therefore left alone by every rational competitor on this chain. Your gas is sponsored, so your floor is $0 and this entire band is yours uncontested. It is not a race — nobody else can profitably enter it.`,
  };
}

/**
 * How long has a contract been left alone? Time since the last successful external call is direct,
 * observable evidence about whether anyone is competing for it.
 */
export async function neglectOf(chain, contract) {
  const base = SCOUT[chain];
  let items = [];
  try { items = (await j(`${base}/api/v2/addresses/${contract}/transactions?filter=to`)).items || []; }
  catch { return { contract, chain, error: 'could not read history' }; }
  const ok = items.filter(t => t.status === 'ok' && t.method);
  if (!ok.length) {
    return {
      contract, chain, days_since_last_call: null, callers_30d: 0,
      neglect: 'NEVER CALLED', neglect_score: 100,
      note: 'No successful external call in recent history at all. Either dead, or completely unworked.',
    };
  }
  const last = Date.parse(ok[0].timestamp);
  const days = (Date.now() - last) / 86400000;
  const recent = ok.filter(t => Date.now() - Date.parse(t.timestamp) < 30 * 86400000);
  const callers = new Set(recent.map(t => (t.from?.hash || '').toLowerCase()));
  // Neglect rises with time-since-last-call and falls with how many distinct people are working it.
  const score = Math.max(0, Math.min(100, Math.round(days * 6) + Math.max(0, 30 - callers.size * 10)));
  return {
    contract, chain,
    days_since_last_call: +days.toFixed(2),
    last_method: ok[0].method,
    calls_30d: recent.length,
    distinct_callers_30d: callers.size,
    neglect_score: score,
    neglect: score >= 70 ? 'HEAVILY NEGLECTED — strong evidence nobody is competing'
      : score >= 40 ? 'lightly worked'
        : 'ACTIVELY CONTESTED — bots are on it',
  };
}

/**
 * The full picture for a candidate: is it in the uncontested band AND is nobody working it?
 * Pass candidates that payout_history has already proven pay callers — neglect only means something
 * for a contract that actually pays.
 */
export async function scoreOpportunity(chain, contract, provenPayoutUsd = null, floorUsd = null) {
  const n = await neglectOf(chain, contract);
  const belowFloor = floorUsd !== null && provenPayoutUsd !== null ? provenPayoutUsd < floorUsd : null;
  return {
    ...n,
    proven_payout_usd: provenPayoutUsd,
    below_gas_floor: belowFloor,
    verdict: belowFloor && n.neglect_score >= 70
      ? 'UNCONTESTED NICHE — it pays, it is below what gas costs a competitor, and nobody has touched it. This is the shape you are hunting.'
      : belowFloor ? 'in the band, but someone is working it'
        : n.neglect_score >= 70 ? 'neglected, but large enough that a gas-payer could take it — expect competition if it grows'
          : 'contested',
  };
}
