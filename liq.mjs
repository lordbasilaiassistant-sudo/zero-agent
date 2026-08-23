const U='https://rpc.gnosischain.com';
const POOL='0xb50201558B00496A145fE76f7424749556E326D8';
const BORROW='0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0';
const rpc=async(m,p)=>{const r=await fetch(U,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const j=await r.json();return j.error?{__e:j.error.message}:j.result;};
const head=Number(await rpc('eth_blockNumber',[]));
console.log('gnosis head',head);
// Walk back collecting Borrow events. Chunked because getLogs rejects wide ranges.
const users=new Set(); let scanned=0, chunk=9000;
for(let hi=head; hi>head-400000 && users.size<600; hi-=chunk){
  const lo=Math.max(0,hi-chunk+1);
  const logs=await rpc('eth_getLogs',[{address:POOL,topics:[BORROW],fromBlock:'0x'+lo.toString(16),toBlock:'0x'+hi.toString(16)}]);
  if(logs&&logs.__e){process.stdout.write('x');continue;}
  scanned+=chunk;
  for(const l of logs||[]) if(l.topics[2]) users.add('0x'+l.topics[2].slice(26).toLowerCase());
  process.stdout.write(logs&&logs.length?String(Math.min(9,logs.length)):'.');
}
console.log(`\nscanned ~${scanned} blocks · ${users.size} distinct borrowers\n`);
if(!users.size){console.log('no Borrow events found in the window.');process.exit(0);}
// Batch getUserAccountData
const list=[...users];
const out=[];
for(let i=0;i<list.length;i+=25){
  const slice=list.slice(i,i+25);
  const body=slice.map((a,k)=>({jsonrpc:'2.0',id:i+k,method:'eth_call',
    params:[{to:POOL,data:'0xbf92857c'+'0'.repeat(24)+a.slice(2)},'latest']}));
  const r=await fetch(U,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  if(!Array.isArray(j)) continue;
  for(const x of j){
    if(!x.result||x.result==='0x') continue;
    const w=x.result.slice(2).match(/.{64}/g);
    if(!w||w.length<6) continue;
    const totalCollateral=BigInt('0x'+w[0]), totalDebt=BigInt('0x'+w[1]), hf=BigInt('0x'+w[5]);
    if(totalDebt===0n) continue;
    out.push({addr:list[x.id-0]||slice[x.id-i],debt:Number(totalDebt)/1e8,coll:Number(totalCollateral)/1e8,hf:Number(hf)/1e18});
  }
}
out.sort((a,b)=>a.hf-b.hf);
console.log('borrowers WITH DEBT:',out.length);
console.log('\nhealthiest-to-riskiest (HF<1 = LIQUIDATABLE):');
for(const r of out.slice(0,18)) console.log(`  HF ${r.hf.toFixed(4).padStart(10)}  debt $${r.debt.toFixed(2).padStart(12)}  collateral $${r.coll.toFixed(2).padStart(12)}  ${r.addr}`);
const liq=out.filter(r=>r.hf<1);
console.log(`\nLIQUIDATABLE RIGHT NOW: ${liq.length}`);
for(const r of liq) console.log(`  HF ${r.hf.toFixed(4)} debt $${r.debt.toFixed(2)} -> ~5% bonus = $${(r.debt*0.05).toFixed(2)}  ${r.addr}`);
const near=out.filter(r=>r.hf>=1&&r.hf<1.05);
console.log(`within 5% of liquidation: ${near.length}`);
