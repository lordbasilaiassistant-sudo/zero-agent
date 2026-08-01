// discover.mjs â€” the teat-finder. Turns one proven income family into many.
import { ethers } from 'ethers';   // blindSeed() used ethers.id() with no top-level import: it threw ReferenceError on its first line on EVERY call, and the throw was swallowed at the call site — so the entire 'break the closed Beefy loop' mechanism has never executed once.
//
// Method (empirical, not theoretical): professional keeper bots get paid by every contract worth
// calling. So instead of guessing which contracts pay an arbitrary caller, we find the WALLETS that
// already receive keeper payouts and walk their inbound transfers backwards to the paying contracts.
// That yields a list where every entry is backed by a real payout that actually happened.
//
// Why this beats reading view functions: Beefy's callReward() read $615 on a strategy that paid the
// caller $0.0001 â€” an 8.5-million-x lie. Historical transfers cannot lie.
const SCOUT = {
  base: 'https://base.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  // These three were MISSING for the project's whole life — gnosis and unichain sat at 5/5 free
  // relay slots with "nothing is paying" because the discovery engine literally could not see them.
  // All three hosts + eth_getBlockReceipts on their public RPCs verified live 2026-07-30.
  gnosis: 'https://gnosis.blockscout.com',
  unichain: 'https://unichain.blockscout.com',
  polygon: 'https://polygon.blockscout.com',
};

// Seed keepers observed taking real caller/fee payouts in our own harvest transactions.
export const SEED_KEEPERS = {
  arbitrum: [
    '0xCee843CD04E3758dDC5BCFf08647DddB117151D0',
    '0x02Ae4716B9D5d48Db1445814b0eDE39f5c28264B',
    '0xdad00eCa971D7B22e0dE1B874fbae30471B75354',
  ],
  base: [],
  optimism: [],
};

// A keeper's inbound transfers are full of NOISE: DEX pools and routers show up constantly because
// the keeper swaps its rewards through them. Those are counterparties, not mechanisms â€” they never
// pay an arbitrary caller for showing up. Filter them or the candidate list is 80% garbage.
const NOISE_NAME = /Pool$|Pair$|Router|Swap|Quoter|Vault$|WETH|Token$|ERC20|Bridge|Multicall/i;
export function isNoise(name) { return !!name && NOISE_NAME.test(name); }

// ⚠️ THE CLOSED LOOP — read this before trusting any candidate list this file produces.
// The seeds above are BEEFY's keepers and the payers below are BEEFY strategies. So this engine
// walked Beefy keepers → found Beefy strategies → forever. 307 candidates, ONE family. It was
// structurally incapable of discovering a mechanism we did not already know, which is exactly why
// months of "48 proven streams" was really one stream with 48 taps: if Beefy changes its fee split,
// all 48 die the same morning. A discovery engine seeded from what you already have is a treadmill.
//
// THE FIX: seed MECHANISM-BLIND. The relation has nothing to do with Beefy —
//     AN EOA SENT A TRANSACTION AND AN ERC-20 CAME BACK TO IT, AND IT SENT NOTHING IN.
// "Got paid for calling something, and did not buy it." That describes every keeper of every
// mechanism class that exists — liquidators, oracle reporters, auction settlers, claim relayers, and
// shapes nobody has named yet. The "sent nothing in" clause is load-bearing: without it, every DEX
// swap matches (the trader receives tokens too) and the list fills with routers.
//
// Measured on Base, 14 blocks: 66 paid callers, 47 paying contracts, and the classes that surfaced
// were genuinely new — MerkleDistributor, ERC20SignatureClaim, ConditionalTokens, BaseBulker.
// (Simulated from our own address, none of those four were callable BY US — they need a merkle proof
// or your own position. A real negative result that narrows the map. The seed still works; that
// sample just did not contain a permissionless payer.)
export async function blindSeed(chain, rpcRaw, blocks = 12) {
  const TRANSFER = ethers.id('Transfer(address,address,uint256)');
  const head = parseInt(await rpcRaw('eth_blockNumber', []), 16);
  const callers = {};
  for (let b = head - blocks; b <= head; b++) {
    let rcpts;
    try { rcpts = await rpcRaw('eth_getBlockReceipts', ['0x' + b.toString(16)]); } catch { continue; }
    if (!Array.isArray(rcpts)) continue;
    for (const rc of rcpts) {
      if (rc.status !== '0x1' || !rc.to) continue;
      const from = (rc.from || '').toLowerCase();
      let got = false, sent = false;
      for (const lg of rc.logs || []) {
        if (lg.topics?.[0] !== TRANSFER || lg.topics.length < 3) continue;
        if ('0x' + lg.topics[1].slice(26).toLowerCase() === from) sent = true;
        if ('0x' + lg.topics[2].slice(26).toLowerCase() === from) got = true;
      }
      if (got && !sent) (callers[from] ||= { address: rc.from, n: 0 }).n++;
    }
  }
  // Frequent paid callers are professional keepers; walking THEIR payers finds the mechanism.
  return Object.values(callers).sort((a, b) => b.n - a.n).slice(0, 8).map(c => c.address);
}

