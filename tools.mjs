// tools.mjs — ZERO's hands: wallet, chain, web, memory.
// The private key NEVER enters model context; signing tools use it internally.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { SMART_ACCOUNT, sourcifySource } from './shop.mjs';
import { harvestScan, harvestRun, batchHarvest, reconcileEarnings, pickChain, observeRelay, CHAINS as HARVEST_CHAINS, relayResetSummary } from './harvest.mjs';
import { inspect as inspectContract, discoveryPass, loadDiscoverList } from './discover.mjs';
import { gasSources } from './gasrouter.mjs';
import { payoutHistory } from './payouts.mjs';
import { scanGasless, controlTest as gaslessControl } from './gasless.mjs';
import { discoverSponsors, controlTest as sponsorControl } from './sponsors.mjs';
import { docSearch } from './docs.mjs';
import { treasuryPlan } from './treasury.mjs';
import { prospectIntel } from './prospect.mjs';
import { probeContract } from './oracle.mjs';
import { bruteforceContract } from './bruteforce.mjs';
import { experimentTick } from './experiments.mjs';

export const ROOT = process.env.AUTOGLM_HOME || path.dirname(fileURLToPath(import.meta.url));
const SECRETS = process.env.AUTOGLM_SECRETS || path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env');
const KNOWLEDGE = path.join(ROOT, 'knowledge');
export const STATE = path.join(ROOT, 'state');

const CHAINS = {
  base: {
    chainId: 8453,
    rpc: process.env.BASE_RPC || 'https://mainnet.base.org',
    scout: 'https://base.blockscout.com',
    label: 'Base mainnet (REAL money)',
  },
  'base-sepolia': {
    chainId: 84532,
    rpc: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
    scout: 'https://base-sepolia.blockscout.com',
    label: 'Base Sepolia (testnet — practice, not money)',
    testnet: true,
  },
  // P2-18 fix: ZERO earns on six chains; this harness only knew two, so get_status/eth_call/explorer
  // could not see or touch the other four and threw "unknown chain". Mirrors worker.mjs CHAINS.
  optimism: {
    chainId: 10,
    rpc: process.env.OPTIMISM_RPC || 'https://optimism-rpc.publicnode.com',
    scout: 'https://optimism.blockscout.com',
    label: 'Optimism (REAL money)',
  },
  arbitrum: {
    chainId: 42161,
    rpc: process.env.ARBITRUM_RPC || 'https://arbitrum-one-rpc.publicnode.com',
    scout: 'https://arbitrum.blockscout.com',
    label: 'Arbitrum One (REAL money)',
  },
  polygon: {
    chainId: 137,
    rpc: process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com',
    scout: 'https://polygon.blockscout.com',
    label: 'Polygon (REAL money)',
  },
  gnosis: {
    chainId: 100,
    rpc: process.env.GNOSIS_RPC || 'https://gnosis-rpc.publicnode.com',
    scout: 'https://gnosis.blockscout.com',
    label: 'Gnosis (REAL money)',
  },
  unichain: {
    chainId: 130,
    rpc: process.env.UNICHAIN_RPC || 'https://mainnet.unichain.org',
    scout: 'https://unichain.blockscout.com',
    label: 'Unichain (REAL money)',
  },
};

// Operator blocklist — the agent must never interact with these token contracts.
const NEVER_TOUCH = new Set([
  '0xc07e889e1816de2708bf718683e52150c20f3ba3',
  '0x49e4cf7097c497008800edc80dc76906edd189dd',
]);

export const jstr = (o, n = 2) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), n);
const clip = (s, n) => (s.length > n ? s.slice(0, n) + ` …[truncated ${s.length - n} chars]` : s);

export function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(SECRETS, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* no secrets file yet */ }
  // Cloud runners (GitHub Actions) provide creds via process env instead of the secrets file.
  for (const k of ['ZAI_API_KEY', 'GLM_MODEL', 'GLM_BASE', 'AGENT_PRIVATE_KEY', 'AGENT_MNEMONIC', 'AGENT_ADDRESS']) {
    if (process.env[k]) out[k] = process.env[k];
  }
  return out;
}

function provider(chain) {
  const c = CHAINS[chain];
  if (!c) throw new Error(`unknown chain "${chain}" — valid: ${Object.keys(CHAINS).join(', ')}`);
  return new ethers.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
}

function loadWallet() {
  const env = readEnvFile();
  return env.AGENT_PRIVATE_KEY ? new ethers.Wallet(env.AGENT_PRIVATE_KEY) : null;
}

/** File-backed KV so harvest.mjs / gasrouter.mjs can run in the local harness the same way they run on the Worker. */
function localEnv() {
  const dir = path.join(STATE, 'kv');
  const file = (k) => path.join(dir, encodeURIComponent(k));
  const asJson = (type) => type === 'json' || type?.type === 'json';
  return {
    KV: {
      async get(k, type) {
        let raw;
        try { raw = fs.readFileSync(file(k), 'utf8'); } catch { return null; }
        if (asJson(type)) { try { return JSON.parse(raw); } catch { return null; } }
        return raw;
      },
      async put(k, v) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file(k), typeof v === 'string' ? v : JSON.stringify(v));
      },
    },
  };
}

async function rpcRaw(chain, method, params) {
  const c = CHAINS[chain];
  if (!c) throw new Error(`unknown chain "${chain}" — valid: ${Object.keys(CHAINS).join(', ')}`);
  const r = await fetch(c.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

async function fetchText(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) zero-agent/0.1',
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get('content-type') || '', text };
  } finally {
    clearTimeout(t);
  }
}

const stripHtml = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

// ── tool implementations ────────────────────────────────────────────────────

