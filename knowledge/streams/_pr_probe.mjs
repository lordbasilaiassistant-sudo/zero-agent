// _pr_probe.mjs — persistent-recipient lane probe. READ-ONLY. eth_call only.
// Recovers selectors from bytecode, filters to recipient-setter shapes, and simulates each setter
// FROM ZERO's Safe to see if an arbitrary address can set it (owner-gated => revert).
import { ethers } from 'ethers';

export const SAFE = '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';
export const EOA  = '0x50624F7790732f9767180871D03A304756200dB9';
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const RPCS = {
  base: 'https://base-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  gnosis: 'https://gnosis-rpc.publicnode.com',
  unichain: 'https://unichain-rpc.publicnode.com',
};

let ID = 0;
export async function rpc(chain, method, params) {
  const url = RPCS[chain];
  if (!url) throw new Error('no rpc for ' + chain);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++ID, method, params }),
      });
      const j = await r.json();
      if (j.error) return { __error: j.error.message };
      return j.result;
    } catch (e) {
      if (attempt === 3) return { __error: String(e.message) };
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

export const sel = (sig) => ethers.id(sig).slice(0, 10);

// Persistent-recipient setter shapes: set once, others' activity credits you afterward.
export const SETTER_SIGS = [
  'setRewardRecipient(address)', 'setFeeRecipient(address)', 'setRecipient(address)',
  'setReferrer(address)', 'setPartner(address)', 'setIntegrator(address)',
  'setFeeReceiver(address)', 'setFeeCollector(address)', 'setFeeTo(address)',
  'setTreasury(address)', 'setBeneficiary(address)', 'setProtocolFeeRecipient(address)',
  'setProtocolFeeBeneficiary(address)', 'setDevFund(address)', 'setDao(address)',
  'setFeeAddress(address)', 'setFeeManager(address)', 'setRewardsRecipient(address)',
  'setVault(address)', 'setCollector(address)', 'register(address)',
  'setReferral(address)', 'setAffiliate(address)', 'setFeeWallet(address)',
  'setPlatformWallet(address)', 'setDevAddress(address)', 'setMarketing(address)',
  'setRewardDistributor(address)', 'setPayee(address)', 'setRoyaltyRecipient(address)',
  'setDefaultReferrer(address)', 'setFeeToSetter(address)',
];
export const SETTER_BY_SEL = Object.fromEntries(SETTER_SIGS.map(s => [sel(s), s]));

const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const LEGACY_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const word = (v) => { if (!v || typeof v !== 'string' || v.length < 42) return null; const a = '0x' + v.slice(-40); return /^0x0+$/.test(a) ? null : a; };

export async function implOf(chain, c) {
  for (const s of [IMPL_SLOT, LEGACY_SLOT]) {
    const a = word(await rpc(chain, 'eth_getStorageAt', [c, s, 'latest']));
    if (a) return a;
  }
  const b = word(await rpc(chain, 'eth_getStorageAt', [c, BEACON_SLOT, 'latest']));
  if (b) return word(await rpc(chain, 'eth_call', [{ to: b, data: '0x5c60da1b' }, 'latest']));
  return word(await rpc(chain, 'eth_call', [{ to: c, data: '0x5c60da1b' }, 'latest']));
}

export function extractSelectors(code) {
  const out = new Set();
  if (!code || typeof code !== 'string' || code.length < 10) return [];
  const hex = code.startsWith('0x') ? code.slice(2) : code;
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) !== '63') continue;
    const s = '0x' + hex.slice(i + 2, i + 10).toLowerCase();
    if (/^0x0{4,}/.test(s)) continue;
    out.add(s);
  }
  return [...out];
}

// Which recipient-setters does this contract expose (proxy + impl)?
export async function settersPresent(chain, contract) {
  const impl = await implOf(chain, contract);
  const codes = await Promise.all([
    rpc(chain, 'eth_getCode', [contract, 'latest']),
    impl ? rpc(chain, 'eth_getCode', [impl, 'latest']) : Promise.resolve('0x'),
  ]);
  const hay = [codes[0], codes[1]].filter(x => typeof x === 'string').join('').toLowerCase();
  const present = [];
  for (const [s, sig] of Object.entries(SETTER_BY_SEL)) {
    if (hay.includes(s.slice(2))) present.push({ selector: s, sig });
  }
  return { impl, isContract: hay.length > 6, present, allSelCount: extractSelectors(codes[0]).length + extractSelectors(typeof codes[1]==='string'?codes[1]:'0x').length };
}

// Simulate calling setter(SAFE) FROM the Safe. Owner-gated => revert. Open => success (no revert).
export async function simulateSetterFromSafe(chain, contract, sig, arg = SAFE) {
  const iface = new ethers.Interface([`function ${sig}`]);
  const data = iface.encodeFunctionData(sig.split('(')[0], [arg]);
  const res = await rpc(chain, 'eth_call', [{ from: SAFE, to: contract, data }, 'latest']);
  if (res && res.__error) return { callable: false, reason: res.__error.slice(0, 120), data };
  return { callable: true, returnData: res, data };
}

// Read a stored recipient getter if present (fee recipient, referrer of arg, etc.)
export async function readGetter(chain, contract, sig, args = []) {
  try {
    const iface = new ethers.Interface([`function ${sig}`]);
    const data = iface.encodeFunctionData(sig.split('(')[0], args);
    const res = await rpc(chain, 'eth_call', [{ to: contract, data }, 'latest']);
    if (res && res.__error) return { ok: false, reason: res.__error.slice(0, 80) };
    const decoded = iface.decodeFunctionResult(sig.split('(')[0], res);
    return { ok: true, value: decoded.length === 1 ? decoded[0] : decoded };
  } catch (e) { return { ok: false, reason: String(e.message).slice(0, 80) }; }
}
