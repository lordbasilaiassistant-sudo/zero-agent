// discover.mjs â€” the teat-finder. Turns one proven income family into many.
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
};
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

export async function resolveImpl(chain, contract) {
  const rpc = RPCS[chain];
  if (!rpc) return null;
  try {
    const r = await fetch(rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getStorageAt', params: [contract, IMPL_SLOT, 'latest'] }),
    });
    const v = (await r.json()).result || '';
    if (v.length < 42) return null;
    const impl = '0x' + v.slice(26);
    return /^0x0+$/.test(impl) ? null : impl;
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
export async function discoveryPass(env, { chain = 'arbitrum', maxPayers = 12 } = {}) {
  const state = (await env.KV.get('discover:state', 'json')) || { keepers: {}, candidates: {}, passes: 0 };
  let seeds = [...(SEED_KEEPERS[chain] || []), ...Object.keys(state.keepers).filter(k => state.keepers[k] === chain)];
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
        functions: ins.candidate_functions || [], verdict: ins.verdict || null,
        seen: 1, tried: false,
      };
      found.push(state.candidates[key]);
    }
  }
  state.passes += 1;
  state.lastPass = new Date().toISOString();
  await env.KV.put('discover:state', JSON.stringify(state));
  const open = Object.values(state.candidates).filter(c => c.verified && !c.access_controlled && c.pays_a_caller);
  return {
    chain, new_candidates: found.length,
    total_candidates: Object.keys(state.candidates).length,
    promising_open: open.length,
    top: open.sort((a, b) => b.payouts_seen - a.payouts_seen).slice(0, 8)
      .map(c => ({ contract: c.contract, name: c.name, payouts_seen: c.payouts_seen, functions: c.functions.slice(0, 3).map(f => f.sig) })),
  };
}