async function ensure_wallet() {
  const existing = loadWallet();
  if (existing) return { address: existing.address, created: false, note: 'wallet already exists' };
  if (process.env.CI) throw new Error('running in an ephemeral cloud runner without AGENT_PRIVATE_KEY in env — refusing to create a throwaway wallet. Operator must set the secret.');
  const w = ethers.Wallet.createRandom();
  fs.mkdirSync(path.dirname(SECRETS), { recursive: true });
  fs.appendFileSync(SECRETS,
    `\n# ZERO agent wallet — created ${new Date().toISOString()} — NEVER expose\n` +
    `AGENT_PRIVATE_KEY=${w.privateKey}\nAGENT_MNEMONIC=${w.mnemonic.phrase}\nAGENT_ADDRESS=${w.address}\n`);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'wallet.json'), jstr({ address: w.address, createdAt: new Date().toISOString() }));
  return {
    address: w.address,
    created: true,
    note: 'Credentials saved to the operator secrets store (outside the project). You never see the private key; sign_message/send_tx use it for you.',
  };
}

async function get_status() {
  const w = loadWallet();
  const out = { wallet: w ? w.address : null, smart_account: SMART_ACCOUNT, chains: {}, runtime: 'local' };
  if (!w) { out.note = 'no wallet yet — call ensure_wallet first'; return out; }
  for (const [name, c] of Object.entries(CHAINS)) {
    if (c.testnet) continue;
    try {
      const p = provider(name);
      const [bal, nonce] = await Promise.all([p.getBalance(w.address), p.getTransactionCount(w.address)]);
      out.chains[name] = { label: c.label, eth: ethers.formatEther(bal), tx_count: nonce };
    } catch (e) {
      out.chains[name] = { error: String(e.message || e).slice(0, 200) };
    }
  }
  try {
    const s = await fetchText('https://base.blockscout.com/api/v2/stats');
    const price = parseFloat(JSON.parse(s.text).coin_price);
    if (price) {
      out.eth_usd = price;
      if (out.chains.base?.eth) out.chains.base.usd_value = (parseFloat(out.chains.base.eth) * price).toFixed(4);
    }
  } catch { /* price is a nicety */ }
  try {
    const tb = await fetchText(`${CHAINS.base.scout}/api/v2/addresses/${w.address}/token-balances`);
    if (tb.status === 200) {
      const tokens = JSON.parse(tb.text);
      if (Array.isArray(tokens) && tokens.length) {
        out.chains.base.tokens = tokens.slice(0, 20).map(t => ({
          symbol: t.token?.symbol, address: t.token?.address_hash || t.token?.address,
          raw_balance: t.value, decimals: t.token?.decimals,
        }));
      }
    }
  } catch { /* fresh addresses often 404 here */ }
  out.broke = (() => {
    // P2-19 FIX: a chain whose RPC errored used to satisfy `!c.eth` and count as broke — the agent
    // was told it was broke when its balance was merely UNREAD. Errored chains are unknown, not
    // zero, and are excluded from the verdict; if every chain errored there is no verdict at all.
    const known = Object.values(out.chains).filter(c => !c.error);
    if (!known.length) return undefined;
    return known.every(c => parseFloat(c.eth || '0') === 0);
  })();
  return out;
}

