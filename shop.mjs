// shop.mjs — ZERO's storefront: the one earning rail that needs no capital.
import { ethers } from 'ethers';
import { mutateKV } from './kv.mjs';
import { probeContract } from './oracle.mjs';
import { bruteforceContract } from './bruteforce.mjs';
// In x402, the BUYER's client settles onchain and pays the gas; the seller only answers HTTP 402
// with its address. So a broke agent can sell even though it cannot transact.
// v1 settlement: pay-then-fetch. Buyer sends USDC on Base to ZERO, then calls back with the tx hash.
// We verify the ERC-20 Transfer log onchain, burn the hash so it can't be reused, and deliver.
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ZERO is paid at its SMART ACCOUNT, not its EOA. Reason: gas is paid in USDC through Candide's
// keyless ERC-4337 paymaster, which requires the USDC to sit in the smart account at validation time
// (verified: paymaster returns "token balance lower than the required 0x237f allowance" = 0.009087 USDC).
// USDC landing on the EOA would be stranded — moving it would need ETH the agent will never have.
/* GENESIS II Safe, deployed 2026-08-13 via Safe's sponsored relay for $0.00.
   SafeL2 v1.4.1, singleton 0x29fcB43b…C762, DEPLOYED on base/optimism/arbitrum/polygon/gnosis.
   The previous constant pointed at a Safe owned by the RETIRED EOA, so swapping the key left ZERO
   unable to sign execTransaction and pointed the x402 payTo into a contaminated account.
   VERIFIED on-chain: getOwners() = [0xc94929d1...d57a], threshold 1. The "0.3.0 undeployed" claim
   was the Safe4337Module version, a different contract, and it was wrong twice. */
export const SMART_ACCOUNT = '0x75d93b33708e7cf5eb4dcf14dfc25254f5d5817f';
export const LIVE_EOA = '0xC94929d14435D80dd04b3206BfEA9F5dEBAbD57A';
/** GENESIS I Safe — owned by the retired EOA. Never caller, payTo, or callFeeRecipient. */
export const RETIRED_SAFE = '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';
export const RETIRED_EOA = '0x50624F7790732f9767180871D03A304756200dB9';
export function isRetiredAccount(addr) {
  const a = String(addr || '').toLowerCase();
  return a === RETIRED_SAFE.toLowerCase() || a === RETIRED_EOA.toLowerCase();
}

export const PRODUCTS = {
  'contract-audit': {
    price_usdc: '0.05',
    units: 50000n,
    title: 'Contract red-flag report',
    description: 'Know whether a contract can rug you before you touch it: owner powers, mint/blacklist/pause authority, fee logic, upgradeability — each finding quoted from the specific verified-source line that justifies it. Answers "unverified source" honestly instead of guessing.',
    params: { contract: '0x-prefixed contract address on Base (required)' },
  },
  'wallet-brief': {
    price_usdc: '0.02',
    units: 20000n,
    title: 'Address activity brief',
    description: 'Plain-language brief on any Base address: age, transaction and transfer counts, token holdings, contract-or-EOA, and what the recent activity pattern suggests.',
    params: { address: '0x-prefixed address on Base (required)' },
  },
  // ── the search engine, sold ────────────────────────────────────────────────
  // These are the instruments ZERO built to find its own income, and they answer questions no block
  // explorer does. Selling them closes a genuine loop: an x402 payment lands as USDC at the smart
  // account, and USDC is exactly what the permissionless token paymaster accepts (~0.009087/op). So a
  // single sale is not just revenue — it is GAS. The search engine funds its own searching.
  'payout-oracle': {
    price_usdc: '0.03',
    units: 30000n,
    title: 'Will this contract pay me for calling it?',
    description: 'Before you spend gas on a call: the EXACT fee this contract pays an arbitrary caller right now, measured by simulating the settlement itself — never read off a getter. Reward getters lie: callReward() has read $615.54 and paid $0.0001; maxRewards() read $63.24 and paid $0.00 across six consecutive settlements. Prices mechanisms nobody has ever called yet. Proxies resolved automatically (EIP-1967, beacon, direct).',
    params: { contract: '0x-prefixed contract address on Base (required)' },
  },
  'interface-xray': {
    price_usdc: '0.04',
    units: 40000n,
    title: 'Every function a contract has — even unverified',
    description: 'No ABI, no verified source, no explorer entry? Recovers the COMPLETE external interface straight from runtime bytecode (PUSH4 dispatch-table scan), then prices every function and reports which ones move value TO an arbitrary caller. A typical contract exposes 40-90 functions — usually more than its published ABI, and a proxy shows none until resolved. You get every selector, probed in isolation.',
    params: { contract: '0x-prefixed contract address on Base (required)' },
  },
  // ── the census, sold ───────────────────────────────────────────────────────
  // The wallet-map instrument's output, productized: every contract we have PROVEN to pay an
  // arbitrary caller, with per-call economics measured by simulation. No explorer sells this,
  // because no explorer asks "who pays my caller?" — only a broke agent ever had to.
  'payer-census': {
    price_usdc: '0.005',
    units: 5000n,
    noParams: true,
    title: 'Map of contracts that pay ANY caller (live-simulated)',
    description: 'The verified census of contracts that move value to an arbitrary caller, graded by simulating each payout from a neutral address and pricing what actually lands. Every row carries per-call net USD, distinct caller count, token breakdown with executability flags, block range and a sample tx you can check on-chain. Feed this to a keeper bot, an agent looking for income, or an airdrop farmer hunting gas-rebate programs.',
    params: { chain: 'optional filter: base | optimism | arbitrum | polygon | gnosis | unichain (default: all chains)' },
  },
  // ── the agent's own coin, sold OTC ──────────────────────────────────────────
  // ZERO deployed its own Zora content coin with its own wallet (2026-08-03) and holds the 10M
  // creator supply. It will never sell into its own thin pool (that realizes ~nothing and kills the
  // chart) — but a fixed-price OTC tranche through the storefront touches no pool at all: buyer pays
  // USDC, ZERO's EOA transfers tokens directly. Full disclosure in the description; the premium IS
  // the product (you are buying the story and funding the experiment, not market-priced exposure).
  'buy-zero': {
    price_usdc: '1.00',
    units: 1000000n,
    title: "250,000 ZERO — the agent's own coin, direct from the agent",
    description: 'ZERO deployed its own Zora content coin on Base (0xa08c4Bb56030E923e16bF0ab22248eC4AC9b661c) with its own wallet and holds the creator supply. This buys 250,000 ZERO delivered on-chain from that supply to your address, signed and sent by the agent itself. FULL DISCLOSURE: this fixed price is ABOVE the current pool price and the pool is thin — this is not an investment and you should expect to be unable to resell at this price; you are funding an autonomous $0-start experiment and buying a piece of its story. The agent never sells into its own pool and never buys its own coin.',
    params: { address: 'the Base address that should receive the 250,000 ZERO (required)' },
  },
};

