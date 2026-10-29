// Reuse the real worker/content integration fixture without running its suite.
// Only browser APIs, DOM extraction and the localhost transport are simulated.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
let harness=fs.readFileSync(path.join(__dirname,'async-scope-regression.cjs'),'utf8').replace(/\r\n/g,'\n');
harness=harness.slice(0,harness.indexOf('async function crossScope()'));
function replace(before,after){
  assert(harness.includes(before),'fixture insertion missing: '+before);
  harness=harness.replace(before,after);
}
replace('function world(){','function world(options={}){');
replace('const alarms=new Map();','const alarms=new Map(),faults={cacheWrites:0};');
replace("fs.readFileSync(path.join(extension,'background.js'),'utf8')",
  "options.backgroundSource||fs.readFileSync(path.join(extension,'background.js'),'utf8')");
replace('alarms.set(name,clone(options));',
  'alarms.set(name,{...clone(options),scheduledTime:Date.now()+(options.delayInMinutes||5)*60000});');
replace('set(values,callback){',[
  'set(values,callback){',
  'if(faults.cacheWrites && Object.prototype.hasOwnProperty.call(values,resultKey)){',
  'faults.cacheWrites--;queueMicrotask(()=>{',
  "chrome.runtime.lastError={message:'Synthetic storage quota error'};",
  'callback?.();chrome.runtime.lastError=null;});return;}'
].join('\n'));
replace('const fixture={token,ip,instanceId,paints:[]};',
  "const fixture={token,ip,instanceId,label:'#1 test',paints:[],invalidContext:false,faults:new Map()};");
replace('messages.push(clone(message));',[
  'messages.push(clone(message));',
  "if(fixture.invalidContext)throw Error('Extension context invalidated.');",
  'if(fixture.faults.has(message.type)){',
  'const fault=fixture.faults.get(message.type);',
  'if(!fault.repeat)fixture.faults.delete(message.type);',
  'if(fault.drop)return;',
  "queueMicrotask(()=>callback?.(fault.response||{ok:false,error:fault.message||'The message port closed before a response was received',errorCategory:fault.category||'CHANNEL_CLOSED'}));return;}"
].join('\n'));
replace("nodes.set(id,{style:{},textContent:'',title:''})",
  "nodes.set(id,{style:{},dataset:{},hidden:true,textContent:'',title:''})");
replace("instanceId:__fixture.instanceId,ip:__fixture.ip,label:'#1 test'",
  "instanceId:__fixture.instanceId,ip:__fixture.ip,label:__fixture.label");
replace("      domSignature=cells=>[...cells.keys()].join('|');\n      accountSignalSignature=()=>'';",'');
replace('runCheck,scanAccountStatusWithoutProbe,clearThisScope,',
  'runCheck,scanAccountStatusWithoutProbe,clearThisScope,refreshRuntimeStatus,renderTiming,\n'+
  'get running(){return running;},get blocked(){return runtimeBlocked;},\n'+
  'get lastAttemptAt(){return lastAttemptAt;},get retryAt(){return retryAt;},');
replace('api:context.testApi,nodes,fixture,held,',
  'api:context.testApi,nodes,fixture,held,\n'+
  'deliver(message){let reply;for(const listener of tabListeners)listener(message,{},response=>{reply=response;});return reply;},');
replace('return {stored,requests,messages,notifications,tab,',
  'return {stored,requests,messages,notifications,tab,alarms,faults,\n'+
  'timerDelays(){return [...timers.values()].map(timer=>timer.delay);},\n'+
  'flushTimers(delay){const due=[...timers.entries()].filter(([,timer])=>timer.delay===delay);\n'+
  'return due.map(([id,timer])=>{timers.delete(id);return timer.callback(...timer.args);});},');
