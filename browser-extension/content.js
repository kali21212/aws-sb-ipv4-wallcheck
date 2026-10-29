(() => {
  'use strict';

  // Every browser alarm forces a real probe. DOM refreshes use a short
  // cache and do not misrepresent cached results as new measurements.
  const CACHE_MS = 1 * 60 * 1000;
  const DEFAULT_AUTO_MINUTES = 5;
  const AUTO_INTERVAL_KEY = 'wallcheck_auto_interval_minutes_v1';
  const CONTENT_CODE_VERSION = '2.0.2';
  const CONTENT_PROTOCOL = 2;
  const EXPECTED_PROBE_ENDPOINT = 'http://127.0.0.1:17654/api/probe';
  const MESSAGE_TIMEOUT_MS = 15000;
  const PROBE_MESSAGE_TIMEOUT_MS = 125000;
  const RETRY_DELAYS_MS = [15000,30000,60000];
  const SCOPED_MONITOR_VERSION = 3;
  const openedAt = Date.now();
  let currentScope = null;
  let scopeGeneration = 0;
  let scopeCurrentIPs = [];
  let scopeInstances = {};
  let hiddenNoticeAckKey = '';
  let lastKnownScope = null;
  let scopeTokenMemo = null;
  let scopeHashMemo = null;
  const localDomIPs = new Map();
  // #n slot is stable within one sgt list even when AWS.SB creates a new
  // EC2 instance and both IPv4 and IPv6 are replaced.
  const localSlotIPs = new Map();
  const ONLY_PORTS = [22];

  const cache = new Map();
  const lastCombined = new Map();
  const recentChanges = new Map();
  let pendingCheck = false;
  let pendingForce = false;
  let pendingTrigger = 'page';
  let retryTimer = null;
  let alertEvents = [];
  let conditionStates = {};
  let alertsHydrated = false;
  let pendingMonitorSync = false;
  const AGENT_FAILURE_KINDS = new Set(['AGENT_OFFLINE','EXTENSION_CONTEXT']);
  let running = false;
  let scanTimer = null;
  let mutatingBadges = false;
  let lastFinishedAt = null;
  let lastDomSignature = null;
  let lastAccountSignature = null;
  let lastProbeSignature = null;
  let lastProbeAccountSignature = null;
  let lastAttemptAt = null;
  let lastMeasuredCount = 0;
  let lastMeasuredTotal = 0;
  let lastMeasurementCached = false;
  let lastMeasurementSignature = null;
  let runtimeBlocked = null;
  let runtimeInfo = null;
  let runtimeStatusIssue = '';
  let scheduleExpiryTimer = null;
  let refreshedExpiryAt = null;
  let retryAt = null;
  let retryAttempt = 0;
  let pendingLabelSync = false;
  const ERROR_CATEGORIES = new Set([
    'NONE','CONTEXT_INVALIDATED','PROTOCOL_MISMATCH','CHANNEL_CLOSED','TIMEOUT',
    'TRANSPORT','HTTP_ERROR','INVALID_RESPONSE','STORAGE_ERROR','ALARM_ERROR','UNKNOWN'
  ]);
  const TRIGGERS = new Set(['automatic','manual','retry','page','startup']);
  const ERROR_TEXT = {
    CONTEXT_INVALIDATED:'扩展上下文已失效。请重新加载 WallCheck 扩展，再刷新此页面。',
    PROTOCOL_MISMATCH:'页面与后台版本不一致。请重新加载 WallCheck 扩展，再刷新此页面。',
    CHANNEL_CLOSED:'扩展消息通道中断，未收到后台回复。',
    TIMEOUT:'请求超时，未在限定时间内收到回复。',
    TRANSPORT:'无法连接本机探针，请检查本机检测程序是否运行。',
    HTTP_ERROR:'本机探针返回了失败状态。',
    INVALID_RESPONSE:'后台未返回有效检测数据。',
    STORAGE_ERROR:'扩展本地存储操作失败。',
    ALARM_ERROR:'未能读取自动检测计划。',
    UNKNOWN:'操作未完成，未取得可分类的错误原因。'
  };
  const PHASE_TEXT = {
    handshake:'后台握手',cache_read:'读取历史结果',probe:'网络实测',
    cache_write:'保存实测结果',monitor_sync:'同步告警',schedule:'自动检测计划'
  };
  function errorCategory(error,fallback='UNKNOWN'){
    if(ERROR_CATEGORIES.has(error?.category) && error.category!=='UNKNOWN')return error.category;
    const value=String(error?.message||error||'');
    if(/extension context invalidated/i.test(value))return 'CONTEXT_INVALIDATED';
    if(/protocol.?mismatch|版本不一致/i.test(value))return 'PROTOCOL_MISMATCH';
    if(/message (?:port|channel) closed|channel is closed|extension port was disconnected|receiving end does not exist|could not establish connection|no message listener/i.test(value))return 'CHANNEL_CLOSED';
    if(error?.name==='TimeoutError'||/AbortError|aborted|timed?\s*out|timeout/i.test(value))return 'TIMEOUT';
    if(/failed to fetch|ERR_CONNECTION|NetworkError|network request failed|connection refused/i.test(value))return 'TRANSPORT';
    if(/\bHTTP\s+\d{3}\b/.test(value))return 'HTTP_ERROR';
    if(/QUOTA|MAX_WRITE|storage/i.test(value))return 'STORAGE_ERROR';
    if(error?.name==='SyntaxError'||/invalid response|JSON/i.test(value))return 'INVALID_RESPONSE';
    return ERROR_CATEGORIES.has(fallback)?fallback:'UNKNOWN';
  }
  function runtimeError(category,message){
    const error=new Error(message||ERROR_TEXT[category]||ERROR_TEXT.UNKNOWN);
    error.category=category;
    if(category==='TIMEOUT')error.name='TimeoutError';
    return error;
  }
  function messageRequest(message,timeoutMs=MESSAGE_TIMEOUT_MS){
    return new Promise((resolve,reject)=>{
      let finished=false;
      const finish=(error,value)=>{
        if(finished)return;
        finished=true;
        clearTimeout(timer);
        error?reject(error):resolve(value);
      };
      const timer=setTimeout(()=>finish(runtimeError('TIMEOUT','Extension message timed out')),timeoutMs);
      try{
        chrome.runtime.sendMessage(message,response=>{
          try{
            const lastError=chrome.runtime.lastError;
            if(lastError)return finish(runtimeError(errorCategory(lastError),lastError.message));
            if(!response || typeof response.ok!=='boolean')
              return finish(runtimeError('CHANNEL_CLOSED','The message port closed before a response was received'));
            if(!response.ok){
              const category=ERROR_CATEGORIES.has(response.errorCategory)?response.errorCategory:
                errorCategory(response.error);
              return finish(runtimeError(category,String(response.error||ERROR_TEXT[category]||ERROR_TEXT.UNKNOWN)));
            }
            if(response.stale){
              const error=runtimeError('UNKNOWN','Scoped result was cleared');
              error.stale=true;
              return finish(error);
            }
            finish(null,response);
          }catch(error){finish(runtimeError(errorCategory(error),String(error?.message||error)));}
        });
      }catch(error){finish(runtimeError(errorCategory(error),String(error?.message||error)));}
    });
  }
  function diagnostic(phase,trigger,ok,category='NONE',targetCount=0,durationMs=0){
    if(!['scan_start','scan_complete','scan_error','cache_write','monitor_sync','context_mismatch'].includes(phase))return;
    // Whitelisted metadata only: no raw errors, IPs, page URLs, sgt or account labels.
    messageRequest({type:'diagnostics:record',phase,trigger:TRIGGERS.has(trigger)?trigger:'page',
      ok:!!ok,errorCategory:ERROR_CATEGORIES.has(category)?category:'UNKNOWN',
      targetCount:Math.max(0,Math.min(10000,Number(targetCount)||0)),
      durationMs:Math.max(0,Math.min(3600000,Number(durationMs)||0))},5000).catch(()=>{});
  }
  function timeLabel(value){
    const date=value instanceof Date?value:new Date(value);
    if(!Number.isFinite(date.getTime()))return '尚无记录';
    return date.toDateString()===new Date().toDateString()?date.toLocaleTimeString():date.toLocaleString();
  }
  function writeText(id,text,title=''){
    const node=document.getElementById(id);
    if(node){node.textContent=text;node.title=title;}
  }
  function setPanelStatus(text,state='idle'){
    writeText('wallcheck-status',text);
    const panel=document.getElementById('wallcheck-panel');
    if(panel?.dataset)panel.dataset.state=state;
  }
  function showFailure(phase,error){
    const node=document.getElementById('wallcheck-failure');
    if(node)node.hidden=!error;
    if(!error){writeText('wallcheck-failure-reason','');return;}
    const category=errorCategory(error);
    // Fixed descriptions deliberately avoid rendering arbitrary error/JSON text.
    const status=category==='HTTP_ERROR'?/\bHTTP\s+(\d{3})\b/.exec(String(error?.message||error))?.[1]:null;
    writeText('wallcheck-failure-reason',
      (PHASE_TEXT[phase]||'检测')+'：'+(ERROR_TEXT[category]||ERROR_TEXT.UNKNOWN)+(status?'（HTTP '+status+'）':''));
  }
  function renderSchedule(){
    const at=runtimeInfo?.alarm?.scheduledTime;
    let text=Number.isFinite(at)&&at>0?timeLabel(at)+(at<=Date.now()?'（计划已过期）':''):'未取得调度';
    if(runtimeInfo?.statusErrors?.includes('ALARM_ERROR'))text='计划读取失败';
    if(runtimeBlocked)text='等待重新加载扩展';
    else if(retryAt)text+=' · 重试 '+timeLabel(retryAt)+(retryAt<=Date.now()?'（等待执行）':'');
    writeText('wallcheck-next-check',text,Number.isFinite(at)?new Date(at).toLocaleString():'');
  }
  function renderTiming(){
    let measured='尚无有效实测';
    if(lastFinishedAt){
      measured=timeLabel(lastFinishedAt);
      if(lastMeasuredTotal && lastMeasuredCount<lastMeasuredTotal)measured+='（'+lastMeasuredCount+'/'+lastMeasuredTotal+'）';
      if(lastMeasurementCached)measured+=' · 历史缓存';
    }
    writeText('wallcheck-last-success',measured,lastFinishedAt?.toLocaleString()||'');
    const measuredNode=document.getElementById('wallcheck-last-success');
    if(measuredNode?.dataset)measuredNode.dataset.timestamp=lastFinishedAt?String(lastFinishedAt.getTime()):'';
    writeText('wallcheck-last-attempt',lastAttemptAt?timeLabel(lastAttemptAt):'尚未检查',lastAttemptAt?.toLocaleString()||'');
    renderSchedule();
  }
  function blockRuntime(error,trigger='page'){
    const category=errorCategory(error);
    if(!['CONTEXT_INVALIDATED','PROTOCOL_MISMATCH'].includes(category))return false;
    runtimeBlocked=category;
    clearTimeout(retryTimer);
    clearTimeout(scanTimer);
    clearTimeout(scheduleExpiryTimer);
    retryAt=null;
    pendingCheck=pendingForce=false;
    setPanelStatus('需要重新加载扩展并刷新页面','error');
    showFailure('handshake',runtimeError(category));
    renderTiming();
    diagnostic('context_mismatch',trigger,false,category);
    return true;
  }
  function renderRuntimeDiagnostics(data){
    const details=document.getElementById('wallcheck-diagnostics');
    if(!details?.open)return;
    const list=document.getElementById('wallcheck-diagnostic-list');
    if(!list || typeof list.replaceChildren!=='function')return;
    list.replaceChildren();
    const triggers={automatic:'自动',manual:'手动',retry:'重试',page:'页面',startup:'启动',unknown:'未分类'};
    const phases={scan_start:'开始检查',scan_complete:'实测完成',scan_error:'检查失败',
      cache_write:'保存结果',monitor_sync:'告警同步',context_mismatch:'版本/连接检查',
      alarm_fired:'自动计划触发',delivery_complete:'通知页面',probe_start:'探针开始',
      probe_complete:'探针完成',probe_error:'探针失败',schedule_changed:'计划更新'};
    const events=(Array.isArray(data?.diagnostics)?data.diagnostics:[]).slice(-12).reverse();
    writeText('wallcheck-diagnostic-summary',events.length?'最近 '+events.length+' 条 · 展开时读取':'尚无检测记录');
    for(const event of events){
      if(!Number.isFinite(event.at)||!phases[event.phase])continue;
      const row=document.createElement('li');
      row.className='wc-ui-log-row';
      const head=document.createElement('div');
      head.textContent=timeLabel(event.at)+' · '+(triggers[event.trigger]||'未分类')+' · '+phases[event.phase];
      const detail=document.createElement('div');
      const category=ERROR_CATEGORIES.has(event.errorCategory)?event.errorCategory:
        event.errorCategory==='NO_RECEIVER'?'CHANNEL_CLOSED':'UNKNOWN';
      const count=Number.isFinite(event.targetCount)?Math.max(0,Math.floor(event.targetCount)):0;
      const duration=Number.isFinite(event.durationMs)?Math.max(0,event.durationMs):0;
      detail.textContent=(event.ok?'成功':(ERROR_TEXT[category]||ERROR_TEXT.UNKNOWN))+
        (count?' · '+count+' 个目标':'')+(duration?' · '+(duration/1000).toFixed(1)+' 秒':'');
      if(event.ok===false)row.dataset.state='error';
      row.appendChild(head);row.appendChild(detail);list.appendChild(row);
    }
  }
  async function refreshRuntimeStatus(trigger='page',armExpiry=true){
    const response=await messageRequest({type:'runtime:status'});
    const data=response.data;
    if(!data || data.workerVersion!==CONTENT_CODE_VERSION || data.protocol!==CONTENT_PROTOCOL ||
       data.probeEndpoint!==EXPECTED_PROBE_ENDPOINT)
      throw runtimeError('PROTOCOL_MISMATCH','Worker protocol mismatch');
    runtimeInfo=data;
    const previousIssue=runtimeStatusIssue;
    const statusErrors=Array.isArray(data.statusErrors)?data.statusErrors:[];
    const settingAvailable=Number.isInteger(data.savedMinutes)&&data.savedMinutes>=1&&data.savedMinutes<=60;
    const issues=[];
    if(statusErrors.includes('ALARM_ERROR'))issues.push('自动检测计划读取失败');
    if(statusErrors.includes('STORAGE_ERROR')){
      // The backend also reports diagnostic-storage failures here. A valid
      // savedMinutes value must not be falsely labelled as unreadable.
      issues.push(settingAvailable?'本地诊断存储异常':'检测间隔读取失败');
    }
    runtimeStatusIssue=issues.join('；');
    const feedback=document.getElementById('wallcheck-interval-feedback');
    if(feedback){
      if(runtimeStatusIssue)feedback.textContent=runtimeStatusIssue;
      else if(previousIssue)feedback.textContent=settingAvailable?'已保存：'+data.savedMinutes+' 分钟':'未取得间隔设置';
      if(feedback.dataset)feedback.dataset.state=runtimeStatusIssue?'error':'ok';
    }
    renderSchedule();
    renderRuntimeDiagnostics(data);
    clearTimeout(scheduleExpiryTimer);
    const at=data.alarm?.scheduledTime;
    if(armExpiry && Number.isFinite(at) && at>Date.now() && refreshedExpiryAt!==at){
      scheduleExpiryTimer=setTimeout(()=>{
        refreshedExpiryAt=at;
        renderSchedule();
        if(runtimeBlocked || document.visibilityState==='hidden')return;
        // One read at expiry; this neither drives probes nor keeps MV3 awake by polling.
        refreshRuntimeStatus(trigger,false).catch(error=>{
          if(!blockRuntime(error,trigger)){runtimeInfo=null;renderSchedule();}
        });
      },Math.min(2147483647,Math.max(1,at-Date.now()+1000)));
    }
    return data;
  }
  function queueRetry(category){
    clearTimeout(retryTimer);retryAt=null;
    if(runtimeBlocked || retryAttempt>=RETRY_DELAYS_MS.length){renderSchedule();return false;}
    const delay=RETRY_DELAYS_MS[retryAttempt++];
    retryAt=Date.now()+delay;
    retryTimer=setTimeout(()=>{retryAt=null;renderSchedule();return runCheck(true,'retry');},delay);
    renderSchedule();
    return true;
  }

  function isIPv4(s) {
    const parts = String(s).trim().split('.');
    if (parts.length !== 4) return false;
    return parts.every(part => {
      if (!/^\d{1,3}$/.test(part)) return false;
      if (part.length > 1 && part[0] === '0') return false;
      const n = Number(part);
      return n >= 0 && n <= 255;
    });
  }

  function extractIPv4(text) {
    const hits = String(text || '').match(/(?:^|[^0-9.])((?:\d{1,3}\.){3}\d{1,3})(?=$|[^0-9.])/g) || [];
    const out = [];
    for (const hit of hits) {
      const m = hit.match(/((?:\d{1,3}\.){3}\d{1,3})/);
      if (m && isIPv4(m[1])) out.push(m[1]);
    }
    return [...new Set(out)];
  }



  function isEC2Route() {
    return location.origin === 'https://aws.sb' &&
      location.hash.startsWith('#/ec2-instances');
  }

  async function monitorRequest(type, fields={}) {
    const response=await messageRequest({type,scope:currentScope,...fields});
    return response.data;
  }

  async function scopeFromURL(){
    // In these aws.sb URLs the query belongs to the HASH fragment. location.search is empty.
    if(!isEC2Route())return null;
    const hash=location.hash;
    const index=hash.indexOf('?');
    if(index<0)return null;
    const token=new URLSearchParams(hash.slice(index+1)).get('sgt');
    if(!token || token.length<8 || token.length>1024)return null;
    if(token===scopeTokenMemo)return scopeHashMemo;
    const data=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
    scopeTokenMemo=token; // in-memory only
    scopeHashMemo='sgt:'+Array.from(new Uint8Array(data),b=>b.toString(16).padStart(2,'0')).join('');
    return scopeHashMemo;
  }

  function updateFromSnapshot(snapshot) {
    if(!snapshot || snapshot.scope!==currentScope)return;
    alertEvents=Array.isArray(snapshot.alerts)?snapshot.alerts:[];
    conditionStates=snapshot.conditions || {};
    scopeCurrentIPs=Array.isArray(snapshot.currentIPs)?snapshot.currentIPs:[];
    scopeInstances=snapshot.instances||{};
    hiddenNoticeAckKey=snapshot.hiddenNoticeAckKey||'';
    alertsHydrated=true;
    refreshChangeMarkers();
    renderAlerts();
    renderHiddenNotice(collectIPCells());
  }

  function resetLocalScope(next){
    if(currentScope===next)return;
    scopeGeneration++;
    currentScope=next;
    lastKnownScope=next;
    alertsHydrated=false;
    alertEvents=[];
    conditionStates={};
    scopeCurrentIPs=[];
    scopeInstances={};
    hiddenNoticeAckKey='';
    cache.clear();
    lastCombined.clear();
    recentChanges.clear();
    lastDomSignature=null;
    lastAccountSignature=null;
    lastProbeSignature=null;
    lastProbeAccountSignature=null;
    lastFinishedAt=null;
    lastAttemptAt=null;
    lastMeasuredCount=lastMeasuredTotal=0;
    lastMeasurementCached=false;
    lastMeasurementSignature=null;
    retryAt=null;
    retryAttempt=0;
    clearTimeout(retryTimer);
    localSlotIPs.clear();
    renderAlerts();
    renderHiddenNotice(collectIPCells());
    renderTiming();
  }

    function collectIPCells() {
    const candidates = [...document.querySelectorAll('td,.ant-table-cell,[role="cell"],div,span')];
    const best = new Map();

    for (const el of candidates) {
      if (el.closest('#wallcheck-panel,#wallcheck-alert-center,.wallcheck-badge,.wallcheck-change-badge')) continue;
      // Badges themselves include historical IPv4 values; never re-add those as targets.
      let txt = (el.innerText || el.textContent || '').trim();
      if (el.querySelector?.('.wallcheck-badge,.wallcheck-change-badge')) {
        const clean = el.cloneNode(true);
        clean.querySelectorAll('.wallcheck-badge,.wallcheck-change-badge').forEach(x=>x.remove());
        txt = (clean.innerText || clean.textContent || '').trim();
      }
      if (!txt || txt.length > 240) continue;

      const ips = extractIPv4(txt);
      for (const ip of ips) {
        const score = txt.length * 1000 + el.children.length;
        const prev = best.get(ip);
        if (!prev || score < prev.score) best.set(ip, {el, score});
      }
    }

    const map = new Map();
    for (const [ip, item] of best) map.set(ip, [item.el]);
    return map;
  }

  // Identity evidence must stay INSIDE one individual AWS.SB instance card.
  // Searching a common parent grid once caused #1 IP to inherit #6 IPv6
  // while card metadata was loading, creating a false IP_CHANGE alert.
  function findInstanceCardRoot(cell,ip){
    let node=cell;
    const escaped=ip.replace(/\./g,'\\.');
    const ipLine=new RegExp('(?:^|\\n)\\s*IP\\s*[:：]?\\s*'+escaped+'(?![0-9.])','i');
    for(let depth=0;node && node!==document.body && depth<13;
        depth++,node=node.parentElement){
      const value=(node.innerText||node.textContent||'').trim();
      if(!value || value.length>2400 || !ipLine.test(value))continue;
      const headings=[...value.matchAll(/(?:^|\n)\s*#\s*(\d{1,4})\b/g)];
      if(headings.length===1)return node;
    }
    return null;
  }

  function findInstanceIdNear(root){
    if(!root)return null;
    const value=(root.innerText||root.textContent||'').trim();
    const ids=[...new Set((value.match(/\bi-[0-9a-f]{8,32}\b/gi)||[])
      .map(x=>x.toLowerCase()))];
    return ids.length===1?ids[0]:null;
  }

  function findInstanceLabelNear(root){
    if(!root)return null;
    const value=(root.innerText||root.textContent||'').trim();
    const heads=[...value.matchAll(/(?:^|\n)\s*#\s*(\d{1,4})\b/g)];
    if(heads.length!==1)return null;
    const h=heads[0];
    const lines=value.slice(h.index+h[0].length).split(/\r?\n/)
      .map(x=>x.trim()).filter(Boolean);
    let name=(lines[0]||'').replace(/^[^\p{L}\p{N}]+/u,'')
      .replace(/^编辑\s*/u,'').trim();
    name=name.replace(/\s+\d+\s*(?:天|小时|分钟).*$/u,'').trim();
    name=name.split(/\s{2,}|IPv[46]|地区|型号|配置时间|接近时间|剩余|状态|更换IP|IP\s/iu)[0].trim();
    if(!name)name=(lines.find(x=>x.length<=32 &&
      !/^(IP|IPv|型号|地区|配置|剩余|状态)/.test(x))||'').slice(0,32);
    return {slot:h[1],label:'#'+h[1]+(name?' '+name.slice(0,32):'')};
  }

  // AWS.SB account-failure/replenishment banners are NOT captured by the
  // IPv4-only IP_CHANGE watcher. Scope account events by visible #n cards.
  // The detector extracts ONLY slot/label/IP/booleans, NEVER replacement emails.
  function collectAccountCards(){
    const candidates=[...document.querySelectorAll('div,span,strong,h2,h3,h4,button')];
    const results=new Map();
    for(const el of candidates){
      if(el.closest?.('#wallcheck-panel,#wallcheck-alert-center'))continue;
      const heading=(el.innerText||el.textContent||'').trim();
      if(heading.length>115)continue;
      const first=heading.match(/^#\s*([1-9][0-9]{0,3})\b/);
      if(!first)continue;
      const slot=first[1];
      let node=el,card=null,cardSize=0;
      for(let depth=0;node&&node!==document.body&&depth<13;
          depth++,node=node.parentElement){
        const text=(node.innerText||node.textContent||'').trim();
        if(text.length>2400)break;
        const headers=[...text.matchAll(/(?:^|\n)\s*#\s*([1-9][0-9]{0,3})\b/g)];
        if(headers.length!==1 || headers[0][1]!==slot)break;
        if(/(?:^|\n)\s*IP\s*[:：]?\s*\d|账号无效|帳號無效|自动替补|型[号號]|AuthFailure/i.test(text)){
          card=node;cardSize=text.length;
        }
      }
      if(!card)continue;
      const raw=(card.innerText||card.textContent||'').trim();
      const name=findInstanceLabelNear(card)?.label || '#'+slot;
      const label=name.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi,'[hidden]').slice(0,45);
      const address=raw.match(/(?:^|\n)\s*IP\s*[:：]?\s*((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/i);
      const ip=address && isIPv4(address[1])?address[1]:null;
      const invalid=/账号无效|帳號無效|帐号无效|账号已失效|账号已被取消|AuthFailure|InvalidClientTokenId|无法验证提供的访问凭证|账户凭证无效/i.test(raw);
      const replacing=/自动替补|正在替补|替补中|尝试账号|設定新實例/i.test(raw);
      const previous=results.get(slot);
      if(!previous || cardSize>previous.size){
        results.set(slot,{slot,label,ip,invalid,replacing,size:cardSize});
      }
    }
    return [...results.values()].map(({size,...record})=>record)
      .sort((a,b)=>Number(a.slot)-Number(b.slot)).slice(0,50);
  }

  function accountSignalSignature(records){
    return JSON.stringify(records.map(r=>[
      r.slot,r.label,r.ip,r.invalid,r.replacing
    ]));
  }

  async function syncAccountSignals(records,verifiedIPs=new Set(),resultEpoch){
    if(!currentScope || !records.length)return;
    const ipCells=collectIPCells();
    const instances=collectInstanceRecords(ipCells);
    const identities=new Map([...instances.values()].map(r=>[r.ip,r.instanceId]));
    const safe=records.map(r=>{
      const localKey=currentScope+'|'+r.slot;
      const prior=localSlotIPs.get(localKey);
      // No account emails, browser page text, raw tokens or credentials.
      const value={...r,instanceId:identities.get(r.ip)||null,
        pageOpenedAt:openedAt,changedHere:prior!==undefined && prior!==r.ip,
        verified22:verifiedIPs.has(r.ip)};
      if(r.ip)localSlotIPs.set(localKey,r.ip);
      return value;
    });
    updateFromSnapshot(await monitorRequest('monitor:account',{records:safe,...(resultEpoch===undefined?{}:{resultEpoch})}));
  }

  async function scanAccountStatusWithoutProbe(){
    const hash=location.hash;
    const signed=await scopeFromURL();
    if(!signed || location.hash!==hash || !isEC2Route())return;
    if(currentScope!==signed)resetLocalScope(signed);
    await syncAccountSignals(collectAccountCards());
  }

  function findStableIPv6Near(root){
    if(!root)return null;
    const value=(root.innerText||root.textContent||'').trim();
    const addresses=[...new Set([...value.matchAll(/(?:IPv6\s*[:：]?\s*)([0-9a-f:]{10,50})/gi)]
      .map(m=>m[1].toLowerCase()).filter(v=>v.includes(':')))];
    // Multiple actual IPv6 addresses from THIS card may be present.
    return addresses.length>0 && addresses.length<=3 ?
      addresses.sort()[0]:null;
  }

    function collectInstanceRecords(ipCells) {
    const records=new Map();
    for(const [ip,cells] of ipCells) {
      const cell=cells[0];
      if(!cell) continue;
      const card=findInstanceCardRoot(cell,ip);
      if(!card)continue; // Never infer an instance from the shared card grid.
      const official=findInstanceIdNear(card);
      const display=findInstanceLabelNear(card);
      const ip6=findStableIPv6Near(card);
      // Ordinals like #1 and #2 identify the display label ONLY, not a machine.
      // With no stable EC2/IPv6 marker, key by IPv4 and suppress IP-change inference.
      const instanceId=official ? 'ec2:'+official : (ip6 ? 'ipv6:'+ip6 : 'ip-target:'+ip);
      // If transient loading maps two IPs to the same stable identity,
      // quarantine ambiguity instead of fabricating A->B transitions.
      if(records.has(instanceId) && records.get(instanceId).ip!==ip){
        const prior=records.get(instanceId);
        records.delete(instanceId);
        records.set('ip-target:'+prior.ip,{...prior,instanceId:'ip-target:'+prior.ip});
        records.set('ip-target:'+ip,{instanceId:'ip-target:'+ip,ip,cell,
          label:display?.label||'IPv4 '+ip});
        continue;
      }
      records.set(instanceId,{
        instanceId,ip,cell,label:display?.label || (official ? '实例 '+official : 'IPv4 '+ip)
      });
    }
    return records;
  }

function observedRecords(records) {
    const observations=[];
    for(const rec of records.values()){
      const id=currentScope+'|'+rec.instanceId;
      const before=localDomIPs.get(id);
      observations.push({
        instanceId:rec.instanceId,ip:rec.ip,label:rec.label,
        pageOpenedAt:openedAt,
        changedHere:before!==undefined && before!==rec.ip
      });
      localDomIPs.set(id,rec.ip);
    }
    return observations;
  }

  async function syncInstanceState(records) {
    const before=new Set(alertEvents.map(e=>e.id));
    const snapshot=await monitorRequest('monitor:observe',{records:observedRecords(records)});
    updateFromSnapshot(snapshot);
    return {newChanges:alertEvents.filter(e=>e.kind==='IP_CHANGE' && !before.has(e.id))};
  }

  async function hydrateAlerts(){
    if(alertsHydrated)return;
    updateFromSnapshot(await monitorRequest('monitor:get'));
  }

    function refreshChangeMarkers() {
    recentChanges.clear();
    for(const event of alertEvents)
      if((event.kind==='IP_CHANGE'||event.kind==='SLOT_IP_CHANGE') &&
        !event.acknowledged && !event.resolvedAt &&
        (!event.scope || event.scope===currentScope))
        recentChanges.set(event.newIp,event);
  }

// All scoped alert writes are committed by the single background coordinator.
  // Keeping content-side persistence disabled prevents lost updates between tabs.
  function persistAlerts(){
    throw Error('Scoped alerts are background-owned');
  }

    function dispatchNotification(event) {
    const title=event.kind==='IP_CHANGE'?event.label+' · IPv4 已变化':
      event.kind==='PORT22_UNREACHABLE'?event.label+' · TCP22不可访问':
      event.kind==='PING_UNREACHABLE'?event.label+' · Ping严重异常':
      event.kind==='HOST_UNREACHABLE'?event.label+' · 未确认主机可达':
      event.kind==='EXTENSION_CONTEXT'?'WallCheck · 扩展重新加载':
      'WallCheck · 检测服务故障';
    const message=event.kind==='IP_CHANGE'?event.oldIp+' → '+event.newIp:
      (event.ip?event.ip+'｜':'')+(event.reason||'请检查本机检测服务');
    messageRequest({type:'notify',event:{id:event.id,title,message}}).catch(()=>{
      /* The durable in-page alert remains if system notification submission fails. */
    });
  }

// Background monitor:observe and monitor:reachability create new events atomically.
  // These legacy local writers are intentionally removed.
  async function appendAlert(){
    throw Error('Use background monitor operations');
  }
  async function recordChangeAlerts(){
    // Already recorded atomically in monitor:observe.
  }

  async function refreshLabels(records){
    // Instance label updates are now part of the centralized observe transaction.
  }

  async function updateAgentHealth(ok,reason='',resultEpoch){
    updateFromSnapshot(await monitorRequest('monitor:agent',{ok,reason,...(resultEpoch===undefined?{}:{resultEpoch})}));
  }

  async function updateReachability(records,combined,resultEpoch){
    const items=[];
    for(const rec of records.values()){
      const key=combined.get(rec.ip)?.key;
      const status=key==='LOCAL_FAIL'?'HOST_UNREACHABLE':
        key==='PING_UNREACHABLE'?'PING_UNREACHABLE':
        key==='PORT_22_UNREACHABLE'?'PORT22_UNREACHABLE':
        key==='LOCAL_OK'?'OK':null;
      if(status)items.push({instanceId:rec.instanceId,ip:rec.ip,status});
    }
    updateFromSnapshot(await monitorRequest('monitor:reachability',{items,...(resultEpoch===undefined?{}:{resultEpoch})}));
  }

  async function acknowledgeAlerts(ids){
    updateFromSnapshot(await monitorRequest('monitor:ack',{ids}));
    applyBadges(collectIPCells(),lastCombined);
  }

  async function acknowledgeSlotChanges(slot){
    updateFromSnapshot(await monitorRequest('monitor:ack-slot-group',{slot}));
    applyBadges(collectIPCells(),lastCombined);
  }

  async function acknowledgeIPChanges(instanceId){
    // A group may contain arbitrarily many events accumulated while away.
    // The background transaction deletes the full pending group atomically.
    updateFromSnapshot(await monitorRequest('monitor:ack-change-group',{instanceId}));
    applyBadges(collectIPCells(),lastCombined);
  }

  async function acknowledgeRecoveredFaults(ids){
    // Global agent/extension recovery history is shared across all sgt tabs.
    // Only exact recovered event IDs are purged; live alarms cannot be removed.
    updateFromSnapshot(await monitorRequest('monitor:ack-recovered',{ids}));
  }

  async function clearThisScope(){
    if(!currentScope)return;
    const scope=currentScope;
    const hash=location.hash;
    const generation=++scopeGeneration;
    const cells=collectIPCells();
    const records=collectInstanceRecords(cells);
    const clean=[...records.values()].map(({instanceId,ip,label})=>({instanceId,ip,label}));
    // Invalidate in-flight probes before clearing, including other tabs on
    // this scope. The background preserves every other scope's cache.
    await monitorRequest('results:clear',{scope});
    const result=await monitorRequest('monitor:clear',{scope,records:clean});
    if(currentScope!==scope || location.hash!==hash || scopeGeneration!==generation)return result;
    updateFromSnapshot(result);
    cache.clear();
    lastCombined.clear();
    lastFinishedAt=null;
    lastMeasuredCount=lastMeasuredTotal=0;
    lastMeasurementCached=false;
    lastMeasurementSignature=null;
    renderTiming();
    // Store the freshly cleared baseline so the next scan does not treat
    // the same page as an IP change and does not show legacy ghost markers.
    for(const r of clean)localDomIPs.set(scope+'|'+r.instanceId,r.ip);
    return result;
  }

  function positionWallCheckOverlays(){
    const status=document.getElementById('wallcheck-panel');
    const alerts=document.getElementById('wallcheck-alert-center');
    if(!status || !alerts || status.style.display==='none')return;
    const vw=window.innerWidth || document.documentElement.clientWidth;
    const vh=window.innerHeight || document.documentElement.clientHeight;
    const rect=status.getBoundingClientRect();
    const margin=16,gap=12,minAlertWidth=280;
    const freeLeft=rect.left-margin-gap;
    if(freeLeft>=minAlertWidth){
      // ① Alert LEFT of ② Status, with equal bottom baseline.
      alerts.style.right=Math.ceil(vw-rect.left+gap)+'px';
      alerts.style.bottom=Math.max(margin,Math.ceil(vh-rect.bottom))+'px';
      alerts.style.width=Math.min(420,Math.floor(freeLeft))+'px';
      alerts.style.maxHeight=Math.max(100,Math.floor(vh-2*margin))+'px';
    }else{
      // Narrow viewport: do NOT overlap the status; stack above it.
      const availableAbove=Math.max(70,rect.top-margin-gap);
      alerts.style.right=Math.max(margin,Math.ceil(vw-rect.right))+'px';
      alerts.style.bottom=Math.max(margin,Math.ceil(vh-rect.top+gap))+'px';
      alerts.style.width=Math.max(180,Math.min(420,vw-2*margin))+'px';
      alerts.style.maxHeight=Math.floor(availableAbove)+'px';
    }
  }

    function renderAlerts() {
    const panel=document.getElementById('wallcheck-alert-center');
    if(!panel || typeof panel.replaceChildren!=='function')return;
    const pending=alertEvents.filter(e=>!e.acknowledged && !e.resolvedAt);
    panel.replaceChildren();
    panel.style.display=pending.length?'block':'none';
    const create=(tag,cls,txt)=>{
      const el=document.createElement(tag);
      if(cls)el.className=cls;
      if(txt!==undefined)el.textContent=txt;
      return el;
    };
    const recoveredHistory=document.getElementById('wallcheck-recovered-history');
    if(recoveredHistory && typeof recoveredHistory.replaceChildren==='function'){
      const wasOpen=!!recoveredHistory.open;
      recoveredHistory.replaceChildren();
      const recoveredFaults=alertEvents.filter(e=>AGENT_FAILURE_KINDS.has(e.kind) && e.resolvedAt);
      const oldFaults=recoveredFaults.slice(-20).reverse();
      recoveredHistory.style.display=oldFaults.length?'block':'none';
      if(oldFaults.length){
        recoveredHistory.appendChild(create('summary','wc-history-summary',
          '✓ 检测已恢复 · '+recoveredFaults.length+' 条历史（查看）'));
        const ack=create('button','wc-history-ack','已知');
        ack.type='button';
        ack.title='确认全部已恢复故障，不影响正在发生的故障';
        ack.addEventListener('click',event=>{
          event.preventDefault();event.stopPropagation();
          ack.disabled=true;
          acknowledgeRecoveredFaults(recoveredFaults.map(e=>e.id)).catch(err=>{
            ack.disabled=false;console.error('Recovered history acknowledge failed',err);
          });
        });
        recoveredHistory.appendChild(ack);
        for(const e of oldFaults){
          const source=e.kind==='EXTENSION_CONTEXT' || /Extension context invalidated|扩展上下文已失效/i.test(e.reason||'')
            ? '扩展上下文曾失效' : '本地检测服务曾故障';
          recoveredHistory.appendChild(create('div','wc-history-row',
            source+'｜'+new Date(e.createdAt).toLocaleString()+
            ' → '+new Date(e.resolvedAt).toLocaleString()+' 已恢复'));
        }
      }
      recoveredHistory.open=wasOpen;
    }
    if(!pending.length)return;
    panel.appendChild(create('div','wc-alert-header','WallCheck 告警 · '+pending.length+' 条待确认'));
    const groups=new Map();
    for(const event of pending){
      const key=event.kind==='SLOT_IP_CHANGE'?'slot-change:'+event.slot:
        event.kind==='IP_CHANGE'?'change:'+event.instanceId:event.id;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(event);
    }
    for(const entries of groups.values()){
      const event=entries[0];
      const block=create('div',event.kind==='SCOPE_ONBOARDED'?'wc-alert-entry wc-new-list':'wc-alert-entry');
      const heading=event.kind==='SCOPE_ONBOARDED'
        ?'🆕 新监控列表已接入 · 首次发现 '+(event.observedCount||1)+' 个 IPv4':
        event.kind==='ACCOUNT_INVALID'?'🔴 '+event.label+' · AWS账号已失效':
        event.kind==='ACCOUNT_RECOVERED'?'✅ '+event.label+' · 替补后 IP 已验证可达':
        event.kind==='SLOT_IP_CHANGE'?'🔄 '+event.label+
          ' · 监控组 IP 更新 '+entries.length+' 次':
        event.kind==='IP_LINK_SUSPECT'?'⚠ '+event.label+' · 疑似历史 IP 误关联':
        event.kind==='IP_CHANGE'?'🔄 '+event.label+' · IP变化 '+entries.length+' 次':
        event.kind==='AGENT_OFFLINE'?'⛔ 本机检测服务故障':
        event.kind==='EXTENSION_CONTEXT'?'⚠ 浏览器扩展通信失效':
        event.kind==='PORT22_UNREACHABLE'?'🔴 '+event.label+' · 严重：TCP 22不可访问':
        event.kind==='PING_UNREACHABLE'?'🔴 '+event.label+' · 严重：Ping无回应':
        '🔴 '+event.label+' · 严重：Ping 与 TCP 22均失败';
      block.appendChild(create('div','wc-alert-title',heading));
      for(const e of entries){
        const msg=e.kind==='ACCOUNT_RECOVERED'?
          (e.oldIp?e.oldIp+' → ':'')+(e.newIp||e.ip||'')+'｜'+(e.reason||'已恢复'):
          e.kind==='ACCOUNT_INVALID'?
          (e.ip?e.ip+'｜':'')+(e.reason||'账号无效'):
          e.kind==='SLOT_IP_CHANGE'?
          e.oldIp+' → '+e.newIp+'｜'+(e.reason||'同一组别地址更新'):
          e.kind==='IP_LINK_SUSPECT'?
          e.oldIp+' → '+e.newIp+'｜'+(e.reason||'身份关联待复核'):
          e.kind==='IP_CHANGE'?e.oldIp+' → '+e.newIp:
          e.kind==='SCOPE_ONBOARDED'?(e.label||'实例')+'｜'+(e.ip||'')+'｜'+(e.reason||''):
          (e.ip?e.ip+'｜':'')+(e.reason||'');
        block.appendChild(create('div','wc-alert-detail',
          new Date(e.createdAt).toLocaleString()+'  '+msg));
      }
      const ack=create('button','wc-ack-button','已知 · 不再提示');
      ack.type='button';
      ack.addEventListener('click',evt=>{
        evt.preventDefault();evt.stopPropagation();
        (event.kind==='SLOT_IP_CHANGE'
          ? acknowledgeSlotChanges(event.slot)
          : event.kind==='IP_CHANGE'
          ? acknowledgeIPChanges(event.instanceId)
          : acknowledgeAlerts(entries.map(x=>x.id))).catch(console.error);
      });
      block.appendChild(ack);
      panel.appendChild(block);
    }
    positionWallCheckOverlays();
  }

  function parsePorts(){ return ONLY_PORTS.slice(); }

  async function probe(ips, ports,trigger='page') {
    const response=await messageRequest({type:'probe',trigger:TRIGGERS.has(trigger)?trigger:'page',
      payload:{ips,ports,timeout_ms:1500,retries:2,concurrency:32}
    },PROBE_MESSAGE_TIMEOUT_MS);
    return response.data;
  }
  function portStates(result) {
    const m = new Map();
    for (const p of result?.ports || []) m.set(Number(p.port), p.state);
    return m;
  }

function classify(ip,localResp) {
    const local=localResp?.results?.[ip];
    if(!local)return {key:'LOCAL_OFFLINE',text:'❓ 本机探针无结果'};
    const tcp22=portStates(local).get(22);
    const pingState=local.icmp?.state;
    const pingOK=pingState==='REACHABLE';
    const pingFailed=pingState==='NO_REPLY' || pingState==='ERROR';
    const tcpOK=tcp22==='OPEN';
    const tcpFailed=['REFUSED','TIMEOUT','UNREACHABLE','ERROR'].includes(tcp22);
    // STRICT OR policy: Ping FAILURE OR TCP22 FAILURE is a red alarm.
    // Never re-label an unverified/missing response as a proven host fault.
    if(pingOK && tcpOK)
      return {key:'LOCAL_OK',text:'✅ 22端口可达｜Ping可达'};
    if(pingFailed && tcpFailed)
      return {key:'LOCAL_FAIL',text:'🔴 严重：Ping'+
        (pingState==='NO_REPLY'?'无回应':'检测失败')+'｜TCP 22不可达'};
    if(pingFailed)
      return {key:'PING_UNREACHABLE',text:'🔴 严重：Ping'+
        (pingState==='NO_REPLY'?'无回应':'检测失败')+
        (tcpOK?'｜TCP 22可达':'｜TCP 22未验证')};
    if(tcpFailed)
      return {key:'PORT_22_UNREACHABLE',
        text:'🔴 严重：TCP 22不可达'+(pingOK?'｜Ping可达':'｜Ping未验证')};
    return {key:'PROBE_UNVERIFIED',text:'⚠ Ping/TCP 22结果未完整验证'};
  }

    function renderHiddenNotice(ipCells){
    const target=document.getElementById('wallcheck-hidden-targets');
    if(!target)return;
    const visible=new Set([...ipCells.keys()]);
    const hidden=[...new Set(scopeCurrentIPs.filter(ip=>!visible.has(ip)))].sort();
    const key=hidden.join('|');
    if(!hidden.length || !alertsHydrated || hiddenNoticeAckKey===key){
      target.replaceChildren();
      target.style.display='none';
      return;
    }
    const previouslyExpanded=!!target.querySelector('details')?.open;
    target.replaceChildren();
    target.style.display='block';
    const row=document.createElement('div');
    row.className='wc-hidden-header';
    const details=document.createElement('details');
    const summary=document.createElement('summary');
    summary.textContent=hidden.length+' 个历史目标当前未显示（查看 IP）';
    details.appendChild(summary);
    const matching=Object.entries(scopeInstances||{}).filter(([,inst])=>hidden.includes(inst.ip));
    const seen=new Set();
    for(const [instanceId,inst] of matching){
      if(seen.has(inst.ip))continue;
      seen.add(inst.ip);
      const line=document.createElement('div');
      line.className='wc-hidden-ip';
      const stamp=inst.lastSeenAt ? new Date(inst.lastSeenAt).toLocaleString() : '未知';
      line.textContent=(inst.label||instanceId)+' · '+inst.ip+' · 上次记录：'+stamp;
      details.appendChild(line);
    }
    for(const ip of hidden){
      if(seen.has(ip))continue;
      const line=document.createElement('div');
      line.className='wc-hidden-ip';
      line.textContent='历史 IPv4 '+ip+' · 未找到对应实例标签';
      details.appendChild(line);
    }
    details.open=previouslyExpanded;
    const ack=document.createElement('button');
    ack.type='button';
    ack.className='wc-hidden-ack';
    ack.textContent='已知';
    ack.title='仅关闭当前隐藏目标提示；不会删除任何历史或故障告警';
    ack.addEventListener('click',()=>{
      ack.disabled=true;
      monitorRequest('monitor:ack-hidden',{hiddenIPs:hidden}).then(updateFromSnapshot)
        .catch(err=>{
          ack.disabled=false;
          const status=document.getElementById('wallcheck-status');
          if(status)status.title='历史提示确认失败：'+String(err.message||err);
          console.error('Hidden-target acknowledgement failed',err);
        });
    });
    row.append(details,ack);
    target.appendChild(row);
  }

  function badgeClass(key) {
    if (key === 'LOCAL_OK' || key === 'HOST_OK') return 'wc-ok';
    if (key === 'LOCAL_FAIL' || key === 'PORT_22_UNREACHABLE' ||
        key === 'PING_UNREACHABLE') return 'wc-bad';
    return 'wc-unknown';
  }

  function applyBadges(ipCells, combined) {
    mutatingBadges = true;
    try {
      document.querySelectorAll('.wallcheck-badge,.wallcheck-change-badge').forEach(x => x.remove());

      for (const [ip, cells] of ipCells) {
        const cell = cells[0];
        if (!cell) continue;

        const c = combined.get(ip) || lastCombined.get(ip) ||
          {key:'PENDING',text:'⏳ 等待本机检测结果'};
        const badge = document.createElement('span');
        badge.className = 'wallcheck-badge ' + badgeClass(c.key);
        badge.dataset.ip = ip;
        badge.textContent = c.text;
        cell.appendChild(badge);

        const change = recentChanges.get(ip);
        if (change) {
          const changeBadge = document.createElement('span');
          changeBadge.className = 'wallcheck-change-badge';
          changeBadge.dataset.ip = ip;
          changeBadge.textContent = (change.kind==='SLOT_IP_CHANGE'
            ?'监控组 IP 已更新：':'IP已变更：')+
            change.oldIp + ' → ' + change.newIp + ' ';
          changeBadge.title = (change.label || change.instanceId) + '\n' +
            '变更时间：' + new Date(change.createdAt).toLocaleString();
          const ack = document.createElement('button');
          ack.type = 'button';
          ack.className = 'wc-inline-ack';
          ack.textContent = '已知';
          ack.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            (change.kind==='SLOT_IP_CHANGE'
              ? acknowledgeSlotChanges(change.slot)
              : acknowledgeIPChanges(change.instanceId)).catch(console.error);
          });
          changeBadge.appendChild(ack);
          cell.appendChild(changeBadge);
        }
      }
    } finally {
      queueMicrotask(() => { mutatingBadges = false; });
    }
  }

  async function runCheck(force=false,trigger='page') {
    trigger=TRIGGERS.has(trigger)?trigger:'page';
    if(runtimeBlocked){
      setPanelStatus('需要重新加载扩展并刷新页面','error');
      showFailure('handshake',runtimeError(runtimeBlocked));
      return;
    }
    if (running) { pendingCheck = true; pendingForce ||= force; pendingTrigger=trigger; return; }
    const panel = document.getElementById('wallcheck-panel');
    if (!panel) return;
    if (!isEC2Route()) {
      panel.style.display = 'none';
      const alerts=document.getElementById('wallcheck-alert-center');
      if(alerts)alerts.style.display='none';
      return;
    }
    panel.style.display = 'block';
    if(alertsHydrated)renderAlerts();
    running = true;
    clearTimeout(retryTimer);retryAt=null;
    if(['automatic','manual','startup'].includes(trigger))retryAttempt=0;
    const startedAt=Date.now();
    lastAttemptAt=new Date(startedAt);
    renderTiming();
    setPanelStatus('正在检查后台连接…','checking');
    const checkHash=location.hash;
    let checkScope=null;
    let checkGeneration=scopeGeneration;
    let checkSignature=null;
    let checkAccountSignature=null;
    let ipCells;
    let previous = new Map();
    let targetCount=0;
    let phase='handshake';
    let transportUnavailable = false;
    let acceptedMeasurement=false;
    const stillCurrent=()=>{
      if(!isEC2Route() || location.hash!==checkHash ||
         scopeGeneration!==checkGeneration ||
         (checkScope && currentScope!==checkScope))return false;
      if(checkSignature!==null){
        const cells=collectIPCells();
        if(probeTargetSignature(cells,collectInstanceRecords(cells))!==checkSignature ||
           probeAccountSignature(collectAccountCards())!==checkAccountSignature)return false;
      }
      return true;
    };
    const ensureCurrent=()=>{
      if(stillCurrent())return true;
      if(isEC2Route() && !runtimeBlocked){
        pendingCheck=true;pendingForce=true;pendingTrigger='page';
      }else if(!isEC2Route()){
        panel.style.display='none';
        const alerts=document.getElementById('wallcheck-alert-center');
        if(alerts)alerts.style.display='none';
      }
      return false;
    };
    const discardCleared=()=>{
      cache.clear();lastCombined.clear();lastFinishedAt=null;
      lastMeasuredCount=lastMeasuredTotal=0;lastMeasurementCached=false;
      renderTiming();
      pendingCheck=true;pendingForce=true;pendingTrigger='page';
    };
    try {
      // Ask the executing worker, not getManifest(): disk metadata cannot
      // establish which old/new worker is currently answering this page.
      await refreshRuntimeStatus(trigger);
      if(!ensureCurrent())return;
      const scope=await scopeFromURL();
      if(!ensureCurrent())return;
      if(!scope){
        setPanelStatus('本页缺少账号隔离标识，未开始检测','stale');
        return;
      }
      resetLocalScope(scope);
      checkScope=scope;checkGeneration=scopeGeneration;
      lastAttemptAt=new Date(startedAt);
      ipCells = collectIPCells();
      const ips = [...ipCells.keys()];
      targetCount=ips.length;
      const instanceRecords = collectInstanceRecords(ipCells);
      const accountCards=collectAccountCards();
      checkSignature=probeTargetSignature(ipCells,instanceRecords);
      checkAccountSignature=probeAccountSignature(accountCards);
      lastProbeSignature=checkSignature;lastProbeAccountSignature=checkAccountSignature;
      lastDomSignature=domSignature(ipCells,instanceRecords);
      lastAccountSignature=accountSignalSignature(accountCards);
      phase='monitor_sync';
      await hydrateAlerts();
      if(!ensureCurrent())return;
      await syncAccountSignals(accountCards);
      if(!ensureCurrent())return;
      const syncResult = await syncInstanceState(instanceRecords);
      if(!ensureCurrent())return;
      if(syncResult.newChanges.length){cache.clear();force=true;}
      refreshChangeMarkers();
      writeText('wallcheck-count','当前 '+ips.length+' / 列表 '+ips.length+(recentChanges.size?' / IP变更 '+recentChanges.size:''));
      if(!ips.length){
        setPanelStatus('本页当前无可见 IPv4','idle');
        renderTiming();
        return;
      }
      const ports=parsePorts(),portKey=ports.join(',');
      const key=checkScope+'|'+ips.slice().sort().join('|')+'::'+portKey;
      phase='cache_read';
      const saved=await monitorRequest('results:get',{scope:checkScope});
      if(!ensureCurrent())return;
      if(!saved || !saved.entries || !Number.isSafeInteger(saved.epoch))
        throw runtimeError('INVALID_RESPONSE','Invalid result cache response');
      const historical=[];
      for(const ip of ips){
        const entry=saved.entries[checkScope+'|'+ip+'::'+portKey];
        if(entry?.value && Number.isFinite(entry.checkedAt) && entry.checkedAt>0){
          previous.set(ip,entry.value);historical.push(entry.checkedAt);
        }
      }
      if(lastMeasurementSignature!==checkSignature){
        lastFinishedAt=null;lastMeasuredCount=lastMeasuredTotal=0;lastMeasurementCached=false;
      }
      if(!lastFinishedAt && historical.length){
        // One conservative historical timestamp for the currently visible set.
        // Missing targets remain explicitly partial, never a completed full scan.
        lastFinishedAt=new Date(Math.min(...historical));
        lastMeasuredCount=historical.length;lastMeasuredTotal=ips.length;
        lastMeasurementCached=true;lastMeasurementSignature=checkSignature;
      }
      renderTiming();
      applyBadges(ipCells,previous);
      const hit=cache.get(key);
      if(!force && hit && Date.now()-hit.time<CACHE_MS){
        applyBadges(ipCells,hit.value);
        setPanelStatus('缓存结果（未重测）','idle');
        return;
      }
      phase='probe';
      diagnostic('scan_start',trigger,true,'NONE',targetCount);
      setPanelStatus('正在实测 '+ips.length+' 个 IPv4','checking');
      showFailure('',null);
      const outcome=await wallcheckProbeWithIsolation(ips,ports,(targets,selectedPorts)=>probe(targets,selectedPorts,trigger));
      const checkedAt = Date.now();
      if(!ensureCurrent())return;
      const failureCategories={EXTENSION_CONTEXT:'CONTEXT_INVALIDATED',MESSAGE_CHANNEL:'CHANNEL_CLOSED',
        PROBE_TIMEOUT:'TIMEOUT',NETWORK_TRANSPORT:'TRANSPORT'};
      const sharedCategory=failureCategories[outcome.failureCategory]||null;
      const localResp={results:outcome.results||{}};
      const succeededIPs=ips.filter(ip=>!!localResp.results[ip]);
      const failedIPs=ips.filter(ip=>!localResp.results[ip]);
      if(!succeededIPs.length){
        transportUnavailable=!!outcome.transportFailure;
        throw runtimeError(sharedCategory||errorCategory(outcome.batchError,'INVALID_RESPONSE'),
          outcome.failureReason||outcome.batchError||'Invalid probe response');
      }
      const combined=new Map(),entries={};
      for(const ip of ips){
        if(!localResp.results[ip]){
          const old=previous.get(ip);
          combined.set(ip,{key:'PROBE_UNVERIFIED',text:'⚠ 本次未验证'+(old?.text?'｜上次：'+old.text.slice(0,85):'')});
          continue;
        }
        const value=classify(ip,localResp);
        combined.set(ip,value);
        entries[checkScope+'|'+ip+'::'+portKey]={value,checkedAt};
      }
      let cacheProblem=null,syncProblem=null;
      phase='cache_write';
      try{
        const committed=await monitorRequest('results:merge',{scope:checkScope,epoch:saved.epoch,entries});
        if(!ensureCurrent())return;
        if(!committed?.applied){discardCleared();return;}
      }catch(error){
        if(!ensureCurrent())return;
        if(error.stale){discardCleared();return;}
        cacheProblem=runtimeError(errorCategory(error,'STORAGE_ERROR'),error.message);
        // A read may still succeed after a quota/write error. Recheck the
        // clear epoch before displaying an unsaved measurement when possible.
        if(errorCategory(cacheProblem)==='STORAGE_ERROR'){
          try{
            const fresh=await monitorRequest('results:get',{scope:checkScope});
            if(!ensureCurrent())return;
            if(fresh?.epoch!==saved.epoch){discardCleared();return;}
          }catch(checkError){if(!ensureCurrent())return;}
        }
        diagnostic('cache_write',trigger,false,errorCategory(cacheProblem),succeededIPs.length,Date.now()-checkedAt);
      }
      if(!ensureCurrent())return;
      acceptedMeasurement=true;
      lastFinishedAt = new Date(checkedAt);
      lastMeasuredCount=succeededIPs.length;lastMeasuredTotal=ips.length;
      lastMeasurementCached=false;lastMeasurementSignature=checkSignature;
      for(const [ip,result] of combined)lastCombined.set(ip,result);
      if(failedIPs.length||cacheProblem)cache.delete(key);
      else cache.set(key,{time:checkedAt,value:combined});
      applyBadges(ipCells,combined);renderHiddenNotice(ipCells);renderTiming();
      const targetFailures=[...combined.values()].some(value=>['LOCAL_FAIL','PING_UNREACHABLE','PORT_22_UNREACHABLE'].includes(value.key));
      setPanelStatus((failedIPs.length?'本轮已验证 '+succeededIPs.length+'/'+ips.length+' 个 IPv4':'实测完成 · '+ips.length+' 个 IPv4')+
        (targetFailures?' · 存在不可达目标':''),targetFailures?'error':failedIPs.length?'stale':'ok');
      diagnostic('scan_complete',trigger,true,'NONE',succeededIPs.length,Date.now()-startedAt);
      phase='monitor_sync';
      // A valid network measurement stays valid if subsequent persistence or
      // alert synchronization fails. These phases must never roll it back.
      try{
        await updateAgentHealth(true,'',saved.epoch);
        if(!ensureCurrent())return;
        await updateReachability(instanceRecords,combined,saved.epoch);
        if(!ensureCurrent())return;
        await syncAccountSignals(collectAccountCards(),new Set(ips.filter(ip=>combined.get(ip)?.key==='LOCAL_OK')),saved.epoch);
        if(!ensureCurrent())return;
      }catch(error){
        if(!ensureCurrent())return;
        if(error.stale){discardCleared();return;}
        syncProblem=runtimeError(errorCategory(error,'STORAGE_ERROR'),error.message);
        diagnostic('monitor_sync',trigger,false,errorCategory(syncProblem),succeededIPs.length);
      }
      if(cacheProblem || syncProblem){
        const problem=cacheProblem||syncProblem;
        setPanelStatus(cacheProblem?'实测完成，但保存失败':'实测完成，但告警同步失败','stale');
        showFailure(cacheProblem?'cache_write':'monitor_sync',problem);
        if(blockRuntime(problem,trigger))return;
      }else if(failedIPs.length){
        showFailure('probe',runtimeError(sharedCategory||'INVALID_RESPONSE',outcome.failureReason||outcome.batchError));
      }else showFailure('',null);
      if(sharedCategory && blockRuntime(runtimeError(sharedCategory),trigger))return;
      if(failedIPs.length){
        const queued=queueRetry(sharedCategory||'INVALID_RESPONSE');
        setPanelStatus('本轮已验证 '+succeededIPs.length+'/'+ips.length+' 个 IPv4'+
          (queued?' · 将补测':' · 等待下一轮检查'),'stale');
      }else{retryAttempt=0;retryAt=null;renderSchedule();}
    }catch(error){
      if(!ensureCurrent())return;
      if(error.stale){discardCleared();return;}
      const category=errorCategory(error,phase==='cache_read'||phase==='cache_write'?'STORAGE_ERROR':'UNKNOWN');
      diagnostic('scan_error',trigger,false,category,targetCount,Date.now()-startedAt);
      if(blockRuntime(runtimeError(category,error.message),trigger))return;
      if(!acceptedMeasurement){
        cache.clear();
        if(ipCells)applyBadges(ipCells,previous);
      }
      if(alertsHydrated && transportUnavailable){
        try{await updateAgentHealth(false,ERROR_TEXT.TRANSPORT);}catch(_){}
        if(!ensureCurrent())return;
      }
      showFailure(phase,runtimeError(category,error.message));
      const queued=queueRetry(category);
      setPanelStatus((acceptedMeasurement?'实测完成，后续处理失败':'本轮检查失败')+
        (queued?' · 将重试':' · 等待下一轮或手动检查'),'error');
      renderTiming();
    }finally{
      running=false;
      if(pendingMonitorSync){
        pendingMonitorSync=false;
        if(!runtimeBlocked && isEC2Route() && currentScope)monitorRequest('monitor:get').then(snapshot=>{
          updateFromSnapshot(snapshot);applyBadges(collectIPCells(),lastCombined);
        }).catch(error=>{diagnostic('monitor_sync',trigger,false,errorCategory(error));});
      }
      if(pendingLabelSync){
        pendingLabelSync=false;
        if(!runtimeBlocked && isEC2Route() && currentScope)syncCurrentLabels().catch(()=>{});
      }
      if(pendingCheck && !runtimeBlocked){
        const nextForce=pendingForce,nextTrigger=pendingTrigger;
        pendingCheck=pendingForce=false;pendingTrigger='page';
        setTimeout(()=>runCheck(nextForce,nextTrigger),0);
      }
      // The next scheduled time is refreshed on scans, saves, visibility and
      // a single expiry callback, never by a recurring status poll.
      renderTiming();
    }
  }
  function probeTargetSignature(cells,records){
    const ips=[...cells.keys()].sort();
    const machines=[...records.values()].map(record=>[record.instanceId,record.ip]);
    machines.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return JSON.stringify([ips,machines]);
  }
  function probeAccountSignature(records){
    return JSON.stringify(records.map(record=>[record.slot,record.ip,!!record.invalid,!!record.replacing])
      .sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  }
  async function syncCurrentLabels(){
    const hash=location.hash,scope=currentScope,generation=scopeGeneration;
    if(!scope || !isEC2Route())return;
    const cells=collectIPCells(),records=collectInstanceRecords(cells);
    const accountCards=collectAccountCards();
    await syncInstanceState(records);
    if(location.hash!==hash || currentScope!==scope || scopeGeneration!==generation)return;
    await syncAccountSignals(accountCards);
  }
  function domSignature(cells,records){
    const ips=[...cells.keys()].sort();
    const machines=[...records.values()].map(r=>[r.instanceId,r.ip,r.label]);
    machines.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return JSON.stringify([ips,machines]);
  }

  function isPageMutationRelevant(m) {
    const excluded = '#wallcheck-panel,#wallcheck-alert-center,.wallcheck-badge,.wallcheck-change-badge';
    const target = m.target?.nodeType === 1 ? m.target : m.target?.parentElement;
    if (target?.closest?.(excluded)) return false;
    if (m.type === 'characterData') return true;
    return [...(m.addedNodes || []), ...(m.removedNodes || [])].some(n =>
      // React/Vue often replace a Text node instead of editing characterData.
      n.nodeType === 3 || (
        n.nodeType === 1 &&
        !n.matches?.(excluded) &&
        !n.closest?.(excluded)
      )
    );
  }
  function install() {
    if (document.getElementById('wallcheck-panel')) return;
    const style = document.createElement('style');
    style.textContent = `
      #wallcheck-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;box-sizing:border-box;width:326px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow-y:auto;padding:12px;border:1px solid #ccc;border-radius:10px;background:#fff;box-shadow:0 8px 30px #0003;font:13px/1.45 Segoe UI,sans-serif;color:#222}
      #wallcheck-panel .row{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:7px}
      #wallcheck-hidden-targets{margin:6px 0;font:12px/1.4 Segoe UI,sans-serif;color:#596b7c}
      #wallcheck-hidden-targets .wc-hidden-header{display:flex;align-items:flex-start;justify-content:space-between;gap:5px}
      #wallcheck-hidden-targets details{flex:1;min-width:0}
      #wallcheck-hidden-targets summary{cursor:pointer}
      #wallcheck-hidden-targets .wc-hidden-ip{margin:4px 0;padding:4px 5px;background:#f8fafc;border-radius:4px;overflow-wrap:anywhere}
      #wallcheck-hidden-targets .wc-hidden-ack{padding:1px 7px;border:1px solid #b5c6d6;border-radius:5px;background:#fff;color:#415468;flex-shrink:0}
      #wallcheck-hidden-targets .wc-hidden-ack:disabled{opacity:.6}
      #wallcheck-recovered-history{position:relative;font:12px/1.4 Segoe UI,sans-serif;color:#237653;margin-top:5px;padding-right:51px;min-height:23px}
      #wallcheck-recovered-history summary{cursor:pointer;padding-top:2px}
      #wallcheck-recovered-history .wc-history-ack{position:absolute;right:0;top:0;padding:1px 7px;border:1px solid #9ad4b1;background:#f0fff4;border-radius:5px;color:#196c3b;font-size:12px;cursor:pointer}
      #wallcheck-recovered-history .wc-history-ack:disabled{opacity:.6;cursor:wait}
      .wc-history-row{padding:4px 2px;color:#61746b;overflow-wrap:anywhere}
      #wallcheck-panel button{padding:5px 8px;cursor:pointer}
      #wallcheck-panel input[type=text]{width:105px;padding:4px}
      #wallcheck-auto-minutes{width:58px;min-width:0;padding:4px;font:inherit}
      #wallcheck-interval-feedback{color:#596b7c;font-size:11px;overflow-wrap:anywhere}
      .wallcheck-badge{display:inline-block;margin-left:8px;padding:1px 6px;border-radius:10px;font-size:12px;white-space:nowrap}
      .wallcheck-change-badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:10px;font-size:12px;white-space:nowrap;background:#fff3e0;color:#b45309;font-weight:700;border:1px solid #fed7aa}
      #wallcheck-alert-center{position:fixed;right:354px;bottom:16px;z-index:2147483646;box-sizing:border-box;width:min(420px,calc(100vw - 386px));max-height:calc(100vh - 32px);overflow:auto;padding:10px;border:1px solid #fdba74;border-radius:10px;background:#fffaf0;color:#713f12;box-shadow:0 8px 30px #0003;font:13px/1.5 Segoe UI,sans-serif}
      @media(max-width:649px){
        #wallcheck-panel{max-height:48vh}
        #wallcheck-alert-center{right:16px;width:min(420px,calc(100vw - 32px));bottom:calc(48vh + 28px);max-height:calc(52vh - 44px)}
      }
      .wc-alert-header{font-weight:700;margin-bottom:8px}
      .wc-alert-entry{background:#fff;border:1px solid #fcd9a4;border-radius:8px;padding:8px;margin-top:7px}
      .wc-new-list{background:#eff6ff;border-color:#93c5fd}
      .wc-new-list .wc-alert-title{color:#1d4ed8}
      .wc-alert-title{font-weight:700;color:#92400e}
      .wc-alert-detail{overflow-wrap:anywhere;font-size:12px;margin:4px 0}
      .wc-ack-button,.wc-inline-ack{border:1px solid #e8ba73;border-radius:5px;background:#fff;color:#7c3f12;cursor:pointer;padding:2px 6px;margin:3px 0}
      .wc-inline-ack{margin-left:8px}
      .wallcheck-change-badge{animation:none!important;transition:none!important}
      .wc-ok{background:#e8f5e9;color:#146c2e}.wc-bad{background:#ffebee;color:#b42318;font-weight:700}
      .wc-warn{background:#fff8e1;color:#8a5700}.wc-unknown{background:#f1f3f4;color:#555}
    `;
    style.textContent += `
/* Append after the existing stylesheet. IDs isolate WallCheck from site rules. */
#wallcheck-panel{
  all:initial;display:block;position:fixed;right:16px;bottom:16px;z-index:2147483647;
  box-sizing:border-box;width:344px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);
  overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;
  margin:0;padding:13px 14px;border:1px solid #d6dde7;border-radius:12px;
  background:#fff;box-shadow:0 10px 32px #16263f24;color:#253247;
  font:13px/1.45 "Segoe UI","Microsoft YaHei",sans-serif;text-align:left;direction:ltr;
  isolation:isolate;
}
#wallcheck-panel *,#wallcheck-alert-center *{box-sizing:border-box;}
#wallcheck-panel [hidden],#wallcheck-alert-center [hidden]{display:none!important;}
#wallcheck-panel .wc-ui-header{
  display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0;padding:0;
}
#wallcheck-panel .wc-ui-title{
  display:flex;align-items:baseline;flex-wrap:wrap;gap:5px;min-width:0;margin:0;padding:0;
  font:700 14px/1.35 "Segoe UI","Microsoft YaHei",sans-serif;color:#17253b;
}
#wallcheck-panel #wallcheck-version{font:500 11px/1.35 "Segoe UI",sans-serif;color:#78859a;}
#wallcheck-panel #wallcheck-count{
  flex:0 1 auto;max-width:142px;margin:0;padding:3px 6px;border-radius:5px;
  background:#f0f3f8;color:#55657a;text-align:right;overflow-wrap:anywhere;
  font:600 11px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;
}
#wallcheck-panel .wc-ui-state{
  margin:10px 0 0;padding:8px 10px;border:1px solid #e3e8ef;border-radius:8px;
  background:#f6f8fb;color:#526176;
}
#wallcheck-panel #wallcheck-status{
  display:block;margin:0!important;padding:0!important;color:inherit!important;
  font:600 12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif!important;
  white-space:normal;overflow-wrap:anywhere;
}
#wallcheck-panel[data-state="ok"] .wc-ui-state{background:#f0faf5;border-color:#cee9db;color:#197349;}
#wallcheck-panel[data-state="checking"] .wc-ui-state{background:#eff6ff;border-color:#d4e4fb;color:#285a9d;}
#wallcheck-panel[data-state="stale"] .wc-ui-state{background:#fff8ec;border-color:#f2dfb8;color:#8b6219;}
#wallcheck-panel[data-state="error"] .wc-ui-state{background:#fff2f1;border-color:#f2cbc7;color:#b0352d;}
#wallcheck-panel .wc-ui-times{display:grid;gap:5px;margin:9px 0 0;padding:0;}
#wallcheck-panel .wc-ui-time{
  display:grid;grid-template-columns:104px minmax(0,1fr);align-items:baseline;gap:8px;margin:0;padding:0;
}
#wallcheck-panel .wc-ui-time dt,#wallcheck-panel .wc-ui-time dd{
  display:block;margin:0!important;padding:0!important;
  font:400 12px/1.45 "Segoe UI","Microsoft YaHei",sans-serif!important;
}
#wallcheck-panel .wc-ui-time dt{color:#788498;}
#wallcheck-panel .wc-ui-time dd{
  color:#263850;text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums!important;
}
#wallcheck-panel #wallcheck-last-success{font-weight:600!important;}
#wallcheck-panel .wc-ui-failure{
  margin:8px 0 0;padding:8px 10px;border:1px solid #f2d2cf;border-radius:7px;
  background:#fff8f7;color:#a13c34;font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;
}
#wallcheck-panel .wc-ui-failure-label{display:block;margin:0 0 2px;padding:0;font-weight:600;}
#wallcheck-panel #wallcheck-failure-reason{
  margin:0;padding:0;max-height:84px;overflow:auto;overscroll-behavior:contain;
  white-space:pre-wrap;overflow-wrap:anywhere;
}
#wallcheck-panel .wc-ui-schedule{
  margin:10px 0 0;padding:10px 0 0;border-top:1px solid #e9edf3;
}
#wallcheck-panel .wc-ui-schedule-row{
  display:grid;grid-template-columns:minmax(0,1fr) 52px 24px 54px;
  align-items:center;gap:6px;margin:0;padding:0;
}
#wallcheck-panel .wc-ui-schedule-row label,#wallcheck-panel .wc-ui-schedule-row .wc-ui-unit{
  display:block;margin:0!important;padding:0!important;height:auto!important;
  font:500 12px/1.4 "Segoe UI","Microsoft YaHei",sans-serif!important;color:#44546a!important;
}
#wallcheck-panel .wc-ui-unit{text-align:center;}
#wallcheck-panel button,#wallcheck-alert-center button{
  all:unset;box-sizing:border-box!important;appearance:none!important;display:inline-flex!important;
  align-items:center!important;justify-content:center!important;gap:4px!important;
  min-width:0!important;height:32px!important;margin:0!important;padding:0 9px!important;
  border:1px solid #d5dde8!important;border-radius:7px!important;
  background:#fff!important;color:#42536b!important;box-shadow:none!important;
  font:500 12px/1.3 "Segoe UI","Microsoft YaHei",sans-serif!important;
  text-align:center!important;text-decoration:none!important;white-space:nowrap!important;
  cursor:pointer!important;transform:none!important;
}
#wallcheck-panel button::before,#wallcheck-panel button::after,
#wallcheck-alert-center button::before,#wallcheck-alert-center button::after{content:none!important;}
#wallcheck-panel button:hover,#wallcheck-alert-center button:hover{background:#f1f5fb!important;border-color:#afc1d9!important;}
#wallcheck-panel button:disabled,#wallcheck-alert-center button:disabled{opacity:.55!important;cursor:wait!important;}
#wallcheck-panel button:focus-visible,#wallcheck-panel input:focus-visible,
#wallcheck-alert-center button:focus-visible{outline:2px solid #4188e5!important;outline-offset:2px!important;}
#wallcheck-panel #wallcheck-auto-minutes{
  all:unset;box-sizing:border-box!important;appearance:textfield!important;display:block!important;
  width:100%!important;min-width:0!important;height:32px!important;margin:0!important;padding:0 6px!important;
  border:1px solid #c4cfde!important;border-radius:7px!important;background:#fff!important;color:#253b59!important;
  box-shadow:none!important;font:600 13px/1.2 "Segoe UI","Microsoft YaHei",sans-serif!important;
  text-align:center!important;font-variant-numeric:tabular-nums!important;
}
#wallcheck-panel #wallcheck-auto-minutes::-webkit-inner-spin-button,
#wallcheck-panel #wallcheck-auto-minutes::-webkit-outer-spin-button{appearance:none;margin:0;}
#wallcheck-panel #wallcheck-interval-feedback{
  display:block;min-height:16px;margin:5px 0 0;padding:0;color:#788498;
  font:11px/1.45 "Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere;
}
#wallcheck-panel #wallcheck-interval-feedback[data-state="error"]{color:#a34c3d;}
#wallcheck-panel .wc-ui-actions{
  display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);
  gap:7px;margin:9px 0 0;padding:0;
}
#wallcheck-panel .wc-ui-actions button{width:100%!important;height:33px!important;}
#wallcheck-panel #wallcheck-run{
  border-color:#2f6fc4!important;background:#2f6fc4!important;color:#fff!important;font-weight:600!important;
}
#wallcheck-panel #wallcheck-run:hover{border-color:#255fae!important;background:#255fae!important;}
#wallcheck-panel #wallcheck-clear{color:#9a4d48!important;border-color:#e8d7d4!important;}
#wallcheck-panel #wallcheck-clear:hover{background:#fff5f3!important;border-color:#d8b5ae!important;}
#wallcheck-panel #wallcheck-notification-test-status{
  display:block;margin:7px 0 0;padding:0;color:#65748a;
  font:11px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere;
}
#wallcheck-panel #wallcheck-notification-test-status:empty{display:none;}
#wallcheck-panel .wc-ui-caption{
  margin:10px 0 0;padding:8px 0 0;border-top:1px solid #edf0f5;color:#8190a4;
  font:11px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;
}
#wallcheck-panel .wc-ui-visually-hidden{
  position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;
  overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;
}
#wallcheck-panel #wallcheck-hidden-targets{margin:9px 0 0;padding:0;font-size:12px;}
#wallcheck-panel .wc-hidden-ack,#wallcheck-panel .wc-history-ack{
  width:auto!important;height:24px!important;padding:0 7px!important;border-radius:5px!important;font-size:11px!important;
}
#wallcheck-panel #wallcheck-recovered-history{margin-top:8px;min-height:25px;padding-right:53px;font-size:11px;}
#wallcheck-panel .wc-history-row{font-size:11px;line-height:1.45;overflow-wrap:anywhere;}
#wallcheck-alert-center{
  all:initial;display:block;position:fixed;right:372px;bottom:16px;z-index:2147483646;
  box-sizing:border-box;width:380px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);
  overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;margin:0;padding:12px;
  border:1px solid #efcda2;border-radius:12px;background:#fffaf3;color:#784c1e;
  box-shadow:0 10px 32px #16263f24;font:13px/1.45 "Segoe UI","Microsoft YaHei",sans-serif;
  text-align:left;direction:ltr;isolation:isolate;
}
#wallcheck-alert-center .wc-alert-header{display:block;margin:0 0 8px;padding:0;font-size:13px;font-weight:700;}
#wallcheck-alert-center .wc-alert-entry{display:block;margin:7px 0 0;padding:9px;border:1px solid #f0dbbe;border-radius:8px;background:#fff;}
#wallcheck-alert-center .wc-alert-title{display:block;margin:0;padding:0;font-size:12px;font-weight:700;line-height:1.5;color:#8b4c18;}
#wallcheck-alert-center .wc-alert-detail{display:block;margin:5px 0;padding:0;font-size:11px;line-height:1.55;overflow-wrap:anywhere;color:#775b40;}
#wallcheck-alert-center .wc-new-list{background:#f0f6ff;border-color:#c2d8f7;}
#wallcheck-alert-center .wc-new-list .wc-alert-title{color:#2b5fa0;}
#wallcheck-alert-center .wc-ack-button{height:27px!important;margin-top:4px!important;font-size:11px!important;}
@media(max-width:699px){
  #wallcheck-panel{max-height:48vh;}
  #wallcheck-alert-center{right:16px;width:calc(100vw - 32px);bottom:calc(48vh + 28px);max-height:calc(52vh - 44px);}
}
@media(max-width:359px){
  #wallcheck-panel{padding:11px 12px;}
  #wallcheck-panel .wc-ui-title{font-size:13px;}
  #wallcheck-panel #wallcheck-count{max-width:114px;font-size:10px;}
  #wallcheck-panel .wc-ui-schedule-row{grid-template-columns:minmax(0,1fr) 46px 22px 48px;gap:4px;}
  #wallcheck-panel .wc-ui-time{grid-template-columns:96px minmax(0,1fr);gap:5px;}
}
#wallcheck-panel .wc-ui-diagnostics{margin:8px 0 0;padding:7px 0 0;border-top:1px solid #edf0f5;color:#63748b;font:11px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;}
#wallcheck-panel .wc-ui-diagnostics summary{cursor:pointer;font-weight:600;color:#52647d;}
#wallcheck-panel #wallcheck-diagnostic-summary{margin:6px 0;color:#8390a2;}
#wallcheck-panel #wallcheck-diagnostic-list{list-style:none;max-height:210px;overflow:auto;overscroll-behavior:contain;margin:0;padding:0;}
#wallcheck-panel .wc-ui-log-row{list-style:none;margin:0;padding:7px 0;border-top:1px solid #edf0f5;overflow-wrap:anywhere;}
#wallcheck-panel .wc-ui-log-row>div:first-child{font-weight:600;color:#4e617c;}
#wallcheck-panel .wc-ui-log-row[data-state="error"]>div:last-child{color:#b34b40;}

    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'wallcheck-panel';
    panel.setAttribute('role','region');
    panel.setAttribute('aria-label','WallCheck IPv4 监控');
    panel.dataset.state='idle';
    panel.innerHTML = `
<div class="wc-ui-header">
        <div class="wc-ui-title"><span>IPv4 WallCheck</span><span id="wallcheck-version">${CONTENT_CODE_VERSION}</span></div>
        <span id="wallcheck-count">当前 0 / 列表 0</span>
      </div>
      <div class="wc-ui-state">
        <div id="wallcheck-status" role="status" aria-live="polite">准备检查</div>
      </div>
      <dl class="wc-ui-times" aria-label="检测时间">
        <div class="wc-ui-time"><dt>上次有效实测</dt><dd id="wallcheck-last-success">尚无有效实测</dd></div>
        <div class="wc-ui-time"><dt>最近尝试</dt><dd id="wallcheck-last-attempt">尚未检查</dd></div>
        <div class="wc-ui-time"><dt>下次自动检查</dt><dd id="wallcheck-next-check">等待调度信息</dd></div>
      </dl>
      <div id="wallcheck-failure" class="wc-ui-failure" hidden>
        <span class="wc-ui-failure-label">失败原因</span>
        <div id="wallcheck-failure-reason">尚无错误信息</div>
      </div>
      <div id="wallcheck-hidden-targets" style="display:none"></div>
      <div class="wc-ui-schedule">
        <div class="wc-ui-schedule-row">
          <label for="wallcheck-auto-minutes">自动检测间隔</label>
          <input id="wallcheck-auto-minutes" type="number" min="1" max="60" step="1" value="5" inputmode="numeric" autocomplete="off" aria-describedby="wallcheck-interval-feedback" title="1～60 分钟"/>
          <span class="wc-ui-unit">分钟</span>
          <button id="wallcheck-interval-save" type="button">保存</button>
        </div>
        <div id="wallcheck-interval-feedback" role="status" aria-live="polite">读取设置中…</div>
        <span id="wallcheck-interval-label" class="wc-ui-visually-hidden" aria-hidden="true">每 5 分钟复检</span>
      </div>
      <div class="wc-ui-actions" role="group" aria-label="监控操作">
        <button id="wallcheck-run" type="button">立即检测</button>
        <button id="wallcheck-manual-open" type="button" title="手动添加 IPv4，使用独立检测计划">手动 IP 监控</button>
        <button id="wallcheck-notification-test" type="button" title="发送一条测试通知，检查系统是否显示">测试通知</button>
        <button id="wallcheck-clear" type="button">清空本页记录</button>
      </div>
      <div id="wallcheck-notification-test-status" role="status" aria-live="polite"></div>
      <div class="wc-ui-caption">Ping + TCP 22 · 任一失败红色告警</div>
      <details id="wallcheck-diagnostics" class="wc-ui-diagnostics">
        <summary>检测记录</summary>
        <div id="wallcheck-diagnostic-summary">展开后读取最近记录</div>
        <ol id="wallcheck-diagnostic-list"></ol>
      </details>
    `;
    document.body.appendChild(panel);
    const alertCenter=document.createElement('div');
    alertCenter.id='wallcheck-alert-center';
    alertCenter.style.display='none';
    document.body.appendChild(alertCenter);
    const recoveredHistory=document.createElement('details');
    recoveredHistory.id='wallcheck-recovered-history';
    recoveredHistory.style.display='none';
    panel.appendChild(recoveredHistory);
    // Track the real rendered status dimensions (font scale, expanding
    // historical targets, resize), not a brittle fixed bottom/right offset.
    if(typeof ResizeObserver==='function'){
      new ResizeObserver(()=>positionWallCheckOverlays()).observe(panel);
    }
    window.addEventListener('resize',positionWallCheckOverlays);
    const intervalInput=panel.querySelector('#wallcheck-auto-minutes');
    const intervalFeedback=panel.querySelector('#wallcheck-interval-feedback');
    const intervalSave=panel.querySelector('#wallcheck-interval-save');
    function showInterval(minutes,message=''){
      if(!Number.isInteger(minutes)||minutes<1||minutes>60)return;
      if(document.activeElement!==intervalInput)intervalInput.value=String(minutes);
      panel.querySelector('#wallcheck-interval-label').textContent='每 '+minutes+' 分钟复检';
      intervalFeedback.textContent=runtimeStatusIssue||message;
      positionWallCheckOverlays();
    }
    refreshRuntimeStatus('page').then(data=>{
      showInterval(data.savedMinutes,'已保存：'+data.savedMinutes+' 分钟');
    }).catch(error=>{
      intervalFeedback.textContent='无法读取后台设置';
      if(!blockRuntime(error))showFailure('schedule',error);
    });
    async function saveInterval(){
      const raw=intervalInput.value.trim(),value=Number(raw);
      if(!raw||!Number.isInteger(value)||value<1||value>60){
        intervalFeedback.textContent='请输入 1～60 的整数分钟';return;
      }
      if(runtimeBlocked){blockRuntime(runtimeError(runtimeBlocked),'manual');return;}
      intervalSave.disabled=true;intervalFeedback.textContent='正在保存…';
      let saved=false;
      try{
        const reply=await messageRequest({type:'auto:set-interval',minutes:value});
        saved=true;
        showInterval(reply.minutes,'已保存：'+reply.minutes+' 分钟');
        await refreshRuntimeStatus('manual');
      }catch(error){
        intervalFeedback.textContent=saved?'设置已保存，计划状态暂未读取':'保存失败，请重试';
        if(!blockRuntime(error,'manual'))showFailure('schedule',error);
      }finally{intervalSave.disabled=false;}
    }
    intervalSave.addEventListener('click',saveInterval);
    intervalInput.addEventListener('keydown',event=>{
      if(event.key==='Enter'){event.preventDefault();saveInterval();}
    });
    chrome.storage.onChanged.addListener((changes,area)=>{
      if(area!=='local'||!changes?.[AUTO_INTERVAL_KEY])return;
      const minutes=Number(changes[AUTO_INTERVAL_KEY].newValue);
      if(Number.isInteger(minutes)&&minutes>=1&&minutes<=60){
        showInterval(minutes,'已同步：'+minutes+' 分钟');
        setTimeout(()=>{
          if(!runtimeBlocked)refreshRuntimeStatus('page').catch(error=>{
            if(!blockRuntime(error))showFailure('schedule',error);
          });
        },100);
      }
    });
    panel.querySelector('#wallcheck-run').addEventListener('click',()=>runCheck(true,'manual'));
    panel.querySelector('#wallcheck-notification-test').addEventListener('click',async()=>{
      const out=panel.querySelector('#wallcheck-notification-test-status');
      out.textContent='正在提交测试通知…';
      try{
        await messageRequest({type:'notify',event:{id:'NOTIFICATION_TEST_'+Date.now(),
          title:'WallCheck · 系统通知测试',message:'这是测试通知，不代表监控目标发生故障'}});
        out.textContent='已提交通知；未弹出时请检查系统通知和勿扰设置。';
      }catch(error){
        out.textContent='测试通知提交失败。';
        if(!blockRuntime(error,'manual'))showFailure('monitor_sync',error);
      }
    });
    panel.querySelector('#wallcheck-manual-open').addEventListener('click',()=>{
      messageRequest({type:'manual:open'}).catch(error=>{
        if(!blockRuntime(error,'manual'))showFailure('monitor_sync',error);
      });
    });
    panel.querySelector('#wallcheck-clear').addEventListener('click',async()=>{
      if(!currentScope){setPanelStatus('本页尚未取得账号隔离标识','stale');return;}
      if(!window.confirm('清空当前 sgt 页面的已保存 IP 列表、变化历史和告警？\n将以本页当前 IP 重新建立基线，其他 sgt 页面不受影响。'))return;
      try{
        await clearThisScope();
        document.querySelectorAll('.wallcheck-badge,.wallcheck-change-badge').forEach(node=>node.remove());
        await runCheck(true,'manual');
      }catch(error){
        if(!blockRuntime(error,'manual')){
          setPanelStatus('清空记录未完成','stale');showFailure('cache_write',runtimeError(errorCategory(error,'STORAGE_ERROR'),error.message));
        }
      }
    });
    panel.querySelector('#wallcheck-diagnostics').addEventListener('toggle',event=>{
      if(!event.currentTarget.open)return;
      writeText('wallcheck-diagnostic-summary','正在读取记录…');
      if(runtimeBlocked){writeText('wallcheck-diagnostic-summary','请重新加载扩展并刷新页面后查看记录');return;}
      refreshRuntimeStatus('manual').catch(error=>{
        writeText('wallcheck-diagnostic-summary','读取失败：'+(ERROR_TEXT[errorCategory(error)]||ERROR_TEXT.UNKNOWN));
        blockRuntime(error,'manual');
      });
    });
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState==='hidden'||runtimeBlocked)return;
      renderTiming();
      refreshRuntimeStatus('page').catch(error=>{
        if(!blockRuntime(error))showFailure('schedule',error);
      });
    });

    const observer = new MutationObserver(mutations => {
      if (mutatingBadges || !mutations.some(isPageMutationRelevant)) return;
      // Countdown and progress text may mutate continually. Only stable
      // account status/IPv4 evidence may schedule a new network probe.
      const currentCells=collectIPCells();
      const currentRecords=collectInstanceRecords(currentCells);
      const accountCards=collectAccountCards();
      const accountSignature=accountSignalSignature(accountCards);
      const signature=domSignature(currentCells,currentRecords);
      const targetSignature=probeTargetSignature(currentCells,currentRecords);
      const accountStateSignature=probeAccountSignature(accountCards);
      const accountChanged=accountSignature!==lastAccountSignature;
      const ipChanged=signature!==lastDomSignature;
      if(!accountChanged && !ipChanged)return;
      const measuredInputsChanged=targetSignature!==lastProbeSignature ||
        accountStateSignature!==lastProbeAccountSignature;
      lastAccountSignature=accountSignature;
      lastDomSignature=signature;
      lastProbeSignature=targetSignature;
      lastProbeAccountSignature=accountStateSignature;
      if(!measuredInputsChanged){
        // A label/countdown repaint is not a new measurement. Keep metadata
        // current without invalidating or repeatedly restarting a real probe.
        if(running)pendingLabelSync=true;
        else if(!runtimeBlocked)syncCurrentLabels().catch(()=>{});
        return;
      }
      if(accountChanged && !runtimeBlocked){
        // This lightweight single-writer event persists failure immediately;
        // don't wait until a probe request can finish.
        scanAccountStatusWithoutProbe().catch(()=>{});
      }
      clearTimeout(scanTimer);
      scanTimer=setTimeout(()=>runCheck(true,'page'),700);
    });
    observer.observe(document.body,{childList:true,characterData:true,subtree:true});

    chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
      if(msg?.type==='auto-recheck' || msg?.type==='startup-recheck'){
        // Acknowledge delivery immediately; the real scan has its own bounded
        // lifecycle and diagnostics, and is never awaited by the alarm sender.
        sendResponse?.({ok:true,accepted:!runtimeBlocked});
        runCheck(true,msg.type==='auto-recheck'?'automatic':'startup');
        return false;
      } else if(msg?.type==='results:cleared' && msg.scope===currentScope){
        scopeGeneration++;
        cache.clear();
        lastCombined.clear();
        lastFinishedAt=null;
        lastAttemptAt=null;
        lastMeasuredCount=lastMeasuredTotal=0;
        lastMeasurementCached=false;
        lastMeasurementSignature=null;
        retryAt=null;retryAttempt=0;
        clearTimeout(retryTimer);
        setPanelStatus('本页记录已清空，等待重新检测','idle');
        renderTiming();
        if(running){pendingCheck=true;pendingForce=true;}
        else if(!runtimeBlocked)setTimeout(()=>runCheck(true,'page'),0);
      } else if(msg?.type==='monitor-sync' && msg.scope===currentScope){
        if(running){pendingMonitorSync=true;return;}
        if(runtimeBlocked)return;
        monitorRequest('monitor:get').then(snapshot=>{
          updateFromSnapshot(snapshot);
          applyBadges(collectIPCells(),lastCombined);
        }).catch(()=>{ /* next scheduled scan will reconcile */ });
      }
    });

    window.addEventListener('hashchange', () => {
      scopeGeneration++;
      lastFinishedAt=null;
      lastAttemptAt=null;
      lastMeasuredCount=lastMeasuredTotal=0;
      lastMeasurementCached=false;
      lastMeasurementSignature=null;
      retryAt=null;retryAttempt=0;
      cache.clear();
      lastCombined.clear();
      clearTimeout(retryTimer);
      setPanelStatus('页面已切换，等待本页检测','idle');
      renderTiming();
      if(!runtimeBlocked)setTimeout(()=>runCheck(false,'page'),250);
    });
    setTimeout(()=>runCheck(true), 600);

  }

  install();
})();
