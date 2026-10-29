'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const extension=path.join(__dirname,'..','browser-extension');
const KEY='wallcheck_runtime_diagnostics_v1';
const INTERVAL='wallcheck_auto_interval_minutes_v1';
const AUTO='wallcheck-auto-recheck';
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const event=()=>{const listeners=[];return {listeners,addListener:listener=>listeners.push(listener)};};

function worker(options={}){
  const stored=options.stored||{},alarms=options.alarms||new Map();
  const calls=[],pendingWrites=[],pendingReads=[],requests=[],timers=new Map();
  const fault={blockDiagnosticWrites:false,failSettingsRead:false,failAlarmRead:false};
  const listeners=event(),alarmEvents=event(),startup=event();
  let timer=0,context;
  const chrome={
    runtime:{id:'wallcheck-test',lastError:null,
      // A changed on-disk manifest must not change this executing code identity.
      getManifest:()=>({version:'99.99.99'}),getURL:file=>'chrome-extension://wallcheck-test/'+file,
      onMessage:listeners,onInstalled:event(),onStartup:startup,openOptionsPage:callback=>callback?.()},
    storage:{local:{
      get(keys,callback){
        if(options.delayDiagnosticRead&&keys.includes(KEY)){
          const prior={};for(const key of keys)if(key in stored)prior[key]=clone(stored[key]);
          pendingReads.push(()=>callback(prior));
          return;
        }
        queueMicrotask(()=>{
          if(options.failDiagnosticRead&&keys.includes(KEY)){
            chrome.runtime.lastError={message:'storage failed private diagnostic read detail'};
            try{callback({});}finally{chrome.runtime.lastError=null;}
            return;
          }
          if(fault.failSettingsRead&&keys.includes(INTERVAL)){
            chrome.runtime.lastError={message:'storage quota private-token-value'};
            try{callback({});}finally{chrome.runtime.lastError=null;}
            return;
          }
          const result={};for(const key of keys)if(key in stored)result[key]=clone(stored[key]);
          callback(result);
        });
      },
      set(values,callback){
        const apply=()=>{Object.assign(stored,clone(values));queueMicrotask(()=>callback?.());};
        if(fault.blockDiagnosticWrites&&Object.prototype.hasOwnProperty.call(values,KEY))pendingWrites.push(apply);
        else apply();
      }
    }},
    alarms:{
      get(name,callback){
        calls.push(['alarm.get',name]);
        queueMicrotask(()=>{
          if(fault.failAlarmRead&&name===AUTO){
            chrome.runtime.lastError={message:'sensitive alarm API detail'};
            try{callback(undefined);}finally{chrome.runtime.lastError=null;}
          }else callback(clone(alarms.get(name)));
        });
      },
      clear(name,callback){calls.push(['alarm.clear',name]);alarms.delete(name);queueMicrotask(()=>callback?.(true));},
      async create(name,settings){calls.push(['alarm.create',name]);alarms.set(name,{...clone(settings),scheduledTime:Date.now()+settings.delayInMinutes*60000});},
      onAlarm:alarmEvents
    },
    tabs:{
      query:(_query,callback)=>queueMicrotask(()=>callback(options.tabs||[])),
      sendMessage(id,message,callback){
        calls.push(['tab.send',id,message.type]);
        queueMicrotask(()=>{
          const error=options.deliveryErrors?.[id];
          if(error)chrome.runtime.lastError={message:error};
          try{callback?.(error?undefined:{ok:true,accepted:true});}finally{chrome.runtime.lastError=null;}
        });
      },update(){},create(){}
    },
    notifications:{onClicked:event(),create:(_id,_options,callback)=>callback?.('notification-test')}
  };
  context=vm.createContext({console,chrome,Date,Promise,Map,Set,Error,Array,Object,Number,String,
    AbortController,setTimeout:(fn,ms)=>{const id=++timer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,settings)=>{
      const payload=JSON.parse(settings.body);requests.push({url,payload});
      if(options.fetchError)throw Error(options.fetchError);
      const results=Object.fromEntries((payload.ips||[]).map(ip=>[ip,{icmp:{state:'REACHABLE'},ports:[{port:22,state:'OPEN'}]}]));
      return {ok:true,status:200,text:async()=>JSON.stringify({results}),json:async()=>({results})};
    }
  });
  context.importScripts=(...files)=>{
    for(const file of files)vm.runInContext(fs.readFileSync(path.join(extension,file),'utf8'),context,{filename:file});
  };
  vm.runInContext(fs.readFileSync(path.join(extension,'background.js'),'utf8'),context,{filename:'background.js'});
  const send=message=>new Promise(resolve=>{
    let answered=false,asynchronous=false;
    const done=response=>{if(!answered){answered=true;resolve(clone(response));}};
    for(const listener of listeners.listeners){
      if(listener(clone(message),{id:chrome.runtime.id,tab:{id:1,url:'https://aws.sb/#/ec2-instances'}},done)===true)asynchronous=true;
    }
    if(!answered&&!asynchronous)done(undefined);
  });
  return {stored,alarms,calls,pendingWrites,pendingReads,requests,timers,fault,send,
    fireAlarm:()=>alarmEvents.listeners.forEach(listener=>listener({name:AUTO})),
    fireStartup:()=>startup.listeners.forEach(listener=>listener()),
    flush:async()=>{
      await vm.runInContext('diagnosticMutationQueue',context);
      await vm.runInContext('diagnosticWriteQueue',context);
    }
  };
}
async function tick(){await new Promise(resolve=>setImmediate(resolve));}

