importScripts('monitor-core.js','probe-isolation.js','manual-core.js');

const AUTO_ALARM = 'wallcheck-auto-recheck';
const AUTO_RECHECK_MINUTES = 10;
const ENDPOINT = 'http://127.0.0.1:17654/api/probe';

function ensureAutoAlarm() {
  chrome.alarms.get(AUTO_ALARM, alarm => {
    if (alarm && alarm.periodInMinutes === AUTO_RECHECK_MINUTES) return;
    chrome.alarms.clear(AUTO_ALARM, () => {
      chrome.alarms.create(AUTO_ALARM, {
        delayInMinutes: AUTO_RECHECK_MINUTES,
        periodInMinutes: AUTO_RECHECK_MINUTES
      });
    });
  });
}

chrome.runtime.onInstalled.addListener(ensureAutoAlarm);
chrome.runtime.onStartup.addListener(() => {
  ensureAutoAlarm();
  chrome.tabs.query({url:'https://aws.sb/*'}, tabs => {
    for (const tab of tabs) if (tab.id) chrome.tabs.sendMessage(tab.id, {type:'startup-recheck'}, () => { void chrome.runtime.lastError; });
  });
});
ensureAutoAlarm();

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== AUTO_ALARM) return;
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, {type:'auto-recheck'}, () => {
        void chrome.runtime.lastError;
      });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if(msg?.type==='notify'){
    const event=msg.event||{};
    if(!chrome.notifications?.create){
      sendResponse({ok:false,error:'notifications unavailable'});
      return false;
    }
    const id='wallcheck-'+String(event.id||Date.now()).replace(/[^a-zA-Z0-9_-]/g,'_').slice(-160);
    chrome.notifications.create(id,{
      type:'basic',iconUrl:chrome.runtime.getURL('icon.png'),
      title:String(event.title||'WallCheck 提醒').slice(0,120),
      message:String(event.message||'').slice(0,450),
      priority:2
    },created=>{
      const err=chrome.runtime.lastError;
      auditNotification({kind:'USER_TEST'},err?'API_ERROR':'API_ACCEPTED');
      sendResponse(err?{ok:false,error:err.message}:{ok:true,id:created});
    });
    return true;
  }
  if (!msg || msg.type !== 'probe') return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(120000, Math.max(20000, (msg.payload?.ips?.length || 1) * 1000)));
  fetch(ENDPOINT, {
    signal: controller.signal,
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(msg.payload)
  }).then(async r => {
    const text = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + text);
    return JSON.parse(text);
  }).then(data => sendResponse({ok:true, data}))
    .catch(err => sendResponse({ok:false, error:String(err)}))
    .finally(() => clearTimeout(timer));
  return true;
});


if(chrome.notifications?.onClicked){
  chrome.notifications.onClicked.addListener(id=>{
    if(!String(id).startsWith('wallcheck-'))return;
    if(String(id).startsWith('wallcheck-manual-'))return;
    chrome.tabs.query({url:'https://aws.sb/*'},tabs=>{
      if(tabs.length && tabs[0].id)chrome.tabs.update(tabs[0].id,{active:true});
      else chrome.tabs.create({url:'https://aws.sb/#/ec2-instances',active:true});
    });
  });
}


// Authoritative single-writer monitor state: no content tab may write scoped
// IP baselines or acknowledgements directly to chrome.storage.local.
const monitor = createWallCheckMonitor({
  read: key => new Promise((resolve,reject) =>
    chrome.storage.local.get([key], data => {
      const e=chrome.runtime.lastError;
      e ? reject(Error(e.message)) : resolve(data[key]);
    })),
  write: (key,value) => new Promise((resolve,reject) =>
    chrome.storage.local.set({[key]:value}, () => {
      const e=chrome.runtime.lastError;
      e ? reject(Error(e.message)) : resolve();
    }))
});

// A notification create() callback confirms only submission to Chromium,
 // NOT that Windows actually displayed the toast. Record a privacy-safe
 // bounded diagnostic log so the next incident is directly auditable.
