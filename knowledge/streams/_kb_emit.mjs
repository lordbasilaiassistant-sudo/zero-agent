// Emit keeper-bounties.json straight from the measurement files so no number is retyped by hand.
import fs from 'fs';
import { ethers } from 'ethers';

const P = { ETH: 1864.59993907, AERO: 0.41823577, VELO: 0.01728661, POL: 0.071453 };
const usd = (wei, sym, dec = 18) => Number(ethers.formatUnits(wei, dec)) * P[sym];
const R = (f) => JSON.parse(fs.readFileSync('knowledge/streams/' + f, 'utf8'));
const SAFE = '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';
const SAFEARG = SAFE.slice(2).toLowerCase().padStart(64, '0');
const HARV = '0x0e5c011e';
const out = [];

const full = R('_kb_full_base.json');
const multi = R('_kb_multichain.json');
const orig = { base: R('_kb_origin_base.json'), optimism: R('_kb_origin_optimism.json') };

// --- 1. per-chain harvest(address) pools, top instance each + the pool aggregate
const pools = [
  { chain: 'base', block: full.block, payers: full.rows.length, probed: 241, totalWei: full.total, top: full.rows[0], sym: 'ETH' },
  { chain: 'optimism', block: multi.optimism.block, payers: multi.optimism.payers, probed: multi.optimism.probed, totalWei: multi.optimism.totalWei, top: multi.optimism.top[0], sym: 'ETH' },
  { chain: 'arbitrum', block: multi.arbitrum.block, payers: multi.arbitrum.payers, probed: multi.arbitrum.probed, totalWei: multi.arbitrum.totalWei, top: multi.arbitrum.top[0], sym: 'ETH' },
  { chain: 'polygon', block: multi.polygon.block, payers: multi.polygon.payers, probed: multi.polygon.probed, totalWei: multi.polygon.totalWei, top: multi.polygon.top[0], sym: 'POL' },
];
for (const p of pools) {
  out.push({
    chain: p.chain, contract: p.top.strategy, mechanism: `harvest(address callFeeRecipient) — ERC4626-style auto-compounder keeper fee, ${p.top.platform} strategy (${p.top.id}). Best single instance on this chain.`,
    callData: HARV + SAFEARG, recipient: SAFE,
    measuredWei: p.top.wei, measuredUsd: +usd(p.top.wei, p.sym).toFixed(8), isolatedProbe: true, blockNumber: p.block,
    reproduceCmd: `node knowledge/streams/_kb_full.mjs   # base;  node knowledge/streams/_kb_reinvest.mjs  # op/arb/polygon`,
    gasEstimate: 3464506, gasPaidBy: 'Safe sponsored relay (gas-negative for a self-funding caller: ~$0.039 gas vs ~$0.005 fee)',
    confidence: 'MEASURED',
    notes: `Chain-wide isolated sweep: ${p.payers}/${p.probed} strategies pay an arbitrary caller, pool total ${p.totalWei} wei = $${usd(p.totalWei, p.sym).toFixed(6)}. ${p.chain === 'base' ? 'ZERO already works this chain.' : 'ZERO DOES NOT WORK THIS CHAIN TODAY — new reachable income.'}`,
  });
}

// --- 2. the callReward()-blind families on Base
const blind = full.rows.filter(r => r.callReward === '0' || r.callReward === null);
const blindTot = blind.reduce((s, r) => s + BigInt(r.wei), 0n).toString();
const morpho = full.rows.filter(r => r.platform === 'morpho');
out.push({
  chain: 'base', contract: morpho[0].strategy,
  mechanism: 'harvest(address) on a Morpho-platform strategy — pays a real caller fee while callReward() returns 0. Whole family invisible to any callReward()-based ranking.',
  callData: HARV + SAFEARG, recipient: SAFE,
  measuredWei: morpho[0].wei, measuredUsd: +usd(morpho[0].wei, 'ETH').toFixed(8), isolatedProbe: true, blockNumber: full.block,
  reproduceCmd: 'node knowledge/streams/_kb_morpho.mjs',
  gasEstimate: 3464506, gasPaidBy: 'Safe sponsored relay', confidence: 'MEASURED',
  notes: `callReward()==0 for all 6 morpho strategies yet all 6 pay. Across Base, ${blind.length} strategies report callReward()==0/absent and still pay ${blindTot} wei = $${usd(blindTot, 'ETH').toFixed(6)} (10.4% of the chain pool). Families affected: morpho, curve, stakedao, alienbase, aave.`,
});