export const ZERO_COIN = '0xa08c4Bb56030E923e16bF0ab22248eC4AC9b661c';
const ZERO_TRANCHE = 250000n * 10n ** 18n;

const j = (o, s = 200, extra = {}) => new Response(JSON.stringify(o, null, 2), {
  status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Payment-Required, X-Payment-Response', ...extra },
});

// ── x402 v2 discovery header ────────────────────────────────────────────────
// Indexers and modern x402 clients do NOT read the 402 body — they read a base64 `Payment-Required`
// header (x402 v2). Verified against two services that 402index.io has marked x402_payment_valid=1
// (agent.memoryapi.org, x402stock.xyz): both answer 402 with an empty body and this header only.
// The `extensions.bazaar.info` block is what the x402 Bazaar/discovery crawlers index, so ZERO's
// input schema and output shape travel with the challenge itself.
const b64utf8 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
};

const BAZAAR = {
  'contract-audit': {
    tags: ['security', 'audit', 'smart-contracts', 'base', 'blockchain', 'risk'],
    paramName: 'contract',
    paramDesc: '0x-prefixed contract address on Base mainnet',
    example: {
      product: 'contract-audit', verified_source: true, name: 'WETH9', compiler: 'v0.8.20+commit.a1b79de6',
      report: '## Summary\n...\n## Owner powers\nNo owner: the contract declares no Ownable modifier...\n## What could NOT be determined\n...',
    },
  },
  'wallet-brief': {
    tags: ['blockchain', 'analytics', 'address', 'base', 'onchain', 'intelligence'],
    paramName: 'address',
    paramDesc: '0x-prefixed address on Base mainnet',
    example: {
      product: 'wallet-brief',
      facts: { coin_balance_wei: '0', is_contract: false, has_token_transfers: true, recent_tx_count: 12, token_count: 3 },
      report: 'This address is an EOA with ... Recent activity is dominated by ...',
    },
  },
  // Without an entry here a product is indexed as "skipped: Missing input schema" and is never
  // invocable by a discovery client — the listing IS the product.
  'payout-oracle': {
    tags: ['keeper', 'mev', 'caller-rewards', 'simulation', 'base', 'onchain', 'agents', 'gas'],
    paramName: 'contract',
    paramDesc: '0x-prefixed contract address on Base mainnet',
    example: {
      product: 'payout-oracle', contract: '0x295EE9dC968b939B4276911217D6C9883D6f588f',
      pays_an_arbitrary_caller: true,
      best: { function: 'harvest(address)', wei: '8965432100000', eth: '0.0000089654', usd: 0.01721 },
      money_shaped_functions_found: 3,
      verdict: 'PAYS AN ARBITRARY CALLER RIGHT NOW: harvest(address)',
    },
  },
  'interface-xray': {
    tags: ['bytecode', 'reverse-engineering', 'unverified-contracts', 'abi', 'base', 'onchain', 'agents'],
    paramName: 'contract',
    paramDesc: '0x-prefixed contract address on Base mainnet',
    example: {
      product: 'interface-xray', contract: '0x295EE9dC968b939B4276911217D6C9883D6f588f',
      implementation: '0x61d1803e4d0209fbab4336cec871c3c47f745082',
      external_functions_found: 82, variants_probed: 164,
      paying_functions: [{ selector: '0x0e5c011e', shape: '(address)', eth: '0.0000089654', usd: 0.01721 }],
      verdict: 'PAYS: 0x0e5c011e(address)',
    },
  },
  'payer-census': {
    tags: ['keeper', 'mev', 'caller-rewards', 'yield', 'airdrop', 'base', 'optimism', 'arbitrum', 'onchain', 'agents', 'gasless', 'discovery'],
    paramName: null,
    paramDesc: null,
    example: {
      product: 'payer-census', chains_available: ['base', 'optimism'],
      rows_returned: 1, total_known_payers: 179,
      payers: [
        { chain: 'base', contract: '0xbfc06549532e6119c4bc0eff167290efdca33fa6', selector: '0xae0b51df',
          net_usd_per_call: 30.049835, distinct_callers: 23, hits: 5,
          tokens: [{ symbol: 'ALIGN', usd: 240.411822, executable: false }],
          sample_tx: '0xedfcbdda206e750f980e6196adebf2660a6e7a3c4a68ef59ce511015c0de' },
      ],
      freshness: { mapped_at: '2026-08-21T04:55:48.549Z', note: 'snapshot of the live simulation map; re-verify any row with payout-oracle before spending gas' },
    },
  },
  'buy-zero': {
    tags: ['memecoin', 'zora', 'content-coin', 'base', 'agents', 'autonomous', 'collectible'],
    paramName: 'address',
    paramDesc: 'Base address that receives the 250,000 ZERO tokens',
    example: {
      product: 'buy-zero', coin: '0xa08c4Bb56030E923e16bF0ab22248eC4AC9b661c',
      tranche: '250000', recipient: '0x0000000000000000000000000000000000000001',
      delivery_status: 'confirmed',
      disclosure: 'fixed price above pool price; thin pool; funds an autonomous-agent experiment',
    },
  },
};

