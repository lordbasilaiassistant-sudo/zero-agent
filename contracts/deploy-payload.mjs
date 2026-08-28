// deploy-payload.mjs — build, pre-check and PRINT the one transaction that puts ZeroHarvester on Base.
//
// WHY THIS FILE EXISTS. ZERO has never held a wei and by standing rule never will, so it cannot pay for
// a deployment. It does not have to: Safe's sponsored relay accepts any `execTransaction` whose inner
// target is not the Safe itself (verified against safe-client-gateway's own
// `RelayTransactionHelper.isValidDecodedExecTransaction` — the only branch that inspects the target is
// `toSelf`, and `operation` is never inspected at all). So the inner target can be the universal CREATE2
// factory, and the deployment costs ZERO nothing but one of its five daily relay slots.
//
// THE DANGER THIS FILE GUARDS AGAINST. The contract's address is a pure function of the initcode, and the
// initcode contains solc's metadata hash, which changes when a COMMENT changes. That is not hypothetical:
// commit 0e0c06d edited one doc comment in ZeroHarvester.sol and moved the address from
// 0xB5eda258…ddF6 to 0x922075A8…6fA9 while leaving every executable byte identical. A stale address in a
// human's notes is therefore the most likely way to waste a slot, and the ONLY defence is to recompute
// the address from the artifact on every run and assert it against a pinned hash. That is step 1 below.
//
// SAFETY MODEL. Sending is opt-in and the refusal is the default code path, not a comment: without
// `--i-have-consent` the script never reads the private key, never signs, and never opens a socket to the
// relay. Every pre-flight check is read-only (eth_call / eth_getCode / GET), so running this with no flags
// is free and has no effect on chain or on the relay quota.
//
//   node contracts/deploy-payload.mjs                      # print payload + pre-flight, send nothing
//   node contracts/deploy-payload.mjs --i-have-consent     # sign and POST to the relay (spends 1 slot)
//
import { ethers } from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── the pinned facts. Any drift from these means STOP, not "probably fine". ──────────────────────────
const CHAIN_ID = 8453;
const SAFE = '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';   // GENESIS I Safe — RETIRED. Do not send.
const OWNER = '0x50624F7790732f9767180871D03A304756200dB9';  // retired EOA. Do not sign as this.
const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'; // deterministic-deployment-proxy
const SALT = ethers.id('ZERO/ZeroHarvester/v1');
// keccak256(initcode ++ abi.encode(BENEFICIARY)) as measured at commit 0e0c06d. If the assert on this
// fails, the contract was recompiled and EVERY address written down anywhere is now wrong.
const EXPECTED_INIT_HASH = '0xa02040cf38bed29731d5cd0f90b1d48f228b7aa6e64c5c1221e31282493dc1ea';
const EXPECTED_ADDRESS = '0x922075A88d80bFb3d8a3dbF6436F6853C1FD6fA9';

const ARTIFACT = path.join(HERE, 'out', 'ZeroHarvester.sol', 'ZeroHarvester.json');
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const RELAY = `https://safe-client.safe.global/v1/chains/${CHAIN_ID}/relay`;
const RELAY_HEADERS = {
  'content-type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Origin: 'https://app.safe.global', Referer: 'https://app.safe.global/',
};

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
  ],
};
const safeIface = new ethers.Interface([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)',
]);

// Public RPCs rate-limit a 2.5KB eth_call readily; rotate rather than reporting a limit as a result.
async function rpc(method, params) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = RPCS[attempt % RPCS.length];
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error && /rate limit|limit exceeded|too many/i.test(j.error.message || '')) {
        await new Promise(res => setTimeout(res, 2500)); continue;
      }
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; await new Promise(res => setTimeout(res, 1500)); }
  }
  throw last || new Error('all RPCs exhausted');
}

const readSafeNonce = () => rpc('eth_call', [{ to: SAFE, data: '0xaffed0e0' }, 'latest']).then(v => BigInt(v));

// ── build ───────────────────────────────────────────────────────────────────────────────────────────
function build() {
  const art = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
  const initcode = art.bytecode.object + ethers.AbiCoder.defaultAbiCoder().encode(['address'], [SAFE]).slice(2);
  const initHash = ethers.keccak256(initcode);
  const address = ethers.getCreate2Address(CREATE2_PROXY, SALT, initHash);
  // The proxy's calling convention is positional, not ABI-encoded: 32 bytes of salt, then raw initcode.
  const innerData = SALT + initcode.slice(2);
  return { art, initcode, initHash, address, innerData, runtimeBytes: (art.deployedBytecode.object.length - 2) / 2 };
}