const NOTIFY_AUDIT_KEY='wallcheck_notification_attempts_v1';
let notificationAuditQueue=Promise.resolve();
function auditNotification(event,result){
  notificationAuditQueue=notificationAuditQueue.catch(()=>{}).then(()=>
    new Promise(resolve=>{
      chrome.storage.local.get([NOTIFY_AUDIT_KEY],data=>{
        const prior=Array.isArray(data?.[NOTIFY_AUDIT_KEY])?data[NOTIFY_AUDIT_KEY]:[];
        const record={
          at:Date.now(),kind:String(event.kind||'UNKNOWN').slice(0,36),
          slot:String(event.slot||'').slice(0,4),
          result:result==='API_ACCEPTED'?'API_ACCEPTED':'API_ERROR'
        };
        chrome.storage.local.set({[NOTIFY_AUDIT_KEY]:
          [...prior,record].slice(-120)},()=>resolve());
      });
    })
  );
}
function newMonitorNotification(event) {
  // Suspect past DOM association is shown ONLY for manual review in-page.
  if(event.kind==='IP_LINK_SUSPECT')return;
  const title=event.kind==='ACCOUNT_INVALID'
    ? event.label+' · AWS账号已失效'
    : event.kind==='ACCOUNT_RECOVERED'
    ? event.label+' · 替补后 IP 已恢复'
    : event.kind==='SCOPE_ONBOARDED'
    ? 'WallCheck · 新监控列表已接入'
    : event.kind==='IP_CHANGE'
    ? event.label+' · IPv4 已变化'
    : event.kind==='HOST_UNREACHABLE'
      ? event.label+' · 主机可达性未确认'
      : event.kind==='PORT22_UNREACHABLE'
        ? event.label+' · TCP 22 不可访问'
        : 'WallCheck · 本地检测故障';
  const message=event.kind==='ACCOUNT_INVALID'
    ? (event.ip?event.ip+' · ':'')+(event.reason||'账号无效，等待自动替补')
    : event.kind==='ACCOUNT_RECOVERED'
    ? (event.oldIp?event.oldIp+' → ':'')+(event.newIp||event.ip||'')+
      ' · TCP22已验证可达'
    : event.kind==='SCOPE_ONBOARDED'
    ? (event.label||'实例')+' · '+(event.ip||'')+'；'+(event.reason||'已纳入监控')
    : event.kind==='IP_CHANGE'
    ? event.oldIp+' → '+event.newIp
    : (event.ip ? event.ip+' · ' : '')+(event.reason || '本地检测需要检查');
  try {
    chrome.notifications.create(
      'wallcheck-'+event.id.replace(/[^a-z0-9_-]/gi,'_').slice(-200),
      {type:'basic',iconUrl:chrome.runtime.getURL('icon.png'),
        title:title.slice(0,120),message:message.slice(0,450),priority:2},
      () => {
        const result=chrome.runtime.lastError?'API_ERROR':'API_ACCEPTED';
        auditNotification(event,result);
      }
    );
  } catch (_) {
    auditNotification(event,'API_ERROR');
    // Durable in-page account events are always the fallback.
  }
}

chrome.runtime.onMessage.addListener((msg,sender,sendResponse) => {
  if(!String(msg?.type||'').startsWith('monitor:'))return;
  // Scoped operations are only available to aws.sb extension content scripts.
  if(sender?.tab && !String(sender.tab.url||'').startsWith('https://aws.sb/')){
    sendResponse({ok:false,error:'Origin rejected'});
    return false;
  }
  monitor.dispatch(msg).then(result=>{
    for(const ev of result.newAlerts || [])newMonitorNotification(ev);
    sendResponse({ok:true,data:result.snapshot,changed:result.write});
    if(result.write) chrome.tabs.query({},tabs=>{
      for(const tab of tabs){
        if(!tab.id)continue;
        chrome.tabs.sendMessage(tab.id,
          {type:'monitor-sync',scope:msg.scope,revision:result.revision},()=>{
            void chrome.runtime.lastError;
          });
      }
    });
  }).catch(err=>sendResponse({ok:false,error:String(err.message||err)}));
  return true;
});