export function x402v2Header(product, slug, payTo, resourceUrl, method = 'GET') {
  const b = BAZAAR[slug];
  return b64utf8(JSON.stringify({
    x402Version: 2,
    error: 'Payment required',
    resource: { url: resourceUrl, method, description: product.description, mimeType: 'application/json' },
    accepts: [{
      scheme: 'exact',
      network: 'eip155:8453',
      amount: product.units.toString(),
      asset: ethers.getAddress(USDC),
      payTo: ethers.getAddress(payTo),
      maxTimeoutSeconds: 3600,
      extra: { name: 'USD Coin', version: '2' },
    }],
    extensions: {
      bazaar: {
        info: {
          serviceName: product.title,
          description: product.description,
          tags: b?.tags || [],
          input: {
            type: 'http', method,
            queryParams: b?.paramName ? { [b.paramName]: '0x4200000000000000000000000000000000000006' } : {},
            schema: b?.paramName ? { properties: { [b.paramName]: { type: 'string', description: b.paramDesc } }, required: [b.paramName] } : { properties: {}, required: [] },
          },
          output: { type: 'json', example: b?.example || {} },
        },
        // x402scan reads extensions.bazaar.schema.properties.input (see its
        // packages/external/mcp x402-extensions.ts getInputSchema). Without input AND output
        // here the endpoint is indexed as "skipped: Missing input schema" and never invocable.
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            input: {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'http' },
                method: { type: 'string', enum: ['GET'] },
                queryParams: {
                  type: 'object',
                  properties: b?.paramName ? { [b.paramName]: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$', description: b.paramDesc } } : {},
                  required: b?.paramName ? [b.paramName] : [],
                },
              },
              required: ['type', 'method', 'queryParams'],
            },
            output: {
              type: 'object',
              properties: {
                type: { type: 'string', const: 'json' },
                example: { type: 'object' },
              },
              required: ['type'],
            },
          },
          required: ['input'],
        },
      },
    },
  }));
}

// x402-shaped payment requirements (scheme "exact", Base USDC), plus a plain fallback any agent can follow.
function paymentRequired(product, slug, payTo, resource) {
  return j({
    x402Version: 1,
    error: 'payment required',
    accepts: [{
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: product.units.toString(),
      resource,
      description: product.title,
      mimeType: 'application/json',
      payTo,
      asset: `0x${USDC.slice(2)}`,
      maxTimeoutSeconds: 3600,
      extra: { name: 'USDC', version: '2' },
    }],
    how_to_pay_without_an_x402_client: {
      step_1: `Send ${product.price_usdc} USDC (contract ${USDC}) on Base mainnet to ${payTo} (the agent's smart account — it pays its own gas in USDC from there)`,
      step_2: `Call this same URL again with &tx=<your transaction hash>`,
      step_3: 'The report is returned immediately. One transaction hash may be redeemed once.',
      note: 'No account, no API key, no signup. Overpaying is accepted; underpaying is refused with the amount seen.',
    },
    product: { slug, ...product, units: product.units.toString() },
  }, 402, { 'Payment-Required': x402v2Header(product, slug, payTo, resource) });
}

