const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const dir=path.resolve(__dirname,'..','browser-extension');
const context={};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(dir,'monitor-core.js'),'utf8'),context);
const KEY='wallcheck_scoped_monitor_v3';
const scopeA='sgt:'+'a'.repeat(64),scopeB='sgt:'+'b'.repeat(64);
let now=1000000;
const db={
  wallcheck_instance_state_v1:{'aws-sb-slot-1':{ip:'192.0.2.99'}},
  wallcheck_alert_events_v1:[{id:'FAKE-OLD-CHANGE',kind:'IP_CHANGE',acknowledged:false}],
  wallcheck_ipv4_list_v2:['192.0.2.99']
};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const monitor=context.createWallCheckMonitor({
 read:async key=>{await delay(1);return db[key]?structuredClone(db[key]):undefined;},
 write:async(key,value)=>{await delay(1);db[key]=structuredClone(value);},
 clock:()=>now
});
const rec=(ip,id='ipv6:2406:da1e:abcd:1234::1',label='#1 备用',pageOpenedAt=990000,changedHere=false)=>
 ({instanceId:id,ip,label,pageOpenedAt,changedHere});
const observe=(scope,...records)=>monitor.dispatch({type:'monitor:observe',scope,records});
const ids=result=>result.snapshot.alerts.filter(e=>e.kind==='IP_CHANGE'&&!e.acknowledged);
(async()=>{
 // Two different sgt pages both have #1: absolutely independent baselines.
 let a=await observe(scopeA,rec('16.106.35.233'));
 let b=await observe(scopeB,rec('16.163.108.113','ipv6:2406:da1e:dead:beef::3','#1 待定组'));
 assert.equal(ids(a).length,0);assert.equal(ids(b).length,0);
 assert.equal(a.snapshot.currentIPs[0],'16.106.35.233');
 assert.equal(b.snapshot.currentIPs[0],'16.163.108.113');
 now+=3000;
 a=await observe(scopeA,rec('16.106.35.233'));
 b=await observe(scopeB,rec('16.163.108.113','ipv6:2406:da1e:dead:beef::3','#1 待定组'));
 assert.equal(ids(a).length,0);assert.equal(ids(b).length,0);
 // Simultaneous identical-sgt tabs must have serialized writes, not last-write-wins.
 now+=2000;
 const shared='ec2:i-0123456789ab';
 const first=await observe(scopeA,rec('192.0.2.1',shared,'#2 广州',now-50));
 const p=await Promise.all([
   observe(scopeA,rec('192.0.2.2',shared,'#2 广州',now+200,true)),
   observe(scopeB,rec('192.0.2.20','ipv6:2406:da1e:bb::5','#2 老用户',now,true))
 ]);
 assert.equal(ids(p[0]).length,1);
 assert.equal(ids(p[1]).length,0);
 // Repeating same observation cannot create duplicate alerts.
 const again=await observe(scopeA,rec('192.0.2.2',shared,'#2 广州',now+200,false));
 assert.equal(ids(again).length,1);
 // Stale tab opened before last accepted change MUST NOT revert B to A.
 now+=5000;
 const stale=await observe(scopeA,rec('192.0.2.1',shared,'#2 广州',990001,false));
 assert.equal(stale.snapshot.instances[shared].ip,'192.0.2.2');
 assert.equal(ids(stale).length,1);
 // An explicit on-page update (A->B->C) yields distinct events.
 now+=3000;
 const another=await observe(scopeA,rec('192.0.2.3',shared,'#2 广州',990001,true));
 // A new same-sgt tab can render an older cached address. A reverse
 // observation without an actual in-page change must not create an alert.
 const reloadedStale=await observe(scopeA,rec('192.0.2.1',shared,'#2 广州',now+500,false));
 assert.equal(reloadedStale.snapshot.instances[shared].ip,'192.0.2.3');
 const changes=ids(another).filter(e=>e.instanceId===shared);
 assert.equal(changes.length,2);
 assert.equal(changes[0].oldIp,'192.0.2.1');
 assert.equal(changes[0].newIp,'192.0.2.2');
 assert.equal(changes[1].oldIp,'192.0.2.2');
 assert.equal(changes[1].newIp,'192.0.2.3');
 // Acknowledgement races with a different tab's observe: no lost updates.
 now+=3000;
 const acked=await Promise.all([
   monitor.dispatch({type:'monitor:ack',scope:scopeA,ids:[changes[0].id,changes[1].id]}),
   observe(scopeA,rec('192.0.2.3',shared,'#2 广州',990001,false))
 ]);
 const finalA=await monitor.dispatch({type:'monitor:get',scope:scopeA});
 const finalB=await monitor.dispatch({type:'monitor:get',scope:scopeB});
 assert.equal(ids(finalA).length,0);
 assert.equal(ids(finalB).length,0);
 assert.equal(finalA.snapshot.alerts.filter(e=>e.kind==='IP_CHANGE').length,0, 'ack must delete persisted change detail rows');
 assert.equal(finalA.snapshot.instances[shared].ip,'192.0.2.3', 'ack must retain latest IP baseline');
 // Acknowledge in A must not alter the current IP or state for B.
 assert.equal(finalB.snapshot.instances['ipv6:2406:da1e:dead:beef::3'].ip,'16.163.108.113');
 // Clear A atomically + re-baseline, never alters B. It also clears saved alerts.
 const clear=await monitor.dispatch({type:'monitor:clear',scope:scopeA,
   records:[rec('192.0.2.3',shared,'#2 广州')]});
 assert.equal(clear.snapshot.alerts.filter(e=>e.kind==='IP_CHANGE').length,0);
 const afterClear=await observe(scopeA,rec('192.0.2.3',shared,'#2 广州',990001,false));
 assert.equal(ids(afterClear).length,0);
 assert.equal((await monitor.dispatch({type:'monitor:get',scope:scopeB})).snapshot.instances['ipv6:2406:da1e:dead:beef::3'].ip,'16.163.108.113');
 // Unstable identity cannot infer a change (even when display ordinal reused).
 const unstable=await observe(scopeA,rec('192.0.2.88','ip-target:192.0.2.88','#1 备用',now+100,true));
 assert.equal(ids(unstable).length,0);
 // Simulate being away for days. Keep every unacknowledged change (not just
 // A->B and B->C) and remove the entire instance group with one action.
 const backlogId='ec2:i-11111111111111111';
 now+=3000;
 await observe(scopeA,rec('10.20.0.1',backlogId,'#3 长期监控',now+100,true));
 for(let i=1;i<=610;i++){
   now+=1000;
   const ip='10.20.'+Math.floor(i/250)+'.'+(i%250+1);
   await observe(scopeA,rec(ip,backlogId,'#3 长期监控',now+100,true));
 }
 const beforeGroupAck=await monitor.dispatch({type:'monitor:get',scope:scopeA});
 const pendingForGroup=ids(beforeGroupAck).filter(e=>e.instanceId===backlogId);
 assert.equal(pendingForGroup.length,610,'all 610 unacknowledged events must remain');
 assert(pendingForGroup.every(e=>!e.acknowledged),'none auto-acknowledged');
 assert.equal(pendingForGroup[0].oldIp,'10.20.0.1');
 assert.equal(pendingForGroup[609].newIp,'10.20.2.111');
 // Add an independent warning in the same sgt to prove per-group deletion.
 now+=1000;
 await monitor.dispatch({type:'monitor:reachability',scope:scopeA,
   items:[{instanceId:backlogId,ip:'10.20.2.111',status:'PORT22_UNREACHABLE'}]});
 const deleted=await monitor.dispatch({type:'monitor:ack-change-group',scope:scopeA,instanceId:backlogId});
 assert.equal(ids(deleted).filter(e=>e.instanceId===backlogId).length,0);
 assert.equal(deleted.snapshot.alerts.filter(e=>e.kind==='PORT22_UNREACHABLE' &&
   e.instanceId===backlogId).length,1,'group change acknowledgement must not hide separate port alert');
 assert.equal(deleted.snapshot.instances[backlogId].ip,'10.20.2.111');
 assert.equal(deleted.snapshot.instances[backlogId].history.length,40,'bounded anti-stale metadata is preserved');
 now+=1000;
 const future=await observe(scopeA,rec('10.20.10.50',backlogId,'#3 长期监控',now+100,true));
 assert.equal(ids(future).filter(e=>e.instanceId===backlogId).length,1,'monitoring continues after acknowledgement');
 const getAfterAck=await monitor.dispatch({type:'monitor:get',scope:scopeA});
 assert.equal(ids(getAfterAck).filter(e=>e.instanceId===backlogId).length,1);
 // Same action cannot delete another signed account's data.
 assert.equal((await monitor.dispatch({type:'monitor:get',scope:scopeB}))
   .snapshot.instances['ipv6:2406:da1e:dead:beef::3'].ip,'16.163.108.113');
 // One-time migration: already-acknowledged 1.8.0 IP details are pruned
 // on first 1.8.1 read, while still-pending entries remain untouched.
 db[KEY].scopes[scopeA].alerts.push({
   id:'OLD_ACK_V180',kind:'IP_CHANGE',instanceId:backlogId,
   createdAt:now-2000,acknowledged:true,oldIp:'a',newIp:'b'
 });
 const migrated=await monitor.dispatch({type:'monitor:get',scope:scopeA});
 assert(!migrated.snapshot.alerts.some(e=>e.id==='OLD_ACK_V180'));
 assert.equal(ids(migrated).filter(e=>e.instanceId===backlogId).length,1);
 // Two pages with agent down create ONE global alert, not N duplicate alarms.
 now+=3000;
 const faults=await Promise.all([
   monitor.dispatch({type:'monitor:agent',scope:scopeA,ok:false,reason:'agent not running'}),
   monitor.dispatch({type:'monitor:agent',scope:scopeB,ok:false,reason:'agent not running'})
 ]);
 assert.equal(faults.reduce((n,x)=>n+x.newAlerts.length,0),1);
 const healthy=await monitor.dispatch({type:'monitor:agent',scope:scopeA,ok:true});
 assert(healthy.snapshot.alerts.find(e=>e.kind==='AGENT_OFFLINE').resolvedAt);
 assert.equal(db.wallcheck_alert_events_v1[0].id,'FAKE-OLD-CHANGE');
 // Old v1 data is quarantined: not present in any new active scope.
 assert(!JSON.stringify(db[KEY]).includes('FAKE-OLD-CHANGE'));
 // No sgt token is stored. Only digests and machine IDs are present.
 const saved=JSON.stringify(db[KEY]);
 assert(saved.includes(scopeA)&&saved.includes(scopeB));
 assert(!saved.includes('synthetic-scope-A-123'));
 console.log('PASS scoped monitor: 2 sgt pages with duplicate ordinals, serialized same-sgt tabs, stale reversal guard, A-B-C chain, acknowledgement, isolated reset, fault dedupe and quarantined legacy');
})().catch(e=>{console.error(e);process.exitCode=1;});