const {world,until,good,scopeOf}=new Function('require','__dirname',harness+'\nreturn {world,until,good,scopeOf};')(require,__dirname);
const source=fs.readFileSync(path.join(__dirname,'../browser-extension/background.js'),'utf8');
const text=(tab,id)=>tab.nodes.get(id)?.textContent||'';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function complete(w,t,ip,trigger='manual'){
  const before=w.requests.length,scan=t.api.runCheck(true,trigger);
  await until(()=>w.requests.length===before+1);
  w.requests.at(-1).resolve({[ip]:good});
  await scan;await settle();
  return t.api.lastFinishedAt;
}
async function invalidContextStops(){
  const w=world(),t=w.tab('runtime-invalid-context','192.0.2.111','ec2:i-00000000000000019');
  t.fixture.invalidContext=true;
  await t.api.runCheck(true,'manual');await settle();
  assert.equal(t.api.running,false);assert.equal(t.api.blocked,'CONTEXT_INVALIDATED');
  assert.equal(w.requests.length,0);
  assert.match(text(t,'wallcheck-failure-reason'),/重新加载.*刷新/);
  assert(!w.timerDelays().some(delay=>[15000,30000,60000].includes(delay)),'invalid context must not retry forever');
  const before=w.messages.length;
  await t.api.runCheck(true,'automatic');
  assert.equal(w.messages.length,before,'blocked page must not keep messaging a dead context');
}
async function workerHandshakeStopsMismatch(){
  const old=source.replace("const WORKER_CODE_VERSION = '2.0.2';","const WORKER_CODE_VERSION = '2.0.1';");
  assert.notEqual(old,source,'real worker identity fixture must differ');
  const w=world({backgroundSource:old}),t=w.tab('runtime-old-worker','192.0.2.112','ec2:i-0000000000000001b');
  await t.api.runCheck(true,'automatic');await settle();
  assert.equal(t.api.blocked,'PROTOCOL_MISMATCH');assert.equal(w.requests.length,0);
  assert(!w.messages.some(message=>message.type==='monitor:agent'&&message.ok===false),
    'worker mismatch is not proof that the local agent is offline');
  assert.match(text(t,'wallcheck-failure-reason'),/版本不一致/);
  assert(!w.timerDelays().some(delay=>[15000,30000,60000].includes(delay)));
}
async function missingReplyIsBounded(){
  const w=world(),t=w.tab('runtime-missing-callback','192.0.2.113','ec2:i-0000000000000001c');
  t.fixture.faults.set('runtime:status',{drop:true});
  const scan=t.api.runCheck(true,'manual');
  await until(()=>w.messages.some(message=>message.type==='runtime:status'));
  assert.equal(t.api.running,true);
  w.flushTimers(15000);await scan;await settle();
  assert.equal(t.api.running,false,'missing callback must release the running latch');
  assert.match(text(t,'wallcheck-failure-reason'),/超时/);
  assert.equal(t.api.blocked,null,'one transient timeout is not a permanent context failure');
  assert(w.timerDelays().includes(15000),'a bounded recovery retry is scheduled');
}
async function channelRetriesHaveLimit(){
  const w=world(),t=w.tab('runtime-retry-limit','192.0.2.114','ec2:i-0000000000000001d');
  t.fixture.faults.set('runtime:status',{repeat:true,category:'CHANNEL_CLOSED'});
  await t.api.runCheck(true,'manual');await settle();
  for(const delay of [15000,30000,60000]){
    const pending=w.flushTimers(delay);
    assert.equal(pending.length,1,'exactly one retry at '+delay);
    await Promise.all(pending);await settle();
  }
  assert(!w.timerDelays().some(delay=>[15000,30000,60000].includes(delay)));
  assert.match(text(t,'wallcheck-status'),/下一轮或手动/);
  assert.equal(w.messages.filter(message=>message.type==='runtime:status').length,4);
  assert.equal(w.requests.length,0);
}
async function probeTimeoutReleases(){
  const w=world(),t=w.tab('runtime-probe-timeout','192.0.2.115','ec2:i-0000000000000001e');
  const scan=t.api.runCheck(true,'manual');
  await until(()=>w.requests.length===1);
  assert(w.timerDelays().includes(125000));
  w.flushTimers(125000);await scan;await settle();
  assert.equal(t.api.running,false);
  assert.equal(w.requests.length,1,'shared message timeout must not fan out to per-IP retries');
  assert.match(text(t,'wallcheck-failure-reason'),/超时/);
  assert.equal(t.api.lastFinishedAt,null);
  w.requests[0].resolve({'192.0.2.115':good});await settle();
  assert.equal(t.api.lastFinishedAt,null,'late timed-out reply must not manufacture a completed scan');
}
async function cacheFailureKeepsMeasurement(){
  const w=world(),ip='192.0.2.116',t=w.tab('runtime-cache-write-failure',ip,'ec2:i-0000000000000001f');
  w.faults.cacheWrites=1;
  const measured=await complete(w,t,ip);
  assert(measured && measured.getTime()>0);
  assert.match(text(t,'wallcheck-status'),/实测完成，但保存失败/);
  assert.match(text(t,'wallcheck-failure-reason'),/保存实测结果.*存储/);
  assert.equal(Number(t.nodes.get('wallcheck-last-success').dataset.timestamp),measured.getTime());
  assert.equal(t.api.running,false);
  assert(!w.messages.some(message=>message.type==='monitor:agent'&&message.ok===false));
  assert(!w.timerDelays().includes(15000),'successful real probes are not retried just to conceal a cache error');
  await complete(w,t,ip);
  assert.match(text(t,'wallcheck-status'),/实测完成/);
  assert.equal(t.nodes.get('wallcheck-failure').hidden,true);
}
async function monitorFailureKeepsMeasurement(){
  const w=world(),ip='192.0.2.117',t=w.tab('runtime-alert-sync-failure',ip,'ec2:i-00000000000000012');
  t.fixture.faults.set('monitor:reachability',{category:'STORAGE_ERROR',
    message:'storage failure https://aws.sb/#/ec2-instances?sgt=SECRET_TOKEN user@example.com'});
  const measured=await complete(w,t,ip);
  assert(measured);assert.match(text(t,'wallcheck-status'),/实测完成，但告警同步失败/);
  assert.match(text(t,'wallcheck-failure-reason'),/同步告警.*存储/);
  const visible=[...t.nodes.values()].map(node=>node.textContent+' '+node.title).join(' ');
  assert(!/SECRET_TOKEN|user@example|https:\/\/|sgt=/.test(visible),'raw error data must not enter the UI');
  const diagnostics=w.messages.filter(message=>message.type==='diagnostics:record');
  assert(diagnostics.some(message=>message.phase==='monitor_sync'&&message.ok===false));
  for(const message of diagnostics){
    assert(!/SECRET_TOKEN|user@example|192\.0\.2\.|https:\/\/|sgt=/.test(JSON.stringify(message)),
      'diagnostics must carry only allowlisted metadata');
    assert.deepEqual(Object.keys(message).sort(),
      ['type','phase','trigger','ok','errorCategory','targetCount','durationMs'].sort());
  }
  assert(!w.messages.some(message=>message.type==='monitor:agent'&&message.ok===false));
}
async function labelCountdownDoesNotStarve(){
  const w=world(),ip='192.0.2.118',t=w.tab('runtime-label-countdown',ip,'ec2:i-00000000000000015');
  t.fixture.label='#1 test 00:15:00';
  const scan=t.api.runCheck(true,'manual');
  await until(()=>w.requests.length===1);
  t.fixture.label='#1 test 00:14:59';
  w.requests[0].resolve({[ip]:good});await scan;
  assert(t.api.lastFinishedAt,'label-only countdown must not discard a real probe');
  assert.equal(w.flushZeroTimers().length,0,'label-only repaint must not create a stale-result rescan loop');
}
async function historyAndNextScheduleAreReal(){
  const w=world(),token='runtime-history-time',ip='192.0.2.119',t=w.tab(token,ip,'ec2:i-00000000000000016');
  const historical=Date.now()-600000;
  w.stored.wallcheck_last_valid_results_v3={
    [scopeOf(token)+'|'+ip+'::22']:{value:{key:'LOCAL_OK',text:'historical'},checkedAt:historical}
  };
  const scan=t.api.runCheck(true,'manual');
  await until(()=>w.requests.length===1);
  assert.equal(t.api.lastFinishedAt.getTime(),historical,'restore original cache time, never Date.now()');
  assert.match(text(t,'wallcheck-last-success'),/历史缓存/);
  assert(t.api.lastAttemptAt.getTime()>historical);
  w.requests[0].reject();await scan;await settle();
  assert.equal(t.api.lastFinishedAt.getTime(),historical,'failed attempt preserves prior valid time');
  const alarm=w.alarms.get('wallcheck-auto-recheck');
  alarm.scheduledTime=Date.now()-5000;
  await t.api.refreshRuntimeStatus('manual',false);
  assert.match(text(t,'wallcheck-next-check'),/计划已过期/);
}
async function automaticAckThenFreshProbe(){
  const w=world(),ip='192.0.2.120',t=w.tab('runtime-automatic-trigger',ip,'ec2:i-00000000000000017');
  await complete(w,t,ip);
  assert.deepEqual(w.messages.filter(message=>message.type==='diagnostics:record').map(message=>message.phase),
    ['scan_start','scan_complete'],'one healthy round records only start and result');
  const response=t.deliver({type:'auto-recheck'});
  assert.equal(response.ok,true);assert.equal(response.accepted,true,'delivery ACK is synchronous');
  await until(()=>w.requests.length===2);
  assert.equal(w.messages.filter(message=>message.type==='probe').at(-1).trigger,'automatic');
  w.requests[1].resolve({[ip]:good});
  await until(()=>!t.api.running);
  assert(t.api.lastFinishedAt);
}
async function statusReadErrorsDoNotUndoProbes(){
  for(const item of [
    {category:'ALARM_ERROR',savedMinutes:5,alarm:null,message:/自动检测计划读取失败/},
    {category:'STORAGE_ERROR',savedMinutes:null,alarm:{scheduledTime:Date.now()+300000,periodInMinutes:5},message:/检测间隔读取失败/},
    {category:'STORAGE_ERROR',savedMinutes:5,alarm:{scheduledTime:Date.now()+300000,periodInMinutes:5},message:/本地诊断存储异常/}
  ]){
    const w=world(),ip='192.0.2.121',t=w.tab('runtime-status-read-error',ip,'ec2:i-00000000000000018');
    t.fixture.faults.set('runtime:status',{response:{ok:true,data:{
      workerVersion:'2.0.2',protocol:2,probeEndpoint:'http://127.0.0.1:17654/api/probe',
      savedMinutes:item.savedMinutes,alarm:item.alarm,statusErrors:[item.category],diagnostics:[]
    }}});
    const measured=await complete(w,t,ip);
    assert(measured,'a status read failure must not block a valid network probe');
    assert.equal(t.api.blocked,null);
    assert.match(text(t,'wallcheck-status'),/实测完成/);
    assert.match(text(t,'wallcheck-interval-feedback'),item.message);
    if(item.category==='ALARM_ERROR')assert.match(text(t,'wallcheck-next-check'),/计划读取失败/);
    assert(!w.messages.some(message=>message.type==='monitor:agent'&&message.ok===false));
    await t.api.refreshRuntimeStatus('manual',false);
    assert.equal(text(t,'wallcheck-interval-feedback'),'已保存：5 分钟','recovered read clears its old status warning');
    assert.equal(t.api.lastFinishedAt.getTime(),measured.getTime(),'status recovery must not advance measurement time');
  }
}
(async()=>{
  for(const [name,test] of [
    ['invalid context stops pointless retries',invalidContextStops],
    ['actual worker mismatch blocks without agent-offline claim',workerHandshakeStopsMismatch],
    ['missing message callback has deadline',missingReplyIsBounded],
    ['temporary channel retries are bounded',channelRetriesHaveLimit],
    ['probe message timeout releases running',probeTimeoutReleases],
    ['cache write failure preserves real measurement',cacheFailureKeepsMeasurement],
    ['post-probe sync failure preserves measurement and privacy',monitorFailureKeepsMeasurement],
    ['label countdown does not starve real probes',labelCountdownDoesNotStarve],
    ['historical timestamp and next schedule remain truthful',historyAndNextScheduleAreReal],
    ['automatic delivery ACK precedes forced fresh probe',automaticAckThenFreshProbe],
    ['status-read failures stay visible without blocking real probes',statusReadErrorsDoNotUndoProbes]
  ]){
    await test();console.log('PASS '+name);
  }
  console.log('CONTENT_RUNTIME_RECOVERY_REGRESSION_PASS');
})().catch(error=>{console.error(error.stack||String(error));process.exitCode=1;});
