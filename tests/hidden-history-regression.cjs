const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context={};vm.createContext(context);
const ext=path.join(__dirname,'../browser-extension');
vm.runInContext(fs.readFileSync(path.join(ext,'monitor-core.js'),'utf8'),context);
const a='sgt:'+'a'.repeat(64),b='sgt:'+'b'.repeat(64);
const id0='ipv6:2001:db8:123::13';
const id1='ipv6:2001:db8:123::14';
const id2='ipv6:2001:db8:123::15';
const id3='ipv6:2001:db8:123::60';
const addr0='203.0.113.115',addr1='203.0.113.102',
  addr2='203.0.113.112',addr3='203.0.113.108';
const storage={};let now=1760751000000;
const make=()=>context.createWallCheckMonitor({
 read:async k=>storage[k]?structuredClone(storage[k]):undefined,
 write:async(k,v)=>{storage[k]=structuredClone(v);},
 clock:()=>++now
});
const mon=make();
const invoke=(scope,type,args={})=>mon.dispatch({scope,type,...args});
const rec=(ip,instanceId,label)=>({ip,instanceId,label,pageOpenedAt:now+100,changedHere:false});
(async()=>{
  let snap=await invoke(a,'monitor:observe',{records:[
    rec(addr0,id0,'#1 示例组一'),rec(addr1,id1,'#2 示例账号二'),rec(addr2,id2,'#3 广州')]});
  assert.deepEqual([...snap.snapshot.currentIPs].sort(),[addr0,addr1,addr2].sort());
  assert.equal(snap.snapshot.hiddenNoticeAckKey,'','new default');
  const snapB=await invoke(b,'monitor:observe',{records:[rec(addr3,id3,'#1 备用')]});
  assert.equal(snapB.snapshot.hiddenNoticeAckKey,'');
  // Acknowledging a normal change/fault does not remove historic targets.
  const changed=await invoke(a,'monitor:observe',{records:[
    {...rec('203.0.113.116',id0,'#1 示例组一'),changedHere:true}
  ]});
  assert(changed.snapshot.alerts.some(x=>x.kind==='IP_CHANGE'));
  const change=changed.snapshot.alerts.find(x=>x.kind==='IP_CHANGE');
  await invoke(a,'monitor:ack',{ids:[change.id]});
  snap=await invoke(a,'monitor:get');
  assert.equal(snap.snapshot.currentIPs.includes(addr1),true);
  assert.equal(snap.snapshot.currentIPs.includes(addr2),true);
  assert.equal(snap.snapshot.hiddenNoticeAckKey,'');
  // A source-IP in current scope but not in visible cards can be dismissed.
  const suppress=await invoke(a,'monitor:ack-hidden',{hiddenIPs:[addr1]});
  assert.equal(suppress.snapshot.hiddenNoticeAckKey,addr1);
  assert.equal(Object.keys(suppress.snapshot.instances).length,3);
  assert.equal(suppress.snapshot.currentIPs.length,3);
  assert(!suppress.snapshot.alerts.some(x=>x.kind==='IP_CHANGE'),
    'hidden ack must not restore old alerts');
  // Recreated service worker after page refresh must retain the exact ack.
  const restarted=make();
  const again=await restarted.dispatch({scope:a,type:'monitor:get'});
  assert.equal(again.snapshot.hiddenNoticeAckKey,addr1);
  assert.equal((await restarted.dispatch({scope:b,type:'monitor:get'})).snapshot.hiddenNoticeAckKey,'');
  // A NEW list of missing IPs must not be suppressed by the old acknowledgement.
  const changedHidden=await restarted.dispatch({scope:a,type:'monitor:ack-hidden',
    hiddenIPs:[addr1,addr2]});
  assert.equal(changedHidden.snapshot.hiddenNoticeAckKey,[addr1,addr2].sort().join('|'));
  assert.notEqual(changedHidden.snapshot.hiddenNoticeAckKey,addr1);
  // Invalid/no-scope IPs cannot be used to poison another account's notice.
  await assert.rejects(()=>restarted.dispatch({scope:a,type:'monitor:ack-hidden',
    hiddenIPs:['198.51.100.99']}),/Invalid historic/);
  assert.equal((await restarted.dispatch({scope:a,type:'monitor:get'}))
    .snapshot.hiddenNoticeAckKey,[addr1,addr2].sort().join('|'));
  // Real A-B-C history still functions normally after the hidden-target ack.
  const next=await restarted.dispatch({scope:a,type:'monitor:observe',records:[
    {...rec('203.0.113.117',id0,'#1 示例组一'),changedHere:true}
  ]});
  assert(next.newAlerts.some(x=>x.kind==='IP_CHANGE'));
  assert.equal(next.snapshot.hiddenNoticeAckKey,[addr1,addr2].sort().join('|'));
  // Original clear action re-baselines this scope, without affecting another.
  const cleared=await restarted.dispatch({scope:a,type:'monitor:clear',records:[
    rec('203.0.113.117',id0,'#1 示例组一')]});
  assert.equal(cleared.snapshot.hiddenNoticeAckKey,'');
  assert.deepEqual([...cleared.snapshot.currentIPs],['203.0.113.117']);
  assert.equal((await restarted.dispatch({scope:b,type:'monitor:get'}))
    .snapshot.instances[id3].ip,addr3);
  const content=fs.readFileSync(path.join(ext,'content.js'),'utf8');
  assert(content.includes("monitor:ack-hidden"));
  assert(content.includes('renderHiddenNotice('));
  assert(content.includes("scopeCurrentIPs.filter(ip=>!visible.has(ip))"),
    'set difference must be used instead of count difference');
  assert(!content.includes("个历史目标本页未显示' : ''"),
    'unacknowledged historic targets cannot pollute the health/status line');
  console.log('HIDDEN_HISTORY_ACK_PASS: separate acknowledgement, survives refresh, scope isolated, no record deletion, new hidden set alerts, safe on change');
})().catch(e=>{console.error(e);process.exitCode=1;});
