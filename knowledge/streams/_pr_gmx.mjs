import { rpc, extractSelectors, implOf, SAFE } from './_pr_probe.mjs';
import { ethers } from 'ethers';

// Candidate referral registries (the genuine "register once, credited forever" primitive).
const REGS = [
  ['arbitrum','0xe6fab3F0c7199b0d34d7FbE83394fc0e0D06e99d','GMX ReferralStorage (Arb)'],
  ['arbitrum','0x7981e3E92E4b95530Bf9F1F76BD6d6d9b6C9b0F5','GMX V2 ReferralStorage? (unverified guess)'],
];

// Known GMX ReferralStorage function sigs to match against recovered selectors.
const KNOWN = [
  'registerCode(bytes32)','setCodeOwner(bytes32,address)','govSetCodeOwner(bytes32,address)',
  'setTraderReferralCode(address,bytes32)','setTraderReferralCodeByUser(bytes32)',
  'setReferrerTier(address,uint256)','setTier(uint256,uint256,uint256)','setHandler(address,bool)',
  'codeOwners(bytes32)','traderReferralCodes(address)','getTraderReferralInfo(address)',
  'referrerDiscountShares(address)','referrerTiers(address)','tiers(uint256)',
  'setReferrerDiscountShare(uint256)','gov()',
];
const sel = (s)=>ethers.id(s).slice(0,10);
const KNOWN_BY_SEL = Object.fromEntries(KNOWN.map(s=>[sel(s),s]));

for (const [chain, addr, label] of REGS) {
  const code = await rpc(chain,'eth_getCode',[addr,'latest']);
  if (!code || code === '0x' || code.__error) { console.log(`\n${label} ${addr}: not a contract (${code&&code.__error||'0x'})`); continue; }
  const impl = await implOf(chain, addr);
  let hay = code;
  if (impl) { const ic = await rpc(chain,'eth_getCode',[impl,'latest']); if (typeof ic==='string') hay += ic; }
  const sels = extractSelectors(hay);
  const known = sels.filter(s=>KNOWN_BY_SEL[s]).map(s=>KNOWN_BY_SEL[s]);
  console.log(`\n${label} ${addr}\n  impl=${impl||'-'} selectors=${sels.length}\n  recognized: ${known.join(', ')||'(none recognized)'}`);

  // If registerCode present, simulate registering an arbitrary code from the Safe.
  if (sels.includes(sel('registerCode(bytes32)'))) {
    const code32 = ethers.id('zero-'+addr).slice(0,66); // arbitrary 32-byte code
    const data = new ethers.Interface(['function registerCode(bytes32)']).encodeFunctionData('registerCode',[code32]);
    const r = await rpc(chain,'eth_call',[{from:SAFE,to:addr,data},'latest']);
    console.log(`  registerCode(${code32.slice(0,10)}..) from Safe => ${r&&r.__error?('reverts: '+r.__error.slice(0,80)):'CALLABLE (no revert) — Safe could own this code'}`);
    // Read who owns it now (should be zero addr => available)
    const own = await rpc(chain,'eth_call',[{to:addr,data:new ethers.Interface(['function codeOwners(bytes32)']).encodeFunctionData('codeOwners',[code32])},'latest']);
    console.log(`  codeOwners(code) currently = ${typeof own==='string'?('0x'+own.slice(-40)):JSON.stringify(own)}`);
  }
}
console.log('\nDONE');
