// _fa_probe.mjs — probe candidates for a function that pays an arbitrary caller. READ-ONLY.
//
// Two tiers, because probing every selector on every contract in isolation is unaffordable and
// probing only names somebody thought of in advance is a guess:
//   TIER 1  every claim-shaped signature the contract's own dispatch table actually exposes,
//           each one run through the ISOLATED payment test. Precise, ~0-3 calls per contract.
//   TIER 2  a batched delta SCREEN across every remaining selector (shared state — screening only,
//           never a finding), then each screen hit re-run through the ISOLATED payment test.
//           This is what catches the unnamed functions, which are the interesting ones.
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import * as L from './_fa_lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// Every shape a "give the caller tokens" function has taken in the wild.
export const CLAIM_SIGS = [
  'claim()', 'claim(address)', 'claim(uint256)', 'claim(address,uint256)',
  'claimTokens()', 'claimTokens(address)', 'claimToken()', 'claimAll()',
  'claimAirdrop()', 'claimAirdrop(address)', 'claimDrop()', 'claimFree()',
  'claimReward()', 'claimReward(address)', 'claimRewards()', 'getReward()', 'getReward(address)',
  'faucet()', 'faucet(address)', 'faucetDrip()', 'useFaucet()',
  'drip()', 'drip(address)', 'dripTo(address)',
  'getTokens()', 'getTokens(address)', 'getToken()', 'getFreeTokens()',
  'requestTokens()', 'requestTokens(address)', 'requestToken()', 'requestFunds()', 'request()',
  'mint()', 'mint(address)', 'mint(uint256)', 'freeMint()', 'freeMint(address)',
  'publicMint()', 'mintFree()', 'mintTo(address)', 'devMint()',
  'airdrop()', 'airdrop(address)', 'airdropTokens()',
  'redeem()', 'redeem(address)', 'withdraw()', 'withdrawTokens()', 'withdrawAll()',
  'collect()', 'collect(address)', 'harvest()', 'harvest(address)',
  'dispense()', 'dispense(address)', 'gift()', 'give()', 'giveMe()', 'grab()', 'tap()',
  'distribute()', 'distributeTokens()', 'release()', 'release(address)',
  'free()', 'freeTokens()', 'takeTokens()', 'take()', 'pull()', 'send()', 'sendTokens()',
];
const SIG_BY_SEL = new Map();
for (const s of CLAIM_SIGS) { const k = L.sel(s); if (!SIG_BY_SEL.has(k)) SIG_BY_SEL.set(k, s); }

// Selectors that can never pay an arbitrary caller — probing them is wasted budget.
const NEVER = new Set([
  'name()', 'symbol()', 'decimals()', 'totalSupply()', 'balanceOf(address)', 'allowance(address,address)',
  'owner()', 'paused()', 'DOMAIN_SEPARATOR()', 'nonces(address)', 'supportsInterface(bytes4)',
  'transfer(address,uint256)', 'transferFrom(address,address,uint256)', 'approve(address,uint256)',
  'renounceOwnership()', 'transferOwnership(address)', 'implementation()', 'proxiableUUID()',
].map(L.sel));

/** Argument shapes to try for a selector whose signature we do not know. */
function variantsFor(s, sig) {
  const v = [{ sel: s, sig: sig || `unknown${s}`, shape: '()', data: s }];
  if (!sig || /\(address\)/.test(sig)) v.push({ sel: s, sig: sig || `unknown${s}(address)`, shape: '(address)', data: s + L.addrArg(L.ZERO_SAFE) });
  if (!sig || /\(uint256\)/.test(sig)) v.push({ sel: s, sig: sig || `unknown${s}(uint256)`, shape: '(uint256)', data: s + L.u256(0) });
  return v;
}

/** Everything this contract could possibly pay in: itself (if a token), what it holds, the majors. */
async function watchTokens(chain, contract) {
  const out = [];
  const seen = new Set();
  const add = (t) => { const k = t.address.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t); } };
  // Is the candidate itself an ERC-20? A self-minting faucet pays in its own token.
  const sup = await L.tryCall(chain, contract, L.sel('totalSupply()'));
  if (sup && sup !== '0x') {
    const symHex = await L.tryCall(chain, contract, L.sel('symbol()'));
    const decHex = await L.tryCall(chain, contract, L.sel('decimals()'));
    add({ symbol: L.decStr(symHex) || 'SELF', address: ethers.getAddress(contract), decimals: Number(L.dec(decHex) ?? 18n), self: true });
  }
  for (const t of (L.REF_TOKENS[chain] || [])) add(t);
  return out;
}

