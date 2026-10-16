importScripts('monitor-core.js');

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

function newMonitorNotification(event) {
  const title=event.kind==='IP_CHANGE'
    ? event.label+' · IPv4 已变化'
    : event.kind==='HOST_UNREACHABLE'
      ? event.label+' · 主机可达性未确认'
      : event.kind==='PORT22_UNREACHABLE'
        ? event.label+' · TCP 22 不可访问'
        : 'WallCheck · 本地检测故障';
  const message=event.kind==='IP_CHANGE'
    ? event.oldIp+' → '+event.newIp
    : (event.ip ? event.ip+' · ' : '')+(event.reason || '本地检测需要检查');
  try {
    chrome.notifications.create(
      'wallcheck-'+event.id.replace(/[^a-z0-9_-]/gi,'_').slice(-200),
      {type:'basic',iconUrl:chrome.runtime.getURL('icon.png'),
        title:title.slice(0,120),message:message.slice(0,450),priority:2},
      () => { void chrome.runtime.lastError; }
    );
  } catch (_) {/* Permanent in-page records are the fallback. */}
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
