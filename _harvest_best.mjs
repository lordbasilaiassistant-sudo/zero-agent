import { ethers } from 'ethers';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), '.claude', 'secrets', 'autoglmwallet.env'), 'utf8')
  .split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const wallet = new ethers.Wallet(env.AGENT_PRIVATE_KEY);
const CHAIN = 8453, SAFE = '0xf1597C629BB438ED4576a171ae8e05D770c05396';
const ZERO_EOA = '0x50624F7790732f9767180871D03A304756200dB9';
const WETH = '0x4200000000000000000000000000000000000006';
const p = new ethers.JsonRpcProvider('https://base-rpc.publicnode.com');

const cands = ['0x8B45D51e015Dac924EeAEa754e6f768943206F05','0x9D15Bae40d2C127C6C69D2D61e0a0fBd0Fc86eAd','0xf6f229adFc7B5119C50913b8265A418E8c6c0C77','0x176b2C3d0aa5B344A9B87fD26C1Ab1abd2D07179','0xc664C800bC54229034A629335A231f279320a605','0xD62c204A5dA441E135A9d1e48Ba2CaABF40B4Ab8','0x11dD6940AeA57aAC6aC4D204E13161BB6E5Bf0A8','0xa50696b9D58da273C33413bD778007Bc9cC53669','0x33720C9D044Bb491e27dD5c619E15dB9F8a5f966','0xA7F6A4FA235b82920ecBA5a79e88bbfE8C7dED5D'];
const iH = new ethers.Interface(['function harvest(address)']);
const scored = [];
for (const s of cands) {
  let r = 0n; try { r = BigInt(await p.call({ to: s, data: '0x97fd323d' })); } catch {}
  let ok = false; try { await p.call({ to: s, from: SAFE, data: iH.encodeFunctionData('harvest', [ZERO_EOA]) }); ok = true; } catch {}
  if (r > 0n) console.log(s, ethers.formatEther(r), 'callable:', ok);
  if (ok) scored.push([r, s]);
}
scored.sort((a, b) => (b[0] > a[0] ? 1 : -1));
if (!scored.length) { console.log('none callable'); process.exit(0); }
const [rew, STRAT] = scored[0];
console.log('PICK', STRAT, 'reward', ethers.formatEther(rew), '~$' + (Number(ethers.formatEther(rew)) * 3200).toFixed(4));
if (process.env.GO !== '1') process.exit(0);

const weth = new ethers.Contract(WETH, ['function balanceOf(address) view returns (uint256)'], p);
const before = await weth.balanceOf(ZERO_EOA);
const safe = new ethers.Contract(SAFE, ['function nonce() view returns (uint256)','function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)'], p);
const nonce = await safe.nonce();
const inner = iH.encodeFunctionData('harvest', [ZERO_EOA]);
const tx = { to: STRAT, value: 0n, data: inner, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ethers.ZeroAddress, refundReceiver: ethers.ZeroAddress, nonce };
const sig = await wallet.signTypedData({ chainId: CHAIN, verifyingContract: SAFE },
  { SafeTx: [{ name:'to',type:'address'},{name:'value',type:'uint256'},{name:'data',type:'bytes'},{name:'operation',type:'uint8'},{name:'safeTxGas',type:'uint256'},{name:'baseGas',type:'uint256'},{name:'gasPrice',type:'uint256'},{name:'gasToken',type:'address'},{name:'refundReceiver',type:'address'},{name:'nonce',type:'uint256'}] }, tx);
const data = safe.interface.encodeFunctionData('execTransaction', [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, sig]);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'User-Agent': UA, Origin: 'https://app.safe.global' };
const res = await fetch(`https://safe-client.safe.global/v1/chains/${CHAIN}/relay`, { method: 'POST', headers: H, body: JSON.stringify({ version: '1.4.1', to: SAFE, data, gasLimit: '3000000' }) });
const txt = await res.text(); console.log('relay', res.status, txt);
const taskId = JSON.parse(txt).taskId;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const t = (await (await fetch(`https://api.gelato.digital/tasks/status/${taskId}`, { headers: H })).json()).task || {};
  console.log(i, t.taskState, t.transactionHash || '');
  if (/Success|Cancelled|Reverted/i.test(t.taskState || '')) {
    if (t.transactionHash) { const r = await p.waitForTransaction(t.transactionHash, 1, 120000);
      const after = await weth.balanceOf(ZERO_EOA);
      console.log('receipt', r?.status, 'DELTA WETH', ethers.formatEther(after - before), 'TOTAL', ethers.formatEther(after), 'TX', t.transactionHash); }
    break;
  }
}