async function web_search({ query }) {
  const r = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query));
  const results = [];
  const re = /result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(r.text)) && results.length < 8) {
    let url = m[1];
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    results.push({ title: stripHtml(m[2]), url });
  }
  const snips = [...r.text.matchAll(/result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map(x => stripHtml(x[1]));
  results.forEach((res, i) => { if (snips[i]) res.snippet = clip(snips[i], 200); });
  if (!results.length) {
    const rateLimited = r.status !== 200 || /anomal|captcha|challenge/i.test(r.text.slice(0, 2000));
    return {
      query, results,
      note: rateLimited
        ? `search engine is rate-limiting you (HTTP ${r.status}). STOP searching for several minutes — switch to http_fetch on URLs you already know, or onchain reads.`
        : 'no results — try different words',
    };
  }
  return { query, results };
}

async function http_fetch({ url, method = 'GET', headers = {}, body, max_chars = 5000, raw = false }) {
  if (!/^https?:\/\//i.test(url)) throw new Error('http(s) URLs only');
  const r = await fetchText(url, { method, headers, body: body ?? undefined });
  const isHtml = r.contentType.includes('html');
  const text = raw || !isHtml ? r.text : stripHtml(r.text);
  return { status: r.status, content_type: r.contentType, text: clip(text, Math.min(Number(max_chars) || 5000, 12000)) };
}

async function explorer({ chain, api_path }) {
  const c = CHAINS[chain];
  if (!c) throw new Error(`unknown chain "${chain}"`);
  const r = await fetchText(`${c.scout}/api/v2/${String(api_path).replace(/^\/+/, '')}`);
  const out = { status: r.status, data: clip(r.text, 6000) };
  if (out.status === 200 && out.data && !/"Internal server error"/i.test(out.data)) return out;
  const m = String(api_path).match(/smart-contracts\/(0x[a-fA-F0-9]{40})/i);
  if (!m || !c.chainId) return out;
  const src = await sourcifySource(c.chainId, m[1]);
  if (!src?.source_code) return out;
  return { status: 200, via: 'sourcify', data: clip(JSON.stringify(src), 6000) };
}

async function eth_call({ chain, to, signature, args = [], from, value_eth, block = 'latest' }) {
  const sig = signature.trim().startsWith('function') ? signature.trim() : `function ${signature.trim()}`;
  const iface = new ethers.Interface([sig]);
  const fn = iface.fragments[0];
  const data = iface.encodeFunctionData(fn.name, args);
  // P1-4 FIX: this simulation used to run as msg.sender = address(0) while the system prompt
  // mandates eth_call as the pre-spend safety check. Both error directions are live and measured:
  // a working route gets a FALSE REVERT ("transfer from the zero address"), and a msg.sender-crediting
  // harvest gets a FALSE SUCCESS that says nothing about whether OUR address is paid. Simulate AS
  // YOURSELF by default — a call simulated from a different sender proves nothing.
  const sender = from || loadWallet()?.address;
  const tx = { to, data };
  if (sender) tx.from = sender;
  if (value_eth) tx.value = ethers.parseEther(String(value_eth));
  let ret;
  try { ret = await provider(chain).call(tx, block); }
  catch (e) {
    return { reverted: true, from: sender || null, reason: String(e.shortMessage || e.message).slice(0, 300) };
  }
  let decoded;
  try { decoded = JSON.parse(jstr([...iface.decodeFunctionResult(fn.name, ret)])); }
  catch { decoded = ret; }
  return { result: decoded, from: sender || null };
}

async function send_tx({ chain, to, value_eth = '0', data = '0x', gas_limit }) {
  if (to && NEVER_TOUCH.has(to.toLowerCase())) throw new Error('that address is on the operator NEVER_TOUCH blocklist — refused, do not retry');
  const w = loadWallet();
  if (!w) throw new Error('no wallet — call ensure_wallet first');
  const p = provider(chain);
  const signer = w.connect(p);
  const value = ethers.parseEther(String(value_eth));
  const bal = await p.getBalance(w.address);
  const tx = { to, value, data };
  let gas;
  try {
    gas = gas_limit ? BigInt(gas_limit) : (await p.estimateGas({ ...tx, from: w.address })) * 12n / 10n;
  } catch (e) {
    throw new Error(`gas estimate failed (tx would revert, or zero balance): ${String(e.shortMessage || e.message).slice(0, 300)}`);
  }
  const fee = await p.getFeeData();
  const cost = value + gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
  if (bal < cost) {
    throw new Error(`insufficient funds on ${chain}: balance ${ethers.formatEther(bal)} ETH, need ~${ethers.formatEther(cost)} ETH. You are broke here — earn gas first.`);
  }
  const before = await p.getBalance(w.address);
  const sent = await signer.sendTransaction({ ...tx, gasLimit: gas });
  const rcpt = await sent.wait(1, 90000).catch(() => null);
  // P1-5 FIX: `status === 1` means "the EVM did not revert" — it never meant anything arrived.
  // The model's only way to fill route_log.earned_usd was to GUESS, and the guess became the
  // leaderboard sort key and "lifetime earned". These fields are the actual evidence of payment:
  const after = await p.getBalance(w.address);
  const gasPaid = rcpt ? rcpt.gasUsed * (rcpt.gasPrice ?? 0n) : 0n;
  const net = after - before;
  const TRANSFER = ethers.id('Transfer(address,address,uint256)');
  const inbound = (rcpt?.logs || []).filter(l =>
    l.topics?.[0] === TRANSFER &&
    l.topics[2] && ('0x' + l.topics[2].slice(26).toLowerCase()) === w.address.toLowerCase());
  return {
    hash: sent.hash,
    mined: rcpt ? (rcpt.status === 1 ? 'no-revert' : 'REVERTED') : 'sent, not confirmed within 90s — check explorer',
    // "no-revert" is NOT payment. net_eth_change + tokens_received are the only payment evidence.
    net_eth_change: ethers.formatEther(net),
    gas_paid_eth: ethers.formatEther(gasPaid),
    tokens_received: inbound.map(l => ({ token: l.address, raw: BigInt(l.data).toString() })),
    paid_you: net + gasPaid > 0n || inbound.length > 0,
    explorer: `${CHAINS[chain].scout}/tx/${sent.hash}`,
  };
}

async function sign_message({ message }) {
  const w = loadWallet();
  if (!w) throw new Error('no wallet — call ensure_wallet first');
  return { address: w.address, message, signature: await w.signMessage(message) };
}

const kpath = (name) => {
  const clean = String(name).toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
  if (!clean) throw new Error('bad knowledge file name');
  return path.join(KNOWLEDGE, clean + '.md');
};

async function knowledge_list() {
  fs.mkdirSync(KNOWLEDGE, { recursive: true });
  return {
    files: fs.readdirSync(KNOWLEDGE).filter(f => f.endsWith('.md'))
      .map(f => ({ name: f, bytes: fs.statSync(path.join(KNOWLEDGE, f)).size })),
  };
}

async function knowledge_read({ name }) {
  const p = kpath(name);
  if (!fs.existsSync(p)) throw new Error(`no knowledge file "${name}" — use knowledge_list`);
  const all = fs.readFileSync(p, 'utf8');
  // P1-3 FIX: clip() took the HEAD. Knowledge files are append-only and the journal/frontier hold
  // their history in the newest entries, so this handed the model the OLDEST 20 KB of itself —
  // measured: 80% of journal.md and 40% of frontier were unreachable, and falsified hypotheses got
  // re-derived because the refutation sat past the cut. The TAIL is the recent past.
  const content = all.length > 20000
    ? `…[${all.length - 20000} older chars omitted — below is the most RECENT 20,000]\n` + all.slice(-20000)
    : all;
  return { name: path.basename(p), bytes: all.length, content };
}

async function knowledge_write({ name, content, mode = 'append' }) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('content required');
  // P2-15 FIX: mode was compared case-sensitively and invalid values silently became APPEND — an
  // "overwrite" of a stale playbook appended a contradicting copy underneath it and reported
  // success. Reject unknown modes loudly; normalise casing.
  const m = String(mode).toLowerCase();
  if (!['append', 'overwrite'].includes(m)) {
    throw new Error(`mode must be "append" or "overwrite" (got "${mode}")`);
  }
  fs.mkdirSync(KNOWLEDGE, { recursive: true });
  const p = kpath(name);
  if (m === 'overwrite') fs.writeFileSync(p, content.slice(0, 100000));
  else fs.appendFileSync(p, (fs.existsSync(p) ? '\n\n' : '') + content.slice(0, 100000));
  return { saved: path.basename(p), mode: m, bytes: fs.statSync(p).size };
}

const CREDS = process.env.AUTOGLM_CREDS || path.join(path.dirname(SECRETS), 'autoglmwallet-creds.json');

function readCreds() {
  try { return JSON.parse(fs.readFileSync(CREDS, 'utf8')); } catch { return {}; }
}

async function secret_store({ name, value }) {
  if (!name || typeof value !== 'string' || !value.trim()) throw new Error('name and value required');
  const key = String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
  if (/^0x[0-9a-fA-F]{64}$/.test(value.trim())) throw new Error('that looks like a private key — never store or handle raw private keys');
  // P3 fix: ensure_wallet writes BIP-39 mnemonics to disk, so a mnemonic is exactly as forbidden
  // here as a raw key — but only the 0x+64-hex shape was refused.
  const words = value.trim().split(/\s+/);
  if ((words.length === 12 || words.length === 24) && words.every(w => /^[a-z]{3,}$/i.test(w))) {
    throw new Error('that looks like a BIP-39 seed phrase (12/24 lowercase words) — never store or handle mnemonics');
  }
  const db = readCreds();
  db[key] = { value: value.trim(), savedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(CREDS), { recursive: true });
  fs.writeFileSync(CREDS, jstr(db));
  return { stored: key, note: 'saved in the operator secrets store (survives sessions, outside project dir)' };
}

async function secret_get({ name }) {
  const key = String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
  const db = readCreds();
  if (!db[key]) throw new Error(`no stored secret "${key}" — use secret_list`);
  return { name: key, value: db[key].value, savedAt: db[key].savedAt };
}

async function secret_list() {
  const db = readCreds();
  return { secrets: Object.entries(db).map(([k, v]) => ({ name: k, savedAt: v.savedAt })) };
}

const routesFile = () => path.join(STATE, 'routes.json');
export function readRoutes() {
  try { return JSON.parse(fs.readFileSync(routesFile(), 'utf8')); }
  catch { return { routes: {} }; }
}

// A route is DEAD once its category is closed, it is human-gated in any wording, or it has been
// blocked twice. Refused at the tool layer — prompt instructions alone did not stop re-attempts.
export const HUMAN_GATE_RE = /HUMAN-GATED|captcha|human verification|social login|sign ?up with|email verification|phone verification|KYC/i;
export const CLOSED_CATEGORY = {
  test: /faucet/i,
  why: 'FAUCETS ARE A PERMANENTLY CLOSED CATEGORY (operator ruling). Every known faucet is human-gated, which rule 2b bans. Searching, fetching or logging them is forbidden and wastes the session. Work gigs.sh, BountyBook, AgentPact, or a frontier hypothesis instead.',
};
export function isDead(r, id) {
  if (!r) return false;
  // A route that has actually PAID can never be dead by counter — money arrived = the route is real.
  // P0-1 FIX: the old `&& r.dead !== true` DISABLED this escape hatch — the next line killed the
  // route anyway, so the only proven earner ($0.074421, 26 successes) was served to the model as
  // DEAD_NEVER_REVISIT. Matches the hardened worker.mjs isDead: money outranks every flag, and wei
  // counts as money (a price-feed outage must not bury a paying route behind earned_usd 0).
  if (r.earned_usd > 0) return false;
  try { if (BigInt(r.earned_wei || 0) > 0n || BigInt(r.unpriced_wei || 0) > 0n) return false; } catch { /* malformed counter is not evidence of death */ }
  const notes = (r.notes || []).join(' ');
  // P0-2 FIX: relay-slot exhaustion, rate limits and quota walls are TRANSIENT CAPACITY, not a
  // property of the route. Three aliases of the earning rail were permanently killed by two
  // "Relay budget exhausted" notes each; one of them even said "proven route but cannot execute
  // until slots refill". Capacity noise no longer trips the blocked-counter death.
  const capacityNoise = !HUMAN_GATE_RE.test(notes) && CAPACITY_NOISE_RE.test(notes);
  if (r.dead === true && !capacityNoise) return true;
  if (r.blocked >= 2 && !capacityNoise) return true;
  if (HUMAN_GATE_RE.test(notes)) return true;
  if (id && CLOSED_CATEGORY.test.test(id)) return true;
  return false;
}
// Phrases that mean "could not run right now", never "this route is worthless".
export const CAPACITY_NOISE_RE = /relay|slot|budget exhaust|rate limit|429|capacity|quota|refill|temporar/i;
const normId = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');

// Mirrors worker.mjs — a ROUTE is a way MONEY CAN ARRIVE. Budget/status/list/scan checks are
// housekeeping; logging them polluted the ledger with ten dead pseudo-routes that then blocked real work.
const NON_ROUTE_RE = /(^|[-_])(budget|status|api|list|scan|health|ping|state|balance|check|exploration|research|browsing|registration|monitor\w*|wait\w*|watch\w*|investigat\w*|observ\w*|tooling|refill|slot\w*|crisis|session\w*|discover\w*|opportunit\w*|candidate\w*|demand)([-_]?check)?([-_]|$)/i;
export function notARoute(id) {
  if (!NON_ROUTE_RE.test(id)) return null;
  // "bount" not "bounty": the agent writes "bounties", which /bounty/ does not match.
  // P2-12 FIX: claim/skim/airdrop/refund/yield/x402 are commonest words for actual on-chain earning
  // actions — a refused log is never persisted, so the agent had no memory of having tried (e.g.
  // "morpho-urd-claim-scan", the x402 rail) and retried it every session. NOTE 'harvest' is
  // deliberately NOT a blanket rescue: the second-generation junk vocabulary is built ON it
  // ("beefy-harvest-wait", "harvest-run-budget-check"), and genuine harvest routes always carry a
  // money word of their own ("beefy-harvest-caller-fees").
  if (/(earning|fee|reward|bount|payout|sale|tip|grant|revenue|claim|skim|airdrop|refund|yield|interest|commission|bonus|x402|invoice)/i.test(id)) return null;
  // gig/job/task rescue only as whole tokens — "taskmarket-api-check" must not ride on "task".
  if (/(^|[-_])(gig|job|task)s?([-_]|$)/i.test(id)) return null;
  return `"${id}" is not an earning route — it is housekeeping. A route is a way MONEY CAN ARRIVE, and a budget/status/list/scan check can never pay you. Logging these polluted your ledger with ten dead pseudo-routes that then blocked your real ones. NOT LOGGED, and this costs you nothing. Just read the value you got and act on it. Only call route_log when you actually tried to GET PAID.`;
}

async function route_log({ route_id, outcome, earned_usd = 0, note = '' }) {
  // P0-2 FIX: 'deferred' = "could not run because a scarce resource was empty; retry later". The
  // old enum forced that honest case into 'blocked', whose counter set dead=true on the second
  // occurrence — three aliases of the only earning rail were killed by two relay-capacity events.
  if (!['success', 'fail', 'blocked', 'deferred', 'pending'].includes(outcome)) {
    throw new Error('outcome must be one of: success | fail | blocked | deferred | pending');
  }
  const db = readRoutes();
  const id = String(route_id).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 50);
  if ((CLOSED_CATEGORY.test.test(id) || CLOSED_CATEGORY.test.test(note)) && outcome !== 'success') {
    return { refused: true, route: id, logged: false, reason: CLOSED_CATEGORY.why };
  }
  const noise = notARoute(id);
  if (noise && !(outcome === 'success' && parseFloat(earned_usd) > 0)) {
    return { refused: true, route: id, logged: false, not_a_route: true, reason: noise };
  }
  // P1-5 FIX: an UNBACKED income claim must never enter earned_usd — it becomes the leaderboard
  // sort key and "lifetime earned" while being a guess ("send_tx said success" is not payment).
  // But REFUSING the whole log repeats the P2-12 mistake (no memory of the attempt). So: the
  // attempt is recorded, the claimed amount is parked in unbacked_usd until a hash proves it.
  const claimedUsd = parseFloat(earned_usd) || 0;
  const backed = !(claimedUsd > 0) || /0x[0-9a-fA-F]{64}/.test(String(note));
  const deadTwin = Object.entries(db.routes).find(([k, v]) => normId(k) === normId(id) && isDead(v, k));
  if ((isDead(db.routes[id], id) || deadTwin) && outcome !== 'success') {
    return {
      refused: true, route: id, logged: false,
      reason: 'DEAD ROUTE — permanently out of scope (human-gated, or blocked twice by real failures). This attempt was NOT logged and the rounds you spent on it were wasted. Never revisit or research this route again; work a LIVE route instead.',
    };
  }
  const r = db.routes[id] ||= { attempts: 0, successes: 0, blocked: 0, earned_usd: 0, notes: [] };
  r.attempts += 1;
  if (outcome === 'success') r.successes += 1;
  if (outcome === 'blocked') r.blocked += 1;
  if (note) { r.notes.push(clip(String(note), 200)); r.notes = r.notes.slice(-5); }
  // P0-2 FIX: only a PERMANENT gate kills a route. Capacity exhaustion is transient — it must not
  // increment the death counter, and historical capacity-noise blocks no longer set `dead`.
  if (outcome === 'deferred') {
    r.last = { at: new Date().toISOString(), outcome };
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(routesFile(), jstr(db));
    const leaderboard = Object.entries(db.routes).filter(([k, v]) => !isDead(v, k))
      .map(([k, v]) => ({ route: k, attempts: v.attempts, successes: v.successes, earned_usd: v.earned_usd }))
      .sort((a, b) => b.earned_usd - a.earned_usd).slice(0, 10);
    return { logged: id, outcome, deferred: true, live_routes_leaderboard: leaderboard };
  }
  r.last = { at: new Date().toISOString(), outcome };
  if (backed) r.earned_usd = +(r.earned_usd + claimedUsd).toFixed(6);
  else r.unbacked_usd = +((r.unbacked_usd || 0) + claimedUsd).toFixed(6);   // parked, never counted
  const joinedNotes = (r.notes || []).join(' ');
  if (HUMAN_GATE_RE.test(note)) r.dead = true;
  else if (r.blocked >= 2 && !CAPACITY_NOISE_RE.test(joinedNotes)) r.dead = true;
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(routesFile(), jstr(db));
  const leaderboard = Object.entries(db.routes).filter(([k, v]) => !isDead(v, k))
    .map(([k, v]) => ({ route: k, attempts: v.attempts, successes: v.successes, earned_usd: v.earned_usd }))
    .sort((a, b) => b.earned_usd - a.earned_usd).slice(0, 10);
  return {
    logged: id, outcome, dead: !!r.dead,
    unbacked_warning: backed ? undefined : `claimed $${claimedUsd} was NOT banked — earned_usd needs the tx hash + measured delta in the note ("success" from a tool is not payment). The attempt itself IS recorded.`,
    live_routes_leaderboard: leaderboard,
  };
}

