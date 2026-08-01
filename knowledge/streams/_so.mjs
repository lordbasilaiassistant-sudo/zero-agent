// Can I put Multicall3's code AT ZERO's Safe address, so the inner calls see msg.sender = the Safe?
import { ethers } from 'ethers';
const RPC='https://mainnet.base.org';
const MC='0xcA11bde05977b3631167028862bE2a173976CA11';
const SAFE='0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';
const EOA='0x50624F7790732f9767180871D03A304756200dB9';
const WETH='0x4200000000000000000000000000000000000006';
async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const j=await r.json();if(j.error)throw new Error(j.error.message);return j.result;}
const AGG=new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);
const mcCode = await rpc('eth_getCode',[MC,'latest']);
console.log('multicall3 code bytes:',(mcCode.length-2)/2);
const bn = await rpc('eth_blockNumber',[]);
// call a contract that returns msg.sender: use Multicall3's own getBlockNumber? need something echoing sender.
// WETH.balanceOf is fine for delta; to PROVE msg.sender we use a tiny injected echo contract.
// echo: returns caller: CALLER PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN => 33 60 00 52 60 20 60 00 f3
const ECHO='0x00000000000000000000000000000000000EcHo0'.toLowerCase();
const echoAddr='0x00000000000000000000000000000000000ec110';
const calls=[{target:echoAddr,allowFailure:true,callData:'0x'}];
const data=AGG.encodeFunctionData('aggregate3',[calls]);
const overrides={ [echoAddr]:{code:'0x3360005260206000f3'}, [SAFE]:{code:mcCode} };
const ret=await rpc('eth_call',[{to:SAFE,data},bn,overrides]);
const [rows]=AGG.decodeFunctionResult('aggregate3',ret);
console.log('inner msg.sender seen by target =','0x'+rows[0].returnData.slice(26));
console.log('SAFE =',SAFE.toLowerCase());
