(() => {
  'use strict';

  const CACHE_MS = 5 * 60 * 1000;
  const AUTO_RECHECK_MINUTES = 10;
  const IP_CHANGE_MARK_MS = 1 * 60 * 60 * 1000;
  const INSTANCE_STATE_KEY = 'wallcheck_instance_state_v1';
  const cache = new Map();
  const lastCombined = new Map();
  const recentChanges = new Map();
  const RESULT_KEY = 'wallcheck_last_valid_results_v1';
  let pendingCheck = false;
  let pendingForce = false;
  let retryTimer = null;
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
      if (el.closest('#wallcheck-panel,#wallcheck-ip-change-toast,.wallcheck-badge,.wallcheck-change-badge')) continue;
      const txt = (el.innerText || el.textContent || '').trim();
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

  function collectInstanceRecords(ipCells) {
    const records = new Map();
    for (const [ip, cells] of ipCells) {
      const cell = cells[0];
      if (!cell) continue;
      const instanceId = findInstanceIdNear(cell, ip);
      if (instanceId) records.set(instanceId, {instanceId, ip, cell});
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
        recentChanges.clear();

        for (const [instanceId, rec] of records) {
          const prev = state[instanceId];

          if (!prev) {
            state[instanceId] = {
              ip: rec.ip,
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
              changedAt: now
            });
          } else {
            state[instanceId] = {...prev, lastSeenAt: now};
          }

          const current = state[instanceId];
          if (current.changedAt && current.previousIp &&
              now - current.changedAt < IP_CHANGE_MARK_MS &&
              current.ip === rec.ip) {
            recentChanges.set(rec.ip, {
              instanceId,
              oldIp: current.previousIp,
              newIp: current.ip,
              changedAt: current.changedAt
            });
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

  function showChangeToast(changes) {
    if (!changes.length) return;
    document.getElementById('wallcheck-ip-change-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'wallcheck-ip-change-toast';
    toast.className = 'wallcheck-toast';
    const first = changes[0];
    toast.innerHTML =
      '<strong>🔄 检测到 IP 变更</strong><br>' +
      first.instanceId + '<br>' +
      first.oldIp + ' → ' + first.newIp +
      (changes.length > 1 ? '<br>另有 ' + (changes.length - 1) + ' 台实例变更' : '');
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 8000);
  }

  function parsePorts() {
    const raw = document.getElementById('wallcheck-ports')?.value || '22,80,443';
    const ports = [...new Set(raw.split(',').map(x => Number(x.trim()))
      .filter(x => Number.isInteger(x) && x >= 1 && x <= 65535))];
    return ports.length ? ports.sort((a,b)=>a-b) : [22,80,443];
  }

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

  function classify(ip, localResp) {
    const local = localResp?.results?.[ip];
    if (!local) return {key:'LOCAL_OFFLINE', text:'❓ 本机探针无结果'};

    const lm = portStates(local);
    const localOpen = [...lm].filter(([,s]) => s === 'OPEN').map(([p]) => p);
    const localTCPResponded = [...lm.values()].some(s => s === 'OPEN' || s === 'REFUSED');
    const localPing = local?.icmp?.state === 'REACHABLE';

    if (localPing && localOpen.length)
      return {key:'LOCAL_OK', text:'✅ 主机可达｜端口可用:' + localOpen.join('/')};
    if (localPing)
      return {key:'HOST_OK', text:'✅ 主机可达｜未发现开放端口'};
    if (localOpen.length)
      return {key:'LOCAL_OK', text:'✅ 端口可用:' + localOpen.join('/') + '｜Ping无回应'};
    if (localTCPResponded)
      return {key:'HOST_OK', text:'✅ 主机可达｜端口已关闭'};

    return {key:'LOCAL_FAIL', text:'⚠ 本机未确认可达'};
  }
  function badgeClass(key) {
    if (key === 'LOCAL_OK' || key === 'HOST_OK') return 'wc-ok';
    if (key === 'LOCAL_FAIL') return 'wc-warn';
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
          changeBadge.textContent = '🔄 IP已变更';
          changeBadge.title =
            change.instanceId + '\n' +
            change.oldIp + ' → ' + change.newIp + '\n' +
            '变更时间：' + new Date(change.changedAt).toLocaleString();
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
    if (!isEC2Route()) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    running = true;
    let ipCells;
    let previous = new Map();
    try {
      ipCells = collectIPCells();
      const currentIPs = [...ipCells.keys()];
      const syncResult = await syncInstanceState(collectInstanceRecords(ipCells));
      if (syncResult.newChanges.length) {
        cache.clear();
        force = true;
        showChangeToast(syncResult.newChanges);
      }
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
      document.getElementById('wallcheck-status').textContent = '本机探针✓ · ' + ips.length + ' 个 IPv4 · ' + lastFinishedAt.toLocaleTimeString();
      document.getElementById('wallcheck-status').title = '';
    } catch (err) {
      cache.clear();
      if (ipCells) applyBadges(ipCells, previous);
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
  function install() {
    if (document.getElementById('wallcheck-panel')) return;
    const style = document.createElement('style');
    style.textContent = `
      #wallcheck-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;padding:12px;border:1px solid #ccc;border-radius:10px;background:#fff;box-shadow:0 8px 30px #0003;font:13px/1.45 Segoe UI,sans-serif;color:#222}
      #wallcheck-panel .row{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:7px}
      #wallcheck-panel button{padding:5px 8px;cursor:pointer}
      #wallcheck-panel input[type=text]{width:105px;padding:4px}
      .wallcheck-badge{display:inline-block;margin-left:8px;padding:1px 6px;border-radius:10px;font-size:12px;white-space:nowrap}
      .wallcheck-change-badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:10px;font-size:12px;white-space:nowrap;background:#fff3e0;color:#b45309;font-weight:700;border:1px solid #fed7aa}
      #wallcheck-ip-change-toast{position:fixed;right:16px;bottom:190px;z-index:2147483647;max-width:330px;padding:12px 14px;border-radius:10px;background:#fff7ed;color:#9a3412;border:1px solid #fdba74;box-shadow:0 8px 30px #0003;font:13px/1.5 Segoe UI,sans-serif}
      .wc-ok{background:#e8f5e9;color:#146c2e}.wc-bad{background:#ffebee;color:#b42318;font-weight:700}
      .wc-warn{background:#fff8e1;color:#8a5700}.wc-unknown{background:#f1f3f4;color:#555}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'wallcheck-panel';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-weight:700"><span>IPv4 WallCheck Portable</span><span id="wallcheck-count">当前 0 / 列表 0</span></div>
      <div id="wallcheck-status" style="color:#666;margin-top:5px">准备扫描</div>
      <div class="row"><label>端口 <input id="wallcheck-ports" type="text" value="22,80,443"></label><button id="wallcheck-run">强制重测</button><button id="wallcheck-clear">清空列表</button></div>
      <div style="color:#666;margin-top:7px">本机 ICMP + TCP 双层检测；每 ${AUTO_RECHECK_MINUTES} 分钟复检。IP变更橙色标记保留1小时。</div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#wallcheck-run').addEventListener('click',()=>runCheck(true));
    panel.querySelector('#wallcheck-ports').addEventListener('change',()=>runCheck(true));
    panel.querySelector('#wallcheck-clear').addEventListener('click', async () => {
      await clearStoredIPs();
      cache.clear();
      lastCombined.clear();
      await storageSet({[RESULT_KEY]: {}});
      document.querySelectorAll('.wallcheck-badge,.wallcheck-change-badge').forEach(x => x.remove());
      document.getElementById('wallcheck-ip-change-toast')?.remove();
      runCheck(true);
    });

    const observer = new MutationObserver(mutations => {
      if (mutatingBadges) return;
      const relevant = mutations.some(m =>
        (m.type === 'characterData' && !m.target.parentElement?.closest('#wallcheck-panel,#wallcheck-ip-change-toast,.wallcheck-badge,.wallcheck-change-badge')) ||
        [...m.addedNodes, ...m.removedNodes].some(n =>
          n.nodeType === 1 &&
          !n.classList?.contains('wallcheck-badge') &&
          !n.classList?.contains('wallcheck-change-badge') &&
          !n.classList?.contains('wallcheck-toast') &&
          !n.closest?.('#wallcheck-panel')
        )
      );
      if (!relevant) return;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(()=>runCheck(false), 700);
    });
    observer.observe(document.body,{childList:true,characterData:true,subtree:true});

    chrome.runtime.onMessage.addListener(msg => {
      if (msg?.type === 'auto-recheck' || msg?.type === 'startup-recheck') runCheck(true);
    });

    window.addEventListener('hashchange', () => setTimeout(()=>runCheck(false), 250));
    setTimeout(()=>runCheck(true), 600);
    setInterval(() => {
      if (!isEC2Route()) return;
      for (const [ip, change] of recentChanges) {
        if (Date.now() - change.changedAt >= IP_CHANGE_MARK_MS) {
          recentChanges.delete(ip);
          document.querySelectorAll('.wallcheck-change-badge').forEach(b => {
            if (b.dataset.ip === ip) b.remove();
          });
        }
      }
    }, 1000);
  }

  install();
})();