async function harvest_scan({ limit = 10 } = {}) {
  return await harvestScan(localEnv(), rpcRaw, { limit: Number(limit) || 10 });
}
async function harvest_batch({ chain = 'base', max = 12 } = {}) {
  return await batchHarvest(localEnv(), rpcRaw, SMART_ACCOUNT, chain, { max: Number(max) || 12 });
}
async function harvest_run() {
  return await harvestRun(localEnv(), rpcRaw);
}
async function harvest_stats() {
  const env = localEnv();
  const s = (await env.KV.get('harvest:state', 'json')) || {};
  const w = loadWallet();
  let truth = null;
  try { truth = await reconcileEarnings(env, rpcRaw, w?.address, SMART_ACCOUNT); }
  catch (e) { truth = { error: String(e.message).slice(0, 140) }; }
  const { all: budgets } = await pickChain(SMART_ACCOUNT);
  const obs = await observeRelay(env, budgets.map(b => ({ name: b.name, remaining: b.remaining, limit: b.limit })));
  return {
    MEASURED_ON_CHAIN: truth,
    attempts: s.attempts || 0, wins: s.wins || 0,
    tracker_wei_earned: s.weiEarned || '0',
    tracker_caveat: 'lower bound only — use MEASURED_ON_CHAIN for any number you write down or report',
    relay: relayResetSummary(obs),
  };
}
async function inspect_contract({ chain, contract }) {
  return await inspectContract(chain, contract, SMART_ACCOUNT);
}
async function gas_sources({ chain = 'base' } = {}) {
  const w = loadWallet();
  return await gasSources(localEnv(), rpcRaw, { safe: SMART_ACCOUNT, eoa: w?.address, chain });
}
async function payout_history({ chain = 'base', contract, sample = 6 } = {}) {
  return await payoutHistory(async (url) => {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) zero-agent/0.1' } });
    return { status: r.status, text: await r.text() };
  }, { chain, contract, sample });
}
const feeToken = (chain) => HARVEST_CHAINS[chain]?.weth || HARVEST_CHAINS.base.weth;
async function discover_new_sources({ chain = 'arbitrum' } = {}) {
  return await discoveryPass(localEnv(), { chain, rpcRaw: (m, p) => rpcRaw(chain, m, p) });
}
async function discover_list() {
  return await loadDiscoverList(localEnv());
}
async function prospect_intel() {
  return await prospectIntel(localEnv());
}
async function gasless_scan({ chain = 'base', contract } = {}) {
  return await scanGasless(chain, contract, rpcRaw);
}
async function gasless_control({ chain = 'base' } = {}) {
  return await gaslessControl(chain, rpcRaw);
}
async function sponsor_discover({ chain = 'base' } = {}) {
  return {
    sponsors: await discoverSponsors(chain, { top: 6 }),
    note: 'Seeing a sponsor is NOT being able to use one. Next step is the admission test.',
  };
}
async function sponsor_control({ chain = 'base' } = {}) {
  return await sponsorControl(chain);
}
async function doc_search({ query, k = 4 } = {}) {
  if (!query || !String(query).trim()) return { error: 'give me something to search for' };
  return await docSearch(localEnv(), String(query), Math.min(Number(k) || 4, 8));
}
async function treasury() {
  const w = loadWallet();
  return await treasuryPlan(rpcRaw, w?.address, SMART_ACCOUNT);
}
async function payout_oracle({ chain = 'base', contract, token } = {}) {
  return await probeContract(rpcRaw, chain, contract, token || feeToken(chain));
}
async function bruteforce({ chain = 'base', contract, token } = {}) {
  return await bruteforceContract(rpcRaw, chain, contract, token || feeToken(chain));
}
async function experiment({ chain = 'base' } = {}) {
  return await experimentTick(localEnv(), rpcRaw, chain);
}

