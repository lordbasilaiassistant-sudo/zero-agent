// capability probe — what can these public RPCs actually do? read-only.
const RPCS = {
  base: ['https://mainnet.base.org','https://base-rpc.publicnode.com'],
  optimism: ['https://optimism-rpc.publicnode.com'],
  arbitrum: ['https://arbitrum-one-rpc.publicnode.com'],
  polygon: ['https://polygon-bor-rpc.publicnode.com'],
  gnosis: ['https://gnosis-rpc.publicnode.com'],
};
async function call(url, method, params){
  try{
    const r = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    const j = await r.json();
    if(j.error) return {err:j.error.message};
    return {ok:j.result};
  }catch(e){ return {err:'FETCH '+e.message}; }
}
const MC='0xcA11bde05977b3631167028862bE2a173976CA11';
for(const [c,urls] of Object.entries(RPCS)){
  for(const u of urls){
    const bn = await call(u,'eth_blockNumber',[]);
    if(bn.err){ console.log(`${c} ${u} DEAD ${bn.err}`); continue; }
    const blk = parseInt(bn.ok,16);
    // 1) debug_traceCall
    const t = await call(u,'debug_traceCall',[{to:MC,data:'0x0f28c97d'},'latest',{tracer:'callTracer'}]);
    // 2) state override on eth_call (3rd param)
    const so = await call(u,'eth_call',[{to:'0x000000000000000000000000000000000000dEaD',data:'0x'},'latest',
      {'0x000000000000000000000000000000000000dEaD':{code:'0x60016000526020600ff3'}}]);
    // 3) eth_getLogs range tolerance
    const lg = await call(u,'eth_getLogs',[{fromBlock:'0x'+(blk-50).toString(16),toBlock:'0x'+blk.toString(16),topics:[]}]);
    console.log(JSON.stringify({chain:c,url:u,block:blk,
      trace: t.err? 'NO: '+t.err.slice(0,60):'YES',
      stateOverride: so.err? 'NO: '+so.err.slice(0,60): 'YES ret='+so.ok,
      logs50: lg.err? 'NO: '+lg.err.slice(0,70): 'YES n='+lg.ok.length}));
  }
}
