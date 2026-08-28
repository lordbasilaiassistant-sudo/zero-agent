// authtest.mjs — proves the X-PAYMENT (EIP-3009) path with a real signed authorization.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { ethers } from 'ethers';
import { verifyAuthorization, SMART_ACCOUNT } from './shop.mjs';
const PAY_TO=SMART_ACCOUNT;
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DOMAIN={name:'USD Coin',version:'2',chainId:8453,verifyingContract:USDC};
const TYPES={TransferWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},
 {name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]};
const kv=new Map(); const env={KV:{get:async k=>kv.get(k)??null,put:async(k,v)=>void kv.set(k,v)}};
const rpc=async(c,m,p)=>{const r=await fetch('https://base-rpc.publicnode.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});return (await r.json()).result};
const buyer=ethers.Wallet.createRandom();
const now=Math.floor(Date.now()/1000);
async function mk(over={}){
  const a={from:buyer.address,to:PAY_TO,value:50000n,validAfter:0,validBefore:now+3600,
    nonce:ethers.hexlify(ethers.randomBytes(32)),...over};
  const sig=await buyer.signTypedData(DOMAIN,TYPES,a);
  return Buffer.from(JSON.stringify({x402Version:1,scheme:'exact',network:'base',payload:{signature:over.badSig?('0x'+'11'.repeat(65)):sig,authorization:{...a,value:a.value.toString()}}})).toString('base64');
}
let pass=0,fail=0;
const t=async(n,f)=>{try{const o=await f();console.log('PASS ',n,o?'— '+String(o).slice(0,90):'');pass++}catch(e){console.log('FAIL ',n,'—',String(e.message).slice(0,140));fail++}};
await t('valid authorization accepted',async()=>{const r=await verifyAuthorization(env,rpc,await mk(),50000n,PAY_TO);
  if(!r.ok&&!/payer holds/.test(r.why))throw new Error(r.why); return r.ok?'accepted':'signature ok, rejected only on payer balance (correct: buyer is empty)'});
await t('underpayment refused',async()=>{const r=await verifyAuthorization(env,rpc,await mk({value:100n}),50000n,PAY_TO);
  if(r.ok||!/need/.test(r.why))throw new Error('accepted underpay'); return r.why});
await t('wrong recipient refused',async()=>{const r=await verifyAuthorization(env,rpc,await mk({to:'0x000000000000000000000000000000000000dEaD'}),50000n,PAY_TO);
  if(r.ok||!/pays/.test(r.why))throw new Error('accepted wrong payee')});
await t('forged signature refused',async()=>{const r=await verifyAuthorization(env,rpc,await mk({badSig:true}),50000n,PAY_TO);
  if(r.ok)throw new Error('accepted forgery!'); return r.why.slice(0,60)});
await t('expired authorization refused',async()=>{const r=await verifyAuthorization(env,rpc,await mk({validBefore:now-10}),50000n,PAY_TO);
  if(r.ok||!/expired/.test(r.why))throw new Error('accepted expired')});
await t('not-yet-valid refused',async()=>{const r=await verifyAuthorization(env,rpc,await mk({validAfter:now+9999}),50000n,PAY_TO);
  if(r.ok||!/not valid yet/.test(r.why))throw new Error('accepted premature')});
await t('garbage header refused',async()=>{const r=await verifyAuthorization(env,rpc,'not-base64!!',50000n,PAY_TO);
  if(r.ok)throw new Error('accepted garbage')});
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
