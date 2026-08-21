#!/usr/bin/env node
/**
 * SUPERSEDED 2026-08-20 → scripts/wallet-map.mjs
 *
 * The question this file asked was the right one and wallet-map.mjs still asks it: WHO IS ALREADY
 * BEING PAID, RIGHT NOW, BY ANYONE? The scanner underneath it is gone, because its own saved output
 * proves six defects, and the two that matter most both made it report LESS than it had found:
 *
 *   · it priced tokens through a per-chain Blockscout URL that was `null` on arbitrum, so every row
 *     in the last run it ever wrote came back $0.00 — including a 10,206 USDC payout;
 *   · its "permissionless" filter required `usd_per_call > 0`, so that dead price column silently
 *     converted a contract with TEN distinct callers into the verdict `openPayers: 0`.
 *
 * It also could not see native-ETH payouts at all (no Transfer log to read), never subtracted gas
 * from a payout, and overwrote its own result file every run so the map never accumulated — while
 * DOCTRINE.md §5 says the accumulated map is the compounding asset.
 *
 * The NAME is kept as a forwarder rather than deleted because knowledge/genesis.md points here and
 * a stale scanner that still RUNS is worse than one that is missing. wallet-map.mjs still writes
 * freemoney-map-result.json, so scripts/brain-corpus.json keeps its source.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
console.log('freemoney-map.mjs is superseded → running scripts/wallet-map.mjs (see this file for why)\n');

// v1 took positional args: [blocks] [chain]. Translate them so old invocations keep working.
const [blocks, chain] = process.argv.slice(2);
const args = [path.join(HERE, 'wallet-map.mjs')];
if (blocks && /^\d+$/.test(blocks)) args.push('--blocks', blocks);
if (chain) args.push('--chain', chain);

spawn(process.execPath, args, { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
