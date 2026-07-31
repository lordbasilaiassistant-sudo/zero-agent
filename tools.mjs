// tools.mjs — ZERO's hands: wallet, chain, web, memory.
// The private key NEVER enters model context; signing tools use it internally.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

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
  const out = { wallet: w ? w.address : null, chains: {} };
  if (!w) { out.note = 'no wallet yet — call ensure_wallet first'; return out; }
  for (const [name, c] of Object.entries(CHAINS)) {
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
  out.broke = Object.values(out.chains).every(c => !c.eth || parseFloat(c.eth) === 0);
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
  return { status: r.status, data: clip(r.text, 6000) };
}

async function eth_call({ chain, to, signature, args = [] }) {
  const sig = signature.trim().startsWith('function') ? signature.trim() : `function ${signature.trim()}`;
  const iface = new ethers.Interface([sig]);
  const fn = iface.fragments[0];
  const data = iface.encodeFunctionData(fn.name, args);
  const ret = await provider(chain).call({ to, data });
  let decoded;
  try { decoded = JSON.parse(jstr([...iface.decodeFunctionResult(fn.name, ret)])); }
  catch { decoded = ret; }
  return { result: decoded };
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
    gas = gas_limit ? BigInt(gas_limit) : await p.estimateGas({ ...tx, from: w.address });
  } catch (e) {
    throw new Error(`gas estimate failed (tx would revert, or zero balance): ${String(e.shortMessage || e.message).slice(0, 300)}`);
  }
  const fee = await p.getFeeData();
  const cost = value + gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
  if (bal < cost) {
    throw new Error(`insufficient funds on ${chain}: balance ${ethers.formatEther(bal)} ETH, need ~${ethers.formatEther(cost)} ETH. You are broke here — earn gas first.`);
  }
  const sent = await signer.sendTransaction({ ...tx, gasLimit: gas });
  const rcpt = await sent.wait(1, 90000).catch(() => null);
  return {
    hash: sent.hash,
    status: rcpt ? (rcpt.status === 1 ? 'success' : 'REVERTED') : 'sent, not confirmed within 90s — check explorer',
    gas_used: rcpt ? rcpt.gasUsed.toString() : null,
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
  return { name: path.basename(p), content: clip(fs.readFileSync(p, 'utf8'), 20000) };
}

async function knowledge_write({ name, content, mode = 'append' }) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('content required');
  fs.mkdirSync(KNOWLEDGE, { recursive: true });
  const p = kpath(name);
  if (mode === 'overwrite') fs.writeFileSync(p, content.slice(0, 100000));
  else fs.appendFileSync(p, (fs.existsSync(p) ? '\n\n' : '') + content.slice(0, 100000));
  return { saved: path.basename(p), mode, bytes: fs.statSync(p).size };
}

const CREDS = process.env.AUTOGLM_CREDS || path.join(path.dirname(SECRETS), 'autoglmwallet-creds.json');

function readCreds() {
  try { return JSON.parse(fs.readFileSync(CREDS, 'utf8')); } catch { return {}; }
}

async function secret_store({ name, value }) {
  if (!name || typeof value !== 'string' || !value.trim()) throw new Error('name and value required');
  const key = String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
  if (/^0x[0-9a-fA-F]{64}$/.test(value.trim())) throw new Error('that looks like a private key — never store or handle raw private keys');
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
  if (r.earned_usd > 0 && r.dead !== true) return false;
  if (r.dead === true || r.blocked >= 2) return true;
  if (HUMAN_GATE_RE.test((r.notes || []).join(' '))) return true;
  if (id && CLOSED_CATEGORY.test.test(id)) return true;
  return false;
}
const normId = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');

