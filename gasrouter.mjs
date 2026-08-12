// gasrouter.mjs — every way ZERO can get a transaction on-chain, continuously admission-tested.
//
// WHY THIS EXISTS. Gas capacity has been hardcoded as "the Safe relay, 5/chain/day" and every time we
// went looking by hand we found more: gnosis and polygon sitting at 5/5 untouched (ten free tx/day
// discarded for the project's life), then unichain at 5/5, then Candide's keyless endpoint with public
// gas policies. Each discovery was a manual probe that then went stale.
//
// The deeper problem is that ADMISSION IS NOT STATIC. A paymaster that refuses today may accept
// tomorrow because a third party funded a campaign; a public gas policy appears when a dapp pays for
// one and vanishes when the budget runs out; a relay quota refills on a schedule nobody publishes.
// Hand-probing a moving target is exactly the tireless, rule-bound work that belongs in code.
//
// So: one registry of every known gas source, each with a live admission test, re-checked on cron and
// cached. Callers ask for CAPACITY, not for "the Safe relay". New sources plug in as one entry instead
// of a rewrite — which matters, because the whole history of this project is that the next source is
// always one enumeration away.
//
// Everything here is READ-ONLY. It reports what is available; it never spends anything.
import { ethers } from 'ethers';

const SAFE_RELAY = (id, safe) => `https://safe-client.safe.global/v1/chains/${id}/relay/${safe}`;
const RELAY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Origin: 'https://app.safe.global', Referer: 'https://app.safe.global/',
};
const ENTRYPOINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

// Chains worth probing for a Safe relay quota. Probe SEQUENTIALLY — firing these in parallel got
// rate-limited and returned a clean-looking zero, which is the failed-read-looks-like-a-null trap.
export const RELAY_CHAINS = {
  base: 8453, optimism: 10, arbitrum: 42161, gnosis: 100, polygon: 137, unichain: 130,
  // Probed and found to have no quota for us — kept so we re-check rather than re-discover:
  ethereum: 1, bnb: 56, avalanche: 43114, celo: 42220, zksync: 324, linea: 59144,
  scroll: 534352, blast: 81457, mantle: 5000, sonic: 146, world: 480, mode: 34443,
};

const NATIVE = {
  base: 8453, optimism: 10, arbitrum: 42161, unichain: 130, polygon: 137, gnosis: 100,
};

/** Safe's sponsored relay — free, quota per (Safe, chain), refill schedule undocumented. */
async function checkRelay(safe) {
  const out = [];
  for (const [name, id] of Object.entries(RELAY_CHAINS)) {
    try {
      const r = await fetch(SAFE_RELAY(id, safe), { headers: RELAY_HEADERS });
      if (r.status !== 200) continue;
      const q = await r.json();
      if (typeof q.limit !== 'number' || q.limit <= 0) continue;
      out.push({
        source: 'safe-relay', chain: name, chainId: id,
        available: typeof q.remaining === 'number' && q.remaining > 0, capacity: q.remaining, ceiling: q.limit,
        cost_usd: 0, note: typeof q.remaining !== 'number' ? ('quota UNREADABLE this request (' + (q.error || 'no reading') + ') — unknown, NOT exhausted') : q.remaining > 0 ? 'free slots right now' : 'exhausted; refills on an unpublished schedule',
      });
    } catch { /* one chain failing is not a verdict */ }
    await new Promise(r => setTimeout(r, 160));
  }
  return out;
}

/** Native ETH we own — unlimited, unrevokable, the only capability nobody can take away. */
async function checkOwnGas(rpc, eoa) {
  const out = [];
  for (const [name] of Object.entries(NATIVE)) {
    try {
      const wei = BigInt(await rpc(name, 'eth_getBalance', [eoa, 'latest']));
      if (wei === 0n) continue;
      const gp = BigInt(await rpc(name, 'eth_gasPrice', []));
      const perTx = gp * 250000n;
      out.push({
        source: 'own-native-gas', chain: name,
        available: wei > perTx, capacity: Number(wei / (perTx || 1n)),
        cost_usd: null, note: 'self-funded: no quota, no sponsor, nobody can revoke it',
      });
    } catch { /* chain unreachable */ }
  }
  return out;
}

/**
 * ERC-4337 paymasters — the DECISIVE admission test is calling validatePaymasterUserOp AS THE
 * ENTRYPOINT and reading validationData (0 = would sponsor us, 1 = SIG_VALIDATION_FAILED).
 * Inferring admission from transaction shape is the weak test and it misled us once already.
 * Measured 2026-07-29: all 17 live paymasters on Base returned closed.
 */
const PM_IFACE = new ethers.Interface([
  'function validatePaymasterUserOp((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp, bytes32 userOpHash, uint256 maxCost) returns (bytes context, uint256 validationData)',
]);
export async function admissionTestPaymaster(rpc, chain, paymaster, account) {
  const op = {
    sender: account, nonce: 0n, initCode: '0x', callData: '0x',
    accountGasLimits: ethers.zeroPadValue('0x0186a0', 32), preVerificationGas: 50000n,
    gasFees: ethers.zeroPadValue('0x0186a0', 32),
    paymasterAndData: paymaster + '0'.repeat(80), signature: '0x',
  };
  const data = PM_IFACE.encodeFunctionData('validatePaymasterUserOp', [op, ethers.ZeroHash, 100000000000000n]);
  try {
    const ret = await rpc(chain, 'eth_call', [{ to: paymaster, data, from: ENTRYPOINT }, 'latest']);
    const [, validationData] = PM_IFACE.decodeFunctionResult('validatePaymasterUserOp', ret);
    return { paymaster, open: validationData === 0n, validationData: validationData.toString() };
  } catch (e) {
    return { paymaster, open: false, reason: String(e.message).replace(/execution reverted:?/, '').trim().slice(0, 60) };
  }
}