// Contracts we have PERSONALLY harvested and confirmed pay an arbitrary caller. These are the
// bootstrap doorways for any chain with no known keepers yet.
export const KNOWN_PAYERS = {
  base: ['0xc664C800bC54229034A629335A231f279320a605', '0x8B45D51e015Dac924EeAEa754e6f768943206F05'],
  arbitrum: ['0x3DAfB52975faB6B02eA6Cf4ead926E409Fa23ca0'],
  // real strategies we harvested on optimism, verified addresses from Beefy's API
  optimism: ['0x01087C3419CDf589b55c086AAF006D5D8e54f7a1', '0x20051a36204d4136E32D92e5b1015a311ee1a708', '0xD7E0Cde3479AFbF63ed7B7AD850A857db8629a32'],
};

const j = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'zero-agent/0.4' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

// Who pays this keeper, how much, and how often?
export async function payersOf(chain, keeper, pages = 2) {
  const base = SCOUT[chain];
  if (!base) throw new Error(`no explorer for ${chain}`);
  const payers = {};
  let url = `${base}/api/v2/addresses/${keeper}/token-transfers?type=ERC-20&filter=to`;
  for (let p = 0; p < pages && url; p++) {
    let data;
    try { data = await j(url); } catch { break; }
    for (const it of data.items || []) {
      const from = (it.from?.hash || '').toLowerCase();
      if (!from || from === keeper.toLowerCase()) continue;
      // Only count payments FROM contracts â€” an EOA paying a keeper is a payroll, not a mechanism.
      if (it.from?.is_contract === false) continue;
      const dec = Number(it.token?.decimals ?? 18);
      const amt = Number(it.total?.value ?? 0) / Math.pow(10, dec);
      const rec = payers[from] ||= { contract: it.from?.hash, name: it.from?.name || null, n: 0, tokens: {}, last: it.timestamp };
      rec.n += 1;
      rec.tokens[it.token?.symbol || '?'] = (rec.tokens[it.token?.symbol || '?'] || 0) + amt;
    }
    url = data.next_page_params
      ? `${base}/api/v2/addresses/${keeper}/token-transfers?type=ERC-20&filter=to&` +
        new URLSearchParams(data.next_page_params).toString()
      : null;
  }
  return Object.values(payers).sort((a, b) => b.n - a.n);
}