// ── schemas the model sees ──────────────────────────────────────────────────

const S = (props = {}, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });

export const TOOL_DEFS = [
  { name: 'ensure_wallet', description: 'Create your wallet if it does not exist yet (credentials are stored safely for you), or return your existing address. Call once at the start of your life.', parameters: S() },
  { name: 'get_status', description: 'Your situation: address, ETH + USDC balances and tx counts on every mainnet you harvest (Base, Optimism, Arbitrum, Polygon, Gnosis, Unichain), ETH/USD, and whether you are broke. Testnet is reachable via explorer/eth_call; it is not a holdings chain.', parameters: S() },
  { name: 'web_search', description: 'Search the web (DuckDuckGo). Returns up to 8 results with title, url, snippet. Use for discovering faucets, bounties, docs, opportunities.', parameters: S({ query: str('search query') }, ['query']) },
  { name: 'http_fetch', description: 'Fetch a URL (GET/POST/etc). HTML is converted to plain text unless raw=true. Many modern sites are JS apps and return little text — prefer their APIs or docs pages. Use for reading pages and calling public APIs.', parameters: S({ url: str('http(s) URL'), method: str('HTTP method, default GET'), headers: { type: 'object', description: 'request headers' }, body: str('request body for POST/PUT'), max_chars: { type: 'number', description: 'max chars returned, default 5000, cap 12000' }, raw: { type: 'boolean', description: 'true = do not strip HTML' } }, ['url']) },
  { name: 'explorer', description: "Blockscout explorer API (free, no key). chain: any of base, optimism, arbitrum, polygon, gnosis, unichain (and base-sepolia only for practice). api_path examples: 'addresses/{addr}', 'smart-contracts/{addr}' (verified source!), 'stats', 'transactions/{hash}'.", parameters: S({ chain: str('chain name'), api_path: str('path after /api/v2/') }, ['chain', 'api_path']) },
  { name: 'eth_call', description: "Read any contract, simulated AS YOUR WALLET by default (a call from a different sender proves nothing — pass 'from' only deliberately). Reverts come back as {reverted:true, reason}. signature is a human ABI fragment e.g. 'balanceOf(address) view returns (uint256)'. args as strings/numbers; value_eth for payable calls.", parameters: S({ chain: str("'base' | 'base-sepolia' | 'optimism' | 'arbitrum' | 'polygon' | 'gnosis' | 'unichain'"), to: str('contract address'), signature: str('function signature'), args: { type: 'array', description: 'function arguments', items: {} }, from: str('optional msg.sender override (defaults to YOUR wallet)'), value_eth: str('optional ETH value for payable calls') }, ['chain', 'to', 'signature']) },
  { name: 'send_tx', description: 'Sign and send a transaction from YOUR wallet. Fails with a clear error if you lack gas. Returns mined + paid_you + net_eth_change + tokens_received: "no-revert" is NOT payment — check paid_you before logging earnings. value_eth in ETH units, data optional hex calldata.', parameters: S({ chain: str("'base' | 'base-sepolia' | 'optimism' | 'arbitrum' | 'polygon' | 'gnosis' | 'unichain'"), to: str('recipient/contract address'), value_eth: str("ETH amount, e.g. '0.001', default '0'"), data: str('hex calldata, default 0x'), gas_limit: str('optional manual gas limit') }, ['chain', 'to']) },
  { name: 'sign_message', description: 'Sign a message with your wallet key (free, no gas). Needed for signature-auth flows (SIWE login, claim proofs, ownership verification).', parameters: S({ message: str('exact message text to sign') }, ['message']) },
  { name: 'knowledge_list', description: 'List your permanent knowledge files.', parameters: S() },
  { name: 'knowledge_read', description: 'Read one of your knowledge files (e.g. genesis, recovery, journal).', parameters: S({ name: str('file name without .md') }, ['name']) },
  { name: 'knowledge_write', description: "Write to permanent memory — this is the ONLY thing that survives between sessions. mode 'append' (default) or 'overwrite'. Keep 'journal' updated every session; update 'recovery' the moment an earning route is proven.", parameters: S({ name: str('file name without .md'), content: str('markdown content'), mode: str("'append' | 'overwrite'") }, ['name', 'content']) },
  { name: 'route_log', description: 'Record the outcome of an earning-route attempt in your permanent ledger. ALWAYS log after trying a route. outcome: success (earned something) | fail (tried, no payout) | blocked (PERMANENT gate: human/captcha/KYC — never retry) | deferred (could not run: no relay slot, rate limit, out of gas — retry later, costs the route nothing) | pending (awaiting result). earned_usd > 0 requires the tx hash + measured delta in the note.', parameters: S({ route_id: str('short stable id, e.g. chainlink-faucet-base-sepolia'), outcome: str('success | fail | blocked | deferred | pending'), earned_usd: { type: 'number', description: 'USD value earned this attempt (0 if none; estimate testnet as 0)' }, note: str('one-line lesson learned; REQUIRED with the tx hash when earned_usd > 0') }, ['route_id', 'outcome']) },
  { name: 'secret_store', description: 'Save a credential you earned (platform API key, auth token, receipt) in permanent secure storage OUTSIDE your knowledge files. NEVER put credentials in knowledge_write — use this. Refuses private keys.', parameters: S({ name: str('credential name, e.g. clawtasks-api-key'), value: str('the credential value') }, ['name', 'value']) },
  { name: 'secret_get', description: 'Retrieve a stored credential by name (e.g. to use in an http_fetch Authorization header).', parameters: S({ name: str('credential name') }, ['name']) },
  { name: 'secret_list', description: 'List names of your stored credentials (never shows values).', parameters: S() },
  { name: 'harvest_scan', description: 'YOUR BREAD AND BUTTER. Ranks Beefy strategies on Base by MEASURED PAYOUT — pays_wei is the actual wrapped-native balance change a harvest would move to us, simulated in one eth_call — then checks each is callable. Free, unlimited, costs no relay slot. Spend slots top-down on callable:true. If a row shows callReward_wei and ranking:"FALLBACK", the oracle was down and the order is untrustworthy: callReward() REVERTS on our eight best Aerodrome/CoW strategies, so they vanish from that ordering entirely.', parameters: S({ limit: { type: 'number', description: 'how many candidates to simulate, default 10' } }) },
  { name: 'harvest_batch', description: 'HARVEST THE WHOLE POOL IN ONE SLOT. A relay slot carries a transaction, and a transaction can DELEGATECALL MultiSend with a couple dozen harvests inside it — measured: 26 batched harvests simulate clean. So 5 slots/day was never 5 harvests/day. Every candidate is individually simulated first because MultiSend is all-or-nothing. Prefer this over harvest_run.', parameters: S({ chain: str('chain name'), max: { type: 'number', description: 'max harvests per batch, default 12' } }) },
  { name: 'harvest_run', description: 'Fire a harvest BATCH now (walks every chain, batches all paying strategies into one relay slot). NOTE: this exact pass already runs AUTOMATICALLY every 2 minutes — calling it almost never adds anything. Your rounds are worth more on discovery.', parameters: S() },
  { name: 'harvest_stats', description: 'Your lifetime harvest record. MEASURED_ON_CHAIN is the truth (real WETH at both your addresses, plus how much is spendable vs stranded); the tracker figure is a lower bound. Also returns the live relay budget and everything actually measured about when it refills.', parameters: S() },
  { name: 'inspect_contract', description: "Read a contract's verified source and report whether it is access-controlled, whether it pays a caller, and which non-view functions look like paid maintenance work. Free — use it before ever spending a relay slot.", parameters: S({ chain: str('chain name'), contract: str('0x address') }, ['chain', 'contract']) },
  { name: 'gas_sources', description: 'EVERY WAY YOU CAN GET A TRANSACTION ON-CHAIN, tested live: Safe relay quota across 18 chain ids, native ETH you own, every ERC-4337 paymaster (admission-tested by calling validatePaymasterUserOp AS the EntryPoint — the decisive test, not transaction shape), and keyless sponsorship APIs. It distinguishes an AUTH wall (needs a key, stop probing) from a TECHNICAL one (public policies exist, keep varying the op). Ask this instead of assuming the relay; capacity has repeatedly turned up in places nobody had probed.', parameters: S({ chain: str('chain name') }) },
  { name: 'payout_history', description: "MANDATORY BEFORE THE FIRST RELAY SLOT ON ANY NEW CONTRACT. Reads a contract's real history and reports whether callers have ACTUALLY been paid: 'PAYS_CALLERS' with the real settled amounts, 'PAYS_ZERO' (callers got nothing — never spend a slot), or 'NO_EVIDENCE'. A failed explorer read is an error, never PAYS_ZERO. Free, costs no slot. A reward getter like callReward()/maxRewards() is a CAP and has twice fooled you ($615 read → $0.0001 paid; $63 read → $0.00 paid). Trust this, not a getter.", parameters: S({ chain: str("'base' | 'optimism' | 'arbitrum'"), contract: str('0x contract address'), sample: { type: 'number', description: 'how many past calls to decode, default 6' } }, ['contract']) },
  { name: 'discover_new_sources', description: "THE GROWTH TOOL. Harvest crumbs are accrual-capped at cents/day — the only way past that is MORE INDEPENDENT INCOME FAMILIES. This finds them empirically: it walks the inbound payments of known keeper wallets back to the contracts paying them, so every candidate is backed by a payout that really happened. Works on all six chains — gnosis and unichain have IDLE free slots waiting for their first payer, so a payer found there is worth double. Also rotates automatically on the cron; call it to push a specific chain faster.", parameters: S({ chain: str("'base' | 'optimism' | 'arbitrum' | 'gnosis' | 'unichain' | 'polygon'") }) },
  { name: 'discover_list', description: 'Your accumulated candidate list from discovery: contracts seen paying callers, whether their source shows access control, and which functions an arbitrary caller might invoke. Untried + promising first.', parameters: S() },
  { name: 'prospect_intel', description: 'What the automatic prospector has ground out while you were asleep: how much of the candidate backlog is triaged, which contracts are PROVEN to pay callers and callable by you (your ready-to-stack queue), which are eliminated forever, and — most valuable — the PATTERN layer: which contract FAMILIES pay and which never do, so you can generalise to instances you have never tested. Read this before hunting; it is free and it is already done.', parameters: S() },
  { name: 'gasless_scan', description: "Read a contract's RUNTIME BYTECODE and report which gasless rails it exposes (ERC-2771 meta-tx, native executeMetaTransaction, EIP-3009 transferWithAuthorization, EIP-2612 permit, ERC-4337 paymaster, or a settable persistent fee recipient). Works on UNVERIFIED contracts — every external selector is in the dispatch table. One free call. Use it to find ways onto the chain that do NOT consume a Safe relay slot.", parameters: S({ chain: str("'base' | 'optimism' | 'arbitrum'"), contract: str('0x contract address') }, ['contract']) },
  { name: 'gasless_control', description: 'THE CONTROL for gasless_scan. The Safe singleton you transact through and the live v0.7 EntryPoint must both expose their rails, or every "no rail" verdict is suspect.', parameters: S({ chain: str("'base' | 'optimism' | 'arbitrum'") }) },
  { name: 'sponsor_discover', description: 'Enumerate the gas SPONSORS operating on a chain — every entity that pays for other people\'s transactions — found by on-chain behaviour, not by name, so it includes sponsors with no website and no docs. Your Safe relay is ONE of these with a 5/day cap; this finds the rest of the species. Measured: 44% of recent ERC-4337 ops on Base had their gas paid by a third party.', parameters: S({ chain: str("'base' | 'optimism' | 'arbitrum'") }) },
  { name: 'sponsor_control', description: 'THE CONTROL EXPERIMENT. Feeds the sponsor-detector the two addresses that provably paid for your own first transactions and checks it rediscovers them from behaviour alone. An instrument that cannot reproduce a known result is not measuring anything — run this before you believe any novel sponsor it reports.', parameters: S({ chain: str("'base' | 'optimism' | 'arbitrum'") }) },
  { name: 'doc_search', description: 'SEARCH YOUR REFERENCE LIBRARY BEFORE YOU GUESS. Operational docs for every system you touch — Safe relay and MultiSend packing, CCTP domains and depositForBurn, Uniswap SwapRouter02 tuple shapes and the WETH9 2300-gas trap, ERC-4337 EntryPoint structs and paymaster admission, Blockscout paths, JSON-RPC state overrides, EIP-1967 slots. Exact signatures, selectors, per-chain addresses and the documented gotchas. FREE, unlimited, costs no relay slot — there is never a reason not to check. Search a function name, a bare 0x address, or a plain question. ⚠️ A doc is a HYPOTHESIS: confirm anything load-bearing with a free eth_call before you spend a scarce slot on it.', parameters: S({ query: str('function name, contract address, or plain question'), k: { type: 'number', description: 'how many passages, default 4' } }, ['query']) },
  { name: 'treasury', description: 'Where your money sits across every chain, and what should move. Harvest everywhere (free slots are per-chain and expire), but CONSOLIDATE into the home chain — value spread thin across five chains cannot act, which is the same trap as stranded WETH. Tells you which tributaries have accumulated enough to be worth a bridge fee.', parameters: S() },
  { name: 'payout_oracle', description: 'MEASURE WHAT A FUNCTION WOULD PAY YOU, BEFORE SPENDING ANYTHING. Simulates the settlement itself through Multicall3 and returns the exact fee an arbitrary caller would receive right now. Free, no relay slot, no capital, works on UNVERIFIED contracts and on contracts nobody has ever called. payout_history reads the past; this prices the present. Measured spread across known payers was 118x, so ALWAYS probe before choosing which one to spend a slot on.', parameters: S({ chain: str('chain name'), contract: str('0x contract address'), token: str('optional fee token, defaults to the chain wrapped native') }, ['contract']) },
  { name: 'bruteforce', description: 'TEST EVERY FUNCTION A CONTRACT HAS. Recovers the complete external interface straight from the runtime bytecode dispatch table (every PUSH4 selector) — no ABI, no source, no explorer, works on unverified and unnamed contracts — then prices ALL of them through Multicall3 and reports whichever move value to an arbitrary caller. This does not guess at function names; it reads what the contract actually exposes. Free and unlimited. Use it on anything you cannot otherwise understand.', parameters: S({ chain: str('chain name'), contract: str('0x contract address'), token: str('optional fee token') }, ['contract']) },
  { name: 'experiment', description: 'RUN AN EXPERIMENT. Probes a mechanism class we do not yet know pays — currently Uniswap-V2 skim dust (pairs holding priced tokens above their cached reserves, claimable by skim(to) with zero capital) and abandonment (contracts that used to pay callers, went silent, and still hold a balance). Free, spends no relay slot, and every result including the negatives is logged so the search converges instead of wandering. This runs automatically on cron; call it to push it faster.', parameters: S({ chain: str('chain name') }) },
].map(f => ({ type: 'function', function: f }));

export const TOOL_IMPL = {
  ensure_wallet, get_status, web_search, http_fetch, explorer,
  eth_call, send_tx, sign_message,
  knowledge_list, knowledge_read, knowledge_write, route_log,
  secret_store, secret_get, secret_list,
  harvest_scan, harvest_batch, harvest_run, harvest_stats,
  inspect_contract, gas_sources, payout_history,
  discover_new_sources, discover_list, prospect_intel,
  gasless_scan, gasless_control, sponsor_discover, sponsor_control,
  doc_search, treasury, payout_oracle, bruteforce, experiment,
};