// ── X-PAYMENT (the standard x402 path) ──────────────────────────────────────
// A client signs an EIP-3009 transferWithAuthorization and retries with the header. ZERO cannot
// broadcast it (that costs gas it does not have), so it VERIFIES the authorization cryptographically,
// confirms the payer can actually cover it, banks the bearer instrument for later settlement, and
// delivers. Settlement happens the moment ZERO can afford one paymaster op — the authorization stays
// valid until validBefore, and anyone may submit it.
const USDC_DOMAIN = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: ethers.getAddress(USDC) };
const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};

export async function verifyAuthorization(env, rpc, headerValue, minUnits, payTo) {
  let decoded;
  try {
    decoded = JSON.parse(typeof atob === 'function' ? atob(headerValue) : Buffer.from(headerValue, 'base64').toString());
  } catch { return { ok: false, why: 'X-PAYMENT must be base64-encoded JSON (x402 exact scheme)' }; }

  const p = decoded.payload || decoded;
  const auth = p.authorization || p.auth;
  const signature = p.signature;
  if (!auth || !signature) return { ok: false, why: 'payload must contain {authorization, signature}' };
  if (decoded.network && !/base/i.test(decoded.network) && decoded.network !== 'eip155:8453') {
    return { ok: false, why: `wrong network "${decoded.network}" — this endpoint settles on Base mainnet` };
  }

  const value = BigInt(auth.value);
  if (value < minUnits) return { ok: false, why: `authorized ${(Number(value) / 1e6).toFixed(6)} USDC, need ${(Number(minUnits) / 1e6).toFixed(6)}` };
  if (ethers.getAddress(auth.to) !== ethers.getAddress(payTo)) return { ok: false, why: `authorization pays ${auth.to}, not ${payTo}` };

  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validAfter) > now) return { ok: false, why: 'authorization is not valid yet' };
  if (Number(auth.validBefore) <= now + 30) return { ok: false, why: 'authorization already expired (or expires within 30s)' };

  let signer;
  try {
    signer = ethers.verifyTypedData(USDC_DOMAIN, AUTH_TYPES, {
      from: auth.from, to: auth.to, value, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce,
    }, signature);
  } catch (e) { return { ok: false, why: 'signature did not recover: ' + String(e.message).slice(0, 120) }; }
  if (ethers.getAddress(signer) !== ethers.getAddress(auth.from)) {
    return { ok: false, why: 'signature does not match the "from" address' };
  }

  const key = 'auth:' + String(auth.nonce).toLowerCase();
  if (await env.KV.get(key)) return { ok: false, why: 'this authorization nonce has already been used here' };

  // On-chain truth: nonce unused at USDC, and the payer actually holds the funds.
  try {
    const state = await rpc('base', 'eth_call', [{ to: USDC, data: '0xe94a0102' + auth.from.slice(2).toLowerCase().padStart(64, '0') + String(auth.nonce).slice(2).padStart(64, '0') }, 'latest']);
    if (state && BigInt(state) !== 0n) return { ok: false, why: 'this authorization was already used on-chain' };
  } catch { /* non-fatal: the signature checks above still bind */ }
  try {
    const bal = await rpc('base', 'eth_call', [{ to: USDC, data: '0x70a08231' + auth.from.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
    if (BigInt(bal) < value) return { ok: false, why: `payer holds ${(Number(BigInt(bal)) / 1e6).toFixed(6)} USDC, less than the authorized amount` };
  } catch { /* non-fatal */ }

  return { ok: true, paid_units: value.toString(), from: auth.from, nonce: auth.nonce, authorization: auth, signature };
}

export async function verifyPayment(env, rpc, txHash, minUnits, payTo) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, why: 'tx must be a 0x-prefixed 32-byte hash' };
  const used = await env.KV.get('paid:' + txHash.toLowerCase());
  if (used) return { ok: false, why: 'this transaction hash has already been redeemed' };
  const rcpt = await rpc('base', 'eth_getTransactionReceipt', [txHash]);
  if (!rcpt) return { ok: false, why: 'transaction not found on Base mainnet yet — wait for it to confirm and retry' };
  if (rcpt.status !== '0x1') return { ok: false, why: 'that transaction reverted' };
  const want = payTo.toLowerCase().slice(2).padStart(64, '0');
  let paid = 0n;
  for (const log of rcpt.logs || []) {
    if (log.address.toLowerCase() !== USDC) continue;
    if ((log.topics?.[0] || '').toLowerCase() !== TRANSFER_TOPIC) continue;
    if ((log.topics?.[2] || '').toLowerCase().slice(2) !== want) continue;
    paid += BigInt(log.data);
  }
  if (paid < minUnits) {
    return { ok: false, why: `payment too small: saw ${(Number(paid) / 1e6).toFixed(6)} USDC to ${payTo}, need ${(Number(minUnits) / 1e6).toFixed(6)}` };
  }
  return { ok: true, paid_units: paid.toString() };
}

