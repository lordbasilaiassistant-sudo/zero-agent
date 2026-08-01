// _fa_pass2.mjs — second pass for the signatures the first pass did not know about.
// Cheap because interfaceOf() is cached from pass 1: for most contracts this is zero RPC calls,
// and the isolated payment test only runs where the dispatch table actually exposes the selector.
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import * as L from './_fa_lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const NEW_SIGS = [
  'mint(address,uint256)', 'mint(uint256,address)', 'mintTo(address,uint256)',
  'freeMint(uint256)', 'publicMint(uint256)', 'claim(address,uint256)',
  'airdrop(address,uint256)', 'transfer(address,uint256)', 'drip(address,uint256)',
  'distribute(address,uint256)', 'send(address,uint256)', 'giveTo(address,uint256)',
];
const AMT = 10n ** 18n;
const dataFor = (sig) => /\(uint256,address\)/.test(sig)
  ? L.sel(sig) + L.u256(AMT) + L.addrArg(L.ZERO_SAFE)
  : L.sel(sig) + L.addrArg(L.ZERO_SAFE) + L.u256(AMT);

async function selfToken(chain, c) {
  const sup = await L.tryCall(chain, c, L.sel('totalSupply()'));
  if (!sup || sup === '0x') return null;
  const s = L.decStr(await L.tryCall(chain, c, L.sel('symbol()')));
  const d = L.dec(await L.tryCall(chain, c, L.sel('decimals()')));
  return { symbol: s || 'SELF', address: ethers.getAddress(c), decimals: Number(d ?? 18n), self: true };
}

export async function pass2(chain, contract, meta = {}) {
  const iface = await L.interfaceOf(chain, contract);
  if (iface.isEOA || !iface.selectors.length) return null;
  const present = NEW_SIGS.filter(s => iface.selectors.includes(L.sel(s)));
  if (!present.length) return null;
  const self = await selfToken(chain, contract);
  const tokens = [...(self ? [self] : []), ...(L.REF_TOKENS[chain] || [])];
  const paying = [];
  for (const sig of present) {
    const data = dataFor(sig);
    const r = await L.payTest(chain, contract, data, tokens);
    if (r.pays) paying.push({ sel: L.sel(sig), sig, shape: sig.slice(sig.indexOf('(')), data, deltas: r.deltas });
  }
  if (!paying.length) return null;
  return { chain, contract, ...meta, functions: iface.selectors.length, verdict: 'PAYS', paying, pass: 2 };
}

if (process.argv[1] && process.argv[1].endsWith('_fa_pass2.mjs')) {
  const files = (process.env.FA_UNIVERSES || '_fa_universe.json,_fa_universe_behaviour.json,_fa_universe_other.json').split(',');
  const seen = new Set(); const list = [];
  for (const f of files) {
    let u = []; try { u = JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8')); } catch { continue; }
    for (const c of u) { const k = c.chain + ':' + c.address.toLowerCase(); if (seen.has(k)) continue; seen.add(k); list.push(c); }
  }
  console.log(`pass2 over ${list.length} unique candidates, ${NEW_SIGS.length} signatures`);
  const out = []; let n = 0, cur = 0;
  await Promise.all(Array.from({ length: Number(process.env.FA_CONC || 10) }, async () => {
    while (cur < list.length) {
      const c = list[cur++];
      try {
        const r = await pass2(c.chain, c.address, { name: c.name, src: c.src, type: c.type });
        if (r) { out.push(r); console.log(`PAYS ${r.chain} ${r.contract} ${JSON.stringify(r.name)} :: ` + r.paying.map(p => `${p.sig} -> ` + p.deltas.map(d => `${d.wei} ${d.symbol}@${d.recipient.slice(0, 10)}`).join(',')).join(' | ')); }
      } catch {}
      if (++n % 200 === 0) { console.log(`  ..${n}/${list.length} pays=${out.length}`); fs.writeFileSync(path.join(HERE, '_fa_hits_pass2.json'), JSON.stringify(out, null, 1)); }
    }
  }));
  fs.writeFileSync(path.join(HERE, '_fa_hits_pass2.json'), JSON.stringify(out, null, 1));
  console.log(`\nDONE pass2: ${n} checked, ${out.length} pay`);
}
