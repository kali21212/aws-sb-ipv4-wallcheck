(() => {
  'use strict';

  const CACHE_MS = 5 * 60 * 1000;
  const AUTO_RECHECK_MINUTES = 10;
  const ALERT_KEY = 'wallcheck_alert_events_v1';
  const CONDITION_KEY = 'wallcheck_condition_states_v1';
  const ONLY_PORTS = [22];
  const INSTANCE_STATE_KEY = 'wallcheck_instance_state_v1';
  const cache = new Map();
  const lastCombined = new Map();
  const recentChanges = new Map();
  const RESULT_KEY = 'wallcheck_last_valid_results_v1';
  let pendingCheck = false;
  let pendingForce = false;
  let retryTimer = null;
  let alertEvents = [];
  let conditionStates = {};
  let alertsHydrated = false;
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

  const STORE_KEY = 'wallcheck_ipv4_list_v2';

  function isEC2Route() {
    return location.origin === 'https://aws.sb' &&
      location.hash.startsWith('#/ec2-instances');
  }

  function mergeStoredIPs(currentIPs) {
    return new Promise(resolve => {
      chrome.storage.local.get([STORE_KEY], data => {
        const stored = Array.isArray(data[STORE_KEY]) ? data[STORE_KEY] : [];
        const all = [...new Set([...stored, ...currentIPs])].filter(isIPv4).sort();
        chrome.storage.local.set({[STORE_KEY]: all}, () => resolve(all));
      });
    });
  }

  function clearStoredIPs() {
    return new Promise(resolve => {
      chrome.storage.local.set({
        [STORE_KEY]: [],
        [INSTANCE_STATE_KEY]: {}
      }, () => {
        recentChanges.clear();
        resolve();
      });
    });
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
  function collectInstanceRecords(ipCells) {
    const records=new Map();
    for(const [ip,cells] of ipCells) {
      const cell=cells[0];
      if(!cell) continue;
      const official=findInstanceIdNear(cell,ip);
      const display=findInstanceLabelNear(cell,ip);
      const instanceId=official || (display ? 'aws-sb-slot-'+display.slot : 'ip-target:'+ip);
      records.set(instanceId,{
        instanceId,ip,cell,label:display?.label || (official ? '实例 '+official : 'IPv4 '+ip)
      });
    }
    return records;
  }

    function syncInstanceState(records) {
    return new Promise(resolve => {
      chrome.storage.local.get([INSTANCE_STATE_KEY, STORE_KEY], data => {
        const state = data[INSTANCE_STATE_KEY] && typeof data[INSTANCE_STATE_KEY] === 'object'
          ? data[INSTANCE_STATE_KEY]
          : {};
        let storedIPs = Array.isArray(data[STORE_KEY]) ? data[STORE_KEY].filter(isIPv4) : [];
        const now = Date.now();
        const newChanges = [];
        for (const [instanceId, rec] of records) {
          const prev = state[instanceId];

          if (!prev) {
            state[instanceId] = {
              ip: rec.ip,
              label: rec.label,
              firstSeenAt: now,
              lastSeenAt: now,
              history: []
            };
          } else if (prev.ip && prev.ip !== rec.ip) {
            const history = Array.isArray(prev.history) ? prev.history.slice(-19) : [];
            history.push({ip: prev.ip, replacedAt: now});
            state[instanceId] = {
              ...prev,
              ip: rec.ip,
              label: rec.label,
              previousIp: prev.ip,
              changedAt: now,
              lastSeenAt: now,
              history
            };
            storedIPs = storedIPs.filter(x => x !== prev.ip);
            newChanges.push({
              instanceId,
              oldIp: prev.ip,
              newIp: rec.ip,
              label: rec.label,
              changedAt: now
            });
          } else {
            state[instanceId] = {...prev, label:rec.label, lastSeenAt: now};
          }


        }

        storedIPs = [...new Set([...storedIPs, ...[...records.values()].map(x => x.ip)])].filter(isIPv4).sort();
        chrome.storage.local.set({
          [INSTANCE_STATE_KEY]: state,
          [STORE_KEY]: storedIPs
        }, () => resolve({newChanges, storedIPs}));
      });
    });
  }

  async function hydrateAlerts() {
    if(alertsHydrated)return;
    const data=await storageGet([ALERT_KEY,CONDITION_KEY]);
    alertEvents=Array.isArray(data[ALERT_KEY])?data[ALERT_KEY].filter(e=>e?.id && e?.kind):[];
    conditionStates=data[CONDITION_KEY] && typeof data[CONDITION_KEY]==='object'?data[CONDITION_KEY]:{};
    alertsHydrated=true;
    refreshChangeMarkers();
    renderAlerts();
  }

  function refreshChangeMarkers() {
    recentChanges.clear();
    for(const event of alertEvents)
      if(event.kind==='IP_CHANGE' && !event.acknowledged)
        recentChanges.set(event.newIp,event);
  }

  async function persistAlerts() {
    const pending=alertEvents.filter(e=>!e.acknowledged && !e.resolvedAt);
    const archived=alertEvents.filter(e=>e.acknowledged || e.resolvedAt).slice(-150);
    alertEvents=[...archived,...pending].sort((a,b)=>a.createdAt-b.createdAt);
    await storageSet({[ALERT_KEY]:alertEvents,[CONDITION_KEY]:conditionStates});
    refreshChangeMarkers();
    renderAlerts();
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

  async function appendAlert(event) {
    if(alertEvents.some(x=>x.id===event.id))return;
    alertEvents.push({...event,acknowledged:false});
    await persistAlerts();
    dispatchNotification(event);
  }

  async function recordChangeAlerts(changes) {
    for(const change of changes){
      await appendAlert({
        id:'IP_CHANGE:'+change.instanceId+':'+change.changedAt+':'+change.newIp,
        kind:'IP_CHANGE',instanceId:change.instanceId,
        label:change.label||change.instanceId,
        oldIp:change.oldIp,newIp:change.newIp,createdAt:change.changedAt
      });
    }
  }

  async function refreshLabels(records) {
    let changed=false;
    for(const e of alertEvents){
      const rec=records.get(e.instanceId);
      if(rec?.label && rec.label!==e.label){e.label=rec.label;changed=true;}
    }
    if(changed)await persistAlerts();
  }

  async function updateAgentHealth(ok,reason='') {
    const message=String(reason);
    const failureKind=/Extension context invalidated|扩展上下文已失效/i.test(message)
      ? 'EXTENSION_CONTEXT' : 'AGENT_OFFLINE';
    const next=ok?'OK':failureKind;
    if(ok){
      // Successful *fresh* probe proves the messaging and local agent are currently usable.
      // Keep fault records, but never leave a historical recovered error as an active alarm.
      let changed=conditionStates.__agent!=='OK';
      conditionStates.__agent='OK';
      const recoveredAt=Date.now();
      for(const event of alertEvents){
        if(AGENT_FAILURE_KINDS.has(event.kind) && !event.resolvedAt){
          event.resolvedAt=recoveredAt;
          changed=true;
        }
      }
      if(changed)await persistAlerts();
      return;
    }
    if(conditionStates.__agent===next)return;
    conditionStates.__agent=next;
    await appendAlert({
      id:failureKind+':'+Date.now(),kind:failureKind,
      label:failureKind==='EXTENSION_CONTEXT'?'浏览器扩展':'本机检测服务',
      createdAt:Date.now(),reason:message.slice(0,220)
    });
  }

    async function updateReachability(records,combined){
    let changed=false;
    for(const rec of records.values()){
      const state=combined.get(rec.ip)?.key;
      if(!state || state==='LOCAL_OFFLINE' || state==='UNKNOWN')continue;
      const next=state==='LOCAL_FAIL'?'HOST_UNREACHABLE':
        state==='PORT_22_UNREACHABLE'?'PORT22_UNREACHABLE':'OK';
      const nextWithIP=next+'|'+rec.ip;
      if(conditionStates[rec.instanceId]===nextWithIP)continue;
      if(conditionStates[rec.instanceId]===next) {
        // Migrate old v1.7 state without duplicating a one-time alert.
        conditionStates[rec.instanceId]=nextWithIP;
        changed=true;
        continue;
      }
      conditionStates[rec.instanceId]=nextWithIP;
      changed=true;
      if(next!=='OK')await appendAlert({
        id:next+':'+rec.instanceId+':'+Date.now(),
        kind:next,instanceId:rec.instanceId,label:rec.label,
        ip:rec.ip,createdAt:Date.now(),
        reason:next==='PORT22_UNREACHABLE'?'本机 TCP 22 未开放':
          '本机 Ping 与 TCP 22 均未确认可达'
      });
    }
    if(changed)await persistAlerts();
  }

  async function acknowledgeAlerts(ids){
    await hydrateAlerts();
    const wanted=new Set(ids);
    let changed=false;
    for(const event of alertEvents) {
      if(wanted.has(event.id) && !event.acknowledged){
        event.acknowledged=true;
        event.acknowledgedAt=Date.now();
        changed=true;
      }
    }
    if(!changed)return;
    await persistAlerts();
    applyBadges(collectIPCells(),lastCombined);
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
      const oldFaults=alertEvents.filter(e=>AGENT_FAILURE_KINDS.has(e.kind) && e.resolvedAt)
        .slice(-20).reverse();
      recoveredHistory.style.display=oldFaults.length?'block':'none';
      if(oldFaults.length){
        recoveredHistory.appendChild(create('summary','wc-history-summary',
          '✓ 检测已恢复 · '+oldFaults.length+' 条故障历史（点击查看）'));
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
        acknowledgeAlerts(entries.map(x=>x.id)).catch(console.error);
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
            acknowledgeAlerts(alertEvents.filter(x => !x.acknowledged && x.kind === 'IP_CHANGE' &&
              x.instanceId === change.instanceId).map(x => x.id)).catch(console.error);
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
    try {
      ipCells = collectIPCells();
      const currentIPs = [...ipCells.keys()];
      const instanceRecords = collectInstanceRecords(ipCells);
      await hydrateAlerts();
      const syncResult = await syncInstanceState(instanceRecords);
      await refreshLabels(instanceRecords);
      if (syncResult.newChanges.length) {
        cache.clear();
        force = true;
        await recordChangeAlerts(syncResult.newChanges);
      }
      refreshChangeMarkers();
      const ips = await mergeStoredIPs(currentIPs);
      document.getElementById('wallcheck-count').textContent = '当前 ' + currentIPs.length + ' / 列表 ' + ips.length + (recentChanges.size ? ' / IP变更 ' + recentChanges.size : '');
      if (!ips.length) { document.getElementById('wallcheck-status').textContent = '未发现 IPv4'; return; }
      const ports = parsePorts();
      const portKey = ports.join(',');
      const key = ips.slice().sort().join('|') + '::' + portKey;
      const data = await storageGet([RESULT_KEY]);
      const saved = data[RESULT_KEY] || {};
      for (const ip of ips) {
        const entry = saved[ip + '::' + portKey];
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
      const localResp = await probe(ips, ports);
      if (!localResp?.results || ips.some(ip => !localResp.results[ip])) throw new Error('本机探针返回不完整结果');
      await updateAgentHealth(true);
      const combined = new Map();
      const checkedAt = Date.now();
      for (const ip of ips) {
        const c = classify(ip, localResp);
        combined.set(ip, c);
        lastCombined.set(ip, c);
        saved[ip + '::' + portKey] = {value:c, checkedAt};
      }
      const bounded = Object.fromEntries(Object.entries(saved).sort((a,b) => b[1].checkedAt - a[1].checkedAt).slice(0,2000));
      await storageSet({[RESULT_KEY]: bounded});
      clearTimeout(retryTimer);
      lastFinishedAt = new Date(checkedAt);
      cache.set(key, {time:checkedAt, value:combined});
      applyBadges(ipCells, combined);
      await updateReachability(instanceRecords, combined);
      document.getElementById('wallcheck-status').textContent = '本机探针✓ · ' + ips.length + ' 个 IPv4 · ' + lastFinishedAt.toLocaleTimeString();
      document.getElementById('wallcheck-status').title = '';
    } catch (err) {
      cache.clear();
      if (ipCells) applyBadges(ipCells, previous);
      if (alertsHydrated) {
        try { await updateAgentHealth(false,err.message||String(err)); }catch(_){}
      }
      const status = document.getElementById('wallcheck-status');
      status.textContent = '⚠ 本次检测失败｜' + (previous.size ? '保留上次有效结果' : '本机探针不可用') + '｜15秒后重试';
      status.title = String(err.message || err);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => runCheck(true), 15000);
    } finally {
      running = false;
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
      #wallcheck-recovered-history{font:12px/1.4 Segoe UI,sans-serif;color:#237653;margin-top:5px}
      #wallcheck-recovered-history summary{cursor:pointer}
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
      <div style="display:flex;justify-content:space-between;font-weight:700"><span>IPv4 WallCheck 1.7.1</span><span id="wallcheck-count">当前 0 / 列表 0</span></div>
      <div id="wallcheck-status" style="color:#666;margin-top:5px">准备扫描</div>
      <div class="row"><span>TCP端口：22（固定）</span><button id="wallcheck-run">强制重测</button><button id="wallcheck-clear">清空列表</button></div>
      <div style="color:#666;margin-top:7px">本机 ICMP + TCP 双层检测；每 ${AUTO_RECHECK_MINUTES} 分钟复检。IP变化待人工确认，不自动消失。</div>
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
    panel.querySelector('#wallcheck-clear').addEventListener('click', async () => {
      await clearStoredIPs();
      cache.clear();
      lastCombined.clear();
      await storageSet({[RESULT_KEY]: {}});
      document.querySelectorAll('.wallcheck-badge,.wallcheck-change-badge').forEach(x => x.remove());
      runCheck(true);
    });

    const observer = new MutationObserver(mutations => {
      if (mutatingBadges || !mutations.some(isPageMutationRelevant)) return;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(()=>runCheck(false), 700);
    });
    observer.observe(document.body,{childList:true,characterData:true,subtree:true});

    chrome.runtime.onMessage.addListener(msg => {
      if (msg?.type === 'auto-recheck' || msg?.type === 'startup-recheck') runCheck(true);
    });

    window.addEventListener('hashchange', () => setTimeout(()=>runCheck(false), 250));
    setTimeout(()=>runCheck(true), 600);

  }

  install();
})();