(async()=>{
  const existingTime=Date.now()+123456;
  const w=worker({stored:{[INTERVAL]:7},alarms:new Map([[AUTO,{periodInMinutes:7,scheduledTime:existingTime}]]),
    tabs:[{id:1},{id:2}],deliveryErrors:{2:'Could not establish connection. Receiving end does not exist. https://aws.sb/?sgt=PRIVATE_SGT 203.0.113.9'}});
  const initial=await w.send({type:'runtime:status'});
  assert.equal(initial.ok,true);assert.equal(initial.data.workerVersion,'2.0.2');assert.equal(initial.data.protocol,2);
  assert.equal(initial.data.probeEndpoint,'http://127.0.0.1:17654/api/probe');assert.equal(initial.data.savedMinutes,7);
  assert.equal(initial.data.alarm.scheduledTime,existingTime);assert.equal(initial.data.alarm.periodInMinutes,7);
  const before=w.calls.filter(call=>call[0]==='alarm.create'||call[0]==='alarm.clear').length;
  await w.send({type:'auto:get-status'});await w.send({type:'runtime:status'});
  assert.equal(w.calls.filter(call=>call[0]==='alarm.create'||call[0]==='alarm.clear').length,before,'read-only status must not rearm alarms');
  w.fireAlarm();await tick();await w.flush();
  const delivered=(await w.send({type:'auto:get-status'})).data;
  assert(delivered.lastAlarmAt>0);assert.equal(delivered.lastDelivery.attempted,2);
  assert.equal(delivered.lastDelivery.delivered,1);assert.equal(delivered.lastDelivery.failed,1);
  assert.equal(delivered.lastDelivery.errorCategory,'NO_RECEIVER');
  const deliveryEvent=delivered.diagnostics.find(item=>item.phase==='delivery_complete');
  assert.equal(deliveryEvent.ok,true,'non-AWS unmatched tabs must not turn a successful delivery red');
  assert.equal(deliveryEvent.errorCategory,'NONE');assert.equal(deliveryEvent.targetCount,1);
  assert(!JSON.stringify(delivered.diagnostics).includes('PRIVATE_SGT'));
  assert(!JSON.stringify(delivered.diagnostics).includes('203.0.113.9'));
  assert(!JSON.stringify(delivered.diagnostics).includes('https://'));

  const noReceiver=worker({tabs:[{id:1}],deliveryErrors:{1:'Receiving end does not exist.'}});
  noReceiver.fireAlarm();await tick();await noReceiver.flush();
  const undelivered=(await noReceiver.send({type:'runtime:status'})).data;
  assert.equal(undelivered.lastDelivery.delivered,0);
  const emptyDelivery=undelivered.diagnostics.find(item=>item.phase==='delivery_complete');
  assert.equal(emptyDelivery.ok,false);assert.equal(emptyDelivery.errorCategory,'NO_RECEIVER');
  const closedChannel=worker({tabs:[{id:1},{id:2}],deliveryErrors:{2:'The message port closed before a response was received.'}});
  closedChannel.fireAlarm();await tick();await closedChannel.flush();
  const closed=(await closedChannel.send({type:'runtime:status'})).data.diagnostics.find(item=>item.phase==='delivery_complete');
  assert.equal(closed.ok,false);assert.equal(closed.errorCategory,'CHANNEL_CLOSED');

  for(let i=0;i<110;i++){
    const response=await w.send({type:'diagnostics:record',phase:'scan_error',trigger:'automatic',ok:false,
      targetCount:6,durationMs:123,errorCategory:'TIMEOUT',at:1,
      scope:'sgt:PRIVATE_SGT',url:'https://secret.invalid',ip:'203.0.113.88',error:'private email@example.test',rawResponse:'SECRET_RESPONSE'});
    assert.equal(response.ok,true);assert.equal(response.data,null);
  }
  await w.flush();
  const bounded=(await w.send({type:'runtime:status'})).data;
  assert.equal(bounded.diagnostics.length,100);assert.equal(w.stored[KEY].events.length,100);
  assert(bounded.diagnostics.every(item=>item.at!==1));
  assert(bounded.diagnostics.every(item=>Object.keys(item).sort().join(',')==='at,description,durationMs,errorCategory,ok,phase,targetCount,trigger'));
  const sanitized=JSON.stringify(w.stored[KEY]);
  for(const forbidden of ['PRIVATE_SGT','secret.invalid','203.0.113.88','email@example.test','SECRET_RESPONSE'])assert(!sanitized.includes(forbidden));
  const invalid=await w.send({type:'diagnostics:record',phase:'raw_personal_data',trigger:'https://secret.invalid'});
  assert.equal(invalid.ok,false,'unlisted diagnostic phase must be rejected');

  const restarted=worker({stored:clone(w.stored),alarms:new Map(w.alarms)});
  const restored=(await restarted.send({type:'runtime:status'})).data;
  assert.equal(restored.diagnostics.length,100);assert.equal(restored.lastAlarmAt,bounded.lastAlarmAt);
  assert.deepEqual(restored.lastDelivery,bounded.lastDelivery);
  assert.equal(restored.savedMinutes,7);assert.equal(restored.alarm.scheduledTime,existingTime);

  const blocked=worker();await blocked.send({type:'runtime:status'});
  blocked.fault.blockDiagnosticWrites=true;
  const recorded=await blocked.send({type:'diagnostics:record',phase:'scan_start',trigger:'manual',ok:true,targetCount:1});
  assert.equal(recorded.ok,true);await tick();assert.equal(blocked.pendingWrites.length,1);
  const probe=await blocked.send({type:'probe',trigger:'manual',payload:{ips:['192.0.2.10'],ports:[22]}});
  assert.equal(probe.ok,true,'blocked diagnostic persistence must not block probe reply');
  const live=(await blocked.send({type:'runtime:status'})).data;
  assert.equal(live.lastProbe.ok,true);assert.equal(live.lastProbe.trigger,'manual');assert.equal(live.lastProbe.targetCount,1);
  assert(live.lastProbe.finishedAt>=live.lastProbe.startedAt);
  assert(blocked.pendingWrites.length>0,'test must really leave diagnostic write callbacks pending');
  blocked.fault.blockDiagnosticWrites=false;for(const release of blocked.pendingWrites.splice(0))release();
  await blocked.flush();await tick();assert.equal(blocked.timers.size,0,'observability must not create a continuous keepalive timer');

  const unread=worker({delayDiagnosticRead:true,stored:{[KEY]:{version:1,
    events:[{at:1,phase:'scan_error',trigger:'manual',ok:false,errorCategory:'TIMEOUT'}],
    lastAlarmAt:1,lastDelivery:null,lastProbe:null}}});
  let statusAnswered=false;
  const waitingStatus=unread.send({type:'runtime:status'}).then(response=>{
    statusAnswered=true;return response;
  });
  await tick();assert.equal(statusAnswered,false);assert.equal(unread.pendingReads.length,1);
  unread.fireAlarm();
  const duringRead=await unread.send({type:'probe',trigger:'automatic',payload:{ips:['192.0.2.20'],ports:[22]}});
  assert.equal(duringRead.ok,true,'optional history initialization must not block a probe reply');
  const deadlines=[...unread.timers].filter(([,timer])=>timer.ms===1500);
  assert.equal(deadlines.length,1,'initial history read has exactly one bounded deadline');
  for(const [id,timer] of deadlines){unread.timers.delete(id);timer.fn();}
  const boundedStatus=(await waitingStatus).data;
  assert.equal(boundedStatus.workerVersion,'2.0.2');assert.equal(boundedStatus.protocol,2);
  assert.equal(boundedStatus.savedMinutes,5);assert.equal(boundedStatus.alarm.periodInMinutes,5);
  assert.deepEqual(boundedStatus.statusErrors,['STORAGE_ERROR']);
  assert(boundedStatus.lastAlarmAt>1);assert.equal(boundedStatus.lastProbe.ok,true);
  assert(boundedStatus.diagnostics.length>0);
  assert(boundedStatus.diagnostics.every(item=>item.at!==1));
  await unread.flush();
  // The old read snapshot arrives only after new alarm/probe events persisted.
  for(const release of unread.pendingReads.splice(0))release();
  await tick();
  const afterLateRead=(await unread.send({type:'runtime:status'})).data;
  assert.deepEqual(afterLateRead.diagnostics,boundedStatus.diagnostics,'a late initial read must not roll back newer diagnostics');
  assert.equal(afterLateRead.lastAlarmAt,boundedStatus.lastAlarmAt);
  assert.deepEqual(afterLateRead.lastProbe,boundedStatus.lastProbe);
  assert.deepEqual(afterLateRead.statusErrors,['STORAGE_ERROR'],'successful later writes must not conceal initialization loss');
  assert.equal(unread.timers.size,0,'the initialization deadline must not recur');

  const failedRead=worker({failDiagnosticRead:true});
  const failedReadStatus=(await failedRead.send({type:'runtime:status'})).data;
  assert.equal(failedReadStatus.workerVersion,'2.0.2');
  assert.deepEqual(failedReadStatus.statusErrors,['STORAGE_ERROR']);
  assert.equal(failedRead.timers.size,0,'an explicit read failure cancels the deadline immediately');
  await failedRead.send({type:'diagnostics:record',phase:'scan_start',trigger:'page',ok:true});
  await failedRead.flush();
  const recoveredWrites=(await failedRead.send({type:'runtime:status'})).data;
  assert.deepEqual(recoveredWrites.statusErrors,['STORAGE_ERROR']);
  assert(!JSON.stringify(recoveredWrites).includes('private diagnostic read detail'));

  blocked.fault.failSettingsRead=true;blocked.fault.failAlarmRead=true;
  const degraded=(await blocked.send({type:'runtime:status'})).data;
  assert.equal(degraded.workerVersion,'2.0.2');assert.equal(degraded.protocol,2);
  assert.equal(degraded.savedMinutes,null);assert.equal(degraded.alarm,null);
  assert.deepEqual(degraded.statusErrors,['STORAGE_ERROR','ALARM_ERROR']);

  const failure=worker({fetchError:'TypeError: Failed to fetch https://private.invalid/?token=PRIVATE'});
  const failed=await failure.send({type:'probe',payload:{ips:['198.51.100.11'],ports:[22]}});
  assert.equal(failed.ok,false);assert.equal(failed.errorCategory,'TRANSPORT');
  const failedStatus=(await failure.send({type:'runtime:status'})).data;
  assert.equal(failedStatus.lastProbe.trigger,'unknown');assert.equal(failedStatus.lastProbe.errorCategory,'TRANSPORT');
  assert(!JSON.stringify(failedStatus.diagnostics).includes('private.invalid'));
  assert(!JSON.stringify(failedStatus.diagnostics).includes('198.51.100.11'));
  console.log('SCHEDULE_OBSERVABILITY_REGRESSION_PASS: executing-code handshake, read-only alarm status, actual delivery counts, bounded private diagnostics, restart persistence, bounded initial read with late-reply protection, nonblocking probe reply, degraded status and no keepalive');
})().catch(error=>{console.error(error.stack||String(error));process.exitCode=1;});
