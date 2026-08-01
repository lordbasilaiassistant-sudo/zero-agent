// rpcpool.mjs — stop losing measurements to rate limits, without abusing anyone.
//
// THE PROBLEM, observed repeatedly tonight: every scan that mattered eventually died on
// `-32016 over rate limit` or `429`, and a scan that gets throttled halfway does not return a small
// answer — it returns a WRONG one, because the code usually swallows the error and reports whatever it
// had. That is how "0 contracts deployed per day" got printed for a chain doing 7.5M transactions a
// day: a 403 caught by `.catch(() => null)` and reported as a measurement.
//
// THE FIX IS NOT A BYPASS. Public endpoints publish limits and they are entitled to them; hammering
// one harder is both rude and self-defeating (they ban, and then we have nothing). The honest levers,
// in the order they pay off:
//
//   1. DON'T ASK TWICE. Runtime bytecode is immutable — `eth_getCode` for a given address can be
//      cached forever. Most of a scan is re-reading things that cannot have changed.
//   2. SPREAD THE LOAD. Base has many independent free endpoints. Rotating across N of them multiplies
//      the budget by N without exceeding any single provider's limit — each sees 1/N of the traffic.
//   3. BACK OFF, DON'T DIE. On a 429, quarantine that endpoint for a cool-off and move to the next.
//      A quarantined endpoint returns automatically; a dead script does not.
//   4. BATCH READS. One Multicall3 `aggregate3` carries hundreds of reads in one request. (Never batch
//      PAYMENT probes — shared state inside one aggregate3 produced 94.7% false positives.)
//   5. FAIL LOUDLY. If every endpoint is quarantined, throw. A pool that silently returns null teaches
//      the caller to report zeros as findings, which is the bug this file exists to end.
//
// Read-only by construction: this pool refuses any method that could change state or touch a key.

const ENDPOINTS = {
  base: [
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://base.llamarpc.com',
    'https://base.drpc.org',
    'https://1rpc.io/base',
    'https://base.meowrpc.com',
    'https://base-mainnet.public.blastapi.io',
  ],
  optimism: [
    'https://mainnet.optimism.io',
    'https://optimism-rpc.publicnode.com',
    'https://optimism.drpc.org',
    'https://1rpc.io/op',
  ],
  arbitrum: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.drpc.org',
    'https://1rpc.io/arb',
  ],
  polygon: [
    'https://polygon-rpc.com',
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon.drpc.org',
  ],
  gnosis: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com', 'https://gnosis.drpc.org'],
  unichain: ['https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com'],
};

