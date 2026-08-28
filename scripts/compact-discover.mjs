#!/usr/bin/env node
// compact-discover.mjs — shrink discover:state BEFORE a deploy so the first parse cannot OOM.
//
// MEASURED 2026-08-23: 4.0 MB / 6,639 candidates killed every cron `exceededMemory` for ~40 minutes.
// pruneDiscoverState runs on write AFTER deploy; this script is the missing first step — compact
// the live blob so the Worker never has to parse the fat copy.
//
//   node scripts/compact-discover.mjs --selftest
//   node scripts/compact-discover.mjs dump.json              # write dump.compact.json, no KV
//   node scripts/compact-discover.mjs --kv                   # wrangler get → local compact file
//   node scripts/compact-discover.mjs --kv --apply           # put compacted blob back (OPERATOR)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pruneDiscoverState, DISCOVER_CANDIDATE_CAP, DISCOVER_SAFE_BYTES } from '../discover.mjs';

const NS = '8842359b115d440ea0de22f3be061198';
const KEY = 'discover:state';
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const positional = args.filter(a => !a.startsWith('--'));
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function wrangler(extra) {
  // Windows Node cannot execFileSync('npx') (ENOENT) or 'npx.cmd' without a shell (EINVAL).
  // MEASURED 2026-08-27 on this machine. sync.mjs already uses shell:true for the same reason.
  // `--remote` is required: wrangler 4 `kv key get` otherwise reads the empty local preview
  // store and prints "Value not found".
  return execFileSync(NPX, ['wrangler', ...extra], {
    encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
}

if (flag('--selftest')) {
  const fat = { candidates: {} };
  for (let i = 0; i < 80; i++) {
    fat.candidates['x' + i] = {
      retired: true, payout_verdict: 'PAYS_ZERO', retired_at: 1, first_seen: '2020-01-01',
      functions: Array(40).fill({ sig: 'harvest()', extra: 'x'.repeat(120) }),
    };
  }
  fat.candidates.keep = { payout_verdict: 'PAYS_CALLERS', first_seen: '2019' };
  const before = Buffer.byteLength(JSON.stringify(fat));
  const { state, size } = pruneDiscoverState(fat, { cap: 10, now: 1e15 });
  const after = Buffer.byteLength(JSON.stringify(state));
  if (!(after < before) || !state.candidates.keep || size > 10) {
    console.error(`selftest FAIL before=${before} after=${after} size=${size} keep=${!!state.candidates.keep}`);
    process.exit(1);
  }
  console.log(`selftest ok ${before} → ${after} bytes, ${size} candidates, payer kept`);
  process.exit(0);
}

let src;
let srcLabel;
if (flag('--kv')) {
  srcLabel = `KV ${KEY}`;
  src = JSON.parse(wrangler(['kv', 'key', 'get', KEY, '--namespace-id', NS, '--remote']));
} else if (positional[0]) {
  srcLabel = positional[0];
  src = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
} else {
  console.error('usage: node scripts/compact-discover.mjs <file.json> | --kv [--apply] | --selftest');
  process.exit(2);
}

const beforeBytes = Buffer.byteLength(JSON.stringify(src));
const beforeN = Object.keys(src.candidates || {}).length;
let cap = DISCOVER_CANDIDATE_CAP;
let { state, pruned, compacted, size } = pruneDiscoverState(src, { cap });
let out = JSON.stringify(state);
let afterBytes = Buffer.byteLength(out);
while (afterBytes > DISCOVER_SAFE_BYTES && cap > 200) {
  cap = Math.max(200, Math.floor(cap * DISCOVER_SAFE_BYTES / afterBytes * 0.92));
  ({ state, pruned, compacted, size } = pruneDiscoverState(src, { cap }));
  out = JSON.stringify(state);
  afterBytes = Buffer.byteLength(out);
}
if (afterBytes > DISCOVER_SAFE_BYTES) {
  console.error(`compact still ${afterBytes} bytes > DISCOVER_SAFE_BYTES=${DISCOVER_SAFE_BYTES}; refuse apply`);
  process.exit(1);
}

console.log(JSON.stringify({
  source: srcLabel,
  cap,
  safe_bytes: DISCOVER_SAFE_BYTES,
  before: { bytes: beforeBytes, candidates: beforeN },
  after: { bytes: afterBytes, candidates: size, pruned, compacted },
  shrink_ratio: beforeBytes ? +(afterBytes / beforeBytes).toFixed(3) : null,
  apply: flag('--apply'),
}, null, 2));

if (flag('--kv') && flag('--apply')) {
  const tmp = path.join(process.env.TEMP || '/tmp', 'discover-state.compact.json');
  fs.writeFileSync(tmp, out);
  wrangler(['kv', 'key', 'put', KEY, '--namespace-id', NS, '--path', tmp, '--remote']);
  const bytesFile = path.join(process.env.TEMP || '/tmp', 'discover-bytes.txt');
  fs.writeFileSync(bytesFile, String(afterBytes));
  wrangler(['kv', 'key', 'put', 'discover:bytes', '--namespace-id', NS, '--path', bytesFile, '--remote']);
  console.log('applied to KV ' + KEY + ' and discover:bytes=' + afterBytes);
} else {
  const dest = positional[0]
    ? positional[0].replace(/\.json$/i, '') + '.compact.json'
    : path.join('state', 'discover-state.compact.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out);
  console.log('wrote ' + dest + ' (KV untouched)');
}
