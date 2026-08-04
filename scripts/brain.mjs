// brain.mjs — ZERO's learned triage layer. Zero dependencies, trains on this laptop, infers in the Worker.
//
// WHY THIS SHAPE (the design decision that matters):
//   We do NOT learn "will this contract pay me" — eth_call already answers that for free and exactly.
//   Learning to approximate a free oracle is wasted compute. The real bottleneck is COVERAGE: Base
//   has millions of contracts and we can simulate a few thousand. So the model does the two jobs
//   simulation can't:
//     (A) TRIAGE  — score an unsimulated contract from bytecode alone, so we spend our simulation
//                   budget on the top 1% instead of a random 1%.
//     (B) CLONES  — once ONE payer is found, retrieve every contract with a similar interface.
//                   Payers travel in families (forks, factory clones, redeploys). This is how a
//                   single hit becomes a hundred, and no amount of simulating random addresses does it.
//
// SPLIT (his PC is not 24/7): TRAIN here, ship a tiny JSON of weights to the Worker, INFER there
// forever. Training is heavy and occasional; inference is a dot product and runs on every cron tick.
//
// Usage:
//   node scripts/brain.mjs build      # ingest every result file into a labelled corpus
//   node scripts/brain.mjs train      # fit the triage scorer, write brain-weights.json
//   node scripts/brain.mjs similar <0xaddress|0xbytecode>   # find the family of a known payer
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, 'brain-corpus.json');
const WEIGHTS = path.join(HERE, 'brain-weights.json');
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'];

async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}

// ── FEATURES ────────────────────────────────────────────────────────────────
// Cheap, bytecode-only, computable without any external call. Everything here must be derivable
// from `eth_getCode` alone, or the Worker can't score a fresh contract in one round trip.
const OPCODES = {
  CALL: 'f1', CALLCODE: 'f2', DELEGATECALL: 'f4', STATICCALL: 'fa', CREATE: 'f0', CREATE2: 'f5',
  SELFDESTRUCT: 'ff', SSTORE: '55', SLOAD: '54', TIMESTAMP: '42', NUMBER: '43', CALLER: '33',
  BALANCE: '31', SELFBALANCE: '47', LOG3: 'a3', REVERT: 'fd',
};

export function selectorsOf(code) {
  const out = new Set(); const hex = code.startsWith('0x') ? code.slice(2) : code;
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) === '63') {
      const s = hex.slice(i + 2, i + 10);
      if (!/^0{8}$/.test(s) && !/^f{8}$/.test(s)) out.add('0x' + s);
    }
  }
  return [...out];
}

export function featurize(code) {
  const hex = (code || '0x').startsWith('0x') ? code.slice(2) : code;
  const len = hex.length / 2;
  const sels = selectorsOf(code);
  const f = {
    log_size: len ? Math.log10(len) : 0,
    n_selectors: sels.length,
    log_selectors: sels.length ? Math.log10(sels.length + 1) : 0,
    is_minimal_proxy: hex.startsWith('363d3d373d3d3d363d73') ? 1 : 0,
  };
  // opcode density — a contract that MOVES VALUE must contain CALL and touch balances
  for (const [name, op] of Object.entries(OPCODES)) {
    let c = 0, i = 0;
    while ((i = hex.indexOf(op, i)) !== -1) { if (i % 2 === 0) c++; i += 2; }
    f['op_' + name] = len ? Math.min(1, c / Math.max(1, len / 100)) : 0;
  }
  // the money shapes: a payer nearly always has CALL + (SELFBALANCE|BALANCE) + CALLER
  f.money_shape = (f.op_CALL > 0 && (f.op_SELFBALANCE > 0 || f.op_BALANCE > 0) && f.op_CALLER > 0) ? 1 : 0;
  f.can_delegate = f.op_DELEGATECALL > 0 ? 1 : 0;
  f.bias = 1;
  return { features: f, selectors: sels };
}

const FEATURE_KEYS = (() => {
  const { features } = featurize('0x');
  return Object.keys(features).sort();
})();
const vec = (f) => FEATURE_KEYS.map(k => f[k] ?? 0);

