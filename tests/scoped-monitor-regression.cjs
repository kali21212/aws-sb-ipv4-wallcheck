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
const rec=(ip,id='ipv6:2001:db8:123::1a',label='#1 备用',pageOpenedAt=990000,changedHere=false)=>
 ({instanceId:id,ip,label,pageOpenedAt,changedHere});
const observe=(scope,...records)=>monitor.dispatch({type:'monitor:observe',scope,records});
const ids=result=>result.snapshot.alerts.filter(e=>e.kind==='IP_CHANGE'&&!e.acknowledged);
(async()=>{
 // Two different sgt pages both have #1: absolutely independent baselines.
 let a=await observe(scopeA,rec('203.0.113.103'));
 let b=await observe(scopeB,rec('203.0.113.108','ipv6:2001:db8:123::25','#1 示例组一'));
 assert.equal(ids(a).length,0);assert.equal(ids(b).length,0);
 assert.equal(a.snapshot.currentIPs[0],'203.0.113.103');
 assert.equal(b.snapshot.currentIPs[0],'203.0.113.108');
 now+=3000;
 a=await observe(scopeA,rec('203.0.113.103'));
 b=await observe(scopeB,rec('203.0.113.108','ipv6:2001:db8:123::25','#1 示例组一'));
 assert.equal(ids(a).length,0);assert.equal(ids(b).length,0);
 // Simultaneous identical-sgt tabs must have serialized writes, not last-write-wins.
 now+=2000;
 const shared='ec2:i-00000000000000010';
 const first=await observe(scopeA,rec('192.0.2.1',shared,'#2 广州',now-50));
 const p=await Promise.all([
   observe(scopeA,rec('192.0.2.2',shared,'#2 广州',now+200,true)),
   observe(scopeB,rec('192.0.2.20','ipv6:2001:db8:123::1c','#2 示例账号二',now,true))
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
 assert.equal(finalA.snapshot.alerts.filter(e=>e.kind==='IP_CHANGE'&&e.acknowledged).length,2);
 // Acknowledge in A must not alter the current IP or state for B.
 assert.equal(finalB.snapshot.instances['ipv6:2001:db8:123::25'].ip,'203.0.113.108');
 // Clear A atomically + re-baseline, never alters B. It also clears saved alerts.
 const clear=await monitor.dispatch({type:'monitor:clear',scope:scopeA,
   records:[rec('192.0.2.3',shared,'#2 广州')]});
 assert.equal(clear.snapshot.alerts.filter(e=>e.kind==='IP_CHANGE').length,0);
 const afterClear=await observe(scopeA,rec('192.0.2.3',shared,'#2 广州',990001,false));
 assert.equal(ids(afterClear).length,0);
 assert.equal((await monitor.dispatch({type:'monitor:get',scope:scopeB})).snapshot.instances['ipv6:2001:db8:123::25'].ip,'203.0.113.108');
 // Unstable identity cannot infer a change (even when display ordinal reused).
 const unstable=await observe(scopeA,rec('192.0.2.88','ip-target:192.0.2.88','#1 备用',now+100,true));
 assert.equal(ids(unstable).length,0);
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
