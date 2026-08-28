// Curve FeeCollector on Gnosis — the one non-Beefy payer sitting on a chain with idle Safe slots.
//
// Source read 2026-08-28 from the verified Vyper on gnosis.blockscout.com (FeeCollector.vy 0.3.10),
// not from a catalogue. collect(_coins, _receiver) pays the NAMED receiver a ramping keeper fee
// (max 0.1% as of the 2026-06-16 set_max_fee) in the collected tokens, then the CowSwapBurner
// takes the rest. harvest() this is not: the fee follows _receiver, not tx.origin.
//
// Epochs are a Thursday-00:00-UTC week (START_TIME 1600300800):
//   SLEEP 0–4d  COLLECT Mon  EXCHANGE Tue  FORWARD Wed
// Last settled collect on this contract: 2026-03-30T23:11Z (keepers waited until ~23:00 so the
// dutch ramp was near max). An early-Monday collect would sweep the pile for dust and leave
// nothing for the rest of the window — only fire when fee() is ≥ 90% of max_fee.
//
// This is NOT Base native ETH. It pays EURe / BREAD / etc. at the Safe on Gnosis. Stack the
// stream; do not quote it as spendable_liquid_native_eth_on_base_usd.

import { ethers } from 'ethers';
import { MULTICALL3 } from './oracle.mjs';

export const CURVE_FEE_COLLECTOR = '0xBb7404F9965487a9DdE721B3A5F0F3CcfA9aa4C5';
export const CURVE_START_TIME = 1600300800;
export const CURVE_WEEK = 7 * 24 * 3600;
export const CURVE_EPOCH = { SLEEP: 1, COLLECT: 2, EXCHANGE: 4, FORWARD: 8 };
export const CURVE_WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';

// Coins the collector actually holds (measured 2026-08-28 on gnosis.blockscout.com token-balances).
// Sorted descending by then-USD. WXDAI is killed for COLLECT. Skip airdrop/LP junk — one revert
// kills CowSwapBurner.burn for the whole collect.
export const CURVE_COLLECT_COINS = [
  '0xcB444e90D8198415266c6a2724b7900fb12FC56E', // EURE (old) ~$12.90
  '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430', // EURE ~$12.90
  '0x54E4cB2a4Fa0ee46E3d9A98D13Bea119666E09f6', // EURC.E ~$12.71
  '0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3', // BREAD ~$10.37
];

const IFACE = new ethers.Interface([
  'function epoch(uint256 ts) view returns (uint256)',
  'function fee(uint256 epoch, uint256 ts) view returns (uint256)',
  'function max_fee(uint256 epoch) view returns (uint256)',
  'function collect(address[] coins, address receiver)',
  'function forward(tuple(uint8 hook_id, uint256 value, bytes data)[] hook_inputs, address receiver) payable returns (uint256)',
]);
const AGG = new ethers.Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])',
]);
const balOf = (addr) => '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0');

export function curveEpochName(n) {
  return ({ 1: 'SLEEP', 2: 'COLLECT', 4: 'EXCHANGE', 8: 'FORWARD' })[Number(n)] || `unknown:${n}`;
}

export function nextCollectTs(now = Math.floor(Date.now() / 1000)) {
  const off = (now - CURVE_START_TIME) % CURVE_WEEK;
  const start = 4 * 24 * 3600;
  if (off >= start && off < 5 * 24 * 3600) return now;
  if (off < start) return now + (start - off);
  return now + (CURVE_WEEK - off) + start;
}

export function encodeCollect(coins, receiver) {
  return IFACE.encodeFunctionData('collect', [coins, receiver]);
}

export function encodeForward(receiver) {
  return IFACE.encodeFunctionData('forward', [[], receiver]);
}

export async function readCurveEpoch(rpc, ts = Math.floor(Date.now() / 1000)) {
  const hex = await rpc('gnosis', 'eth_call', [
    { to: CURVE_FEE_COLLECTOR, data: IFACE.encodeFunctionData('epoch', [ts]) },
    'latest',
  ]);
  return Number(hex);
}

