import { discoveryPass } from "./discover.mjs";
const kv=new Map();
const env={KV:{get:async(k,t)=>{const v=kv.get(k); return v?(t==="json"?JSON.parse(v):v):null;},put:async(k,v)=>void kv.set(k,v)}};
const r=await discoveryPass(env,{chain:"arbitrum"});
console.log("new candidates:",r.new_candidates,"| total:",r.total_candidates,"| promising open:",r.promising_open);
console.log("TOP UNGATED CONTRACTS THAT DEMONSTRABLY PAY CALLERS:");
(r.top||[]).forEach(t=>console.log("  "+t.contract+"  "+(t.name||"?").slice(0,26).padEnd(26)+" payouts="+t.payouts_seen+"  "+(t.functions||[]).slice(0,3).join(", ")));
