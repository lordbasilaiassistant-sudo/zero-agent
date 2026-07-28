import { payersOf, inspect } from "./discover.mjs";
const K="0xCee843CD04E3758dDC5BCFf08647DddB117151D0";
console.log("=== who pays this keeper (arbitrum) ===");
const payers=await payersOf("arbitrum",K,2);
console.log("distinct paying contracts:",payers.length);
for(const p of payers.slice(0,10)){
  const toks=Object.entries(p.tokens).map(([s,v])=>s+":"+v.toFixed(6)).slice(0,3).join(" ");
  console.log("  "+(p.contract||"").slice(0,14)+"  payouts="+String(p.n).padStart(3)+"  "+(p.name||"").slice(0,22).padEnd(22)+" "+toks);
}
console.log("");
console.log("=== inspect top payer ===");
if(payers[0]){ const i=await inspect("arbitrum",payers[0].contract);
  console.log("  name:",i.name,"| verified:",i.verified,"| gated:",i.access_controlled,"| pays caller:",i.pays_a_caller);
  console.log("  verdict:",i.verdict);
  (i.candidate_functions||[]).slice(0,6).forEach(f=>console.log("    "+f.sig+(f.takesRecipient?"  <-- recipient param":"")));
}