// ── BUILD: harvest labels from every probe we have ever run ─────────────────
async function build() {
  const rows = [];
  const files = readdirSync(HERE).filter(f => f.endsWith('-result.json'));
  const seen = new Set();
  const push = (addr, label, meta) => {
    const a = (addr || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return;
    const key = a + ':' + label;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ address: a, label, ...meta });
  };

  for (const file of files) {
    let j; try { j = JSON.parse(readFileSync(path.join(HERE, file), 'utf8')); } catch { continue; }
    // result files differ in shape across probes; only iterate what is genuinely a list
    const arr = (v) => (Array.isArray(v) ? v : []);
    // POSITIVES: observed paying a real third-party caller on-chain
    for (const r of [...arr(j.permissionless), ...arr(j.top)]) {
      if (r?.contract && r.usd_per_call > 0 && (r.distinct_callers ?? 0) >= 2) push(r.contract, 1, { src: file, usd: r.usd_per_call, callers: r.distinct_callers });
    }
    // NEGATIVES: we fired at it from our own address and it did not pay us
    for (const r of arr(j.results)) {
      if (r?.contract && r.PAYS !== true && !r.untested) push(r.contract, 0, { src: file, revert: (r.revert || '').slice(0, 60) });
    }
    for (const r of arr(j.sample)) if (r?.contract) push(r.contract, 0, { src: file });
    for (const r of arr(j.WINNERS)) if (r?.contract) push(r.contract, 1, { src: file, winner: true });
    // day-0 fossils: funded but unclaimable = negative; executable state-changer = positive lead
    for (const r of arr(j.funded)) if (r?.address) push(r.address, 0, { src: file, fossil: true });
    for (const r of arr(j.executableFindings)) if (r?.fossil) push(r.fossil, 1, { src: file, fossil: true });
  }

  console.log(`labelled addresses: ${rows.length} (pos ${rows.filter(r => r.label === 1).length} / neg ${rows.filter(r => r.label === 0).length})`);
  console.log('fetching bytecode…');
  let n = 0;
  for (const r of rows) {
    try { r.code = await rpc('eth_getCode', [r.address, 'latest']); } catch { r.code = '0x'; }
    const { features, selectors } = featurize(r.code || '0x');
    r.x = vec(features); r.selectors = selectors; delete r.code;
    if (++n % 40 === 0) console.log(`  …${n}/${rows.length}`);
  }
  writeFileSync(CORPUS, JSON.stringify({ builtAt: new Date().toISOString(), featureKeys: FEATURE_KEYS, rows }, null, 1));
  console.log(`saved -> ${CORPUS}`);
}

// ── TRAIN: logistic regression, plain JS, no deps, seconds on a laptop ──────
function train() {
  const { rows, featureKeys } = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const data = rows.filter(r => r.x && r.x.length);
  const pos = data.filter(r => r.label === 1).length;
  if (pos < 5 || data.length - pos < 5) {
    console.log(`REFUSING TO TRAIN: ${pos} positives / ${data.length - pos} negatives.`);
    console.log('A model fit on this would be memorising noise. Run more sweeps first — the corpus');
    console.log('grows every time freemoney-map or sweep1000 runs. This refusal IS the honest output.');
    return;
  }
  const d = featureKeys.length;
  let w = new Array(d).fill(0);
  const lr = 0.1, epochs = 800, l2 = 1e-3;
  for (let e = 0; e < epochs; e++) {
    const g = new Array(d).fill(0);
    for (const r of data) {
      const z = r.x.reduce((s, v, i) => s + v * w[i], 0);
      const p = 1 / (1 + Math.exp(-z));
      const err = p - r.label;
      for (let i = 0; i < d; i++) g[i] += err * r.x[i];
    }
    for (let i = 0; i < d; i++) w[i] -= lr * (g[i] / data.length + l2 * w[i]);
  }
  // honest evaluation: accuracy on the training set is meaningless; report separation instead
  const score = (x) => 1 / (1 + Math.exp(-x.reduce((s, v, i) => s + v * w[i], 0)));
  const ps = data.filter(r => r.label === 1).map(r => score(r.x));
  const ns = data.filter(r => r.label === 0).map(r => score(r.x));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  writeFileSync(WEIGHTS, JSON.stringify({ trainedAt: new Date().toISOString(), featureKeys, weights: w, n: data.length, pos, meanPos: mean(ps), meanNeg: mean(ns) }, null, 1));
  console.log(`trained on ${data.length} (pos ${pos}). mean score: positives ${mean(ps).toFixed(3)} vs negatives ${mean(ns).toFixed(3)}`);
  console.log(`saved -> ${WEIGHTS}  (ship this JSON to the Worker; inference is one dot product)`);
}

// ── SIMILAR: the clone finder — one hit becomes a family ────────────────────
async function similar(target) {
  const { rows } = JSON.parse(readFileSync(CORPUS, 'utf8'));
  let sels;
  if (/^0x[0-9a-fA-F]{40}$/.test(target)) sels = selectorsOf(await rpc('eth_getCode', [target, 'latest']));
  else sels = selectorsOf(target);
  const A = new Set(sels);
  const scored = rows.filter(r => r.selectors?.length).map(r => {
    const B = new Set(r.selectors);
    let inter = 0; for (const s of A) if (B.has(s)) inter++;
    const union = A.size + B.size - inter;
    return { address: r.address, label: r.label, jaccard: union ? inter / union : 0, shared: inter };
  }).sort((a, b) => b.jaccard - a.jaccard).slice(0, 25);
  console.log(`target exposes ${A.size} selectors. nearest interfaces in corpus:`);
  for (const s of scored) console.log(`  ${s.jaccard.toFixed(3)} (${s.shared} shared) ${s.address} label=${s.label}`);
}

const cmd = process.argv[2];
if (cmd === 'build') await build();
else if (cmd === 'train') train();
else if (cmd === 'similar') await similar(process.argv[3]);
else console.log('usage: node scripts/brain.mjs build | train | similar <0xaddr|0xbytecode>');
