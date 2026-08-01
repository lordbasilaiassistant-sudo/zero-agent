// _fa_behaviour.mjs — find giveaway contracts by what they DO, not by what they are called.
//
// Name-matching finds contracts whose author typed "faucet". Most giveaways never say so. What a
// giveaway cannot hide is its footprint in the log: one source, many distinct recipients, repeatedly.
// So this reads raw Transfer logs off the chain and ranks contracts by that footprint.
//
// Two footprints, both bought with the same logs:
//   MINT       Transfer(from=0x0, to=X) — X got tokens out of thin air. Many distinct X on one token
//              in a short window is an open mint, which is a faucet whatever it is named.
//   DISTRIBUTE Transfer(from=C, to=X) where C has code — a contract handing its balance out.
// READ-ONLY: eth_getLogs + eth_getCode only.
import fs from 'fs';
import path from 'path';
import * as L from './_fa_lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO32 = '0x' + '0'.repeat(64);
const addrOf = (topic) => '0x' + topic.slice(26);

export async function scan(chain, { blocks = 600, chunk = 10 } = {}) {
  const head = BigInt(await L.rpc(chain, 'eth_blockNumber', []));
  const mints = new Map();      // token -> Set(recipient)
  const dist = new Map();       // `${token}|${from}` -> Set(recipient)
  const repeats = new Map();    // `${token}|${from}` -> Map(recipient -> count)  <- repeatability evidence
  let got = 0, done = 0;

  for (let off = 0; off < blocks; off += chunk) {
    const to = head - BigInt(off);
    const from = to - BigInt(chunk - 1);
    let logs;
    try {
      logs = await L.rpc(chain, 'eth_getLogs', [{
        fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER],
      }]);
    } catch { continue; }
    done += chunk; got += logs.length;
    for (const lg of logs) {
      if (!lg.topics || lg.topics.length < 3) continue;   // ERC-721 has 4; ERC-20 has 3
      const token = lg.address.toLowerCase();
      const f = lg.topics[1], t = lg.topics[2];
      if (t === ZERO32) continue;                          // a burn pays nobody
      const rcpt = addrOf(t);
      if (f === ZERO32) {
        if (!mints.has(token)) mints.set(token, new Set());
        mints.get(token).add(rcpt);
      } else {
        const src = addrOf(f);
        const k = `${token}|${src}`;
        if (!dist.has(k)) dist.set(k, new Set());
        dist.get(k).add(rcpt);
        if (!repeats.has(k)) repeats.set(k, new Map());
        const m = repeats.get(k);
        m.set(rcpt, (m.get(rcpt) || 0) + 1);
      }
    }
  }

  // A distributor is only interesting if the SOURCE has code — an EOA airdropping by hand is not a
  // contract anyone can call. Check code once per unique source, not once per log.
  const srcs = [...new Set([...dist.keys()].map(k => k.split('|')[1]))];
  const isContract = new Map();
  const CONC = 12;
  let ci = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (ci < srcs.length) {
      const s = srcs[ci++];
      const code = await L.codeOf(chain, s).catch(() => '0x');
      isContract.set(s, !!code && code !== '0x');
    }
  }));

  const out = [];
  for (const [token, set] of mints) {
    if (set.size < 3) continue;
    out.push({ chain, address: token, name: null, type: 'token', verified: false,
      src: `behaviour:mint(${set.size} distinct recipients / ${done} blocks)`, distinctRecipients: set.size, kind: 'MINT' });
  }
  for (const [k, set] of dist) {
    const [token, src] = k.split('|');
    if (!isContract.get(src)) continue;
    if (set.size < 4) continue;
    const rp = repeats.get(k);
    const repeaters = [...rp.values()].filter(v => v > 1).length;
    out.push({ chain, address: src, name: null, type: 'contract', verified: false,
      src: `behaviour:distribute(${set.size} distinct recipients of ${token} / ${done} blocks)`,
      distinctRecipients: set.size, repeatRecipients: repeaters, payToken: token, kind: 'DISTRIBUTE' });
  }
  out.sort((a, b) => b.distinctRecipients - a.distinctRecipients);
  console.log(`${chain}: ${done} blocks, ${got} Transfer logs -> ${out.length} behavioural candidates ` +
    `(${out.filter(o => o.kind === 'MINT').length} open-mint, ${out.filter(o => o.kind === 'DISTRIBUTE').length} distributor)`);
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('_fa_behaviour.mjs')) {
  const chains = (process.argv[2] || 'base').split(',');
  const blocks = Number(process.argv[3] || 600);
  let all = [];
  for (const c of chains) all = all.concat(await scan(c, { blocks }));
  const p = path.join(HERE, '_fa_behaviour.json');
  fs.writeFileSync(p, JSON.stringify(all, null, 1));
  console.log(`TOTAL ${all.length} -> ${p}`);
  for (const o of all.slice(0, 15)) console.log(' ', o.chain, o.address, o.kind, o.distinctRecipients, o.repeatRecipients ?? '');
}
