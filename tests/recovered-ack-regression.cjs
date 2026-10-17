const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const dir=path.resolve(__dirname,'..','browser-extension');
const context={};vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(dir,'monitor-core.js'),'utf8'),context);
const store={};let time=1750000000000;
const monitor=context.createWallCheckMonitor({
 read:async key=>structuredClone(store[key]),
 write:async(key,value)=>{store[key]=structuredClone(value);},
 clock:()=>++time
});
const scopeA='sgt:'+'a'.repeat(64),scopeB='sgt:'+'b'.repeat(64);
const invoke=(scope,type,fields={})=>monitor.dispatch({scope,type,...fields});
const faults=x=>x.snapshot.alerts.filter(e=>e.kind==='AGENT_OFFLINE'||e.kind==='EXTENSION_CONTEXT');
(async()=>{
 const bad=await invoke(scopeA,'monitor:agent',{ok:false,reason:'Failed to fetch'});
 assert.equal(faults(bad).length,1);
 const firstId=faults(bad)[0].id;
 const recovered=await invoke(scopeB,'monitor:agent',{ok:true});
 assert(faults(recovered)[0].resolvedAt,'fault must be marked resolved');
 // Add pending IP-change event and an open independent port failure.
 const machine='ec2:i-00000000000000014';
 await invoke(scopeA,'monitor:observe',{records:[{instanceId:machine,ip:'192.0.2.1',label:'#1',pageOpenedAt:time,changedHere:false}]});
 const change=await invoke(scopeA,'monitor:observe',{records:[{instanceId:machine,ip:'192.0.2.2',label:'#1',pageOpenedAt:time+100,changedHere:true}]});
 assert(change.snapshot.alerts.some(e=>e.kind==='IP_CHANGE'));
 await invoke(scopeA,'monitor:reachability',{items:[{instanceId:machine,ip:'192.0.2.2',status:'PORT22_UNREACHABLE'}]});
 // A new live failure must survive acknowledgement of only the prior recovery.
 const live=await invoke(scopeB,'monitor:agent',{ok:false,reason:'another outage'});
 assert.equal(faults(live).filter(e=>!e.resolvedAt).length,1);
 const ack=await invoke(scopeA,'monitor:ack-recovered',{ids:[firstId, ...faults(live).map(e=>e.id)]});
 assert(!faults(ack).some(e=>e.id===firstId),'first recovered fault must be deleted');
 assert.equal(faults(ack).filter(e=>!e.resolvedAt).length,1,'live fault must remain');
 assert(ack.snapshot.alerts.some(e=>e.kind==='IP_CHANGE'),'IP changes must survive');
 assert(ack.snapshot.alerts.some(e=>e.kind==='PORT22_UNREACHABLE'),'port failure must survive');
 assert.equal(faults(await invoke(scopeB,'monitor:get')).length,1,'ack must sync across scopes');
 await invoke(scopeA,'monitor:ack-recovered',{ids:[firstId]}); // idempotent
 await invoke(scopeB,'monitor:agent',{ok:true});
 const recoveredAgain=await invoke(scopeA,'monitor:get');
 const secondId=faults(recoveredAgain)[0].id;
 assert(secondId!==firstId,'future recovered event must be new');
 assert(faults(recoveredAgain)[0].resolvedAt);
 // Clicking "已知" on recovery should remove only that exact event.
 await invoke(scopeA,'monitor:ack-recovered',{ids:[secondId]});
 assert.equal(faults(await invoke(scopeB,'monitor:get')).length,0);
 assert.equal(store.wallcheck_scoped_monitor_v3.globalAlerts.length,0);
 const content=fs.readFileSync(path.join(dir,'content.js'),'utf8');
 assert(content.includes('wc-history-ack')&&content.includes('acknowledgeRecoveredFaults('));
 assert(content.includes("'monitor:ack-recovered'"));
 assert(!content.includes('setTimeout(()=>acknowledgeRecoveredFaults('));
 console.log('PASS recovered-history acknowledgement: purge only resolved, retain live alerts, cross-sgt sync, fresh future faults');
})().catch(e=>{console.error(e);process.exitCode=1;});
