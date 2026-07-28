import { bootstrapKeepers } from "./discover.mjs";
// strategies we have personally harvested and confirmed pay callers
const KNOWN={
 base:["0xc664C800bC54229034A629335A231f279320a605","0x8B45D51e015Dac924EeAEa754e6f768943206F05"],
 optimism:["0x3DAfB52975faB6B02eA6Cf4ead926E409Fa23ca0"],
};
for(const [chain,payers] of Object.entries(KNOWN)){
  const k=await bootstrapKeepers(chain,payers);
  console.log(chain+": found "+k.length+" candidate keeper wallets");
  k.slice(0,8).forEach(x=>console.log("   "+x.address+"  paid "+x.seen+"x"));
}
