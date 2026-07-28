// look up the REAL strategy addresses for the optimism vaults we actually harvested
const ids=["velodrome-v2-weth-op","velodrome-v2-op-velo","velodrome-v2-wsteth-velo","velodrome-v2-weth-frxeth"];
const v=await (await fetch("https://api.beefy.finance/vaults")).json();
for(const id of ids){ const x=v.find(y=>y.id===id); console.log(id.padEnd(28), x?x.strategy:"NOT FOUND"); }
