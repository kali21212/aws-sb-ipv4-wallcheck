const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const dir=path.resolve(__dirname,'../browser-extension');
const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(dir,'monitor-core.js'),'utf8'),ctx);
const a='sgt:'+'a'.repeat(64),b='sgt:'+'b'.repeat(64),c='sgt:'+'c'.repeat(64);
const key='wallcheck_scoped_monitor_v3';
let now=1000000;
const existingId='ipv6:2001:db8:100::b';
const store={
 [key]:{
 version:3,
 scopes:{[a]:{instances:{[existingId]:{ip:'203.0.113.106',label:'#1 旧列表',
   firstSeenAt:300000,lastSeenAt:300000,lastConfirmedAt:300000,history:[],changedAt:0}},
   alerts:[],conditions:{},currentIPs:['203.0.113.106'],updatedAt:300000}},
 globalAlerts:[],agentState:'OK',revision:1}
};
const monitor=ctx.createWallCheckMonitor({
 read:async key=>structuredClone(store[key]),
 write:async(key,value)=>{store[key]=structuredClone(value);},
 clock:()=>now
});
const get=(scope,type,extra={})=>monitor.dispatch({scope,type,...extra});
const rec=(ip,id,label)=>({instanceId:id,ip,label,pageOpenedAt:now,changedHere:false});
const news=r=>r.snapshot.alerts.filter(x=>x.kind==='SCOPE_ONBOARDED'&&!x.acknowledged);
(async()=>{
  // Old 1.9.0 scopes may lack onboarding metadata: never manufacture old alerts.
  let result=await get(a,'monitor:observe',{records:[rec('203.0.113.106',existingId,'#1 旧列表')]});
  assert.equal(news(result).length,0,'existing account baseline must remain silent');
  // New list's initial GET creates an empty scope before the page renders valid IPs.
  result=await get(b,'monitor:get');
  assert.equal(news(result).length,0);
  result=await get(b,'monitor:observe',{records:[]});
  assert.equal(news(result).length,0,'login failure / empty page must not notify');
  now+=1000;
  result=await get(b,'monitor:observe',{records:[
    rec('203.0.113.115','ipv6:2001:db8:100::8','#1 待定组'),
    rec('203.0.113.111','ipv6:2001:db8:100::9','#2 广州')
  ]});
  const onboarding=news(result);
  assert.equal(onboarding.length,1,'new monitor list must notify exactly once');
  assert.equal(result.newAlerts.length,1);
  assert.equal(onboarding[0].observedCount,2);
  assert.equal(onboarding[0].ip,'203.0.113.115');
  assert.equal(onboarding[0].label,'#1 待定组');
  assert(!JSON.stringify(store).includes('synthetic-sgt-raw-token'));
  assert.equal(result.snapshot.alerts.filter(x=>x.kind==='IP_CHANGE').length,0,
    'new sgt first seen is not cross-account IP change');
  const id=onboarding[0].id;
  now+=2000;
  result=await get(b,'monitor:observe',{records:[
    rec('203.0.113.115','ipv6:2001:db8:100::8','#1 待定组')
  ]});
  assert.equal(result.newAlerts.length,0,'returning/rechecking same scope must not notify');
  result=await get(b,'monitor:ack',{ids:[id]});
  assert.equal(news(result).length,0,'ack must hide the new-list notice');
  result=await get(b,'monitor:get');
  assert.equal(news(result).length,0,'ack must be durable');
  now+=3000;
  result=await get(b,'monitor:observe',{records:[
    rec('203.0.113.116','ipv6:2001:db8:100::8','#1 待定组')
  ]});
  // The same instance in B changing its IP continues to generate IP_CHANGE.
  assert.equal(result.snapshot.alerts.filter(x=>x.kind==='IP_CHANGE'&&!x.acknowledged).length,1);
  assert.equal(news(result).length,0);
  // Clearing the list must not recreate the onboarding notice.
  await get(b,'monitor:clear',{records:[
    rec('203.0.113.116','ipv6:2001:db8:100::8','#1 待定组')
  ]});
  result=await get(b,'monitor:observe',{records:[
    rec('203.0.113.116','ipv6:2001:db8:100::8','#1 待定组')
  ]});
  assert.equal(news(result).length,0);
  // New C uses identical #1 label with another address: must be a NEW scope
  // onboarding, NOT a false cross-account A->B IP history.
  result=await get(c,'monitor:observe',{records:[
    rec('192.0.2.55','ipv6:2001:db8:100::16','#1 待定组')
  ]});
  assert.equal(news(result).length,1);
  assert.equal(result.snapshot.alerts.filter(x=>x.kind==='IP_CHANGE').length,0);
  assert.equal((await get(a,'monitor:get')).snapshot.instances[existingId].ip,
    '203.0.113.106');
  const source=fs.readFileSync(path.join(dir,'background.js'),'utf8');
  assert(source.includes("event.kind==='SCOPE_ONBOARDED'"));
  const ui=fs.readFileSync(path.join(dir,'content.js'),'utf8');
  assert(ui.includes('wc-new-list')&&ui.includes('新监控列表已接入'));
  console.log('NEW_SCOPE_NOTICE_PASS: one toast per new scoped list, ack durable, empty-page suppression, old accounts untouched, no #1 confusion');
})().catch(e=>{console.error(e);process.exitCode=1;});