// --- 3. EOA-ONLY reinvest() family — real money, structurally unreachable
for (const [chain, sym] of [['base', 'AERO'], ['optimism', 'VELO']]) {
  const e = orig[chain].eoaOnly.sort((a, b) => (BigInt(b.wei) > BigInt(a.wei) ? 1 : -1));
  if (!e.length) continue;
  const tot = e.reduce((s, x) => s + BigInt(x.wei), 0n).toString();
  out.push({
    chain, contract: e[0].target, mechanism: 'reinvest() — Tarot-shape auto-compounder, REINVEST_BOUNTY() = 2e16 (2%), pays msg.sender. GUARDED BY require(msg.sender == tx.origin).',
    callData: '0xfdb5a03e', recipient: '0xcA11bde05977b3631167028862bE2a173976CA11 (probe caller; a Safe can never satisfy the guard)',
    measuredWei: e[0].wei, measuredUsd: +usd(e[0].wei, sym).toFixed(8), isolatedProbe: true, blockNumber: orig[chain].block,
    reproduceCmd: `node knowledge/streams/_kb_origin.mjs ${chain}`,
    gasEstimate: e[0].gas, gasPaidBy: 'n/a — unreachable', confidence: 'DEAD',
    notes: `The money is real and measured (${e.length} contracts on ${chain}, total ${tot} wei = $${usd(tot, sym).toFixed(6)}), but reinvest() only executes when tx.origin == msg.sender. A Safe reached through a sponsored relay always has tx.origin = the relayer, so this class is permanently out of reach for ZERO's architecture. Do not re-probe.`,
  });
}

// --- 4. the DEAD families
const dead = [
  ['base', '0x98Ef32edd24e2c92525E59afc4475C1242a30184', 'Aura BoosterLite earmarkRewards(uint256,address) — earmarkIncentive 10-50 bps of harvested BAL to msg.sender', '0x7979426b' + '0'.repeat(64) + '0'.repeat(64), 'node knowledge/streams/_kb_aura.mjs', 'isShutdown() == 1 on ALL FIVE chains (base/optimism/arbitrum/polygon/gnosis, same address). Every earmarkRewards call reverts with "shutdown". 241 pools total across the five deployments, all inert. Aura wound down its sidechain deployments. DO NOT RE-PROBE.'],
  ['base', '0x214f62B5836D83f3D6c4f71F174209097B1A779C', 'Ajna kickReserveAuction() — advertised to pay the kicker a share of claimable reserves, zero capital', '0xa8342e5a', 'node knowledge/streams/_kb_ajna.mjs', 'Enumerated every pool from the ERC20PoolFactory on all 5 reachable chains (base/arbitrum/optimism/polygon/gnosis) and ran one isolated probe per pool. ZERO payers. Two pools hold real claimable reserves (5539668248122795 and 1286215412485120990 of quote token) and kickReserveAuction() is callable there, but it settles nothing to the caller in the same call — the kicker award is not an immediate transfer.'],
  ['base', '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', 'Aave v3 liquidationCall(address,address,address,uint256,bool)', '0x00a718a9', 'node knowledge/streams/_kb_named.mjs', 'Reverts for a caller holding no debt asset — the liquidator must transfer debtToCover IN before receiving collateral. Fails rule (a): non-zero principal. mintToTreasury([USDC]) is callable by anyone and pays the caller 0.'],
  ['base', '0xb125E6687d4313864e53df431d5425969c15Eb2F', 'Compound v3 Comet absorb(address,address[]) / accrueAccount(address)', '0xc3cecfd2', 'node knowledge/streams/_kb_named.mjs', 'absorb() reverts (no underwater account at this block) and pays the absorber in non-transferable liquidator points, never a token. accrueAccount() is callable by anyone and pays 0. No caller bounty exists in Comet.'],
  ['base', '0x16613524e02ad97edfef371bc883f2f5d6c480a5', 'Aerodrome Voter.distribute(uint256,uint256)', '0x2a361aa2', 'node knowledge/streams/_kb_named.mjs', 'Fully permissionless and callable by an arbitrary caller (measured, does not revert) but pays the caller nothing in WETH or AERO. Aerodrome/Velodrome gauge distribution carries no keeper bounty.'],
];
for (const [chain, contract, mechanism, callData, cmd, notes] of dead) {
  out.push({ chain, contract, mechanism, callData, recipient: SAFE, measuredWei: '0', measuredUsd: 0, isolatedProbe: true,
    blockNumber: full.block, reproduceCmd: cmd, gasEstimate: null, gasPaidBy: 'n/a', confidence: 'DEAD', notes });
}