/** Keyless Sourcify repo lookup. Blockscout's /v2 surface 500s; this is the honest fallback, not a guess. */
export async function sourcifySource(chainId, address) {
  const low = String(address).toLowerCase();
  for (const kind of ['full_match', 'partial_match']) {
    try {
      const s = await fetch(`https://repo.sourcify.dev/contracts/${kind}/${chainId}/${low}/metadata.json`, { signal: AbortSignal.timeout(15000) });
      if (s.status !== 200) continue;
      const src2 = await s.json();
      if (!src2?.sources) continue;
      const target = Object.values((src2.settings || {}).compilationTarget || {})[0] || null;
      return {
        name: target,
        compiler_version: (src2.compiler || {}).version || null,
        is_fully_verified: kind === 'full_match',
        via: 'sourcify',
        source_code: Object.values(src2.sources).map((f) => f.content).join('\n\n'),
      };
    } catch { continue; }
  }
  return null;
}

async function glmReport(env, system, user) {
  const res = await fetch((env.GLM_BASE || 'https://api.z.ai/api/paas/v4') + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.ZAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.GLM_MODEL || 'glm-4.5-flash',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 1800, temperature: 0.2, thinking: { type: 'disabled' },
    }),
  });
  const out = await res.json();
  return out.choices?.[0]?.message?.content || null;
}

export async function buildContractAudit(env, rpc, contract) {
  // Blockscout has hard 500'd globally before (2026-08-23, whole /v2 surface). A buyer who pays
  // during an outage must still get the report they paid for — so fall back to Sourcify's
  // keyless public repo before declaring the source unverifiable.
  let meta = null;
  try {
    const r = await fetch(`https://base.blockscout.com/api/v2/smart-contracts/${contract}`);
    if (r.status === 200) meta = await r.json();
  } catch { /* fall through to Sourcify */ }
  if (!meta || !meta.source_code) {
    try {
      const src2 = await sourcifySource(8453, contract);
      if (src2?.source_code) meta = src2;
    } catch { /* stay honest below */ }
  }
  if (!meta || !meta.source_code) {
    const code = await rpc('base', 'eth_getCode', [contract, 'latest']);
    return { verified_source: false, is_contract: code && code !== '0x', report: 'Source code is NOT VERIFIED anywhere reachable right now (explorer lookup failed or unverified). No honest audit is possible from bytecode alone at this price — treat unverified source as a red flag in itself.' };
  }
  const src = (meta.source_code || '').slice(0, 45000);
  const report = await glmReport(env,
    'You are a precise smart-contract risk analyst. Report ONLY what the provided source supports, quoting the function or modifier name for every finding. Never invent findings. If something cannot be determined from the source, say so explicitly. Output markdown with sections: Summary, Owner powers, Token mechanics, Upgradeability, Notable risks, What could NOT be determined.',
    `Contract ${contract} on Base. Name: ${meta.name || 'unknown'}. Compiler: ${meta.compiler_version || 'unknown'}. Proxy: ${meta.is_fully_verified ? 'verified' : 'partial'}.\n\nSOURCE:\n${src}`);
  return {
    verified_source: true, name: meta.name || null, compiler: meta.compiler_version || null,
    source_chars: src.length, report: report || 'analysis unavailable — the model returned nothing; no charge is owed for a null report, contact the operator',
  };
}

export async function buildWalletBrief(env, rpc, address) {
  const [info, txs, tokens] = await Promise.all([
    fetch(`https://base.blockscout.com/api/v2/addresses/${address}`).then(r => r.json()).catch(() => null),
    fetch(`https://base.blockscout.com/api/v2/addresses/${address}/transactions?filter=to%20%7C%20from`).then(r => r.json()).catch(() => null),
    fetch(`https://base.blockscout.com/api/v2/addresses/${address}/token-balances`).then(r => r.json()).catch(() => null),
  ]);
  const facts = {
    coin_balance_wei: info?.coin_balance ?? null,
    is_contract: !!info?.is_contract,
    has_token_transfers: !!info?.has_token_transfers,
    recent_tx_count: Array.isArray(txs?.items) ? txs.items.length : 0,
    recent_methods: (txs?.items || []).slice(0, 12).map(t => t.method).filter(Boolean),
    token_count: Array.isArray(tokens) ? tokens.length : 0,
    top_tokens: (Array.isArray(tokens) ? tokens : []).slice(0, 8).map(t => ({ symbol: t.token?.symbol, raw: t.value })),
  };
  const report = await glmReport(env,
    'You are an onchain analyst. Describe ONLY what the JSON facts support. No speculation about identity or intent beyond what activity shows. Say plainly when data is insufficient. Output concise markdown.',
    `Address ${address} on Base mainnet.\nFACTS:\n${JSON.stringify(facts, null, 1)}`);
  return { facts, report: report || 'analysis unavailable' };
}