export async function readCurveFee(rpc, epoch, ts = Math.floor(Date.now() / 1000)) {
  const hex = await rpc('gnosis', 'eth_call', [
    { to: CURVE_FEE_COLLECTOR, data: IFACE.encodeFunctionData('fee', [epoch, ts]) },
    'latest',
  ]);
  return BigInt(hex);
}

export async function readCurveMaxFee(rpc, epoch) {
  const hex = await rpc('gnosis', 'eth_call', [
    { to: CURVE_FEE_COLLECTOR, data: IFACE.encodeFunctionData('max_fee', [epoch]) },
    'latest',
  ]);
  return BigInt(hex);
}

async function sandwich(rpc, token, callData, recipient, from) {
  const calls = [
    { target: token, allowFailure: true, callData: balOf(recipient) },
    { target: CURVE_FEE_COLLECTOR, allowFailure: true, callData },
    { target: token, allowFailure: true, callData: balOf(recipient) },
  ];
  const ret = await rpc('gnosis', 'eth_call', [
    { to: MULTICALL3, data: AGG.encodeFunctionData('aggregate3', [calls]), from },
    'latest',
  ]);
  const [rows] = AGG.decodeFunctionResult('aggregate3', ret);
  if (!rows?.[1]?.success) return { measured: true, wei: 0n, reverted: true };
  if (!rows[0]?.success || !rows[2]?.success) return { measured: false, wei: 0n, reason: 'balance read failed' };
  return { measured: true, wei: BigInt(rows[2].returnData) - BigInt(rows[0].returnData), reverted: false };
}

/** Fee ramps 0→max over the 24h COLLECT window. Keepers historically fired ~23:00 UTC. */
export function collectFeeRipe(fee, maxFee) {
  if (maxFee === 0n) return false;
  return fee * 10n >= maxFee * 9n;
}

export async function pickCurveGnosisCall(rpc, safe) {
  const ts = Math.floor(Date.now() / 1000);
  const epoch = await readCurveEpoch(rpc, ts);
  const name = curveEpochName(epoch);
  if (epoch === CURVE_EPOCH.COLLECT) {
    let fee, maxFee;
    try {
      fee = await readCurveFee(rpc, CURVE_EPOCH.COLLECT, ts);
      maxFee = await readCurveMaxFee(rpc, CURVE_EPOCH.COLLECT);
    } catch (e) {
      return { skipped: 'COLLECT fee() unreadable: ' + String(e.message || e).slice(0, 80), epoch, name };
    }
    if (!collectFeeRipe(fee, maxFee)) {
      return {
        skipped: 'COLLECT fee still ramping — waiting for ≥90% of max so we do not sweep the pile for dust',
        epoch, name, fee: fee.toString(), maxFee: maxFee.toString(),
      };
    }
    for (const coin of CURVE_COLLECT_COINS) {
      const data = encodeCollect([coin], safe);
      const probe = await sandwich(rpc, coin, data, safe, safe);
      if (!probe.measured) continue;
      if (probe.reverted || probe.wei <= 0n) continue;
      return { ok: true, kind: 'collect', epoch, name, coin, data, wei: probe.wei, fee: fee.toString() };
    }
    return { skipped: 'COLLECT is open but no listed coin measures a positive fee to the Safe', epoch, name };
  }
  if (epoch === CURVE_EPOCH.FORWARD) {
    const data = encodeForward(safe);
    const probe = await sandwich(rpc, CURVE_WXDAI, data, safe, safe);
    if (!probe.measured) return { skipped: 'FORWARD probe unreadable: ' + (probe.reason || ''), epoch, name };
    if (probe.reverted || probe.wei <= 0n) {
      return { skipped: 'FORWARD simulates clean-or-revert with no WXDAI to the Safe', epoch, name };
    }
    return { ok: true, kind: 'forward', epoch, name, coin: CURVE_WXDAI, data, wei: probe.wei };
  }
  return {
    skipped: `curve gnosis ${name} — collect opens ${new Date(nextCollectTs(ts) * 1000).toISOString()}`,
    epoch, name, next_collect: nextCollectTs(ts),
  };
}
