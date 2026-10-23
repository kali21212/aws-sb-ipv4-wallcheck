const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const context={};vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../browser-extension/monitor-core.js'),'utf8'),context);
let now=1792750000000;
const scope='sgt:'+'a'.repeat(64), other='sgt:'+'b'.repeat(64),db={};
let mon=context.createWallCheckMonitor({read:async k=>structuredClone(db[k]),
 write:async(k,v)=>{db[k]=structuredClone(v)},clock:()=>now});
const account=(slots,sc=scope)=>mon.dispatch({scope:sc,type:'monitor:account',records:slots});
const observe=(records,sc=scope)=>mon.dispatch({scope:sc,type:'monitor:observe',records});
const msg=(slot,ip,id,opts={})=>({
  slot:String(slot),ip,label:'#'+slot+' '+(slot===1?'示例组一':'示例账号二'),
  instanceId:id,invalid:false,replacing:false,verified22:!!opts.verified,
  pageOpenedAt:opts.opened||now-60000,changedHere:!!opts.changed
});
const rec=(id,ip,slot)=>({instanceId:id,ip,label:'#'+slot+' 示例组一',
 pageOpenedAt:now,changedHere:false});
const A='ipv6:2001:db8:bb4:fc00:36b8:c292:306c:ca8b';
const B='ipv6:2001:db8:123::23';
const C='ipv6:2001:db8:123::22';
const old='203.0.113.109',fresh='203.0.113.105',third='203.0.113.106';
const one=()=>db.wallcheck_scoped_monitor_v3.scopes[scope];
const pending=(kind)=>one().alerts.filter(e=>e.kind===kind&&!e.acknowledged);
(async()=>{
  // Initial capture of #1 and #2 must never manufacture a switch.
  await account([msg(1,old,A),msg(2,'203.0.113.112','ipv6:2001:db8:a15:2c00:b3cc:a8e:5dfc:299a')]);
  await observe([rec(A,old,1)]);
  assert.equal(pending('SLOT_IP_CHANGE').length,0);
  now+=10000;
  // Both IPv4 AND IPv6 changed, so the old machine-ID-based IP_CHANGE path
  // can only create a second baseline; monitor must still alert #1 slot.
  let r=await account([msg(1,fresh,B,{opened:now-5000,changed:true}),
    msg(2,'203.0.113.112','ipv6:2001:db8:a15:2c00:b3cc:a8e:5dfc:299a')]);
  await observe([rec(B,fresh,1)]);
  assert.equal(pending('IP_CHANGE').length,0,'replacement is not same-machine change');
  assert.equal(pending('SLOT_IP_CHANGE').length,1,
    'same sgt + same card slot replaced its IPv6/IPv4: must notify');
  assert.equal(pending('SLOT_IP_CHANGE')[0].oldIp,old);
  assert.equal(pending('SLOT_IP_CHANGE')[0].newIp,fresh);
  assert.equal(pending('SLOT_IP_CHANGE')[0].slot,'1');
  assert.equal(one().accountStates['1'].lastIp,fresh);
  now+=1000;
  r=await account([msg(1,fresh,B)]);
  assert.equal(r.newAlerts.length,0,'refresh or repeated scan must not re-notify');
  // A->B->C must accumulate until a single manual group acknowledgement.
  now+=1000;
  r=await account([msg(1,third,C,{opened:now-1000,changed:true})]);
  assert.equal(pending('SLOT_IP_CHANGE').length,2,'cumulative history');
  assert.equal(pending('SLOT_IP_CHANGE')[1].oldIp,fresh);
  assert.equal(pending('SLOT_IP_CHANGE')[1].newIp,third);
  // Older tab showing oldIP after the new observation must be ignored.
  now+=1000;
  r=await account([msg(1,old,A,{opened:now-100000})]);
  assert.equal(one().accountStates['1'].lastIp,third);
  assert.equal(r.newAlerts.length,0);
  // Acknowledgement removes ALL pending slot-change events, not the baseline.
  await mon.dispatch({scope,type:'monitor:ack-slot-group',slot:'1'});
  assert.equal(pending('SLOT_IP_CHANGE').length,0);
  assert.equal(one().accountStates['1'].lastIp,third);
  assert.equal(one().instances[A].ip,old,'old instance history preserved');
  assert.equal(one().instances[B].ip,fresh,'replacement baseline preserved');
  // New incident after acknowledged group not suppressed.
  now+=10000;
  r=await account([msg(1,'203.0.113.107','ipv6:2001:db8:123::24',
   {changed:true,opened:now-1000})]);
  assert.equal(r.newAlerts.filter(e=>e.kind==='SLOT_IP_CHANGE').length,1);
  // Different scope with same #1 does not share state.
  r=await account([msg(1,'198.51.100.19',C)],other);
  assert.equal(r.newAlerts.length,0);
  // No cross-card IP association: #1 old IP still visible as #2 => suspect.
  const cross='sgt:'+'c'.repeat(64);
  await account([msg(1,old,A),msg(2,fresh,B)],cross);
  now+=5000;
  r=await account([msg(1,third,C,{changed:true}),
     msg(2,old,A)],cross);
  assert.equal(r.newAlerts.filter(e=>e.kind==='SLOT_IP_CHANGE').length,0,
   'IP still on neighboring card MUST NOT be claimed as real slot switch');
  // Regression: when underlying identity is stable, only existing primary
  // machine IP_CHANGE may be emitted, no duplicate SLOT_IP_CHANGE.
  const stable='sgt:'+'d'.repeat(64);
  now+=1000;
  await account([msg(1,old,A)],stable);
  await observe([rec(A,old,1)],stable);
  now+=5000;
  await account([msg(1,fresh,A,{opened:now-1000,changed:true})],stable);
  await observe([{...rec(A,fresh,1),changedHere:true}],stable);
  assert.equal(db.wallcheck_scoped_monitor_v3.scopes[stable].alerts.filter(e=>e.kind==='SLOT_IP_CHANGE').length,0);
  assert.equal(db.wallcheck_scoped_monitor_v3.scopes[stable].alerts.filter(e=>e.kind==='IP_CHANGE').length,1);
  const entire=JSON.stringify(db);
  assert(!entire.includes('private@example.com'));
  assert(!entire.includes('sgt='));
  console.log('SLOT_IP_TRANSITION_PASS: matching slot survives changed IPv6, accumulated group ack, stale-tab no reversal, cross-card no false alert, stable-ID no duplicate');
})().catch(e=>{console.error(e);process.exitCode=1;});