// Mirrors worker.mjs — a ROUTE is a way MONEY CAN ARRIVE. Budget/status/list/scan checks are
// housekeeping; logging them polluted the ledger with ten dead pseudo-routes that then blocked real work.
const NON_ROUTE_RE = /(^|[-_])(budget|status|api|list|scan|health|ping|state|balance|check|exploration|research|browsing|registration|monitor\w*|wait\w*|watch\w*|investigat\w*|observ\w*|tooling|refill|slot\w*|crisis|session\w*|discover\w*|opportunit\w*|candidate\w*|demand)([-_]?check)?([-_]|$)/i;
export function notARoute(id) {
  if (!NON_ROUTE_RE.test(id)) return null;
  // "bount" not "bounty": the agent writes "bounties", which /bounty/ does not match.
  if (/(earning|fee|reward|bount|payout|sale|tip|grant|revenue)/i.test(id)) return null;
  // gig/job/task rescue only as whole tokens — "taskmarket-api-check" must not ride on "task".
  if (/(^|[-_])(gig|job|task)s?([-_]|$)/i.test(id)) return null;
  return `"${id}" is not an earning route — it is housekeeping. A route is a way MONEY CAN ARRIVE, and a budget/status/list/scan check can never pay you. Logging these polluted your ledger with ten dead pseudo-routes that then blocked your real ones. NOT LOGGED, and this costs you nothing. Just read the value you got and act on it. Only call route_log when you actually tried to GET PAID.`;
}

async function route_log({ route_id, outcome, earned_usd = 0, note = '' }) {
  if (!['success', 'fail', 'blocked', 'pending'].includes(outcome)) {
    throw new Error('outcome must be one of: success | fail | blocked | pending');
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
  const deadTwin = Object.entries(db.routes).find(([k, v]) => normId(k) === normId(id) && isDead(v, k));
  if ((isDead(db.routes[id], id) || deadTwin) && outcome !== 'success') {
    return {
      refused: true, route: id, logged: false,
      reason: 'DEAD ROUTE — permanently out of scope (human-gated, or blocked twice). This attempt was NOT logged and the rounds you spent on it were wasted. Never revisit or research this route again; work a LIVE route instead.',
    };
  }
  const r = db.routes[id] ||= { attempts: 0, successes: 0, blocked: 0, earned_usd: 0, notes: [] };
  r.attempts += 1;
  if (outcome === 'success') r.successes += 1;
  if (outcome === 'blocked') r.blocked += 1;
  r.earned_usd = +(r.earned_usd + (parseFloat(earned_usd) || 0)).toFixed(6);
  r.last = { at: new Date().toISOString(), outcome };
  if (note) { r.notes.push(clip(String(note), 200)); r.notes = r.notes.slice(-5); }
  if (/HUMAN-GATED|captcha|social login|KYC/i.test(note) || r.blocked >= 2) r.dead = true;
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(routesFile(), jstr(db));
  const leaderboard = Object.entries(db.routes).filter(([k, v]) => !isDead(v, k))
    .map(([k, v]) => ({ route: k, attempts: v.attempts, successes: v.successes, earned_usd: v.earned_usd }))
    .sort((a, b) => b.earned_usd - a.earned_usd).slice(0, 10);
  return { logged: id, outcome, dead: !!r.dead, live_routes_leaderboard: leaderboard };
}

// ── schemas the model sees ──────────────────────────────────────────────────

const S = (props = {}, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });

