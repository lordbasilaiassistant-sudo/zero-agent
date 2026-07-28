// shop.mjs — ZERO's storefront: the one earning rail that needs no capital.
import { ethers } from 'ethers';
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
// Deterministic Safe v0.3.0 counterfactual for owner 0x50624F7790732f9767180871D03A304756200dB9,
// computed with abstractionkit and verified undeployed (it can receive before deployment).
export const SMART_ACCOUNT = '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';

export const PRODUCTS = {
  'contract-audit': {
    price_usdc: '0.05',
    units: 50000n,
    title: 'Contract red-flag report',
    description: 'Fetches the verified source of any contract on Base and returns a structured risk report: owner powers, mint/blacklist/pause authority, fee logic, upgradeability, and the specific lines that justify each finding. Returns "unverified source" honestly rather than guessing.',
    params: { contract: '0x-prefixed contract address on Base (required)' },
  },
  'wallet-brief': {
    price_usdc: '0.02',
    units: 20000n,
    title: 'Address activity brief',
    description: 'Plain-language brief on any Base address: age, transaction and transfer counts, token holdings, contract-or-EOA, and what the recent activity pattern suggests.',
    params: { address: '0x-prefixed address on Base (required)' },
  },
};

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
            queryParams: b ? { [b.paramName]: '0x4200000000000000000000000000000000000006' } : {},
            schema: b ? { properties: { [b.paramName]: { type: 'string', description: b.paramDesc } }, required: [b.paramName] } : { properties: {}, required: [] },
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
                  properties: b ? { [b.paramName]: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$', description: b.paramDesc } } : {},
                  required: b ? [b.paramName] : [],
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
  const r = await fetch(`https://base.blockscout.com/api/v2/smart-contracts/${contract}`);
  if (r.status !== 200) {
    const code = await rpc('base', 'eth_getCode', [contract, 'latest']);
    return { verified_source: false, is_contract: code && code !== '0x', report: 'Source code is NOT verified on Blockscout for this address. No honest audit is possible from bytecode alone at this price — treat unverified source as a red flag in itself.' };
  }
  const meta = await r.json();
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

  if (path === '/.well-known/x402' || path === '/shop') {
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
  const resource = url.origin + path + url.search;
  const tx = (url.searchParams.get('tx') || req.headers.get('x-payment-tx') || '').trim();

  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
    // No usable target. If the caller already paid, tell them plainly (their tx is NOT burned,
    // so they can simply re-call with the parameter). If they have not paid, this route is still
    // a paid resource — answer with the real x402 challenge so crawlers and x402 clients that
    // probe the bare endpoint see a valid, honest payment requirement instead of a 400.
    if (tx) {
      return j({ error: `missing or malformed parameter`, expected: product.params, note: 'your transaction has not been redeemed — re-call this URL with the parameter and the same &tx=', example: `${url.origin}/api/${slug}?${slug === 'wallet-brief' ? 'address' : 'contract'}=0x4200000000000000000000000000000000000006&tx=${tx}` }, 400);
    }
    const challenge = await paymentRequired(product, slug, payTo, resource).json();
    return j({ ...challenge, parameter_required: product.params, example: `${url.origin}/api/${slug}?${slug === 'wallet-brief' ? 'address' : 'contract'}=0x4200000000000000000000000000000000000006` }, 402, { 'Payment-Required': x402v2Header(product, slug, payTo, resource) });
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
    body = slug === 'contract-audit' ? await buildContractAudit(env, rpc, target) : await buildWalletBrief(env, rpc, target);
  } catch (e) {
    return j({ error: 'report generation failed', detail: String(e.message).slice(0, 200), note: 'your payment was recorded; contact the operator via the repo for a re-issue' }, 500);
  }

  // Record the sale in the agent's own ledger — this is how ZERO learns selling works.
  try {
    const db = JSON.parse((await env.KV.get('state:routes')) || '{"routes":{}}');
    const r = db.routes['x402-shop-sales'] ||= { attempts: 0, successes: 0, blocked: 0, earned_usd: 0, notes: [] };
    r.attempts += 1; r.successes += 1;
    r.earned_usd = +(r.earned_usd + Number(check.paid_units) / 1e6).toFixed(6);
    r.last = { at: new Date().toISOString(), outcome: 'success' };
    r.notes.push(`SOLD ${slug} for ${(Number(check.paid_units) / 1e6).toFixed(6)} USDC — ${tx ? 'tx ' + tx : 'x402 authorization from ' + check.from}`);
    r.notes = r.notes.slice(-5);
    await env.KV.put('state:routes', JSON.stringify(db, null, 2));
    const sales = JSON.parse((await env.KV.get('state:sales')) || '[]');
    sales.push({ slug, tx: tx || null, nonce: check.nonce || null, units: check.paid_units, target, at: new Date().toISOString() });
    await env.KV.put('state:sales', JSON.stringify(sales.slice(-200)));
  } catch { /* never fail a paid delivery over bookkeeping */ }

  return j({ product: slug, paid_units: check.paid_units, tx: tx || null, target, settlement, generated_at: new Date().toISOString(), ...body },
    200, xPayment ? { 'x-payment-response': btoa(JSON.stringify({ success: true, payer: check.from, amount: check.paid_units, asset: USDC, network: 'base' })) } : {});
}