export async function handleShop(req, env, url, rpc, payTo) {
  const path = url.pathname;

  if (path === '/.well-known/x402' || path === '/.well-known/x402-discovery' || path === '/shop') {
    return j({
      x402Version: 1,
      // `version` + `resources` are the /.well-known/x402 fan-out shape x402scan reads when an
      // origin has no OpenAPI (its DISCOVERY.md section B). Cheap to serve, and it means a crawler
      // that only knows the well-known path still finds both paid routes.
      version: 1,
      resources: Object.keys(PRODUCTS).map(slug => `${url.origin}/api/${slug}`),
      seller: 'ZERO', seller_wallet: payTo, network: 'base', asset: USDC,
      note: 'An autonomous agent with no funding, selling analysis to pay for its own existence. No account or API key is ever required.',
      products: Object.entries(PRODUCTS).map(([slug, p]) => ({
        slug, price_usdc: p.price_usdc, title: p.title, description: p.description, params: p.params,
        endpoint: `${url.origin}/api/${slug}`,
      })),
    });
  }

  const m = path.match(/^\/api\/([a-z-]+)$/);
  if (!m) return null;
  const slug = m[1];
  const product = PRODUCTS[slug];
  if (!product) return j({ error: 'unknown product', available: Object.keys(PRODUCTS) }, 404);

  const target = (url.searchParams.get('contract') || url.searchParams.get('address') || '').trim();
  const chain = (url.searchParams.get('chain') || '').trim().toLowerCase();
  const resource = url.origin + path + url.search;
  const tx = (url.searchParams.get('tx') || req.headers.get('x-payment-tx') || '').trim();

  if (!product.noParams && !/^0x[0-9a-fA-F]{40}$/.test(target)) {
    // No usable target. If the caller already paid, tell them plainly (their tx is NOT burned,
    // so they can simply re-call with the parameter). If they have not paid, this route is still
    // a paid resource — answer with the real x402 challenge so crawlers and x402 clients that
    // probe the bare endpoint see a valid, honest payment requirement instead of a 400.
    const paramName = slug === 'wallet-brief' ? 'address' : 'contract';
    if (tx) {
      return j({ error: `missing or malformed parameter`, expected: product.params, note: 'your transaction has not been redeemed — re-call this URL with the parameter and the same &tx=', example: `${url.origin}/api/${slug}?${paramName}=0x4200000000000000000000000000000000000006&tx=${tx}` }, 400);
    }
    const challenge = await paymentRequired(product, slug, payTo, resource).json();
    return j({ ...challenge, parameter_required: product.params, example: `${url.origin}/api/${slug}?${paramName}=0x4200000000000000000000000000000000000006` }, 402, { 'Payment-Required': x402v2Header(product, slug, payTo, resource) });
  }

  // Standard x402 clients sign an EIP-3009 authorization and retry with X-PAYMENT.
  const xPayment = req.headers.get('x-payment');
  let check, settlement;
  if (xPayment) {
    check = await verifyAuthorization(env, rpc, xPayment, product.units, payTo);
    if (!check.ok) {
      return j({ x402Version: 1, error: 'payment not accepted', reason: check.why }, 402,
        { 'x-payment-response': btoa(JSON.stringify({ success: false, error: check.why })) });
    }
    // Bank the bearer instrument; ZERO submits it once it can afford one paymaster operation.
    await env.KV.put('auth:' + String(check.nonce).toLowerCase(), JSON.stringify({
      slug, at: new Date().toISOString(), units: check.paid_units, from: check.from,
      authorization: check.authorization, signature: check.signature, settled: false,
    }));
    settlement = 'authorization accepted and banked; it settles on-chain when the agent can afford one paymaster operation';
  } else if (tx) {
    check = await verifyPayment(env, rpc, tx, product.units, payTo);
    if (!check.ok) return j({ x402Version: 1, error: 'payment not accepted', reason: check.why, retry_with: 'a confirmed USDC transfer on Base to ' + payTo }, 402, { 'Payment-Required': x402v2Header(product, slug, payTo, resource) });
    // Burn the hash BEFORE delivering so a slow report can't be double-redeemed.
    await env.KV.put('paid:' + tx.toLowerCase(), JSON.stringify({ slug, at: new Date().toISOString(), units: check.paid_units }));
    settlement = 'settled on-chain by the buyer';
  } else {
    return paymentRequired(product, slug, payTo, resource);
  }

  let body;
  try {
    body = slug === 'contract-audit' ? await buildContractAudit(env, rpc, target)
      : slug === 'payout-oracle' ? await buildPayoutOracle(rpc, target)
      : slug === 'interface-xray' ? await buildInterfaceXray(rpc, target)
      : slug === 'payer-census' ? await buildPayerCensus(env, chain)
      : slug === 'buy-zero' ? await deliverZeroTranche(env, rpc, target)
      : await buildWalletBrief(env, rpc, target);
  } catch (e) {
    return j({ error: 'report generation failed', detail: String(e.message).slice(0, 200), note: 'your payment was recorded; contact the operator via the repo for a re-issue' }, 500);
  }

  // Record the sale in the agent's own ledger — this is how ZERO learns selling works.
  try {
    // Third concurrent writer of the earnings ledger (the earner loop and the agent's route_log
    // tool are the other two). Merge into fresh state — a blob overwrite here would erase a harvest
    // or a route_log that landed while this sale was being generated, and THIS one records an actual
    // customer payment, which is the rarest event in the whole system.
    await mutateKV(env, 'state:routes', (db) => {
      db.routes ||= {};
      const r = db.routes['x402-shop-sales'] ||= { attempts: 0, successes: 0, blocked: 0, earned_usd: 0, notes: [] };
      r.attempts += 1; r.successes += 1;
      r.earned_usd = +(r.earned_usd + Number(check.paid_units) / 1e6).toFixed(6);
      r.last = { at: new Date().toISOString(), outcome: 'success' };
      r.notes = [...(r.notes || []), `SOLD ${slug} for ${(Number(check.paid_units) / 1e6).toFixed(6)} USDC — ${tx ? 'tx ' + tx : 'x402 authorization from ' + check.from}`].slice(-5);
      return db;
    }, { fallback: { routes: {} } });
    const sales = JSON.parse((await env.KV.get('state:sales')) || '[]');
    sales.push({ slug, tx: tx || null, nonce: check.nonce || null, units: check.paid_units, target, at: new Date().toISOString() });
    await env.KV.put('state:sales', JSON.stringify(sales.slice(-200)));
  } catch { /* never fail a paid delivery over bookkeeping */ }

  return j({ product: slug, paid_units: check.paid_units, tx: tx || null, target, settlement, generated_at: new Date().toISOString(), ...body },
    200, xPayment ? { 'x-payment-response': btoa(JSON.stringify({ success: true, payer: check.from, amount: check.paid_units, asset: USDC, network: 'base' })) } : {});
}


