// gasless.mjs — find the ways onto the chain that DON'T depend on anyone's relay quota.
//
// Safe's sponsored relay is one off-chain service with a hard cap of 5/chain/day. It got us our first
// money and it is currently the bottleneck: 11 contracts proven to pay callers, zero slots to call them
// with. The mistake would be to go shopping for another relay service — they are all account-gated
// (Gelato 1Balance, Biconomy, Pimlico, OZ Defender all want a funded account or an API key).
//
// The alternative is already ON CHAIN, written into the contracts themselves. A contract that supports
// a meta-transaction standard will accept a SIGNATURE from a broke wallet and let ANY submitter carry
// it. Signing is free and unlimited — ZERO can sign forever with zero ETH. The scarce thing stops being
// a relay slot and becomes "who submits", which is a much bigger, much less gated set.
//
// HOW WE LOOK: `eth_getCode` and search the runtime bytecode for 4-byte selectors. Solidity emits every
// external function's selector into the dispatch table as a literal, so this works on UNVERIFIED
// contracts, needs no explorer, no API key, and no source. It is the cheapest possible read and it
// cannot be fooled by a missing ABI — the selector is either in the dispatcher or the function does not
// exist. One eth_getCode answers "what gasless rails does this thing expose".
import { ethers } from 'ethers';
import { implFromCode } from './minimalproxy.mjs';

const RPCS = {
  base: 'https://base-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
};