// Confirm the payer is a mechanism an ARBITRARY caller can trigger, not a whitelisted keeper job.
// Reads verified source and looks for the access-control shapes that disqualify it.
const GATE_RE = /onlyOwner|onlyKeeper|onlyManager|onlyGovernance|onlyStrategist|onlyVault|onlyOperator|require\s*\(\s*msg\.sender\s*==|hasRole\s*\(|_checkRole|onlyRole/;
const PAYS_CALLER_RE = /msg\.sender|callFeeRecipient|rewardRecipient|feeRecipient|_recipient|tx\.origin/;

export async function inspect(chain, contract, caller = '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1') {
  const base = SCOUT[chain];
  let meta;
  // Resolve proxies FIRST — a proxy's own source describes the proxy, never the logic.
  const impl = await resolveImpl(chain, contract);
  const target = impl || contract;
  try { meta = await j(`${base}/api/v2/smart-contracts/${target}`); }
  catch { return { contract, verified: false, verdict: 'source not verified â€” cannot confirm caller is unrestricted' }; }
  const src = meta.source_code || '';
  if (!src) return { contract, verified: false, verdict: 'no source' };
  const abi = meta.abi || [];
  // candidate entry points: non-view functions whose names smell like maintenance work
  const CANDIDATE = /harvest|claim|settle|finish|start|poke|update|compound|rebalance|liquidat|distribute|checkpoint|sync|execute|trigger|process|finalize/i;
  const fns = abi.filter(x => x.type === 'function' && x.stateMutability !== 'view' && x.stateMutability !== 'pure' && CANDIDATE.test(x.name || ''))
    .map(x => ({
      sig: `${x.name}(${(x.inputs || []).map(i => i.type).join(',')})`,
      takesRecipient: (x.inputs || []).some(i => /recipient|receiver|to|feeTo/i.test(i.name || '')),
      payable: x.stateMutability === 'payable',
    }));
  const checked = [];
  for (const f of fns.slice(0, 6)) {
    const sim = await simulateCandidate(chain, contract, f.sig, caller);
    checked.push({ ...f, callable: sim.callable, revert: sim.why || null });
  }
  const callableNow = checked.filter(f => f.callable);
  return {
    contract, implementation: impl || null, callable_now: callableNow.map(f => f.sig),
    name: meta.name || null, verified: true,
    access_controlled: GATE_RE.test(src),
    pays_a_caller: PAYS_CALLER_RE.test(src),
    candidate_functions: checked,
    verdict: callableNow.length
      ? 'CALLABLE NOW: ' + callableNow.map(f => f.sig).join(', ') + ' — simulated clean from our own address'
      : 'every candidate reverts for us: ' + checked.map(f => f.revert).filter(Boolean).slice(0, 2).join(' | '),
  };
}

// THE DECISIVE TEST — source reading lies in BOTH directions. A proxy hides its logic entirely (we
// burned a candidate on a "TransparentUpgradeableProxy" whose implementation was a DEX Pair), and a
// string-style `require(msg.sender == gauge, "!gauge")` hides from a modifier regex. An eth_call from
// our own address cannot lie: it either reverts or it doesn't. Free, unlimited, and the ONLY thing
// that should ever promote a candidate to "worth a relay slot".
const RPCS = {
  base: 'https://base-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  // The three below were absent, and they are the FIRST three in the cron's DISCOVERY_ROTATION —
  // so simulateCandidate returned 'no rpc for chain' on them permanently. gnosis and unichain are
  // also the two chains sitting at 5/5 free relay slots right now.
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  gnosis: 'https://gnosis-rpc.publicnode.com',
  unichain: 'https://unichain-rpc.publicnode.com',
};
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967 impl
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'; // EIP-1967 beacon
const LEGACY_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3'; // OZ legacy
const IMPL_SEL = '0x5c60da1b'; // implementation()
const CHILD_SEL = '0xda525716'; // childImplementation()

async function rawCall(rpc, method, params) {
  const r = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  return j.error ? null : j.result;
}
const addrFromWord = (v) => {
  if (!v || v.length < 42) return null;
  const a = '0x' + v.slice(-40);
  return /^0x0+$/.test(a) ? null : a;
};

// A proxy's own source describes the proxy, never the logic — so failing to resolve one silently
// discards the candidate. This only handled EIP-1967 `implementation`, which meant every BeaconProxy
// (a huge share of DeFi, and 90+ of our 214 discovered candidates) read as a bare proxy with no
// business logic, scored `pays_a_caller: false`, and was thrown away. Beacons need two hops:
// read the beacon address out of its own slot, then ask the beacon for implementation().
export async function resolveImpl(chain, contract) {
  const rpc = RPCS[chain];
  if (!rpc) return null;
  try {
    // 1. direct EIP-1967 / legacy implementation slots
    for (const slot of [IMPL_SLOT, LEGACY_SLOT]) {
      const a = addrFromWord(await rawCall(rpc, 'eth_getStorageAt', [contract, slot, 'latest']));
      if (a) return a;
    }
    // 2. beacon proxy: slot holds the BEACON, which must then be asked for the implementation
    const beacon = addrFromWord(await rawCall(rpc, 'eth_getStorageAt', [contract, BEACON_SLOT, 'latest']));
    if (beacon) {
      for (const sel of [IMPL_SEL, CHILD_SEL]) {
        const a = addrFromWord(await rawCall(rpc, 'eth_call', [{ to: beacon, data: sel }, 'latest']));
        if (a) return a;
      }
    }
    // 3. some proxies just expose implementation() directly
    const direct = addrFromWord(await rawCall(rpc, 'eth_call', [{ to: contract, data: IMPL_SEL }, 'latest']));
    if (direct) return direct;
    return null;
  } catch { return null; }
}

export async function simulateCandidate(chain, contract, fnSig, caller) {
  const rpc = RPCS[chain];
  if (!rpc) return { callable: false, why: 'no rpc for chain' };
  const name = fnSig.split('(')[0];
  const types = fnSig.slice(fnSig.indexOf('(') + 1, fnSig.lastIndexOf(')')).split(',').filter(Boolean);
  if (types.length > 1) return { callable: false, why: 'takes arguments we cannot safely guess' };
  const { ethers } = await import('ethers');
  let data;
  try {
    const iface = new ethers.Interface([`function ${name}(${types.join(',')})`]);
    data = types.length === 1 && /address/.test(types[0])
      ? iface.encodeFunctionData(name, [caller]) : iface.encodeFunctionData(name, []);
  } catch { return { callable: false, why: 'could not encode' }; }
  try {
    const r = await fetch(rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data, from: caller }, 'latest'] }),
    });
    const out = await r.json();
    if (out.error) return { callable: false, why: String(out.error.message || '').slice(0, 90) };
    return { callable: true, returned: String(out.result || '').slice(0, 66) };
  } catch (e) { return { callable: false, why: String(e.message).slice(0, 60) }; }
}

