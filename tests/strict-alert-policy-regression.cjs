const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'../browser-extension');
const src=fs.readFileSync(path.join(root,'content.js'),'utf8');
const context={
  console,document:{body:{}},
  location:{origin:'https://aws.sb',hash:'#/ec2-instances?sgt=local-test-sgt'},
  crypto:require('node:crypto').webcrypto,TextEncoder,URLSearchParams,
  chrome:{storage:{local:{}},runtime:{}},Map,Set,Promise,Uint8Array,
  queueMicrotask,Date,setTimeout:()=>{},clearTimeout:()=>{}
};
vm.createContext(context);
const injected=src.replace('  install();','  globalThis.probeTest={classify,badgeClass};');
assert.notEqual(injected,src);
vm.runInContext(injected,context);
const probe=context.probeTest;
const ip='192.0.2.17';
const classify=(ping,tcp)=>{
  const response={results:{[ip]:{
    icmp:ping?{state:ping}:undefined,
    ports:tcp?[{port:22,state:tcp}]:[]
  }}};
  return probe.classify(ip,response);
};
for(const [icmp,tcp,key] of [
  ['REACHABLE','OPEN','LOCAL_OK'],
  ['NO_REPLY','OPEN','PING_UNREACHABLE'],
  ['ERROR','OPEN','PING_UNREACHABLE'],
  ['REACHABLE','TIMEOUT','PORT_22_UNREACHABLE'],
  ['REACHABLE','REFUSED','PORT_22_UNREACHABLE'],
  ['REACHABLE','ERROR','PORT_22_UNREACHABLE'],
  ['REACHABLE','UNREACHABLE','PORT_22_UNREACHABLE'],
  ['NO_REPLY','TIMEOUT','LOCAL_FAIL'],
  ['NO_REPLY','REFUSED','LOCAL_FAIL'],
  ['ERROR','ERROR','LOCAL_FAIL'],
  ['NO_REPLY',null,'PING_UNREACHABLE'],
  [null,'TIMEOUT','PORT_22_UNREACHABLE'],
  [null,'OPEN','PROBE_UNVERIFIED']
]){
  const result=classify(icmp,tcp);
  assert.equal(result.key,key,'unexpected classification for '+icmp+' '+tcp);
  if(key==='LOCAL_OK')assert.equal(probe.badgeClass(key),'wc-ok');
  else if(key==='PROBE_UNVERIFIED')assert.equal(probe.badgeClass(key),'wc-unknown');
  else{
    assert.equal(probe.badgeClass(key),'wc-bad','failure is NOT red');
    assert(result.text.includes('🔴'),'red marker missing');
  }
}
assert.equal(probe.classify(ip,{results:{}}).key,'LOCAL_OFFLINE',
  'missing local probe data must not accuse AWS instance');
assert(!classify('NO_REPLY','OPEN').text.startsWith('✅'),
  'prior 1.9.6 false-green Ping_NO_REPLY+TCP_OPEN regression');

const core={};vm.createContext(core);
vm.runInContext(fs.readFileSync(path.join(root,'monitor-core.js'),'utf8'),core);
let now=1800000001000;
const db={};
const monitor=core.createWallCheckMonitor({
  read:async key=>db[key]?structuredClone(db[key]):undefined,
  write:async (key,value)=>{db[key]=structuredClone(value)},
  clock:()=>now
});
const scope='sgt:'+'a'.repeat(64);
const instanceId='ipv6:2001:db8:123::61';
const observe=()=>monitor.dispatch({scope,type:'monitor:observe',records:[{
  instanceId,ip,label:'#1 示例组一',pageOpenedAt:now-1000,changedHere:false
}]});
const update=status=>monitor.dispatch({scope,type:'monitor:reachability',
  items:[{instanceId,ip,status}]});
(async()=>{
 await observe();
 let r=await update('OK');
 assert.equal(r.newAlerts.length,0);
 now+=1000;
 r=await update('PING_UNREACHABLE');
 assert.equal(r.newAlerts.length,1,'Ping alone MUST create an event');
 assert.equal(r.newAlerts[0].kind,'PING_UNREACHABLE');
 assert(r.newAlerts[0].reason.includes('严重'));
 const first=r.newAlerts[0].id;
 now+=600000;
 r=await update('PING_UNREACHABLE');
 assert.equal(r.newAlerts.length,0,'unchanged fault must not spam every scan');
 now+=1000;
 r=await update('HOST_UNREACHABLE');
 assert.equal(r.newAlerts.length,1,'new stronger failure can be recorded');
 const restored=r.snapshot.alerts.find(e=>e.id===first);
 assert(restored.resolvedAt>0,'previous fault state is superseded');
 now+=1000;
 r=await update('OK');
 assert.equal(r.newAlerts.length,0,'recovery does not trigger severe fault');
 assert(r.snapshot.alerts.find(e=>e.kind==='HOST_UNREACHABLE').resolvedAt>0);
 now+=1000;
 r=await update('PORT22_UNREACHABLE');
 assert.equal(r.newAlerts.length,1,'later TCP failure after recovery alerts anew');
 now+=1000;
 r=await update('OK');
 assert.equal(r.newAlerts.length,0);
 now+=1000;
 r=await update('PING_UNREACHABLE');
 assert.equal(r.newAlerts.length,1,'later Ping failure after recovery alerts anew');
 assert.notEqual(r.newAlerts[0].id,first);
 // Pending ack does not disable future transitions.
 r=await monitor.dispatch({scope,type:'monitor:ack',ids:[r.newAlerts[0].id]});
 assert(r.snapshot.alerts.some(e=>e.kind==='PING_UNREACHABLE' && e.acknowledged));
 const bkg=fs.readFileSync(path.join(root,'background.js'),'utf8');
 assert(bkg.includes("event.kind==='PING_UNREACHABLE'"));
 assert(bkg.includes('newMonitorNotification(ev)'),
  'new events must reach native Chromium notification emitter');
 assert(bkg.includes('chrome.notifications.create('));
 console.log('STRICT_OR_SEVERE_ALERT_PASS: Ping NO_REPLY+TCP OPEN RED, TCP fail RED, both fail RED, dedupe, recover/recur, native toast dispatch');
})().catch(err=>{console.error(err);process.exitCode=1});
