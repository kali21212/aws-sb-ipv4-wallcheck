const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const stage=path.resolve(__dirname,'../browser-extension');
const context={};vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(stage,'monitor-core.js'),'utf8'),context);
const scope='sgt:'+'a'.repeat(64),other='sgt:'+'b'.repeat(64);
const KEY='wallcheck_scoped_monitor_v3';
const db={};let now=1800000000000;
const create=()=>context.createWallCheckMonitor({
  read:async k=>db[k]?structuredClone(db[k]):undefined,
  write:async(k,v)=>{db[k]=structuredClone(v)},
  clock:()=>now
});
let core=create();
const obs=(slot,label,ip,invalid=false,replacing=false,verified22=false)=>
  ({slot:String(slot),label,ip,invalid,replacing,verified22,
     email:'private@example.test',accountToken:'PRIVATE_TOKEN_MUST_NOT_PERSIST'});
const account=(records,sc=scope)=>core.dispatch({scope:sc,type:'monitor:account',records});
const pending=(result,kind)=>result.snapshot.alerts.filter(e=>e.kind===kind&&!e.acknowledged);
(async()=>{
 // Set baseline for a healthy account; this is NOT a cross-machine IP event.
 let r=await account([obs(2,'#2 示例账号二','203.0.113.104')]);
 assert.equal(r.newAlerts.length,0);
 assert.equal(r.snapshot.accountStates['2'].lastIp,'203.0.113.104');
 now+=1000;
 r=await account([obs(2,'#2 示例账号二','203.0.113.104',true,true)]);
 assert.equal(r.newAlerts.map(e=>e.kind).join(','),'ACCOUNT_INVALID');
 assert.equal(r.newAlerts[0].slot,'2');
 assert.equal(r.newAlerts[0].ip,'203.0.113.104');
 const failedAt=r.newAlerts[0].createdAt;
 now+=1000;
 r=await account([obs(2,'#2 示例账号二',null,true,true)]);
 assert.equal(r.newAlerts.length,0,'repetitive spinner must never spam toast');
 assert.equal(r.snapshot.accountStates['2'].phase,'REPLACING');
 now+=1000;
 r=await account([obs(2,'#2 示例账号二','203.0.113.110',false,true,false)]);
 assert.equal(r.newAlerts.length,0,'banner disappeared not sufficient');
 assert.equal(r.snapshot.accountStates['2'].phase,'VERIFYING');
 assert.equal(r.snapshot.accountStates['2'].lastIp,'203.0.113.104');
 now+=1000;
 r=await account([obs(2,'#2 示例账号二','203.0.113.110',false,true,true)]);
 assert.equal(r.newAlerts.length,1);
 assert.equal(r.newAlerts[0].kind,'ACCOUNT_RECOVERED');
 assert.equal(r.newAlerts[0].oldIp,'203.0.113.104');
 assert.equal(r.newAlerts[0].newIp,'203.0.113.110');
 assert.equal(r.newAlerts[0].failedAt,failedAt);
 assert.equal(pending(r,'ACCOUNT_INVALID').length,1,
   'failure history remains for explicit user ack');
 assert.equal(pending(r,'ACCOUNT_RECOVERED').length,1);
 assert.equal(r.snapshot.accountStates['2'].phase,'NORMAL');
 now+=1000;
 r=await account([obs(2,'#2 示例账号二','203.0.113.110',false,false,true)]);
 assert.equal(r.newAlerts.length,0,'periodic checks do not spam recovered alert');
 const oldIds=r.snapshot.alerts.filter(e=>e.kind.startsWith('ACCOUNT_')).map(e=>e.id);
 r=await core.dispatch({scope,type:'monitor:ack',ids:oldIds});
 assert.equal(r.snapshot.alerts.filter(e=>e.kind.startsWith('ACCOUNT_')&&!e.acknowledged).length,0);
 assert.equal(r.snapshot.accountStates['2'].lastIp,'203.0.113.110');
 now+=1000;
 r=await account([obs(2,'#2 示例账号二','203.0.113.110',true)]);
 assert.equal(r.newAlerts.length,1,'second incident after recovery must notify again');
 assert.equal(r.newAlerts[0].kind,'ACCOUNT_INVALID');
 // Distinct signed-page token never shares account alerts or current phase.
 const b=await account([obs(2,'#2 示例账号二','198.51.100.22')],other);
 assert.equal(b.snapshot.accountStates['2'].lastIp,'198.51.100.22');
 assert.equal(pending(b,'ACCOUNT_INVALID').length,0);
 const beforeRestart=JSON.stringify(db[KEY]);
 assert(!beforeRestart.includes('PRIVATE_TOKEN_MUST_NOT_PERSIST'));
 assert(!beforeRestart.includes('private@example.test'));
 core=create();
 const after=await core.dispatch({scope,type:'monitor:get'});
 assert.equal(pending(after,'ACCOUNT_INVALID').length,1,'persist across worker restart');
 assert.equal(after.snapshot.accountStates['2'].phase,'INVALID');
 const oldBaseline=after.snapshot.instances;
 assert.deepEqual(Object.keys(oldBaseline),[],'account alerts do not overwrite EC2 instances');
 console.log('ACCOUNT_EVENTS_REGRESSION_PASS: invalid once, replenishing stage, proven TCP22 recovery, ack, second incident, scoped isolation, secret-free persistence');
})().catch(e=>{console.error(e);process.exitCode=1;});
