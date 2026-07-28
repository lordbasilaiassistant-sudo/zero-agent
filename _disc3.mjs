import { discoveryPass } from "./discover.mjs";
const kv=new Map();
const env={KV:{get:async(k,t)=>{const v=kv.get(k); return v?(t==="json"?JSON.parse(v):v):null;},put:async(k,v)=>void kv.set(k,v)}};
for(const chain of ["arbitrum","base","optimism"]){
  try{
    const r=await discoveryPass(env,{chain});
    console.log(chain.padEnd(9),"new="+r.new_candidates,"total="+r.total_candidates,"open="+r.promising_open, r.skipped?("SKIP: "+r.skipped):"");
    (r.top||[]).slice(0,4).forEach(t=>console.log("     "+t.contract.slice(0,14)+" "+(t.name||"?").slice(0,24).padEnd(24)+" payouts="+t.payouts_seen+" "+(t.functions||[]).slice(0,2).join(",")));
  }catch(e){console.log(chain,"ERR",String(e.message).slice(0,60))}
}