// ── the search-engine products ───────────────────────────────────────────────
// Thin wrappers over the instruments ZERO uses on itself. Sold rather than hoarded because an x402
// payment arrives as USDC at the smart account, and USDC is what the permissionless token paymaster
// takes — so revenue here converts directly into the gas that funds more searching.
const WETH_BASE = '0x4200000000000000000000000000000000000006';
async function ethUsdBase() {
  const take = (n) => (Number.isFinite(n) && n > 0 ? n : null);
  try {
    const n = parseFloat((await (await fetch('https://base.blockscout.com/api/v2/stats')).json()).coin_price);
    const v = take(n);
    if (v != null) return v;
  } catch { /* fall through */ }
  try {
    const cg = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')).json();
    return take(parseFloat(cg.ethereum?.usd));
  } catch { return null; }
}

// ── OTC delivery of the agent's own coin ────────────────────────────────────
// Runs AFTER payment is verified and the hash burned. The EOA holds native Base gas (first funded
// 2026-08-03), so it signs a plain ERC-20 transfer itself — no relay slot, no paymaster.
export async function deliverZeroTranche(env, rpc, to) {
  if (!env.AGENT_PRIVATE_KEY) throw new Error('agent key missing on this Worker');
  const wallet = new ethers.Wallet(env.AGENT_PRIVATE_KEY);
  const eoa = wallet.address;

  // stock check — creator supply must cover the tranche
  const bal = BigInt(await rpc('base', 'eth_call', [{ to: ZERO_COIN, data: '0x70a08231' + eoa.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
  if (bal < ZERO_TRANCHE) throw new Error('sold out: creator supply below one tranche');

  const data = '0xa9059cbb' + to.slice(2).toLowerCase().padStart(64, '0') + ZERO_TRANCHE.toString(16).padStart(64, '0');
  const [nonceHex, gasHex, block, prioHex] = await Promise.all([
    rpc('base', 'eth_getTransactionCount', [eoa, 'pending']),
    rpc('base', 'eth_estimateGas', [{ from: eoa, to: ZERO_COIN, data }]),
    rpc('base', 'eth_getBlockByNumber', ['latest', false]),
    rpc('base', 'eth_maxPriorityFeePerGas', []).catch(() => '0x0f4240'),
  ]);
  const signed = await wallet.signTransaction({
    type: 2, chainId: 8453, nonce: Number(nonceHex), to: ZERO_COIN, value: 0n, data,
    gasLimit: (BigInt(gasHex) * 130n) / 100n,
    maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + BigInt(prioHex),
    maxPriorityFeePerGas: BigInt(prioHex),
  });
  const txHash = await rpc('base', 'eth_sendRawTransaction', [signed]);
  let status = 'pending';
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const rcpt = await rpc('base', 'eth_getTransactionReceipt', [txHash]).catch(() => null);
    if (rcpt) { status = rcpt.status === '0x1' ? 'confirmed' : 'REVERTED'; break; }
  }
  return {
    product: 'buy-zero', coin: ZERO_COIN, tranche: '250000', recipient: to,
    delivery_tx: txHash, delivery_status: status,
    verify: `https://base.blockscout.com/tx/${txHash}`,
    zora: `https://zora.co/coin/base:${ZERO_COIN}`,
    disclosure: 'fixed price above pool price; thin pool; you funded an autonomous-agent experiment. If delivery_status is pending, the transfer confirms within seconds — check the verify link.',
  };
}

export async function buildPayoutOracle(rpc, contract) {
  const [r, px] = await Promise.all([
    probeContract((c, m, p) => rpc(c, m, p), 'base', contract, WETH_BASE),
    ethUsdBase(),
  ]);
  const usd = (w) => (px ? +((Number(w) / 1e18) * px).toFixed(8) : null);
  return {
    product: 'payout-oracle', contract, chain: 'base', measured_at: new Date().toISOString(),
    pays_an_arbitrary_caller: r.paying.length > 0,
    best: r.paying[0] ? { function: r.paying[0].sig, wei: r.paying[0].paid_wei, eth: r.paying[0].paid, usd: usd(r.paying[0].paid_wei) } : null,
    all_paying: r.paying.map((p) => ({ function: p.sig, eth: p.paid, usd: usd(p.paid_wei) })),
    callable_but_unpaid: (r.callable_now || []).filter((s) => !r.paying.some((p) => p.sig === s)),
    money_shaped_functions_found: r.exposed,
    verdict: r.verdict,
    method: 'Multicall3 aggregate3 batching [balanceOf, target.fn(), balanceOf] in one eth_call — the delta between the two balance reads IS the caller fee. Simulated settlement, not a getter reading.',
    caveat: 'Zero means zero AT THIS MOMENT, not never — payouts are state-dependent and accrue over time. Re-probe rather than concluding a contract never pays.',
  };
}

export async function buildInterfaceXray(rpc, contract) {
  const [r, px] = await Promise.all([
    bruteforceContract((c, m, p) => rpc(c, m, p), 'base', contract, WETH_BASE),
    ethUsdBase(),
  ]);
  const usd = (w) => (px ? +((Number(w) / 1e18) * px).toFixed(8) : null);
  return {
    product: 'interface-xray', contract, chain: 'base', measured_at: new Date().toISOString(),
    implementation: r.implementation,
    external_functions_found: r.functions,
    variants_probed: r.probed,
    paying_functions: (r.hits || []).map((h) => ({ selector: h.selector, shape: h.shape, eth: h.eth, usd: usd(h.wei) })),
    verdict: r.verdict,
    method: 'Runtime bytecode is scanned for PUSH4 opcodes to recover the dispatch table, giving the complete external interface with no ABI, no source and no explorer. Proxies are resolved first (EIP-1967 implementation slot, EIP-1967 beacon slot then implementation(), or a direct implementation()) because a proxy has no dispatch table of its own.',
    caveat: 'Screening batches share state within one call, so every hit is re-measured in isolation before being reported here.',
  };
}

// ── the census, served ──────────────────────────────────────────────────────
// Reads KV `shop:census`, which mirrors state/wallet-map.json (pushed by the mapper's operator
// flow and refreshable by the agent). A snapshot is honest if it is stamped: every row says when
// it was measured, and the buyer is told to re-verify with payout-oracle before spending gas.
export async function buildPayerCensus(env, chain) {
  const raw = await env.KV.get('shop:census');
  if (!raw) {
    return { product: 'payer-census', rows_returned: 0, payers: [], note: 'census snapshot not loaded yet — first map run pending; your payment is recorded and this response is still the full current dataset' };
  }
  const map = JSON.parse(raw);
  const shape = (r) => ({
    chain: r.chain, contract: r.contract, selector: r.selector,
    net_usd_per_call: r.net_usd_per_call, gross_usd_per_call: r.gross_usd_per_call,
    gas_usd_per_call: r.gas_usd_per_call,
    hits: r.hits, distinct_callers: r.distinct_callers,
    tokens: (r.tokens || []).map((t) => ({ symbol: t.symbol, usd: t.usd, executable: t.executable })),
    first_block: r.first_block, last_block: r.last_block, sample_tx: r.sample_tx,
  });
  const all = Object.values(map.payers || {}).filter((r) => !chain || r.chain === chain)
    .sort((a, b) => (b.net_usd_per_call || 0) - (a.net_usd_per_call || 0));
  // Openness beats size: a row many DISTINCT addresses have successfully called is one an
  // arbitrary caller can plausibly replay; a $640k row with exactly 1 caller is usually a
  // role-gated fee sweep or claim-once state, and ranking it first would sell a fantasy.
  const open = all.filter((r) => (r.distinct_callers || 0) >= 3).slice(0, 40).map(shape);
  const oneShot = all.filter((r) => (r.distinct_callers || 0) < 3).slice(0, 10).map((r) => ({
    ...shape(r), warning: 'few distinct callers — likely role-gated or one-time state; verify before acting',
  }));
  return {
    product: 'payer-census',
    chain_filter: chain || null,
    rows_returned: open.length,
    total_known_payers: Object.keys(map.payers || {}).length,
    payers: open,
    large_single_caller_claims: oneShot,
    freshness: {
      mapped_at: map.createdAt || null, updated_at: map.updatedAt || null, runs: Array.isArray(map.runs) ? map.runs.length : null,
      note: 'snapshot of the live simulation map. Payouts are state-dependent — re-verify any row with payout-oracle before spending gas.',
    },
    method: 'Each row was graded by replaying observed calldata at its payout block AND at head, then measuring the value that actually lands at a neutral caller via eth_simulateV1 traceTransfers. executable=false means the quote is spot-priced in a market too thin to realize.',
  };
}
