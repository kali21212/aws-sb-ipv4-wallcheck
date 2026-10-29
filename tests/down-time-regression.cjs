const assert=require('node:assert/strict');
const {createManualMonitor}=require('../browser-extension/manual-core.js');
let now=1760683800000;
const storage={};
const key='wallcheck_manual_ipv4_v1';
const result=(ping,tcp)=>({icmp:{state:ping},ports:[{port:22,state:tcp}]});
const monitor=createManualMonitor({
  read:async k=>storage[k]?structuredClone(storage[k]):undefined,
  write:async(k,v)=>{storage[k]=structuredClone(v)},
  clock:()=>now
});
const run=(type,payload={})=>monitor.dispatch(type,payload);
const get=async id=>(await run('get')).items.find(t=>t.id===id);
async function check(id,verdict,at,error=null){
  now=at;
  const t=await get(id);
  return run('apply',{results:[{id,ip:t.ip,generation:t.generation,
    when:at,...(error?{error}:{result:verdict})}]});
}
(async()=>{
 const id=(await run('add',{ip:'203.0.113.113',mode:'either',label:'实验',intervalMinutes:5})).addedId;
 assert.equal((await get(id)).downSince,0);
 const first=1760683860000;
 let v=await check(id,result('NO_REPLY','TIMEOUT'),first);
 assert.equal(v.events.length,1);
 assert.equal(v.events[0].kind,'DOWN');
 assert.equal(v.events[0].time,first);
 assert.equal((await get(id)).downSince,first);
 const repeat=first+300000;
 v=await check(id,result('NO_REPLY','TIMEOUT'),repeat);
 assert.equal(v.events.length,0,'No duplicate desktop notifications');
 assert.equal((await get(id)).downSince,first,'first detection is immutable');
 assert.equal((await get(id)).lastCheckedAt,repeat,'last checked continues updating');
 const ack=await run('ack',{id});
 assert.equal(ack.items[0].events.length,0);
 assert.equal(ack.items[0].downSince,first,'ack does not erase active outage');
 await check(id,result('NO_REPLY','REFUSED'),repeat+300000);
 assert.equal((await get(id)).downSince,first,'unchanged even after acknowledging');
 v=await check(id,null,repeat+360000,'Failed to fetch');
 assert.equal(v.events[0].kind,'PROBE_ERROR');
 assert.equal((await get(id)).downSince,first,'transport error not a new outage');
 const recovered=repeat+480000;
 v=await check(id,result('REACHABLE','OPEN'),recovered);
 assert.equal(v.events.length,1);
 assert.equal(v.events[0].kind,'RECOVERED');
 assert.equal(v.events[0].time,recovered);
 assert.equal((await get(id)).recoveredAt,recovered);
 assert.equal((await get(id)).lastOutageSince,first);
 assert.equal((await get(id)).downSince,0);
 // Recovery time remains stable on repeated success; ack hides UI history later.
 await check(id,result('REACHABLE','OPEN'),recovered+300000);
 assert.equal((await get(id)).recoveredAt,recovered);
 await run('ack',{id});
 assert.equal((await get(id)).events.length,0);
 const again=recovered+600000;
 v=await check(id,result('NO_REPLY','TIMEOUT'),again);
 assert.equal(v.events[0].kind,'DOWN');
 assert.equal((await get(id)).downSince,again,'future outage is new');
 assert.equal((await get(id)).recoveredAt,0);
 await run('update',{id,ip:'203.0.113.114',label:'实验2',mode:'tcp22',intervalMinutes:1});
 assert.equal((await get(id)).downSince,0,'IP edit starts new episode');
 assert.equal((await get(id)).lastOutageSince,0);
 assert.equal((await get(id)).recoveredAt,0);
 // Stale response for previous IP cannot resurrect old red timestamp.
 const previous=(await get(id)).generation-1;
 await run('apply',{results:[{id,ip:'203.0.113.113',generation:previous,
   when:again+60000,result:result('NO_REPLY','TIMEOUT')}]});
 assert.equal((await get(id)).downSince,0);
 // Migration test: a pre-1.9.2 live down target only has DOWN event time.
 const fresh=again+120000;
 const t=await get(id);
 const legacyTime=again+70000;
 delete storage[key].items[0].downSince;
 storage[key].items[0].state='DOWN';
 storage[key].items[0].lastStable='DOWN';
 storage[key].items[0].events=[{
   id:'manual-legacy',targetId:id,ip:t.ip,kind:'DOWN',time:legacyTime,mode:t.mode
 }];
 await check(id,result('NO_REPLY','TIMEOUT'),fresh);
 assert.equal((await get(id)).downSince,legacyTime,
   '1.9.1 pending outage time is restored rather than fabricated');
 console.log('DOWN_TIME_REGRESSION_PASS: first detection, repeat, ack, error, recovered, new outage, IP edit, legacy migration');
})().catch(error=>{console.error(error);process.exitCode=1});
