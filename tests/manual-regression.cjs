const assert=require('node:assert/strict');
const {createManualMonitor,evaluate,ipValid}=require('../browser-extension/manual-core.js');
let now=1000000;
const data={};
const key='wallcheck_manual_ipv4_v1';
const monitor=createManualMonitor({
 read:async k=>data[k]?structuredClone(data[k]):undefined,
 write:async(k,v)=>{data[k]=structuredClone(v);},
 clock:()=>now
});
const doIt=(type,payload)=>monitor.dispatch(type,payload);
const result=(ping,tcp)=>({icmp:{state:ping,latency_ms:9.1},
 ports:[{port:22,state:tcp,latency_ms:14.7}]});
(async()=>{
 assert(ipValid('127.0.0.1'));assert(!ipValid('256.0.0.1'));
 assert(!ipValid('01.0.0.1'));assert(!ipValid('example.com'));
 assert.equal(evaluate('ping',result('NO_REPLY','OPEN')).state,'DOWN');
 assert.equal(evaluate('tcp22',result('NO_REPLY','OPEN')).state,'UP');
 assert.equal(evaluate('either',result('NO_REPLY','OPEN')).state,'DOWN');
 assert.equal(evaluate('either',result('NO_REPLY','REFUSED')).state,'DOWN');
 assert.equal(evaluate('either',result('REACHABLE','TIMEOUT')).state,'DOWN');
 assert.equal(evaluate('either',result('REACHABLE','OPEN')).state,'UP');
 assert.equal(evaluate('either',result('ERROR','OPEN')).state,'DOWN');
 assert.equal(evaluate('either',result('REACHABLE','ERROR')).state,'DOWN');
 assert.equal(evaluate('either',null).state,'UNKNOWN');
 await assert.rejects(()=>doIt('add',{ip:'1.1.1.999'}));
 const added=await doIt('add',{ip:'192.0.2.10',label:'#1 自定义',mode:'tcp22',intervalMinutes:1});
 const id=added.addedId;
 assert.equal(added.items.length,1);assert.equal(added.items[0].ip,'192.0.2.10');
 await assert.rejects(()=>doIt('add',{ip:'192.0.2.10'}));
 const before=(await monitor.due(now)).find(x=>x.id===id);
 assert(before);
 const generation=before.generation;
 await doIt('apply',{results:[{id,ip:before.ip,generation,when:now,result:result('NO_REPLY','OPEN')}]});
 let snapshot=await doIt('get');
 assert.equal(snapshot.items[0].state,'UP');
 assert.equal(snapshot.items[0].events.length,0);
 assert.equal((await monitor.due(now+30000)).length,0,'not due before next interval');
 now+=61000;
 await doIt('apply',{results:[{id,ip:before.ip,generation,when:now,result:result('REACHABLE','TIMEOUT')}]});
 snapshot=await doIt('get');
 assert.equal(snapshot.items[0].state,'DOWN','TCP-only mode checks port not ping');
 assert.equal(snapshot.items[0].events.length,1);
 assert.equal(snapshot.items[0].events[0].kind,'DOWN');
 now+=61000;
 await doIt('apply',{results:[{id,ip:before.ip,generation,when:now,result:result('REACHABLE','OPEN')}]});
 snapshot=await doIt('get');
 assert.equal(snapshot.items[0].state,'UP');
 assert.equal(snapshot.items[0].events[1].kind,'RECOVERED');
 assert.equal(snapshot.items[0].events.length,2);
 // Stale monitor results from old address cannot overwrite edited address.
 now+=500;
 await doIt('update',{id,ip:'192.0.2.11',label:'新IP',mode:'ping',intervalMinutes:5});
 snapshot=await doIt('get');
 assert.equal(snapshot.items[0].ip,'192.0.2.11');
 assert.equal(snapshot.items[0].state,'PENDING');
 assert.equal(snapshot.items[0].events.length,3);
 assert.equal(snapshot.items[0].events[2].oldIp,'192.0.2.10');
 const newerGeneration=snapshot.items[0].generation;
 await doIt('apply',{results:[{id,ip:'192.0.2.10',generation,when:now+100,
   result:result('REACHABLE','OPEN')}]});
 assert.equal((await doIt('get')).items[0].ip,'192.0.2.11');
 assert.equal((await doIt('get')).items[0].state,'PENDING');
 now+=1000;
 await doIt('apply',{results:[{id,ip:'192.0.2.11',generation:newerGeneration,
   when:now,result:result('REACHABLE','REFUSED')}]});
 assert.equal((await doIt('get')).items[0].state,'UP');
 // Old previous-IP events survive exactly until acknowledgement.
 assert.equal((await doIt('get')).items[0].events.length,3);
 await doIt('ack',{id});
 const cleared=(await doIt('get')).items[0];
 assert.equal(cleared.events.length,0);
 assert.equal(cleared.ip,'192.0.2.11');
 assert.equal(cleared.state,'UP');
 // Change back to old IP is a fresh manually authorized change, not false reverse.
 await doIt('update',{id,ip:'192.0.2.10',label:'返回旧IP',mode:'either',intervalMinutes:10});
 assert.equal((await doIt('get')).items[0].events[0].kind,'IP_EDIT');
 await doIt('enable',{id,enabled:false});
 assert.equal((await monitor.due(now+24*60*60000)).length,0);
 await doIt('enable',{id,enabled:true});
 assert.equal((await monitor.due(now+24*60*60000)).length,1);
 // Race: user removes a target while an old result is in-flight.
 const g=(await doIt('get')).items[0].generation;
 await doIt('remove',{id});
 await doIt('apply',{results:[{id,ip:'192.0.2.10',generation:g,when:now+120000,
   result:result('NO_REPLY','TIMEOUT')}]});
 assert.equal((await doIt('get')).items.length,0);
 assert(!JSON.stringify(data).includes('sgt:'));
 // Persistent browser-backed state can be read by a recreated worker.
 const monitor2=createManualMonitor({
   read:async k=>structuredClone(data[k]),write:async(k,v)=>{data[k]=structuredClone(v)},
   clock:()=>now
 });
 assert.equal((await monitor2.dispatch('get')).items.length,0);
 // Keep every pending event, even after long unattended monitoring.
 const item=(await doIt('add',{ip:'198.51.100.7',mode:'ping'})).addedId;
 const gen=(await doIt('get')).items[0].generation;
 for(let k=0;k<85;k++){
   now+=62000;
   const icmp=k%2?'REACHABLE':'NO_REPLY';
   await doIt('apply',{results:[{id:item,ip:'198.51.100.7',generation:gen,
     when:now,result:result(icmp,'REFUSED')}]});
 }
 assert.equal((await doIt('get')).items[0].events.length,85);
 await doIt('ack',{id:item});
 assert.equal((await doIt('get')).items[0].events.length,0);
 console.log('MANUAL_CORE_REGRESSION_PASS: methods, intervals, transitions, edit/reset, stale response, pause, remove, 85 pending events, restart');
})().catch(e=>{console.error(e);process.exitCode=1});
