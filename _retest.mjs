import { inspect } from "./discover.mjs";
const i=await inspect("arbitrum","0x1E50482e9185D9DAC418768D14b2F2AC2b4DAF39");
console.log("impl resolved:",i.implementation);
console.log("name:",i.name);
console.log("callable_now:",JSON.stringify(i.callable_now));
console.log("verdict:",i.verdict);