// Each entry is a way for a signature to become a state change without the signer paying gas.
export const RAILS = [
  // ERC-2771: the contract trusts a forwarder to vouch for the real sender. If the forwarder is open,
  // anyone at all can submit our signed request — no quota, no account.
  { sig: 'isTrustedForwarder(address)', rail: 'ERC-2771', note: 'accepts meta-tx via a trusted forwarder — find the forwarder, then check if it is open to any submitter' },
  { sig: 'trustedForwarder()', rail: 'ERC-2771', note: 'exposes its forwarder address directly' },
  { sig: 'execute((address,address,uint256,uint256,uint256,bytes),bytes)', rail: 'ERC-2771-FORWARDER', note: 'IS a forwarder — it submits other people\'s signed requests' },
  { sig: 'verify((address,address,uint256,uint256,uint256,bytes),bytes)', rail: 'ERC-2771-FORWARDER', note: 'forwarder verification entry point' },
  // Native meta-tx (Polygon/Biconomy pattern) — very common on bridged tokens.
  { sig: 'executeMetaTransaction(address,bytes,bytes32,bytes32,uint8)', rail: 'NATIVE-META-TX', note: 'built-in meta-tx: sign it, anyone can submit it' },
  // EIP-3009 — transfer value with only a signature. USDC implements this.
  { sig: 'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)', rail: 'EIP-3009', note: 'value moves on a signature alone; the submitter pays gas' },
  { sig: 'receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)', rail: 'EIP-3009', note: 'pull-payment on a signature' },
  { sig: 'cancelAuthorization(address,bytes32,uint8,bytes32,bytes32)', rail: 'EIP-3009', note: 'confirms full 3009 support' },
  // EIP-2612 — approve by signature. Turns a 2-tx flow into 1 that someone else can pay for.
  { sig: 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', rail: 'EIP-2612', note: 'approval by signature' },
  { sig: 'DOMAIN_SEPARATOR()', rail: 'EIP-712', note: 'signs typed data — a prerequisite for most gasless rails' },
  // Signature-authorised actions: someone else submits, WE are credited.
  { sig: 'delegateBySig(address,uint256,uint256,uint8,bytes32,bytes32)', rail: 'SIG-ACTION', note: 'delegation by signature' },
  { sig: 'claimBySig(address,uint256,bytes)', rail: 'SIG-ACTION', note: 'claim by signature' },
  { sig: 'setApprovalForAllBySig(address,bool,uint256,uint256,bytes)', rail: 'SIG-ACTION', note: 'approval by signature' },
  // ERC-4337: an EntryPoint executes ops for smart accounts; a paymaster can cover the gas.
  { sig: 'handleOps((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes)[],address)', rail: 'ERC-4337-ENTRYPOINT', note: 'IS an EntryPoint' },
  { sig: 'validatePaymasterUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes),bytes32,uint256)', rail: 'ERC-4337-PAYMASTER', note: 'IS a paymaster — it can pay for our operations' },
  // The prize shape: a persistent recipient we can set ONCE (or that anyone can set for us), after
  // which OTHER people's transactions credit us forever and we never transact again.
  { sig: 'setRewardRecipient(address)', rail: 'PERSISTENT-RECIPIENT', note: 'HIGH VALUE: set once, other callers credit you afterwards' },
  { sig: 'setFeeRecipient(address)', rail: 'PERSISTENT-RECIPIENT', note: 'HIGH VALUE if not owner-gated' },
  { sig: 'setRecipient(address)', rail: 'PERSISTENT-RECIPIENT', note: 'HIGH VALUE if not owner-gated' },
  { sig: 'register(address)', rail: 'PERSISTENT-RECIPIENT', note: 'registry — may credit us on others\' activity' },
  { sig: 'setReferrer(address)', rail: 'PERSISTENT-RECIPIENT', note: 'referral credit from other people\'s actions' },
];

export const selectorOf = (sig) => ethers.id(sig).slice(0, 10);

async function rpc(chain, method, params) {
  const url = RPCS[chain];
  if (!url) throw new Error(`no rpc for chain "${chain}"`);
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/**
 * Read a contract's runtime bytecode and report which gasless rails it exposes.
 * No explorer, no API key, works on unverified contracts.
 *
 * MUST scan the IMPLEMENTATION as well as the proxy. Caught in live testing: USDC on Base returned
 * "no rails" because its proxy shell is 1852 bytes of delegation with no selectors in it — while the
 * implementation behind it supports both EIP-3009 and EIP-2612. Scanning a proxy and concluding the
 * contract has no functions is exactly the mistake that discarded 90+ discovery candidates.
 */
export async function scanGasless(chain, contract) {
  const code = await rpc(chain, 'eth_getCode', [contract, 'latest']);
  if (!code || code === '0x') return { chain, contract, is_contract: false, rails: [] };

  let hay = code.toLowerCase();
  const impl = await resolveImplementation(chain, contract);
  if (impl) {
    const icode = await rpc(chain, 'eth_getCode', [impl, 'latest']).catch(() => '0x');
    if (icode && icode !== '0x') hay += icode.toLowerCase();
  }

  const hits = [];
  for (const r of RAILS) {
    const sel = selectorOf(r.sig).slice(2).toLowerCase();
    if (hay.includes(sel)) hits.push({ rail: r.rail, fn: r.sig, selector: '0x' + sel, note: r.note });
  }
  // Collapse to distinct rails for the headline, keep the functions as evidence.
  const rails = [...new Set(hits.map(h => h.rail))];
  return {
    chain, contract, is_contract: true, code_size: (code.length - 2) / 2,
    implementation: impl || null,
    scanned: impl ? 'proxy + implementation' : 'runtime bytecode',
    rails, matches: hits,
    gasless_possible: rails.some(r => r !== 'EIP-712'),
    verdict: rails.length
      ? `Exposes ${rails.join(', ')} — a signature from you may be enough, with someone else submitting.`
      : 'No meta-transaction or signature rail in its bytecode. Calling it needs a real transaction from someone.',
  };
}

// All three proxy shapes, because having only the first is what hid 90+ real candidates and made USDC
// look like it had no functions: EIP-1967 implementation slot, EIP-1967 BEACON slot (two hops — read
// the beacon, then ask the beacon), and proxies that simply expose implementation().
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const LEGACY_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const addrFromWord = (v) => {
  if (!v || v.length < 42) return null;
  const a = '0x' + v.slice(-40);
  return /^0x0+$/.test(a) ? null : a;
};
export async function resolveImplementation(chain, contract) {
  try {
    // EIP-1167 clones keep the implementation in CODE, not storage — the storage sweep below cannot
    // see them, and 12 of 12 strategies in callreward-measurement.json are clones.
    const code = await rpc(chain, 'eth_getCode', [contract, 'latest']).catch(() => '0x');
    const clone = implFromCode(code);
    if (clone) return clone;

    for (const slot of [IMPL_SLOT, LEGACY_SLOT]) {
      const a = addrFromWord(await rpc(chain, 'eth_getStorageAt', [contract, slot, 'latest']));
      if (a) return a;
    }
    const beacon = addrFromWord(await rpc(chain, 'eth_getStorageAt', [contract, BEACON_SLOT, 'latest']));
    if (beacon) {
      const a = addrFromWord(await rpc(chain, 'eth_call', [{ to: beacon, data: selectorOf('implementation()') }, 'latest']).catch(() => null));
      if (a) return a;
    }
    return addrFromWord(await rpc(chain, 'eth_call', [{ to: contract, data: selectorOf('implementation()') }, 'latest']).catch(() => null));
  } catch { return null; }
}

// If a contract names a trusted forwarder, the forwarder is the thing that actually matters: an OPEN
// forwarder (no allowlist on the submitter) means anyone can carry our signed request, which is a
// strictly better position than a 5/day quota.
export async function resolveForwarder(chain, contract) {
  for (const sig of ['trustedForwarder()', 'getTrustedForwarder()', 'forwarder()']) {
    try {
      const v = await rpc(chain, 'eth_call', [{ to: contract, data: selectorOf(sig) }, 'latest']);
      if (v && v.length >= 66) {
        const a = '0x' + v.slice(-40);
        if (!/^0x0+$/.test(a)) return { forwarder: a, via: sig };
      }
    } catch { /* try the next shape */ }
  }
  return { forwarder: null };
}

/** Scan many contracts and rank by how useful the rail is to a wallet with no ETH. */
export async function sweepGasless(chain, contracts, limit = 25) {
  const RANK = {
    'PERSISTENT-RECIPIENT': 100, 'ERC-2771': 60, 'NATIVE-META-TX': 55, 'ERC-2771-FORWARDER': 50,
    'EIP-3009': 40, 'ERC-4337-PAYMASTER': 40, 'SIG-ACTION': 35, 'ERC-4337-ENTRYPOINT': 20,
    'EIP-2612': 15, 'EIP-712': 1,
  };
  const out = [];
  for (const c of contracts.slice(0, limit)) {
    try {
      const s = await scanGasless(chain, c);
      if (!s.rails.length) continue;
      s.score = Math.max(...s.rails.map(r => RANK[r] || 0));
      if (s.rails.includes('ERC-2771')) Object.assign(s, await resolveForwarder(chain, c));
      out.push(s);
    } catch { /* one bad address must not stop the sweep */ }
  }
  return out.sort((a, b) => b.score - a.score);
}
