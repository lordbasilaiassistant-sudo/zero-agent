// Behavioural universe: most-called contracts in recent blocks. No protocol list.
import { ethers } from 'ethers';
import fs from 'fs';
const CH = {
  base:'https://mainnet.base.org',
  optimism:'https://optimism-rpc.publicnode.com',
};
async function rpc(url,m,p){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const j=await r.json();if(j.error)throw new Error(j.error.message);return j.result;}
for(const [c,url] of Object.entries(CH)){
  const tip = parseInt(await rpc(url,'eth_blockNumber',[]),16);
  const start = tip-40;
  const tally = new Map();
  for(let b=start;b<=tip;b++){
    try{
      const blk = await rpc(url,'eth_getBlockByNumber',['0x'+b.toString(16),true]);
      for(const tx of blk.transactions){
        if(!tx.to) continue;
        const t = tx.to.toLowerCase();
        tally.set(t,(tally.get(t)||0)+1);
      }
    }catch(e){ console.error(c,b,e.message); }
  }
  const ranked=[...tally.entries()].sort((a,b)=>b[1]-a[1]);
  fs.writeFileSync(`_uni_${c}.json`,JSON.stringify({chain:c,tip,scanned:tip-start+1,top:ranked.slice(0,120)},null,0));
  console.log(c,'tip',tip,'distinct to:',tally.size,'top5:',ranked.slice(0,5).map(x=>x[0]+':'+x[1]).join(' '));
}
