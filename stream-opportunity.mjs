// One observed Superfluid liquidation, not an unbounded scanner. Evidence and controls:
// docs/research/2026-09-05-zero.md. Never pays gas or spends pre-existing assets.
import { ethers } from 'ethers';
import { MULTISEND, relayBudget, relayExec, relayStatus, skipIfRelayInFlight, markRelayInflight } from './harvest.mjs';
import { SMART_ACCOUNT } from './shop.mjs';

export const STREAM_JOB = Object.freeze({
  id: 'superfluid-arbitrum-2026-09-05-83bbe9cf',
  key: 'opportunity:superfluid-arbitrum-2026-09-05-83bbe9cf',
  chain: 'arbitrum', chainId: 42161,
  expiresAt: '2026-09-07T21:00:00.000Z',
  host: '0xCf8Acb4eF033efF16E8080aed4c7D5B9285D2192',
  cfa: '0x731FdBB12944973B500518aea61942381d7e240D',
  sender: '0x83bbe9cfcc205bb8e53cba0b51d6db9386ce58b5',
  receiver: '0x08c73bedd69a1b55bd8ce712dc1fb34b548c96eb',
  superToken: '0x1dbc1809486460dcd189b8a15990bca3272ee04e',
  underlying: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
  usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  maxRewardUnits: '24657536095354880',
  minimumUsdcUnits: '20000',
});
const I = new ethers.Interface([
  'function balanceOf(address) view returns(uint256)',
  'function downgrade(uint256)', 'function approve(address,uint256) returns(bool)',
  'function deleteFlow(address,address,address,bytes) returns(bytes)',
  'function callAgreement(address,bytes,bytes) returns(bytes)',
  'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns(uint256)',
  'function multiSend(bytes) payable',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const bal = (token) => ({ from: SMART_ACCOUNT, to: token, data: I.encodeFunctionData('balanceOf',[SMART_ACCOUNT]) });
const liquidation = () => I.encodeFunctionData('callAgreement',[STREAM_JOB.cfa,I.encodeFunctionData('deleteFlow',[STREAM_JOB.superToken,STREAM_JOB.sender,STREAM_JOB.receiver,'0x']),'0x']);
const pack = (to,data) => '00'+to.slice(2).toLowerCase()+'0'.repeat(64)+(data.slice(2).length/2).toString(16).padStart(64,'0')+data.slice(2);

export function streamBatch(rewardUnits, minimumUsdcUnits) {
  const reward=BigInt(rewardUnits), spend=reward/1000000000000n;
  if(reward<=0n || reward>BigInt(STREAM_JOB.maxRewardUnits) || spend<20000n) throw new Error('reward outside measured bounds');
  const legs=[
    [STREAM_JOB.host,liquidation()],
    [STREAM_JOB.superToken,I.encodeFunctionData('downgrade',[reward])],
    [STREAM_JOB.underlying,I.encodeFunctionData('approve',[STREAM_JOB.router,spend])],
    [STREAM_JOB.router,I.encodeFunctionData('exactInputSingle',[[STREAM_JOB.underlying,STREAM_JOB.usdc,100,SMART_ACCOUNT,spend,minimumUsdcUnits,0n]])],
  ];
  return I.encodeFunctionData('multiSend',['0x'+legs.map(([to,data])=>pack(to,data)).join('')]);
}

export function streamSimDelta(result, executionIndex=1) {
  const calls=result?.[0]?.calls;
  if(!Array.isArray(calls) || calls.length!==3) throw new Error('simulation returned no complete call sequence');
  if(calls.some(c=>c.status!=='0x1')) return {ok:false,reason:'simulation reverted',error:calls[executionIndex]?.error};
  if(!/^0x[0-9a-f]{64}$/i.test(calls[0].returnData||'') || !/^0x[0-9a-f]{64}$/i.test(calls[2].returnData||'')) throw new Error('balance simulation returned malformed data');
  return {ok:true,delta:BigInt(calls[2].returnData)-BigInt(calls[0].returnData),gasUsed:parseInt(calls[executionIndex].gasUsed,16)};
}

export async function probeStreamOpportunity(rpc) {
  const sim=await rpc(STREAM_JOB.chain,'eth_simulateV1',[
    {blockStateCalls:[{calls:[bal(STREAM_JOB.superToken),{from:SMART_ACCOUNT,to:STREAM_JOB.host,data:liquidation()},bal(STREAM_JOB.superToken)]}],traceTransfers:false,validation:false},'latest',
  ]);
  const reward=streamSimDelta(sim);
  if(!reward.ok || reward.delta<20000000000000000n) return {ready:false,reason:reward.reason||'no economically useful payment to ZERO',rewardUnits:reward.delta?.toString()};
  const minimum=reward.delta/1000000000000n*98n/100n;
  const data=streamBatch(reward.delta,minimum);
  const code=await rpc(STREAM_JOB.chain,'eth_getCode',[MULTISEND,'latest']);
  if(!code || code==='0x') throw new Error('MultiSend runtime unavailable');
  const full=await rpc(STREAM_JOB.chain,'eth_simulateV1',[
    {blockStateCalls:[{stateOverrides:{[SMART_ACCOUNT]:{code}},calls:[bal(STREAM_JOB.usdc),{from:'0x00000000000000000000000000000000000000aa',to:SMART_ACCOUNT,data,gas:'0xf4240'},bal(STREAM_JOB.usdc)]}],traceTransfers:false,validation:false},'latest',
  ]);
  const result=streamSimDelta(full);
  if(!result.ok || result.delta<minimum || !Number.isFinite(result.gasUsed) || result.gasUsed>850000) return {ready:false,reason:result.reason||'canonical USDC or gas gate failed'};
  return {ready:true,data,rewardUnits:reward.delta.toString(),minimumUsdcUnits:minimum.toString(),expectedUsdcUnits:result.delta.toString(),gasUsed:result.gasUsed,measuredAt:new Date().toISOString()};
}

export function verifyStreamReceipt(receipt,safeTxHash) {
  if(!receipt || receipt.status!=='0x1' || !/^0x[0-9a-f]{64}$/i.test(safeTxHash||'')) return {ok:false,reason:'missing successful receipt or bound Safe transaction hash'};
  let execution=false,delta=0n;
  for(const log of receipt.logs||[]) {
    if(same(log.address,SMART_ACCOUNT)) {
      try { const event=I.parseLog(log); if(event?.name==='ExecutionSuccess' && same(event.args.txHash,safeTxHash)) execution=true; } catch {}
    }
    if(same(log.address,STREAM_JOB.usdc)) {
      try {const event=I.parseLog(log);if(event?.name!=='Transfer')continue;if(same(event.args.to,SMART_ACCOUNT))delta+=event.args.value;if(same(event.args.from,SMART_ACCOUNT))delta-=event.args.value;}catch{}
    }
  }
  if(!execution || delta<BigInt(STREAM_JOB.minimumUsdcUnits)) return {ok:false,reason:'receipt lacks our Safe success or required net canonical USDC',usdcUnits:delta.toString()};
  return {ok:true,tx:receipt.transactionHash,block:receipt.blockNumber,usdcUnits:delta.toString(),usdc:ethers.formatUnits(delta,6)};
}

export async function streamOpportunityTick(env,rpc,{spent=[]}={}) {
  const state=await env.KV.get(STREAM_JOB.key,'json') || {phase:'ready',job:STREAM_JOB.id};
  const save=async update=>{const next={...state,...update,at:new Date().toISOString()};delete next.reserveChain;await env.KV.put(STREAM_JOB.key,JSON.stringify(next));return next;};
  if(['settled','closed'].includes(state.phase)) return state;
  if(state.phase==='attention') return {...state,...(!state.tx?{reserveChain:STREAM_JOB.chain}:{})};
  // Never resubmit an ambiguous POST: a quota and a balance are not proof it did not execute.
  if(state.phase==='submitting') return save({phase:'attention',reason:'relay submission outcome unknown; reconcile before retry'});
  if(state.phase==='submitted') {
    const status=await relayStatus(state.taskId,STREAM_JOB.chainId);
    if(status.tx) {
      const receipt=await rpc(STREAM_JOB.chain,'eth_getTransactionReceipt',[status.tx]);
      if(!receipt)return {...state,reserveChain:STREAM_JOB.chain};
      const proof=verifyStreamReceipt(receipt,state.safeTxHash);
      return save({phase:proof.ok?'settled':'attention',proof,tx:status.tx});
    }
    if(Date.now()-Date.parse(state.submittedAt)>30*60*1000) return save({phase:'attention',reason:'relay unresolved after 30 minutes; no duplicate submission'});
    return {...state,reserveChain:STREAM_JOB.chain};
  }
  if(Date.now()>Date.parse(STREAM_JOB.expiresAt)) return save({phase:'closed',reason:'opportunity expired without settlement'});
  if(spent.includes(STREAM_JOB.chain)) return {...state,reason:'chain already used this tick'};
  const blocked=await skipIfRelayInFlight(env,STREAM_JOB.chain,STREAM_JOB.chainId);
  if(blocked)return {...state,reason:'existing Arbitrum relay in flight'};
  const budget=await relayBudget(SMART_ACCOUNT,STREAM_JOB.chainId);
  if(!(budget.remaining>0))return save({phase:'ready',reason:budget.remaining===0?'waiting for free Arbitrum relay slot':'relay quota unreadable',budget});
  const candidate=await probeStreamOpportunity(rpc);
  if(!candidate.ready)return save({phase:'closed',reason:candidate.reason,probe:candidate});
  await save({phase:'submitting',probe:{...candidate,data:undefined}});
  const sent=await relayExec(env,rpc,SMART_ACCOUNT,MULTISEND,candidate.data,STREAM_JOB.chain,STREAM_JOB.chainId,1);
  if(!sent.ok || !sent.taskId) return save({phase:'attention',reason:'relay rejected or outcome ambiguous; no automatic retry',relay:sent});
  const saved=await save({phase:'submitted',submittedAt:new Date().toISOString(),taskId:sent.taskId,safeTxHash:sent.safeTxHash,probe:{...candidate,data:undefined}});
  await markRelayInflight(env,STREAM_JOB.chain,sent.taskId,{route:STREAM_JOB.id});
  return {...saved,reserveChain:STREAM_JOB.chain};
}