// Anything that signs, sends, or unlocks is refused outright — this pool is for LOOKING.
const READ_ONLY = new Set([
  'eth_call', 'eth_getCode', 'eth_getBalance', 'eth_getStorageAt', 'eth_getLogs', 'eth_blockNumber',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getBlockReceipts', 'eth_chainId', 'eth_gasPrice', 'eth_feeHistory', 'eth_estimateGas',
  'eth_getTransactionCount', 'net_version',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (msg) =>
  /rate limit|429|too many requests|-32016|capacity|throttl|exceeded/i.test(String(msg || ''));

export class RpcPool {
  /**
   * @param {string} chain
   * @param {{cooloffMs?:number, maxRetries?:number, minGapMs?:number, cache?:boolean}} [opts]
   */
  constructor(chain = 'base', opts = {}) {
    this.chain = chain;
    this.urls = ENDPOINTS[chain] || ENDPOINTS.base;
    this.cooloffMs = opts.cooloffMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.minGapMs = opts.minGapMs ?? 0;      // per-endpoint spacing, not global — the pool IS the speed
    this.useCache = opts.cache !== false;
    // `unsupported` is per-endpoint, per-method and PERMANENT for the run: several free endpoints
    // serve eth_getCode happily but reject eth_call or eth_getLogs outright. Retrying those wastes the
    // rotation and, worse, makes a scan look rate-limited when it is actually mis-routed.
    this.state = this.urls.map((url) => ({ url, quarantinedUntil: 0, lastUsed: 0, ok: 0, fail: 0, limited: 0, unsupported: new Set() }));
    this.cache = new Map();                   // immutable reads only (eth_getCode, eth_chainId)
    this.calls = 0;
    this.cacheHits = 0;
    this.rr = 0;
  }

  /** Cacheable == provably immutable for a given argument set. */
  #cacheKey(method, params) {
    if (!this.useCache) return null;
    if (method === 'eth_getCode') return `code:${String(params[0]).toLowerCase()}`;
    if (method === 'eth_chainId' || method === 'net_version') return method;
    // A historical block's contents cannot change; 'latest' obviously can.
    if (method === 'eth_getBlockByNumber' && params[0] !== 'latest' && params[0] !== 'pending') {
      return `blk:${params[0]}:${!!params[1]}`;
    }
    return null;
  }

  #pick(method) {
    const now = Date.now();
    const live = this.state.filter((s) => s.quarantinedUntil <= now && !s.unsupported.has(method));
    if (!live.length) return null;
    // round-robin over healthy endpoints, respecting any per-endpoint spacing
    for (let i = 0; i < live.length; i++) {
      const s = live[(this.rr + i) % live.length];
      if (now - s.lastUsed >= this.minGapMs) {
        this.rr = (this.rr + i + 1) % Math.max(live.length, 1);
        return s;
      }
    }
    return live[this.rr++ % live.length];
  }

  async send(method, params = []) {
    if (!READ_ONLY.has(method)) {
      throw new Error(`RpcPool refuses "${method}" — this pool is read-only by construction`);
    }
    const key = this.#cacheKey(method, params);
    if (key && this.cache.has(key)) { this.cacheHits++; return this.cache.get(key); }

    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const ep = this.#pick(method);
      if (!ep) {
        const capable = this.state.filter((s) => !s.unsupported.has(method));
        if (!capable.length) throw new Error(`no endpoint supports ${method} on ${this.chain}`);
        // All capable endpoints are cooling off. Wait for the soonest rather than failing the scan.
        const soonest = Math.min(...capable.map((s) => s.quarantinedUntil)) - Date.now();
        await sleep(Math.max(250, Math.min(soonest, this.cooloffMs)));
        continue;
      }
      ep.lastUsed = Date.now();
      this.calls++;
      try {
        const res = await fetch(ep.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.calls, method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 429 || res.status === 403) {
          ep.limited++; ep.quarantinedUntil = Date.now() + this.cooloffMs;
          lastErr = new Error(`${res.status} from ${ep.url}`);
          continue;
        }
        const j = await res.json();
        if (j.error) {
          const m = String(j.error.message || '');
          // "not supported" / "usage limit for your current plan" are properties of the ENDPOINT, not
          // of the request. Retrying them on the same endpoint is pure waste, so record and move on.
          if (/not supported|unsupported|not available|usage limit|current plan|method not found/i.test(m)) {
            ep.unsupported.add(method);
            lastErr = new Error(`${m} (${ep.url})`);
            continue;
          }
          if (isRateLimit(m)) {
            ep.limited++; ep.quarantinedUntil = Date.now() + this.cooloffMs;
            lastErr = new Error(m);
            continue;
          }
          // A genuine RPC error (bad params, execution reverted) is the ANSWER, not a transport fault.
          const e = new Error(j.error.message);
          e.rpcError = j.error;
          throw e;
        }
        ep.ok++;
        if (key) this.cache.set(key, j.result);
        return j.result;
      } catch (e) {
        if (e.rpcError) throw e;                  // real answer, do not retry
        ep.fail++; lastErr = e;
        if (isRateLimit(e.message)) ep.quarantinedUntil = Date.now() + this.cooloffMs;
        await sleep(150 * (attempt + 1));         // linear backoff across endpoints
      }
    }
    // Loud by design: a pool that returns null teaches callers to print zeros as findings.
    throw new Error(`RpcPool exhausted ${this.urls.length} endpoints for ${method}: ${lastErr?.message || 'unknown'}`);
  }

  /** ethers-compatible shape so existing code can pass this straight through. */
  asRpc() {
    return (_chain, method, params) => this.send(method, params);
  }

  stats() {
    return {
      chain: this.chain,
      calls: this.calls,
      cacheHits: this.cacheHits,
      cacheSize: this.cache.size,
      endpoints: this.state.map((s) => ({
        url: s.url.replace(/^https:\/\//, ''),
        ok: s.ok, fail: s.fail, limited: s.limited,
        quarantined: s.quarantinedUntil > Date.now(), unsupported: [...s.unsupported],
      })),
    };
  }
}

/** Probe every endpoint for a chain and report which are actually usable right now. */
export async function healthCheck(chain = 'base') {
  const urls = ENDPOINTS[chain] || [];
  const out = [];
  await Promise.all(urls.map(async (url) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json().catch(() => ({}));
      out.push({ url, ok: !!j.result, status: r.status, ms: Date.now() - t0, block: j.result ? parseInt(j.result, 16) : null, err: j.error?.message });
    } catch (e) {
      out.push({ url, ok: false, ms: Date.now() - t0, err: String(e.message).slice(0, 60) });
    }
  }));
  return out.sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0) || a.ms - b.ms);
}