// Manual IPv4 monitor: independent of aws.sb tabs, using MV3 one-minute alarms.
// Scans only while a Chromium browser instance runs; never promises OS-level uptime.
const MANUAL_ALARM='wallcheck-manual-ip-1m';
const manualStore=createManualMonitor({
  read:key=>new Promise((resolve,reject)=>
    chrome.storage.local.get([key],data=>{
      const e=chrome.runtime.lastError;
      e?reject(Error(e.message)):resolve(data[key]);
    })),
  write:(key,value)=>new Promise((resolve,reject)=>
    chrome.storage.local.set({[key]:value},()=>{
      const e=chrome.runtime.lastError;
      e?reject(Error(e.message)):resolve();
    }))
});
function ensureManualAlarm(){
  chrome.alarms.get(MANUAL_ALARM,existing=>{
    if(existing?.periodInMinutes===1)return;
    chrome.alarms.create(MANUAL_ALARM,{delayInMinutes:1,periodInMinutes:1});
  });
}
function manualNotify(event){
  const kinds={
    DOWN:'手动 IP 本次未确认可达',
    RECOVERED:'手动 IP 已恢复',
    PROBE_ERROR:'本地探针通信故障'
  };
  if(!kinds[event.kind])return; // IP edits are recorded, not desktop alarms
  const details=event.details?String(event.details):'';
  chrome.notifications.create('wallcheck-manual-'+event.id,{
    type:'basic',iconUrl:chrome.runtime.getURL('icon.png'),
    title:('WallCheck · '+kinds[event.kind]).slice(0,110),
    message:(event.ip+' · '+details).slice(0,320),priority:2
  },()=>{void chrome.runtime.lastError;});
}
async function manualSendProbe(ips){
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),Math.min(20000,5000+ips.length*1500));
  try{
    const response=await fetch(ENDPOINT,{
      method:'POST',signal:ctl.signal,
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ips,ports:[22],timeout_ms:1500,retries:1,concurrency:16})
    });
    if(!response.ok)throw Error('HTTP '+response.status);
    return await response.json();
  }finally{clearTimeout(timer);}
}
let manualScanQueue=Promise.resolve();
function queueManualScan(ids=null,force=false){
  // Serializes alarm, immediate edit, and "check now" to avoid stale writes.
  const job=manualScanQueue.catch(()=>{}).then(async()=>{
    const now=Date.now();
    const due=await manualStore.due(now,ids,force);
    if(!due.length)return;
    let outcome;
    try {
      outcome=await wallcheckProbeWithIsolation(
        due.map(x=>x.ip),[22],manualSendProbe);
    }catch(error) {
      outcome={results:{},failed:due.map(x=>({ip:x.ip,reason:String(error)}))};
    }
    const errors=new Map((outcome.failed||[]).map(x=>[x.ip,x.reason]));
    const completedAt=Date.now();
    const records=due.map(x=>({
      ...x,when:completedAt,
      ...(outcome.results[x.ip]?
        {result:outcome.results[x.ip]}:
        {error:errors.get(x.ip)||outcome.batchError||'未收到有效检测结果'})
    }));
    const snapshot=await manualStore.dispatch('apply',{results:records});
    for(const event of snapshot.events)manualNotify(event);
  });
  manualScanQueue=job.then(()=>{},e=>console.warn('WallCheck manual scan',e));
  return job;
}
chrome.runtime.onInstalled.addListener(()=>{
  ensureManualAlarm();
  queueManualScan().catch(console.error);
});
chrome.runtime.onStartup.addListener(()=>{
  ensureManualAlarm();
  queueManualScan().catch(console.error);
});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name===MANUAL_ALARM)queueManualScan().catch(console.error);
});
ensureManualAlarm();
queueManualScan().catch(console.error);

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.type==='manual:open'){
    if(sender?.tab && !String(sender.tab.url||'').startsWith('https://aws.sb/')){
      sendResponse({ok:false,error:'Origin blocked'});
      return false;
    }
    chrome.runtime.openOptionsPage(()=>sendResponse({
      ok:!chrome.runtime.lastError,
      error:chrome.runtime.lastError?.message||null
    }));
    return true;
  }
  if(msg?.type!=='manual:action')return false;
  const ownPage=chrome.runtime.getURL('manual-monitor.html');
  if(sender.id!==chrome.runtime.id || !String(sender.url||'').startsWith(ownPage)){
    sendResponse({ok:false,error:'Only the extension monitor page may change manual targets'});
    return false;
  }
  const action=String(msg.action||'');
  const allowed=['get','add','update','enable','remove','ack','probeNow'];
  if(!allowed.includes(action)){
    sendResponse({ok:false,error:'Unsupported manual action'});
    return false;
  }
  (async()=>{
    const result=action==='probeNow' ?
      await manualStore.dispatch('get'):
      await manualStore.dispatch(action,msg.payload||{});
    if(['add','update','enable','probeNow'].includes(action)){
      const id=action==='add'?result.addedId:msg.payload?.id;
      if(id && (action!=='enable'||msg.payload.enabled)){
        queueManualScan([id],true).catch(console.error);
      }else if(action==='probeNow' && !id){
        queueManualScan(null,true).catch(console.error);
      }
      // Respond as soon as state is persisted: probe runs independently.
      // Later edits can supersede in-flight checks via generation guards.
      return manualStore.dispatch('get');
    }
    return result;
  })().then(data=>sendResponse({ok:true,data}))
    .catch(err=>sendResponse({ok:false,error:String(err.message||err)}));
  return true;
});
chrome.notifications.onClicked.addListener(id=>{
  if(!String(id).startsWith('wallcheck-manual-'))return;
  chrome.runtime.openOptionsPage();
});