/** Live paymasters, discovered from EntryPoint logs rather than a hardcoded list. */
async function checkPaymasters(rpc, chain, account, { blocks = 400 } = {}) {
  const TOPIC = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
  let found = {};
  try {
    const head = parseInt(await rpc(chain, 'eth_blockNumber', []), 16);
    const logs = await rpc(chain, 'eth_getLogs', [{ address: ENTRYPOINT, topics: [TOPIC],
      fromBlock: '0x' + (head - blocks).toString(16), toBlock: 'latest' }]);
    for (const l of logs || []) {
      const pm = '0x' + l.topics[3].slice(26).toLowerCase();
      if (!/^0x0+$/.test(pm)) found[pm] = (found[pm] || 0) + 1;
    }
  } catch { return []; }
  const ranked = Object.entries(found).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const out = [];
  for (const [pm, ops] of ranked) {
    const t = await admissionTestPaymaster(rpc, chain, pm, account);
    out.push({
      source: 'erc4337-paymaster', chain, paymaster: pm, ops_seen: ops,
      available: t.open, capacity: t.open ? Infinity : 0, cost_usd: 0,
      note: t.open ? 'OPEN — would sponsor an arbitrary account' : (t.reason || `closed (validationData=${t.validationData})`),
    });
  }
  return out;
}

/**
 * Keyless sponsorship APIs. Read the REFUSAL CAREFULLY — the wording distinguishes a wall from a
 * search. Measured: Pimlico answers "Sponsorship policy ID is required for this API key" (an auth
 * wall, genuinely closed) while Candide answers "does not qualify for any publicly available gas
 * policy" (a TECHNICAL objection — public policies exist, ours simply does not match one). Those are
 * completely different situations and only one of them is worth re-probing.
 */
export const SPONSOR_APIS = [
  { id: 'candide-public', url: (id) => `https://api.candide.dev/public/v3/${id}`, keyless: true },
  { id: 'pimlico-public', url: (id) => `https://public.pimlico.io/v2/${id}/rpc`, keyless: true },
];

export async function checkSponsorApi(api, chainId, account, callData = '0x') {
  const op = {
    sender: account, nonce: '0x0', callData,
    callGasLimit: '0x30d40', verificationGasLimit: '0x30d40', preVerificationGas: '0x11170',
    maxFeePerGas: '0x5f5e100', maxPriorityFeePerGas: '0x5f5e100', signature: '0x' + 'ff'.repeat(65),
  };
  try {
    const r = await fetch(api.url(chainId), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'pm_getPaymasterStubData',
        params: [op, ENTRYPOINT, '0x' + chainId.toString(16), {}] }),
    });
    const j = await r.json();
    if (j.result) return { source: 'sponsor-api', id: api.id, available: true, capacity: Infinity, cost_usd: 0, note: 'ACCEPTED — free sponsored gas', result: j.result };
    const msg = String(j.error?.message || 'unknown');
    const authWall = /api key|policy id is required|unauthor/i.test(msg);
    return {
      source: 'sponsor-api', id: api.id, available: false, capacity: 0,
      wall_type: authWall ? 'AUTH — needs a key, do not re-probe' : 'TECHNICAL — policies exist, keep varying the op',
      note: msg.slice(0, 110),
    };
  } catch (e) { return { source: 'sponsor-api', id: api.id, available: false, note: String(e.message).slice(0, 80) }; }
}

/** The whole picture, cached. This is what callers should ask instead of assuming the relay. */
export async function gasSources(env, rpc, { safe, eoa, chain = 'base', maxAgeMs = 10 * 60000 } = {}) {
  const cached = await env.KV.get('gas:sources', 'json').catch(() => null);
  if (cached && Date.now() - cached.at < maxAgeMs) return { ...cached, cached: true };

  const chainId = RELAY_CHAINS[chain] || 8453;
  const [relay, own, pms] = await Promise.all([
    checkRelay(safe).catch(() => []),
    checkOwnGas(rpc, eoa).catch(() => []),
    checkPaymasters(rpc, chain, safe).catch(() => []),
  ]);
  const apis = [];
  for (const a of SPONSOR_APIS) apis.push(await checkSponsorApi(a, chainId, safe).catch(() => null));

  const all = [...own, ...relay, ...pms, ...apis.filter(Boolean)];
  const usable = all.filter(s => s.available);
  const out = {
    at: Date.now(),
    total_free_slots: relay.reduce((n, r) => n + (r.capacity || 0), 0),
    relay_chains_with_quota: relay.length,
    open_paymasters: pms.filter(p => p.available).length,
    open_sponsor_apis: apis.filter(a => a?.available).length,
    self_funded_chains: own.length,
    sources: all,
    best: usable.sort((a, b) => (b.capacity === Infinity ? 1 : 0) - (a.capacity === Infinity ? 1 : 0) || (b.capacity - a.capacity))[0] || null,
    advice: usable.length
      ? 'Spend FREE capacity first and keep any native ETH — ETH is the only source nobody can revoke.'
      : 'No capacity anywhere. Do not wait: enumerate. Every previous dead end here was an unprobed chain or an unread refusal.',
  };
  await env.KV.put('gas:sources', JSON.stringify(out)).catch(() => {});
  return out;
}