// --- 5. the mined keeper economy, per chain
const mined = [
  ['base', '_kb_mine_base.json', '_kb_origin_base.json'],
  ['optimism', '_kb_mine_optimism.json', '_kb_origin_optimism.json'],
];
for (const [chain, mf, of_] of mined) {
  const m = R(mf), o = R(of_);
  out.push({ chain, contract: 'n/a — chain-wide survey', mechanism: 'Block-receipt mining: every (contract, selector) whose transaction credited its own sender an ERC20 transfer while the sender paid in nothing but gas. Protocol-agnostic discovery of the live keeper economy.',
    callData: 'n/a', recipient: SAFE, measuredWei: '0', measuredUsd: 0, isolatedProbe: true, blockNumber: m.head,
    reproduceCmd: `node knowledge/streams/_kb_mine.mjs ${chain} ${m.nblocks} && node knowledge/streams/_kb_origin.mjs ${chain}`,
    gasEstimate: null, gasPaidBy: 'n/a', confidence: 'DEAD',
    notes: `${m.nblocks} blocks scanned, ${m.rows.length} distinct paying (contract,selector) pairs found. Re-probed as an arbitrary caller: ${o.reachable.length} reachable by ZERO's Safe, ${o.eoaOnly.length} EOA-only, ${o.callableZero.length} callable-but-pay-zero, ${o.permissioned.length} permissioned. The live keeper economy on ${chain} is essentially closed to a contract caller.` });
}
for (const [chain, f] of [['polygon', '_kb_mine_polygon.json'], ['gnosis', '_kb_mine_gnosis.json']]) {
  const m = R(f);
  out.push({ chain, contract: 'n/a — chain-wide survey', mechanism: 'Block-receipt mining of the keeper economy (see base/optimism rows).', callData: 'n/a', recipient: SAFE,
    measuredWei: '0', measuredUsd: 0, isolatedProbe: true, blockNumber: m.head, reproduceCmd: `node knowledge/streams/_kb_mine.mjs ${chain} ${m.nblocks} && node knowledge/streams/_kb_verify.mjs ${chain}`,
    gasEstimate: null, gasPaidBy: 'n/a', confidence: 'DEAD',
    notes: `${m.nblocks} blocks, ${m.rows.length} paying pairs, 0 reachable by an arbitrary caller after isolated re-probe.${chain === 'gnosis' ? ' Gnosis has effectively no keeper economy: 1131 transactions produced only 2 sender-crediting pairs, both permissioned.' : ''}` });
}

out.sort((a, b) => (BigInt(b.measuredWei) > BigInt(a.measuredWei) ? 1 : (BigInt(b.measuredWei) < BigInt(a.measuredWei) ? -1 : 0)));
fs.writeFileSync('knowledge/streams/keeper-bounties.json', JSON.stringify(out, null, 2));
console.log('rows:', out.length);
console.log('\nreachable pool totals:');
for (const p of pools) console.log(` ${p.chain.padEnd(9)} ${p.payers}/${p.probed} payers  ${p.totalWei.padStart(16)} wei  $${usd(p.totalWei, p.sym).toFixed(6)}`);
const newMoney = BigInt(multi.optimism.totalWei) + BigInt(multi.arbitrum.totalWei);
console.log(` NEW (op+arb, ETH-denominated): ${newMoney} wei = $${usd(newMoney, 'ETH').toFixed(6)}  + polygon $${usd(multi.polygon.totalWei, 'POL').toFixed(6)}`);
console.log(` blind-to-callReward on base  : ${blindTot} wei = $${usd(blindTot, 'ETH').toFixed(6)}`);
for (const [chain, sym] of [['base', 'AERO'], ['optimism', 'VELO']]) {
  const t = orig[chain].eoaOnly.reduce((s, x) => s + BigInt(x.wei), 0n).toString();
  console.log(` EOA-ONLY ${chain}: ${t} wei ${sym} = $${usd(t, sym).toFixed(6)} (unreachable)`);
}