export const TOOL_DEFS = [
  { name: 'ensure_wallet', description: 'Create your wallet if it does not exist yet (credentials are stored safely for you), or return your existing address. Call once at the start of your life.', parameters: S() },
  { name: 'get_status', description: 'Your current situation: address, ETH balance + tx count on Base mainnet and Base Sepolia, ERC-20 token balances on Base, ETH/USD price, and whether you are broke.', parameters: S() },
  { name: 'web_search', description: 'Search the web (DuckDuckGo). Returns up to 8 results with title, url, snippet. Use for discovering faucets, bounties, docs, opportunities.', parameters: S({ query: str('search query') }, ['query']) },
  { name: 'http_fetch', description: 'Fetch a URL (GET/POST/etc). HTML is converted to plain text unless raw=true. Many modern sites are JS apps and return little text — prefer their APIs or docs pages. Use for reading pages and calling public APIs.', parameters: S({ url: str('http(s) URL'), method: str('HTTP method, default GET'), headers: { type: 'object', description: 'request headers' }, body: str('request body for POST/PUT'), max_chars: { type: 'number', description: 'max chars returned, default 5000, cap 12000' }, raw: { type: 'boolean', description: 'true = do not strip HTML' } }, ['url']) },
  { name: 'explorer', description: "Blockscout explorer API (free, no key). chain: 'base' or 'base-sepolia'. api_path examples: 'addresses/{addr}', 'addresses/{addr}/transactions', 'smart-contracts/{addr}' (verified source code!), 'tokens/{addr}', 'stats', 'transactions/{hash}'.", parameters: S({ chain: str("'base' | 'base-sepolia'"), api_path: str('path after /api/v2/') }, ['chain', 'api_path']) },
  { name: 'eth_call', description: "Read any contract directly. signature is a human ABI fragment, e.g. 'balanceOf(address) view returns (uint256)' or 'symbol() view returns (string)'. args are the arguments as strings/numbers.", parameters: S({ chain: str("'base' | 'base-sepolia'"), to: str('contract address'), signature: str('function signature'), args: { type: 'array', description: 'function arguments', items: {} } }, ['chain', 'to', 'signature']) },
  { name: 'send_tx', description: 'Sign and send a transaction from YOUR wallet. Fails with a clear error if you lack gas. value_eth in ETH units, data optional hex calldata. Costs real gas on base — be sure before spending.', parameters: S({ chain: str("'base' | 'base-sepolia'"), to: str('recipient/contract address'), value_eth: str("ETH amount, e.g. '0.001', default '0'"), data: str('hex calldata, default 0x'), gas_limit: str('optional manual gas limit') }, ['chain', 'to']) },
  { name: 'sign_message', description: 'Sign a message with your wallet key (free, no gas). Needed for signature-auth flows (SIWE login, claim proofs, ownership verification).', parameters: S({ message: str('exact message text to sign') }, ['message']) },
  { name: 'knowledge_list', description: 'List your permanent knowledge files.', parameters: S() },
  { name: 'knowledge_read', description: 'Read one of your knowledge files (e.g. genesis, recovery, journal).', parameters: S({ name: str('file name without .md') }, ['name']) },
  { name: 'knowledge_write', description: "Write to permanent memory — this is the ONLY thing that survives between sessions. mode 'append' (default) or 'overwrite'. Keep 'journal' updated every session; update 'recovery' the moment an earning route is proven.", parameters: S({ name: str('file name without .md'), content: str('markdown content'), mode: str("'append' | 'overwrite'") }, ['name', 'content']) },
  { name: 'route_log', description: 'Record the outcome of an earning-route attempt in your permanent ledger. ALWAYS log after trying a route. outcome: success (earned something) | fail (tried, no payout) | blocked (needs human/account/captcha — do not retry) | pending (awaiting result).', parameters: S({ route_id: str('short stable id, e.g. chainlink-faucet-base-sepolia'), outcome: str('success | fail | blocked | pending'), earned_usd: { type: 'number', description: 'USD value earned this attempt (0 if none; estimate testnet as 0)' }, note: str('one-line lesson learned') }, ['route_id', 'outcome']) },
  { name: 'secret_store', description: 'Save a credential you earned (platform API key, auth token, receipt) in permanent secure storage OUTSIDE your knowledge files. NEVER put credentials in knowledge_write — use this. Refuses private keys.', parameters: S({ name: str('credential name, e.g. clawtasks-api-key'), value: str('the credential value') }, ['name', 'value']) },
  { name: 'secret_get', description: 'Retrieve a stored credential by name (e.g. to use in an http_fetch Authorization header).', parameters: S({ name: str('credential name') }, ['name']) },
  { name: 'secret_list', description: 'List names of your stored credentials (never shows values).', parameters: S() },
].map(f => ({ type: 'function', function: f }));

export const TOOL_IMPL = {
  ensure_wallet, get_status, web_search, http_fetch, explorer,
  eth_call, send_tx, sign_message,
  knowledge_list, knowledge_read, knowledge_write, route_log,
  secret_store, secret_get, secret_list,
};
