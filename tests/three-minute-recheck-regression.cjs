// Legacy test filename retained for CI compatibility; now tests adjustable cadence.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..','browser-extension');
const bg=fs.readFileSync(path.join(root,'background.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'content.js'),'utf8');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
assert.equal(manifest.version,'2.0.2');
assert.match(bg,/const DEFAULT_AUTO_MINUTES = 5;/);
assert.match(bg,/wallcheck_auto_interval_minutes_v1/);
assert.match(ui,/const DEFAULT_AUTO_MINUTES = 5;/);
assert.match(ui,/const CACHE_MS = 1 \* 60 \* 1000;/);
assert.match(ui,/id="wallcheck-auto-minutes" type="number" min="1" max="60" step="1"/);
assert.match(ui,/id="wallcheck-interval-save"/);
assert.match(ui,/type:'auto:set-interval'/);
assert.match(ui,/chrome\.storage\.onChanged\.addListener/);
assert.match(ui,/上次有效实测/);
assert.match(ui,/id="wallcheck-last-success"/);
assert.match(ui,/id="wallcheck-last-attempt"/);
assert.match(ui,/id="wallcheck-next-check"/);
assert.match(ui,/缓存结果（未重测）/);
assert.match(ui,/const checkedAt = Date\.now\(\);/);
assert.match(ui,/lastFinishedAt = new Date\(checkedAt\);/);
const begin=bg.indexOf("const AUTO_ALARM = 'wallcheck-auto-recheck';");
const end=bg.indexOf('chrome.runtime.onInstalled.addListener',begin);
assert(begin>=0 && end>begin);
const head=bg.slice(begin,end);
const key='wallcheck_auto_interval_minutes_v1';
function mockWorker(initial={},oldAlarm){
 const stored={...initial},calls=[],alarms=new Map();
 if(oldAlarm!==undefined)alarms.set('wallcheck-auto-recheck',{periodInMinutes:oldAlarm});
 const chrome={
  runtime:{lastError:null},
  storage:{local:{
   get:(keys,cb)=>{calls.push(['storage.get']);const data={};
    for(const k of keys)if(k in stored)data[k]=stored[k];cb(data);},
   set:(values,cb)=>{calls.push(['storage.set',values[key]]);Object.assign(stored,values);cb();}
  }},
  alarms:{
   get:(name,cb)=>{calls.push(['alarm.get']);cb(alarms.get(name)||null);},
   clear:(name,cb)=>{calls.push(['alarm.clear']);alarms.delete(name);cb(true);},
   create:(name,opt)=>{calls.push(['alarm.create',opt.periodInMinutes]);
     alarms.set(name,{periodInMinutes:opt.periodInMinutes,
       delayInMinutes:opt.delayInMinutes});return Promise.resolve();}
  }
 };
 const ctx={chrome,Promise,Number,Error,setTimeout,clearTimeout};
 vm.createContext(ctx);
 vm.runInContext(head+';globalThis.api={ensureAutoAlarm,changeAutoInterval,savedAutoMinutes,validatedAutoMinutes};',ctx);
 return {api:ctx.api,calls,stored,alarms};
}
(async()=>{
 const a=mockWorker({},3);
 assert.equal(await a.api.ensureAutoAlarm(),5,'migrate 1.9.8 default 3 to 5');
 assert.equal(a.alarms.get('wallcheck-auto-recheck').periodInMinutes,5);
 a.calls.length=0;
 assert.equal(await a.api.ensureAutoAlarm(),5);
 assert.equal(a.calls.filter(c=>c[0]==='alarm.create').length,0,'do not reset 5-min alarm');
 assert.equal(await a.api.changeAutoInterval(7),7);
 assert.equal(a.stored[key],7);
 assert.equal(a.alarms.get('wallcheck-auto-recheck').periodInMinutes,7);
 const restarted=mockWorker(a.stored,7);
 assert.equal(await restarted.api.ensureAutoAlarm(),7);
 assert.equal(restarted.calls.filter(c=>c[0]==='alarm.create').length,0);
 assert.equal(await restarted.api.changeAutoInterval(5),5);
 assert.equal(restarted.stored[key],5);
 assert.equal(restarted.alarms.get('wallcheck-auto-recheck').periodInMinutes,5);
 const parallel=mockWorker({},10);
 await Promise.all([parallel.api.changeAutoInterval(3),parallel.api.changeAutoInterval(15)]);
 assert.equal(parallel.stored[key],15);
 assert.equal(parallel.alarms.get('wallcheck-auto-recheck').periodInMinutes,15);
 for(const invalid of [0,-1,61,2.5,'x','',null,undefined])
   await assert.rejects(()=>parallel.api.changeAutoInterval(invalid));
 assert.equal(parallel.stored[key],15);
 const corrupt=mockWorker({[key]:500},10);
 assert.equal(await corrupt.api.ensureAutoAlarm(),5);
 assert.equal(corrupt.alarms.get('wallcheck-auto-recheck').periodInMinutes,5);
 const legacy=mockWorker({},10);
 assert.equal(await legacy.api.ensureAutoAlarm(),5);
 assert.equal(legacy.alarms.get('wallcheck-auto-recheck').delayInMinutes,5);
 assert.match(bg,/if \(alarm\.name !== AUTO_ALARM\) return;/);
 assert.match(bg,/chrome\.tabs\.sendMessage\(tab\.id, \{type:'auto-recheck'\}/);
 console.log('CONFIGURABLE_INTERVAL_REGRESSION_PASS: 5min default, 1-60 input, 3/10 migration, persisted reload, serialized two tabs, one alarm, no stale timestamp');
})().catch(e=>{console.error(e);process.exitCode=1});