// Bootstrap seed keepers on a chain with none: look at contracts we ALREADY know pay callers
// (the strategies we harvest), and read who else they pay. Those recipients are other keepers â€”
// and each one is a doorway to every other contract that pays them. The network seeds itself.
export async function bootstrapKeepers(chain, knownPayers = [], perContract = 25) {
  const base = SCOUT[chain];
  if (!base) return [];
  const keepers = {};
  for (const c of knownPayers.slice(0, 6)) {
    let data;
    try { data = await j(`${base}/api/v2/addresses/${c}/token-transfers?type=ERC-20&filter=from`); }
    catch { continue; }
    for (const it of (data.items || []).slice(0, perContract)) {
      const to = it.to?.hash;
      if (!to || to.toLowerCase() === c.toLowerCase()) continue;
      // EOAs receiving repeated fee payments are exactly what a keeper bot looks like
      keepers[to] = (keepers[to] || 0) + 1;
    }
  }
  return Object.entries(keepers)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([addr, n]) => ({ address: addr, seen: n }));
}

// One discovery pass: seeds -> payers -> inspected candidates, persisted for the agent to work through.
export async function discoveryPass(env, { chain = 'arbitrum', maxPayers = 12, rpcRaw = null } = {}) {
  const state = (await env.KV.get('discover:state', 'json')) || { keepers: {}, candidates: {}, passes: 0 };
  let seeds = [...(SEED_KEEPERS[chain] || []), ...Object.keys(state.keepers).filter(k => state.keepers[k] === chain)];

  // BREAK THE CLOSED LOOP. Every few passes, inject keepers found MECHANISM-BLIND from raw block
  // data rather than from the family we already farm. Without this the engine only ever rediscovers
  // Beefy — it produced 307 candidates of a single family and called it 48 "streams".
  // Blind-seed every 3rd pass — or IMMEDIATELY on a chain with no seeds at all, because a chain
  // with no keepers, no known payers, and a %3 gate would stay barren forever (gnosis/unichain did).
  if (rpcRaw && (state.passes % 3 === 0 || !seeds.length)) {
    try {
      const blind = await blindSeed(chain, rpcRaw, 12);
      const fresh = blind.filter(a => !state.keepers[a]);
      for (const a of fresh) state.keepers[a] = chain;
      state.blindSeeded = (state.blindSeeded || 0) + fresh.length;
      seeds = [...fresh, ...seeds];
    } catch (e) { console.log('blindSeed FAILED (' + chain + '): ' + String(e && e.message).slice(0, 140)); /* enhancement, never a blocker — but never again silent: this catch hid a ReferenceError for the life of the module */ }
  }
  // Self-seed: a chain with no known keepers bootstraps from contracts we already know pay callers.
  if (!seeds.length) {
    const known = (state.knownPayers && state.knownPayers[chain]) || KNOWN_PAYERS[chain] || [];
    if (!known.length) return { skipped: 'no seed keepers and no known payers for ' + chain };
    const found = await bootstrapKeepers(chain, known);
    for (const k of found.slice(0, 6)) state.keepers[k.address] = chain;
    seeds = found.slice(0, 4).map(k => k.address);
    if (!seeds.length) return { skipped: 'bootstrap found no keepers on ' + chain };
  }

  const found = [];
  for (const keeper of seeds.slice(0, 4)) {
    let payers = [];
    try { payers = await payersOf(chain, keeper); } catch { continue; }
    for (const p of payers.slice(0, maxPayers)) {
      if (isNoise(p.name)) continue; // swap counterparty, not a payer of callers
      const key = `${chain}:${(p.contract || '').toLowerCase()}`;
      if (state.candidates[key]) { state.candidates[key].seen += 1; continue; }
      let ins = {};
      try { ins = await inspect(chain, p.contract); } catch { /* keep going */ }
      state.candidates[key] = {
        chain, contract: p.contract, name: p.name || ins.name || null,
        payouts_seen: p.n, tokens: p.tokens, last: p.last,
        verified: !!ins.verified, access_controlled: ins.access_controlled ?? null,
        pays_a_caller: ins.pays_a_caller ?? null,
        implementation: ins.implementation || null,
        // The decisive fact: a function that simulates clean FROM OUR OWN ADDRESS. Source regexes lie
        // in both directions; an eth_call cannot.
        callable_now: ins.callable_now || [],
        // Stamp ONLY when inspect genuinely returned a result. The catch above sets ins={} on failure,
        // so 'inspect blew up' and 'inspect ran and found nothing' both produced [] and were
        // indistinguishable — which is why the triage queue reported 214 candidates as fully triaged
        // while never having simulated one of them.
        triaged_at: Array.isArray(ins.callable_now) ? Date.now() : null,
        functions: ins.candidate_functions || [], verdict: ins.verdict || null,
        seen: 1, tried: false,
      };
      found.push(state.candidates[key]);
    }
  }
  // RE-INSPECT STALE CANDIDATES. A candidate is inspected once, at discovery time, and then never
  // looked at again — so when the proxy resolver was fixed, 214 already-stored candidates would have
  // stayed mis-scored forever. Refresh a few every pass: any candidate never scored for callability,
  // oldest first. This is also how the list self-heals whenever inspection gets smarter.
  const stale = Object.values(state.candidates).filter(c => c.callable_now === undefined && !c.tried);
  let refreshed = 0;
  for (const c of stale.slice(0, 4)) {
    try {
      const ins = await inspect(c.chain, c.contract);
      c.verified = !!ins.verified;
      c.access_controlled = ins.access_controlled ?? null;
      c.pays_a_caller = ins.pays_a_caller ?? null;
      c.implementation = ins.implementation || null;
      c.callable_now = ins.callable_now || [];
      c.functions = ins.candidate_functions || c.functions || [];
      c.verdict = ins.verdict || c.verdict;
      c.name = c.name || ins.name || null;
      refreshed++;
    } catch { c.callable_now = []; /* mark attempted so it does not block the queue forever */ }
  }

  state.passes += 1;
  state.lastPass = new Date().toISOString();
  await env.KV.put('discover:state', JSON.stringify(state));
  // Gating on `pays_a_caller` — a REGEX OVER SOURCE — threw away every one of 214 candidates while
  // reporting "0 promising", which is what stalled expansion for eleven sessions. It was the weakest
  // signal available and it was being used as a hard gate.
  //
  // Rank by EVIDENCE instead, strongest first:
  //   callable_now  — it simulated clean from our own address. Cannot lie.
  //   payouts_seen  — we watched it actually pay a keeper, N times. Already empirical.
  // The source regex survives only as a tiebreaker hint. Nothing is discarded for failing it, because
  // every stream we can stack has to get FOUND before it can be proven, and a silent filter that
  // returns zero forever is worse than a noisy list.
  // A contract that SIMULATES CALLABLE is never excluded for having `onlyOwner` somewhere in its
  // source. Measured: StrategyERC4626, StrategyPassiveManagerVelodromeV4 and StrategyMerkl all match
  // the access-control regex AND all three simulate clean from our own address. The eth_call wins.
  const scored = Object.values(state.candidates)
    .filter(c => c.callable_now?.length || !c.access_controlled)
    .map(c => ({
      ...c,
      score: (c.callable_now?.length ? 1000 : 0) + (c.payouts_seen || 0) * 10 + (c.pays_a_caller ? 5 : 0) + (c.verified ? 1 : 0),
    }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score);
  const callable = scored.filter(c => c.callable_now?.length);
  return {
    chain, new_candidates: found.length,
    total_candidates: Object.keys(state.candidates).length,
    rescored_this_pass: refreshed,
    still_unscored: Math.max(0, stale.length - refreshed),
    promising_open: scored.length,
    callable_right_now: callable.length,
    next_step: callable.length
      ? 'These simulated CALLABLE from your own address. Run payout_history on the top one before spending a relay slot — a callable function that pays the caller nothing is still worth zero.'
      : 'None simulate callable yet. Work down the ranked list with inspect_contract, and use payout_history to check whether each has ever actually paid a caller.',
    top: scored.slice(0, 8).map(c => ({
      contract: c.contract, name: c.name, chain: c.chain,
      payouts_seen: c.payouts_seen, callable_now: c.callable_now || [],
      implementation: c.implementation || null,
      functions: (c.functions || []).slice(0, 3).map(f => f.sig),
    })),
  };
}




