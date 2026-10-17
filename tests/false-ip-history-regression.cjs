const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../browser-extension/monitor-core.js'),'utf8');
const ctx={};vm.createContext(ctx);vm.runInContext(code,ctx);
const id1='ip-target:54.46.44.121';
const id6='ipv6:2406:da1e:43ff:9df9:9ec4:49d:9ff2:ede7';
const scope='sgt:'+'a'.repeat(64);
const old='54.46.44.121',current='18.162.225.248';
let now=1760730000000;
const eventId='IP_CHANGE:'+scope+':'+id6+':999:'+current;
const beforeRoot={version:3,scopes:{
 [scope]:{instances:{
   [id1]:{ip:old,label:'#1 待定组',firstSeenAt:1,lastSeenAt:1,
      lastConfirmedAt:1,history:[],changedAt:0},
   [id6]:{ip:current,label:'#6 极图悟空',firstSeenAt:1,lastSeenAt:1,
      lastConfirmedAt:1,history:[{ip:old,replacedAt:100}],changedAt:100}
 },alerts:[{id:eventId,kind:'IP_CHANGE',instanceId:id6,label:'#6 极图悟空',
 oldIp:old,newIp:current,createdAt:999,acknowledged:false}],
 conditions:{},currentIPs:[old,current],updatedAt:10}},
 globalAlerts:[],revision:1,agentState:'OK'};
const stored={wallcheck_scoped_monitor_v3:structuredClone(beforeRoot)};
const create=()=>ctx.createWallCheckMonitor({
 read:async k=>structuredClone(stored[k]),
 write:async(k,v)=>{stored[k]=structuredClone(v)},
 clock:()=>now
});
let monitor=create();
const request=(type,records)=>monitor.dispatch({type,scope,records});
const record=(instanceId,ip,label)=>({instanceId,ip,label,pageOpenedAt:now,changedHere:false});
(async()=>{
 const res=await request('monitor:observe',[
  record(id1,old,'#1 待定组'),record(id6,current,'#6 极图悟空')
 ]);
 const suspect=res.snapshot.alerts.find(e=>e.id===eventId);
 assert.equal(suspect.kind,'IP_LINK_SUSPECT',
   'misassigned #1 old IP must be quarantined without deletion');
 assert(suspect.quarantinedAt>0);
 assert.equal(res.newAlerts.length,0,'must not emit a new desktop IP change');
 assert(!res.snapshot.alerts.some(e=>e.kind==='IP_CHANGE'));
 assert.equal(res.snapshot.instances[id6].ip,current,'#6 current address stays');
 assert.equal(res.snapshot.instances[id1].ip,old,'#1 current address stays');
 // Simulate old incorrectly stored #6 baseline, but no previous alert.
 stored.wallcheck_scoped_monitor_v3.scopes[scope].instances[id6]={
    ip:old,label:'#6 极图悟空',firstSeenAt:1,lastSeenAt:1,
    lastConfirmedAt:1,history:[],changedAt:0};
 stored.wallcheck_scoped_monitor_v3.scopes[scope].alerts=[];
 now+=2000;
 monitor=create();
 const corrected=await monitor.dispatch({type:'monitor:observe',scope,records:[
   record(id1,old,'#1 待定组'),record(id6,current,'#6 极图悟空')
 ]});
 assert.equal(corrected.newAlerts.length,1);
 assert.equal(corrected.newAlerts[0].kind,'IP_LINK_SUSPECT');
 assert.equal(corrected.snapshot.instances[id6].ip,current);
 assert.equal(corrected.snapshot.alerts.filter(e=>e.kind==='IP_CHANGE').length,0);
 // Legitimate later change not currently held by another instance still alerts.
 now+=2000;
 const real=await monitor.dispatch({type:'monitor:observe',scope,records:[
   record(id1,old,'#1 待定组'),
   {...record(id6,'18.162.225.249','#6 极图悟空'),changedHere:true}
 ]});
 assert.equal(real.newAlerts.filter(e=>e.kind==='IP_CHANGE').length,1);
 assert.equal(real.newAlerts.find(e=>e.kind==='IP_CHANGE').oldIp,current);
 console.log('FALSE_IP_HISTORY_REGRESSION_PASS: existing #6 evidence preserved but quarantined, mismapped baseline repaired, legitimate #6 A-B still alerts');
})().catch(e=>{console.error(e);process.exitCode=1;});
