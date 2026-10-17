(() => {
  'use strict';

  const CACHE_MS = 5 * 60 * 1000;
  const AUTO_RECHECK_MINUTES = 10;
  const SCOPED_MONITOR_VERSION = 3;
  const openedAt = Date.now();
  let currentScope = null;
  let scopeCurrentIPs = [];
  let lastKnownScope = null;
  let scopeTokenMemo = null;
  let scopeHashMemo = null;
  const localDomIPs = new Map();
  const ONLY_PORTS = [22];

  const cache = new Map();
  const lastCombined = new Map();
  const recentChanges = new Map();
  const RESULT_KEY = 'wallcheck_last_valid_results_v3';
  let pendingCheck = false;
  let pendingForce = false;
  let retryTimer = null;
  let alertEvents = [];
  let conditionStates = {};
  let alertsHydrated = false;
  let pendingMonitorSync = false;
  const AGENT_FAILURE_KINDS = new Set(['AGENT_OFFLINE','EXTENSION_CONTEXT']);
  const storageGet = keys => new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, data => {
      const err = chrome.runtime.lastError;
      err ? reject(new Error(err.message)) : resolve(data);
    });
  });
  const storageSet = data => new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      const err = chrome.runtime.lastError;
      err ? reject(new Error(err.message)) : resolve();
    });
  });
  let running = false;
  let scanTimer = null;
  let mutatingBadges = false;
  let lastFinishedAt = null;

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

