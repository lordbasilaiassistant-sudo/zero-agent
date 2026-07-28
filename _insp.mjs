import { inspect } from "./discover.mjs";
const C="0x1E50482e9185D9DAC418768D14b2F2AC2b4DAF39";
const i=await inspect("arbitrum",C);
console.log("name:",i.name,"| verified:",i.verified,"| gated:",i.access_controlled,"| pays caller:",i.pays_a_caller);
console.log("verdict:",i.verdict);
console.log("candidate functions an arbitrary caller could invoke:");
(i.candidate_functions||[]).forEach(f=>console.log("   "+f.sig+(f.takesRecipient?"   <-- takes recipient param":"")));