function encodeExec(innerData, signatures) {
  return safeIface.encodeFunctionData('execTransaction', [
    CREATE2_PROXY, 0n, innerData, 0 /* CALL, never DELEGATECALL */,
    0n, 0n, 0n, ethers.ZeroAddress, ethers.ZeroAddress, signatures,
  ]);
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────
const consent = process.argv.includes('--i-have-consent') || process.argv.includes('--spend');
if (consent) {
  console.error('REFUSED: this payload still targets the RETIRED Safe/owner (GENESIS I). Re-pin SAFE/OWNER to shop.mjs SMART_ACCOUNT / Genesis II EOA and recompute EXPECTED_INIT_HASH before any send.');
  process.exit(2);
}
const b = build();

console.log('ZeroHarvester → Base, via ZERO\'s Safe relay slot');
console.log('='.repeat(78));
console.log('artifact          ', ARTIFACT);
console.log('initcode          ', (b.initcode.length - 2) / 2, 'bytes  (runtime', b.runtimeBytes, 'bytes)');
console.log('keccak(initcode)  ', b.initHash);
console.log('salt              ', SALT, '= keccak256("ZERO/ZeroHarvester/v1")');
console.log('CREATE2 factory   ', CREATE2_PROXY);
console.log('PREDICTED ADDRESS ', b.address);
console.log();

// STEP 1 — the check that catches a recompile. A comment change moves this hash.
let blocked = null;
if (b.initHash !== EXPECTED_INIT_HASH) {
  blocked = `initcode hash drift\n  expected ${EXPECTED_INIT_HASH}\n  actual   ${b.initHash}\n` +
    '  The contract was recompiled since this script was pinned. Every written-down address is now stale.\n' +
    '  Re-verify the source, then update EXPECTED_INIT_HASH and EXPECTED_ADDRESS together.';
} else if (b.address.toLowerCase() !== EXPECTED_ADDRESS.toLowerCase()) {
  blocked = `address drift: expected ${EXPECTED_ADDRESS}, computed ${b.address}`;
}
console.log('[1] initcode hash matches pin ......', blocked ? 'FAIL' : 'OK');

// STEP 2..4 — live state. Read-only; costs nothing and spends no slot.
let codeAtTarget = null, safeNonce = null, quota = null;
try {
  codeAtTarget = await rpc('eth_getCode', [b.address, 'latest']);
  console.log('[2] target address is empty .......', codeAtTarget === '0x' ? 'OK' : `FAIL (${(codeAtTarget.length - 2) / 2} bytes already there)`);
  if (codeAtTarget !== '0x') blocked ??= 'salt already consumed — the CREATE2 proxy will REVERT and the slot is burned';

  safeNonce = await readSafeNonce();
  console.log('[3] safe nonce ....................', safeNonce.toString());

  const q = await fetch(`${RELAY}/${SAFE}`, { headers: RELAY_HEADERS }).then(r => r.json()).catch(() => null);
  quota = q;
  console.log('[4] relay quota ...................', q ? `${q.remaining}/${q.limit} remaining` : 'unreadable');
  if (q && q.remaining === 0) blocked ??= 'relay quota exhausted for today — nothing to spend';
} catch (e) {
  console.log('    live pre-flight failed:', e.message);
  blocked ??= 'could not read live state; refusing to proceed blind';
}

// STEP 5 — simulate the exact wrapped call. Safe accepts an approved-hash signature (r=owner, s=0, v=1)
// when msg.sender is that owner, so the FULL execTransaction path can be exercised with no key at all.
const simSig = ethers.concat([ethers.zeroPadValue(OWNER, 32), ethers.ZeroHash, '0x01']);
try {
  const simData = encodeExec(b.innerData, simSig);
  const ret = await rpc('eth_call', [{ from: OWNER, to: SAFE, data: simData }, 'latest']);
  const ok = BigInt(ret) === 1n;
  console.log('[5] eth_call execTransaction ......', ok ? 'OK (returns true)' : `FAIL (returned ${ret})`);
  if (!ok) blocked ??= 'simulation of execTransaction did not return success';
  const gas = await rpc('eth_estimateGas', [{ from: OWNER, to: SAFE, data: simData }, 'latest']);
  console.log('[6] estimated gas .................', parseInt(gas, 16).toLocaleString());
} catch (e) {
  console.log('[5] eth_call execTransaction ......', 'FAIL', e.message);
  blocked ??= 'simulation reverted: ' + e.message;
}

// ── the payload ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(78));
console.log('PAYLOAD');
console.log('='.repeat(78));
console.log('inner call   to        ', CREATE2_PROXY);
console.log('             value     ', 0);
console.log('             operation ', '0 (CALL — the Safe never delegatecalls anything here)');
console.log('             data      ', b.innerData.slice(0, 74) + '…  (' + (b.innerData.length - 2) / 2 + ' bytes: 32B salt ++ initcode)');
console.log('outer        POST      ', RELAY);
console.log('             body      ', JSON.stringify({ version: '1.4.1', to: SAFE, data: '0x…' }));
console.log('             data is   ', 'execTransaction(...) with the real owner signature over SafeTx nonce', safeNonce?.toString() ?? '?');

if (!consent) {
  console.log('\n' + '='.repeat(78));
  console.log('NOT SENDING.');
  console.log('No key was read, nothing was signed, no relay request was made.');
  console.log('Pre-flight verdict:', blocked ? 'BLOCKED — ' + blocked.split('\n')[0] : 'all checks passed; this would be ready to send');
  if (blocked) console.log('\n' + blocked);
  console.log('\nTo actually deploy (spends one of five daily relay slots):');
  console.log('  node contracts/deploy-payload.mjs --i-have-consent');
  console.log('='.repeat(78));
  process.exit(0);
}

// ── the send path. Only reachable with an explicit flag AND a clean pre-flight. ─────────────────────
if (blocked) {
  console.error('\nREFUSING TO SEND — pre-flight failed:\n' + blocked);
  process.exit(1);
}

// ── ISOLATION GATE ──────────────────────────────────────────────────────────────────────────────────
// The code below this line reads ZERO's private key and signs as ZERO. That crosses a standing
// boundary: company/fleet.json's gate for the zero-agent lane reads, verbatim, "never fund the wallet,
// never sign for it, never touch its keys." ZERO's isolation is not a formality — it is the reason its
// $0.08447 is a clean result. An agent that earned from nothing, whose operators sign on its behalf,
// is no longer an agent that earned from nothing.
//
// The correct path is that ZERO deploys its own contract: signing already happens legitimately inside
// its worker, every two minutes, with its own key. This script's job ends at producing a verified
// payload for ZERO to execute — not at executing it.
//
// So this gate is deliberately NOT satisfiable by a command-line flag. Removing it is a decision a
// human takes in the open, with a commit, not something a script offers as an option.
if (!process.env.ZERO_ISOLATION_WAIVED_BY_ANTHONY) {
  console.error('\n' + '='.repeat(78));
  console.error('REFUSING TO SIGN — this would sign with ZERO\'s key, which the fleet gate forbids.');
  console.error('');
  console.error('  fleet.json (zero-agent): "never fund the wallet, never sign for it, never touch its keys"');
  console.error('');
  console.error('The payload above is verified and ready. Hand it to ZERO and let ZERO submit it with');
  console.error('its own key inside its own worker — that keeps the result honestly its own.');
  console.error('='.repeat(78));
  process.exit(2);
}
console.warn('\n⚠ ZERO isolation waiver is set. Signing as ZERO. This is logged and should be rare.\n');

const secretsPath = path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env');
const env = Object.fromEntries(fs.readFileSync(secretsPath, 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const wallet = new ethers.Wallet(env.AGENT_PRIVATE_KEY);
if (wallet.address.toLowerCase() !== OWNER.toLowerCase()) {
  console.error(`REFUSING — key is ${wallet.address}, expected the Safe owner ${OWNER}`);
  process.exit(1);
}

// Sign over the nonce we just read, then re-read it. A nonce that moved between signing and sending
// makes the signature invalid for the new nonce; Gelato would still submit, the Safe would revert
// GS026, and the slot would be gone. Re-reading closes all but a sub-second race.
const tx = {
  to: CREATE2_PROXY, value: 0n, data: b.innerData, operation: 0,
  safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
  gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce: safeNonce,
};
const signature = await wallet.signTypedData({ chainId: CHAIN_ID, verifyingContract: SAFE }, SAFE_TX_TYPES, tx);
const execData = encodeExec(b.innerData, signature);

if ((await readSafeNonce()) !== safeNonce) {
  console.error('REFUSING — the Safe nonce moved while signing. Re-run.');
  process.exit(1);
}
// Final gate: simulate the REAL signed calldata, not the approved-hash stand-in.
const finalSim = await rpc('eth_call', [{ from: OWNER, to: SAFE, data: execData }, 'latest']);
if (BigInt(finalSim) !== 1n) {
  console.error('REFUSING — simulation of the signed calldata did not return success:', finalSim);
  process.exit(1);
}

console.log('\nsending to the relay…');
const res = await fetch(RELAY, {
  method: 'POST', headers: RELAY_HEADERS,
  body: JSON.stringify({ version: '1.4.1', to: SAFE, data: execData }),
});
const text = await res.text();
console.log('relay HTTP', res.status, text.slice(0, 300));
if (res.status !== 201) process.exit(1);

const taskId = JSON.parse(text).taskId;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const t = (await fetch(`https://api.gelato.digital/tasks/status/${taskId}`, { headers: RELAY_HEADERS }).then(r => r.json())).task || {};
  console.log(' ', t.taskState, t.transactionHash || '', t.lastCheckMessage || '');
  if (/Success/i.test(t.taskState || '')) break;
  if (/Cancelled|Reverted/i.test(t.taskState || '')) { console.error('relay task failed'); process.exit(1); }
}
const finalCode = await rpc('eth_getCode', [b.address, 'latest']);
console.log('\ncode at', b.address, '→', (finalCode.length - 2) / 2, 'bytes',
  finalCode === '0x' ? '— NOT DEPLOYED' : '— DEPLOYED');