function monitorRequest(type, fields={}) {
    return new Promise((resolve,reject) => {
      chrome.runtime.sendMessage({type,scope:currentScope,...fields},res=>{
        const e=chrome.runtime.lastError;
        if(e || !res?.ok) reject(Error(e?.message || res?.error || '监控数据操作未成功'));
        else resolve(res.data);
      });
    });
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
    alertsHydrated=true;
    refreshChangeMarkers();
    renderAlerts();
  }

  function resetLocalScope(next){
    if(currentScope===next)return;
    currentScope=next;
    lastKnownScope=next;
    alertsHydrated=false;
    alertEvents=[];
    conditionStates={};
    scopeCurrentIPs=[];
    cache.clear();
    lastCombined.clear();
    recentChanges.clear();
    renderAlerts();
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

  function findInstanceIdNear(cell, ip) {
    let node = cell;
    for (let depth = 0; node && node !== document.body && depth < 10; depth++, node = node.parentElement) {
      const txt = (node.innerText || node.textContent || '').trim();
      if (!txt || txt.length > 2500 || !txt.includes(ip)) continue;
      const ids = [...new Set((txt.match(/\bi-[0-9a-f]{8,32}\b/gi) || []).map(x => x.toLowerCase()))];
      if (ids.length === 1) return ids[0];
    }
    return null;
  }

function findInstanceLabelNear(cell, ip) {
    let node = cell;
    for (let depth = 0; node && node !== document.body && depth < 12; depth++, node = node.parentElement) {
      const text = (node.innerText || node.textContent || '').trim();
      if (!text.includes(ip) || text.length > 3000) continue;
      const heads = [...text.matchAll(/#\s*(\d{1,4})\b/g)];
      if (heads.length !== 1) continue;
      const h = heads[0];
      const lines = text.slice(h.index + h[0].length).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
      let name = (lines[0] || '').replace(/^[^\p{L}\p{N}]+/u,'').replace(/^编辑\s*/u,'').trim();
      name = name.replace(/\s+\d+\s*(?:天|小时|分钟).*$/u,'').trim();
      name = name.split(/\s{2,}|IPv[46]|地区|型号|配置时间|接近时间|剩余|状态|更换IP|IP\s/iu)[0].trim();
      if (!name) name = (lines.find(x=>x.length <= 32 && !/^(IP|IPv|型号|地区|配置|剩余|状态)/.test(x)) || '').slice(0,32);
      return {slot:h[1],label:'#'+h[1]+(name ? ' '+name.slice(0,32) : '')};
    }
    return null;
  }
  function findStableIPv6Near(cell,ip) {
    let node=cell;
    for(let depth=0;node && node!==document.body && depth<12;depth++,node=node.parentElement){
      const text=(node.innerText || node.textContent || '').trim();
      if(!text.includes(ip) || text.length>1800)continue;
      const values=[...text.matchAll(/(?:IPv6\s*[:：]?\s*)([0-9a-f:]{10,50})/gi)]
        .map(m=>m[1].toLowerCase()).filter(v=>v.includes(':'));
      if(values.length && values.length<=3)return [...new Set(values)].sort()[0];
    }
    return null;
  }

    function collectInstanceRecords(ipCells) {
    const records=new Map();
    for(const [ip,cells] of ipCells) {
      const cell=cells[0];
      if(!cell) continue;
      const official=findInstanceIdNear(cell,ip);
      const display=findInstanceLabelNear(cell,ip);
      const ip6=findStableIPv6Near(cell,ip);
      // Ordinals like #1 and #2 identify the display label ONLY, not a machine.
      // With no stable EC2/IPv6 marker, key by IPv4 and suppress IP-change inference.
      const instanceId=official ? 'ec2:'+official : (ip6 ? 'ipv6:'+ip6 : 'ip-target:'+ip);
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
      if(event.kind==='IP_CHANGE' && !event.acknowledged &&
        !event.resolvedAt && (!event.scope || event.scope===currentScope))
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
      event.kind==='HOST_UNREACHABLE'?event.label+' · 未确认主机可达':
      event.kind==='EXTENSION_CONTEXT'?'WallCheck · 扩展重新加载':
      'WallCheck · 检测服务故障';
    const message=event.kind==='IP_CHANGE'?event.oldIp+' → '+event.newIp:
      (event.ip?event.ip+'｜':'')+(event.reason||'请检查本机检测服务');
    try {
      chrome.runtime.sendMessage({type:'notify',event:{id:event.id,title,message}},()=>{
        void chrome.runtime.lastError;
      });
    }catch(_){ /* page alert persists if system notification is blocked */ }
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

  async function updateAgentHealth(ok,reason=''){
    updateFromSnapshot(await monitorRequest('monitor:agent',{ok,reason}));
  }

  async function updateReachability(records,combined){
    const items=[];
    for(const rec of records.values()){
      const key=combined.get(rec.ip)?.key;
      const status=key==='LOCAL_FAIL'?'HOST_UNREACHABLE':
        key==='PORT_22_UNREACHABLE'?'PORT22_UNREACHABLE':
        key==='LOCAL_OK'?'OK':null;
      if(status)items.push({instanceId:rec.instanceId,ip:rec.ip,status});
    }
    updateFromSnapshot(await monitorRequest('monitor:reachability',{items}));
  }

  async function acknowledgeAlerts(ids){
    updateFromSnapshot(await monitorRequest('monitor:ack',{ids}));
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
    const cells=collectIPCells();
    const records=collectInstanceRecords(cells);
    const clean=[...records.values()].map(({instanceId,ip,label})=>({instanceId,ip,label}));
    const result=await monitorRequest('monitor:clear',{records:clean});
    updateFromSnapshot(result);
    // Also discard this scope's cached probe results; preserve other sgt caches.
    const data=await storageGet([RESULT_KEY]);
    const previous=data[RESULT_KEY] || {};
    for(const key of Object.keys(previous)){
      if(key.startsWith(currentScope+'|'))delete previous[key];
    }
    await storageSet({[RESULT_KEY]:previous});
    cache.clear();
    lastCombined.clear();
    // Store the freshly cleared baseline so the next scan does not treat
    // the same page as an IP change and does not show legacy ghost markers.
    for(const r of clean)localDomIPs.set(currentScope+'|'+r.instanceId,r.ip);
    return result;
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
      const key=event.kind==='IP_CHANGE'?'change:'+event.instanceId:event.id;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(event);
    }
    for(const entries of groups.values()){
      const event=entries[0];
      const block=create('div','wc-alert-entry');
      const heading=event.kind==='IP_CHANGE'?'🔄 '+event.label+' · IP变化 '+entries.length+' 次':
        event.kind==='AGENT_OFFLINE'?'⛔ 本机检测服务故障':
        event.kind==='EXTENSION_CONTEXT'?'⚠ 浏览器扩展通信失效':
        event.kind==='PORT22_UNREACHABLE'?'🔴 '+event.label+' · 22端口不可访问':
        '🔴 '+event.label+' · 主机未确认可达';
      block.appendChild(create('div','wc-alert-title',heading));
      for(const e of entries){
        const msg=e.kind==='IP_CHANGE'?e.oldIp+' → '+e.newIp:
          (e.ip?e.ip+'｜':'')+(e.reason||'');
        block.appendChild(create('div','wc-alert-detail',
          new Date(e.createdAt).toLocaleString()+'  '+msg));
      }
      const ack=create('button','wc-ack-button','已知 · 不再提示');
      ack.type='button';
      ack.addEventListener('click',evt=>{
        evt.preventDefault();evt.stopPropagation();
        (event.kind==='IP_CHANGE'
          ? acknowledgeIPChanges(event.instanceId)
          : acknowledgeAlerts(entries.map(x=>x.id))).catch(console.error);
      });
      block.appendChild(ack);
      panel.appendChild(block);
    }
  }

  function parsePorts(){ return ONLY_PORTS.slice(); }

  function probe(ips, ports) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({type:'probe',
        payload:{ips, ports, timeout_ms:1500, retries:2, concurrency:32}
      }, res => {
        const err = chrome.runtime.lastError;
        if (err || !res?.ok) reject(new Error(err?.message || res?.error || '探针没有返回响应'));
        else resolve(res.data);
      });
    });
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
    const ping=local.icmp?.state==='REACHABLE';
    if(tcp22==='OPEN')return {key:'LOCAL_OK',text:'✅ 22端口可达'+(ping?'｜Ping可达':'｜Ping无回应')};
    if(ping || tcp22==='REFUSED')
      return {key:'PORT_22_UNREACHABLE',text:'🔴 主机可达｜22端口不可访问'};
    return {key:'LOCAL_FAIL',text:'⚠ 本机未确认主机可达（Ping/22均失败）'};
  }

    function badgeClass(key) {
    if (key === 'LOCAL_OK' || key === 'HOST_OK') return 'wc-ok';
    if (key === 'LOCAL_FAIL' || key === 'PORT_22_UNREACHABLE') return 'wc-bad';
    return 'wc-unknown';
  }

  function applyBadges(ipCells, combined) {
    mutatingBadges = true;
    try {
      document.querySelectorAll('.wallcheck-badge,.wallcheck-change-badge').forEach(x => x.remove());

      for (const [ip, cells] of ipCells) {
        const cell = cells[0];
        if (!cell) continue;

        const c = combined.get(ip) || {key:'UNKNOWN', text:'❓ 未检测'};
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
          changeBadge.textContent = 'IP已变更：' + change.oldIp + ' → ' + change.newIp + ' ';
          changeBadge.title = (change.label || change.instanceId) + '\n' +
            '变更时间：' + new Date(change.createdAt).toLocaleString();
          const ack = document.createElement('button');
          ack.type = 'button';
          ack.className = 'wc-inline-ack';
          ack.textContent = '已知';
          ack.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            acknowledgeIPChanges(change.instanceId).catch(console.error);
          });
          changeBadge.appendChild(ack);
          cell.appendChild(changeBadge);
        }
      }
    } finally {
      queueMicrotask(() => { mutatingBadges = false; });
    }
  }

  async function runCheck(force=false) {
    if (running) { pendingCheck = true; pendingForce ||= force; return; }
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
    let ipCells;
    let previous = new Map();
    let transportUnavailable = false;
    try {
      ipCells = collectIPCells();
      const currentIPs = [...ipCells.keys()];
      const scope=await scopeFromURL();
      if(!scope){
        document.getElementById('wallcheck-status').textContent =
          '⚠ 本页缺少 sgt，无法安全记录 IP 变化';
        // No IP-change inference without a stable account scope.
        return;
      }
      resetLocalScope(scope);
      const instanceRecords = collectInstanceRecords(ipCells);
      await hydrateAlerts();
      const syncResult = await syncInstanceState(instanceRecords);
      // Scoped coordinator updates instance display names automatically.
      if (syncResult.newChanges.length) {
        cache.clear();
        force = true;
        // Changes already persisted in background, exactly once.
      }
      refreshChangeMarkers();
      // Only visible addresses on THIS signed sgt page are probed.
      const ips = currentIPs;
      document.getElementById('wallcheck-count').textContent = '当前 ' + currentIPs.length + ' / 列表 ' + ips.length + (recentChanges.size ? ' / IP变更 ' + recentChanges.size : '');
      if (!ips.length) { document.getElementById('wallcheck-status').textContent = '本页当前无可见 IPv4｜历史基线保留'; return; }
      const ports = parsePorts();
      const portKey = ports.join(',');
      const key = currentScope + '|' + ips.slice().sort().join('|') + '::' + portKey;
      const data = await storageGet([RESULT_KEY]);
      const saved = data[RESULT_KEY] || {};
      for (const ip of ips) {
        const entry = saved[currentScope + '|' + ip + '::' + portKey];
        if (entry?.value && entry.checkedAt) previous.set(ip, entry.value);
      }
      applyBadges(ipCells, previous);
      const hit = cache.get(key);
      if (!force && hit && Date.now() - hit.time < CACHE_MS) {
        applyBadges(ipCells, hit.value);
        document.getElementById('wallcheck-status').textContent = '缓存结果 · ' + new Date(hit.time).toLocaleTimeString();
        return;
      }
      document.getElementById('wallcheck-status').textContent = previous.size ? '已恢复上次有效结果 · 正在重新验证' : '检测中 · ' + ips.length + ' 个 IPv4';
      // Keep healthy results even if one target fails; bounded individual retries.
      const outcome=await wallcheckProbeWithIsolation(ips,ports,probe);
      if(outcome.transportFailure){
        transportUnavailable=true;
        throw new Error(outcome.batchError || '本机检测通信失败');
      }
      const localResp={results:outcome.results};
      const succeededIPs=ips.filter(ip=>!!localResp.results[ip]);
      const failedIPs=ips.filter(ip=>!localResp.results[ip]);
      if(!succeededIPs.length)
        throw new Error('检测接口未返回任何可验证目标结果');
      await updateAgentHealth(true);
      const combined = new Map();
      const checkedAt = Date.now();
      for (const ip of ips) {
        if(!localResp.results[ip]){
          const old=previous.get(ip);
          const info=old?.text ? '｜上次：'+old.text.slice(0,85) : '';
          const c={key:'PROBE_UNVERIFIED',text:'⚠ 本次未验证'+info};
          combined.set(ip,c);
          lastCombined.set(ip,c);
          continue; // Not a verified unreachable host; do not cache this.
        }
        const c=classify(ip,localResp);
        combined.set(ip,c);
        lastCombined.set(ip,c);
        saved[currentScope + '|' + ip + '::' + portKey]={value:c,checkedAt};
      }
      const bounded = Object.fromEntries(Object.entries(saved).sort((a,b) => b[1].checkedAt - a[1].checkedAt).slice(0,2000));
      await storageSet({[RESULT_KEY]: bounded});
      clearTimeout(retryTimer);
      lastFinishedAt = new Date(checkedAt);
      if(failedIPs.length)cache.delete(key);
      else cache.set(key,{time:checkedAt,value:combined});
      applyBadges(ipCells, combined);
      await updateReachability(instanceRecords, combined);
      const historicalSkipped=Math.max(0,scopeCurrentIPs.length-ips.length);
      const skippedText=historicalSkipped ? '｜'+historicalSkipped+' 个历史目标本页未显示' : '';
      const status=document.getElementById('wallcheck-status');
      status.textContent=failedIPs.length ?
        '⚠ 已验证 '+succeededIPs.length+'/'+ips.length+' 个可见 IPv4｜其余未验证｜15秒后补测'+skippedText :
        '本机探针✓ · '+ips.length+' 个可见 IPv4 · '+lastFinishedAt.toLocaleTimeString()+skippedText;
      if(failedIPs.length)retryTimer=setTimeout(()=>runCheck(true),15000);
      document.getElementById('wallcheck-status').title = '';
    } catch (err) {
      cache.clear();
      if (ipCells) applyBadges(ipCells, previous);
      // A bad AWS account, DOM parse, or storage error is NOT proof that
      // localhost agent is offline. Only confirmed probe transport failure is.
      if(alertsHydrated && transportUnavailable){
        try{await updateAgentHealth(false,err.message||String(err));}catch(_){}
      }
      const status = document.getElementById('wallcheck-status');
      status.textContent = '⚠ 本次检测失败｜' + (previous.size ? '保留上次有效结果' : '本机探针不可用') + '｜15秒后重试';
      status.title = String(err.message || err);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => runCheck(true), 15000);
    } finally {
      running = false;
      if (pendingMonitorSync) {
        pendingMonitorSync = false;
        monitorRequest('monitor:get').then(snapshot=>{
          updateFromSnapshot(snapshot);
          applyBadges(collectIPCells(),lastCombined);
        }).catch(()=>{});
      }
      if (pendingCheck) {
        const nextForce = pendingForce;
        pendingCheck = pendingForce = false;
        setTimeout(() => runCheck(nextForce), 0);
      }
    }
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
      #wallcheck-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;padding:12px;border:1px solid #ccc;border-radius:10px;background:#fff;box-shadow:0 8px 30px #0003;font:13px/1.45 Segoe UI,sans-serif;color:#222}
      #wallcheck-panel .row{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:7px}
      #wallcheck-recovered-history{position:relative;font:12px/1.4 Segoe UI,sans-serif;color:#237653;margin-top:5px;padding-right:51px;min-height:23px}
      #wallcheck-recovered-history summary{cursor:pointer;padding-top:2px}
      #wallcheck-recovered-history .wc-history-ack{position:absolute;right:0;top:0;padding:1px 7px;border:1px solid #9ad4b1;background:#f0fff4;border-radius:5px;color:#196c3b;font-size:12px;cursor:pointer}
      #wallcheck-recovered-history .wc-history-ack:disabled{opacity:.6;cursor:wait}
      .wc-history-row{padding:4px 2px;color:#61746b;overflow-wrap:anywhere}
      #wallcheck-panel button{padding:5px 8px;cursor:pointer}
      #wallcheck-panel input[type=text]{width:105px;padding:4px}
      .wallcheck-badge{display:inline-block;margin-left:8px;padding:1px 6px;border-radius:10px;font-size:12px;white-space:nowrap}
      .wallcheck-change-badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:10px;font-size:12px;white-space:nowrap;background:#fff3e0;color:#b45309;font-weight:700;border:1px solid #fed7aa}
      #wallcheck-alert-center{position:fixed;right:16px;bottom:190px;z-index:2147483646;width:min(420px,calc(100vw - 32px));max-height:48vh;overflow:auto;padding:10px;border:1px solid #fdba74;border-radius:10px;background:#fffaf0;color:#713f12;box-shadow:0 8px 30px #0003;font:13px/1.5 Segoe UI,sans-serif}
      .wc-alert-header{font-weight:700;margin-bottom:8px}
      .wc-alert-entry{background:#fff;border:1px solid #fcd9a4;border-radius:8px;padding:8px;margin-top:7px}
      .wc-alert-title{font-weight:700;color:#92400e}
      .wc-alert-detail{overflow-wrap:anywhere;font-size:12px;margin:4px 0}
      .wc-ack-button,.wc-inline-ack{border:1px solid #e8ba73;border-radius:5px;background:#fff;color:#7c3f12;cursor:pointer;padding:2px 6px;margin:3px 0}
      .wc-inline-ack{margin-left:8px}
      .wallcheck-change-badge{animation:none!important;transition:none!important}
      .wc-ok{background:#e8f5e9;color:#146c2e}.wc-bad{background:#ffebee;color:#b42318;font-weight:700}
      .wc-warn{background:#fff8e1;color:#8a5700}.wc-unknown{background:#f1f3f4;color:#555}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'wallcheck-panel';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-weight:700"><span>IPv4 WallCheck 1.8.3</span><span id="wallcheck-count">当前 0 / 列表 0</span></div>
      <div id="wallcheck-status" style="color:#666;margin-top:5px">准备扫描</div>
      <div class="row"><span>TCP端口：22（固定）</span><button id="wallcheck-run">强制重测</button><button id="wallcheck-clear">清空本页记录</button></div>
      <div style="color:#666;margin-top:7px">本机 ICMP + TCP 双层检测；每 ${AUTO_RECHECK_MINUTES} 分钟复检。同一实例变化持续累计；点击「已知」清除此组记录。</div>
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
    panel.querySelector('#wallcheck-run').addEventListener('click',()=>runCheck(true));
    panel.querySelector('#wallcheck-clear').addEventListener('click',async ()=>{
      if(!currentScope){
        document.getElementById('wallcheck-status').textContent='本页尚未取得 sgt 隔离标识';
        return;
      }
      if(!window.confirm('清空当前 sgt 页面的已保存 IP 列表、变化历史和告警？\n将以本页当前 IP 重新建立基线，其他 sgt 页面不受影响。'))return;
      try {
        await clearThisScope();
        document.querySelectorAll('.wallcheck-badge,.wallcheck-change-badge').forEach(x=>x.remove());
        await runCheck(true);
      } catch(e){
        document.getElementById('wallcheck-status').textContent='清空失败：'+String(e.message||e);
      }
    });

    const observer = new MutationObserver(mutations => {
      if (mutatingBadges || !mutations.some(isPageMutationRelevant)) return;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(()=>runCheck(false), 700);
    });
    observer.observe(document.body,{childList:true,characterData:true,subtree:true});

    chrome.runtime.onMessage.addListener(msg=>{
      if(msg?.type==='auto-recheck' || msg?.type==='startup-recheck'){
        runCheck(true);
      } else if(msg?.type==='monitor-sync' && msg.scope===currentScope){
        if(running){pendingMonitorSync=true;return;}
        monitorRequest('monitor:get').then(snapshot=>{
          updateFromSnapshot(snapshot);
          applyBadges(collectIPCells(),lastCombined);
        }).catch(()=>{ /* next scheduled scan will reconcile */ });
      }
    });

    window.addEventListener('hashchange', () => setTimeout(()=>runCheck(false), 250));
    setTimeout(()=>runCheck(true), 600);

  }

  install();
})();