export async function probeContract(chain, contract, meta = {}) {
  const iface = await L.interfaceOf(chain, contract);
  if (iface.isEOA) return { chain, contract, ...meta, verdict: 'DEAD', why: 'no code at address' };
  if (!iface.selectors.length) return { chain, contract, ...meta, impl: iface.impl, verdict: 'DEAD', why: 'no dispatch table recovered (unresolved proxy?)' };

  const tokens = await watchTokens(chain, contract);
  const selves = tokens.filter(t => t.self);

  // ---- TIER 1: named claim-shaped signatures the dispatch table actually exposes.
  const named = [];
  for (const s of iface.selectors) {
    const sig = SIG_BY_SEL.get(s);
    if (sig) named.push({ sel: s, sig, shape: sig.slice(sig.indexOf('(')), data: buildData(sig) });
  }
  const paying = [];
  const callableNoPay = [];
  for (const v of named) {
    const r = await L.payTest(chain, contract, v.data, tokens);
    if (r.pays) paying.push({ ...v, deltas: r.deltas });
    else if (r.callable) callableNoPay.push(v.sig);
  }

  // ---- TIER 2: batched SCREEN over everything else, isolated-confirm each screen hit.
  let screened = 0;
  if (!paying.length) {
    const rest = iface.selectors.filter(s => !SIG_BY_SEL.has(s) && !NEVER.has(s));
    const variants = rest.flatMap(s => variantsFor(s, null));
    screened = variants.length;
    const watch = selves[0] || tokens[0];
    if (watch && variants.length) {
      const wt = watch.address, wd = L.balOf(L.MULTICALL3);
      const hits = (await L.screenSelectors(chain, contract, variants, wt, wd))
        .filter(h => h.screenWei !== '0');
      for (const h of hits.slice(0, 12)) {
        const r = await L.payTest(chain, contract, h.data, tokens);
        if (r.pays) paying.push({ sel: h.sel, sig: h.sig, shape: h.shape, data: h.data, deltas: r.deltas, fromScreen: true });
      }
    }
  }

  return {
    chain, contract, ...meta, impl: iface.impl, codeSize: iface.size,
    functions: iface.selectors.length, namedProbed: named.length, screened,
    tokensWatched: tokens.map(t => t.symbol),
    callableNoPay,
    paying,
    verdict: paying.length ? 'PAYS' : 'no function pays an arbitrary caller',
  };
}

function buildData(sig) {
  const s = L.sel(sig);
  if (/\(address\)$/.test(sig)) return s + L.addrArg(L.ZERO_SAFE);
  if (/\(uint256\)$/.test(sig)) return s + L.u256(1);
  if (/\(address,uint256\)$/.test(sig)) return s + L.addrArg(L.ZERO_SAFE) + L.u256(1);
  return s;
}

// ------------------------------------------------------------------ runner
if (process.argv[1] && process.argv[1].endsWith('_fa_probe.mjs')) {
  const uni = JSON.parse(fs.readFileSync(path.join(HERE, '_fa_universe.json'), 'utf8'));
  const only = process.argv[2];
  const list = only ? uni.filter(c => c.chain === only) : uni;
  const outPath = path.join(HERE, `_fa_hits${only ? '_' + only : ''}.json`);
  const results = [];
  let n = 0, pays = 0;
  for (const c of list) {
    try {
      const r = await probeContract(c.chain, c.address, { name: c.name, src: c.src, type: c.type });
      if (r.verdict === 'PAYS') {
        pays++;
        console.log(`PAYS ${r.chain} ${r.contract} ${JSON.stringify(r.name)} :: ` +
          r.paying.map(p => `${p.sig} -> ` + p.deltas.map(d => `${d.wei} ${d.symbol}@${d.recipient.slice(0, 8)}`).join(',')).join(' | '));
      }
      results.push(r);
    } catch (e) { results.push({ chain: c.chain, contract: c.address, verdict: 'ERROR', why: String(e.message).slice(0, 120) }); }
    if (++n % 25 === 0) { console.log(`  ..${n}/${list.length} pays=${pays}`); fs.writeFileSync(outPath, JSON.stringify(results, null, 1)); }
  }
  fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
  console.log(`\nDONE ${n} probed, ${pays} pay -> ${outPath}`);
}
