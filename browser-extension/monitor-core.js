/* WallCheck 1.8.0: single-writer scoped monitor state.
 * Scope IDs are SHA-256 digests of aws.sb `sgt` tokens; raw credentials
 * never enter storage, logs, or user-visible notifications.
 * Old 1.7.x global keys remain untouched as forensic backup, never read as active.
 */
'use strict';
(() => {
  const KEY = 'wallcheck_scoped_monitor_v3';
  const validScope = x => typeof x === 'string' && /^sgt:[a-f0-9]{64}$/.test(x);
  const isIP = s => typeof s === 'string' && s.split('.').length === 4 &&
    s.split('.').every(t => /^[0-9]{1,3}$/.test(t) && Number(t) < 256 && (t === '0' || t[0] !== '0'));
  const validId = id => typeof id === 'string' && /^((ec2:i-[a-f0-9]{8,32})|(ipv6:[a-f0-9:]{8,70})|(ip-target:(?:\d{1,3}\.){3}\d{1,3}))$/.test(id);
  const safeLabel = x => String(x || '').replace(/[\r\n\t]/g,' ').slice(0,60);
  const safeReason = x => String(x || '').replace(/[\r\n\t]/g,' ').slice(0,220);
  const stableId = id => id.startsWith('ec2:') || id.startsWith('ipv6:');
  const clone = obj => JSON.parse(JSON.stringify(obj));
  const cleanOld = arr => {
    // Acknowledged IP-change alerts are no longer retained: the latest IP
    // baseline and compact anti-stale history live under instances instead.
    const all = Array.isArray(arr) ? arr.filter(e=>!(e.kind==='IP_CHANGE' && e.acknowledged)) : [];
    const older = all.filter(e => e.acknowledged || e.resolvedAt).slice(-180);
    const pending = all.filter(e => !e.acknowledged && !e.resolvedAt);
    return [...older,...pending].sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
  };
  const emptyRoot = () => ({version:3,scopes:{},globalAlerts:[],agentState:'UNKNOWN',revision:0});
  const emptyScope = () => ({instances:{},alerts:[],conditions:{},currentIPs:[],updatedAt:0,onboardingNotifiedAt:0,hiddenNoticeAckKey:'',accountStates:{}});

  function createWallCheckMonitor({read,write,clock=Date.now}) {
    let chain = Promise.resolve();
    const transact = (operation) => {
      const task = chain.catch(() => undefined).then(async () => {
        const stored = await read(KEY);
        const root = stored && stored.version === 3 && stored.scopes && typeof stored.scopes === 'object'
          ? stored : emptyRoot();
        const result = await operation(root);
        if (result.write) {
          root.revision = (root.revision || 0) + 1;
          await write(KEY,root);
        }
        return {...result,snapshot:result.scope ? snapshot(root,result.scope) : null,
          revision:root.revision,write:!!result.write};
      });
      chain = task.then(() => undefined,() => undefined);
      return task;
    };
    const snapshot = (root,scopeId) => {
      const scope = root.scopes[scopeId] || emptyScope();
      return {
        scope:scopeId,
        alerts:clone([...scope.alerts,...(root.globalAlerts || [])]),
        instances:clone(scope.instances),
        currentIPs:[...scope.currentIPs],
        hiddenNoticeAckKey:scope.hiddenNoticeAckKey||'',
        conditions:clone(scope.conditions),
        accountStates:clone(scope.accountStates||{}),
        revision:root.revision||0
      };
    };
    async function dispatch(message) {
      const action = String(message?.type||'');
      if (!action.startsWith('monitor:')) throw Error('Unsupported action');
      if (!validScope(message.scope)) throw Error('Missing or invalid isolated page scope');
      const scopeKey = message.scope;
      return transact(async root => {
        const previous = root.scopes[scopeKey];
        const scope = previous || (root.scopes[scopeKey] = emptyScope());
        const created=[];
        const now=clock();
        let dirty = !previous;
        const mark = () => {dirty=true;scope.updatedAt=now;};
        const append = (list,event) => {
          if (list.some(e=>e.id===event.id)) return;
          list.push({...event,acknowledged:false});
          created.push(event);
          mark();
        };
        if (action==='monitor:get') {
          // One-time cleanup of acknowledged IP events retained by 1.8.0.
          // Never discard any still-pending IP-change event.
          if(scope.alerts.some(e=>e.kind==='IP_CHANGE' && e.acknowledged)){
            scope.alerts=cleanOld(scope.alerts);
            mark();
          }
          return {write:dirty,scope:scopeKey,newAlerts:[]};
        }
        if (action==='monitor:observe') {
          const raw=Array.isArray(message.records) ? message.records.slice(0,50) : [];
          const records=[];
          const seen = new Set();
          for (const r of raw) {
            if (!validId(r?.instanceId) || !isIP(r?.ip) || seen.has(r.instanceId)) continue;
            seen.add(r.instanceId);
            records.push({
              instanceId:r.instanceId,ip:r.ip,label:safeLabel(r.label),
              pageOpenedAt:Number.isFinite(r.pageOpenedAt)?r.pageOpenedAt:0,
              changedHere:r.changedHere === true
            });
          }
          // A new signed sgt list is NOT evidence that #1 in a different
          // account changed IP. Announce its first real visible IPv4 separately.
          // Existing 1.9.0 scopes with stored instances are left untouched.
          const firstListSeen=records.length>0 &&
            !scope.onboardingNotifiedAt && Object.keys(scope.instances).length===0;
          const pageIPs=new Set();
          const visibleIpOwners=new Map(records.map(r=>[r.ip,r.instanceId]));
          for (const r of records) {
            pageIPs.add(r.ip);
            const prev=scope.instances[r.instanceId];
            if (!prev) {
              scope.instances[r.instanceId]={
                ip:r.ip,label:r.label,firstSeenAt:now,lastSeenAt:now,
                lastConfirmedAt:now,history:[],changedAt:0
              };
              mark();
              continue;
            }
            // Do not allow a stale tab with a conflicting IP to overwrite
            // the current instance name or create an IP-change alert.
            if (prev.ip===r.ip) {
              if(prev.label!==r.label){
                prev.label=r.label;
                for(const ev of scope.alerts){
                  if(ev.instanceId===r.instanceId)ev.label=r.label;
                }
                mark();
              }
              if (now-prev.lastSeenAt>=1000){prev.lastSeenAt=now;mark();}
              continue;
            }
            // A different stale tab is NOT evidence of a changed server IP.
            // A newly loaded page is authoritative; an already open tab must
            // have observed a real on-page IP mutation. Older tabs cannot
            // reverse a previously accepted transition back to an old IP.
            const sourceFresh = r.pageOpenedAt >= (prev.changedAt || prev.firstSeenAt);
            const sourceUpdated = r.changedHere;
            const oldValue = (prev.history||[]).some(h=>h.ip===r.ip);
            const staleReverse = oldValue && (!r.changedHere || r.pageOpenedAt < prev.changedAt);
            if (!stableId(r.instanceId) || staleReverse || (!sourceFresh && !sourceUpdated)) continue;
            const before=prev.ip;
            const differentOwner=visibleIpOwners.get(before);
            // When previous IP is STILL shown on another instance card in
            // the same scope, the old identity was probably cross-bound
            // during partial page loading. Repair that baseline but NEVER
            // assert a genuine server IP change or send its desktop alert.
            const crossed=differentOwner && differentOwner!==r.instanceId;
            const history=Array.isArray(prev.history)?prev.history.slice(-39):[];
            history.push({ip:before,replacedAt:now});
            scope.instances[r.instanceId]={
              ...prev,ip:r.ip,label:r.label,previousIp:before,
              changedAt:now,lastConfirmedAt:now,lastSeenAt:now,history
            };
            if(prev.label!==r.label){
              for(const ev of scope.alerts){
                if(ev.instanceId===r.instanceId)ev.label=r.label;
              }
            }
            // Preserve ambiguous transitions as evidence, not as verified
            // A->B IP changes. Clicking "已知" may later acknowledge them.
            append(scope.alerts,{
              id:(crossed?'IP_LINK_SUSPECT:':'IP_CHANGE:')+
                scopeKey+':'+r.instanceId+':'+now+':'+r.ip,
              kind:crossed?'IP_LINK_SUSPECT':'IP_CHANGE',
              instanceId:r.instanceId,label:r.label,
              oldIp:before,newIp:r.ip,createdAt:now,
              ...(crossed?{reason:'旧 IP 同时属于当前页面另一实例，疑似卡片身份串位，未判定为真实 IP 变化'}:{})
            });
            // Do not keep unreachable status deduped against the old address.
            delete scope.conditions[r.instanceId];
            mark();
          }
          // Quarantine pre-1.9.3 false historical IP_CHANGE alerts without
          // deleting evidence. Only when another visible instance still
          // carries the alleged old IP and the target's latest IP matches.
          for(const ev of scope.alerts){
            if(ev.kind!=='IP_CHANGE' || ev.acknowledged)continue;
            const owner=visibleIpOwners.get(ev.oldIp);
            const target=scope.instances[ev.instanceId];
            if(owner && owner!==ev.instanceId && target?.ip===ev.newIp){
              ev.kind='IP_LINK_SUSPECT';
              ev.reason='旧 IP 现属于当前页面另一实例，疑似误关联；原始记录保留待人工确认';
              ev.quarantinedAt=now;
              mark();
            }
          }
          if(firstListSeen){
            scope.onboardingNotifiedAt=now;
            append(scope.alerts,{
              id:'SCOPE_ONBOARDED:'+scopeKey+':'+now,
              kind:'SCOPE_ONBOARDED',createdAt:now,
              label:records[0].label,ip:records[0].ip,
              observedCount:records.length,
              reason:'首次发现 '+records.length+' 个 IPv4，已建立独立监控基线。并非旧账号的 IP 变化'
            });
          }
          const ips=[...new Set(Object.values(scope.instances).map(i=>i.ip))].filter(isIP).sort();
          if (JSON.stringify(scope.currentIPs)!==JSON.stringify(ips)) {
            scope.currentIPs=ips;
            mark();
          }
          scope.alerts=cleanOld(scope.alerts);
        } else if (action==='monitor:account') {
          // AWS.SB credentials, account names and emails are NEVER accepted.
          // #n is a visual account-card slot inside a hashed sgt scope,
          // NOT an EC2 machine identity; do not touch instance IP baselines.
          if(!scope.accountStates)scope.accountStates={};
          const raw=Array.isArray(message.records)?message.records.slice(0,50):[];
          const seen=new Set();
          for(const item of raw){
            const slot=String(item?.slot||'');
            if(!/^[1-9][0-9]{0,3}$/.test(slot)||seen.has(slot))continue;
            seen.add(slot);
            const ip=isIP(item.ip)?item.ip:null;
            const label=safeLabel(item.label||('#'+slot))
              .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi,'[hidden]');
            const invalid=item.invalid===true;
            const replacing=item.replacing===true;
            const verified=item.verified22===true;
            let state=scope.accountStates[slot];
            if(!state){
              state={slot,label,lastIp:ip||null,phase:'NORMAL',
                episode:0,failedAt:0,lastRecoveredAt:0};
              scope.accountStates[slot]=state;
              mark();
            }
            const pending=['INVALID','REPLACING','VERIFYING'].includes(state.phase);
            if(state.label!==label){state.label=label;mark();}
            if(invalid){
              if(!pending){
                state.episode=(state.episode||0)+1;
                state.failedAt=now;
                state.oldIp=state.lastIp||ip||null;
                append(scope.alerts,{
                  id:'ACCOUNT_INVALID:'+scopeKey+':'+slot+':'+now,
                  kind:'ACCOUNT_INVALID',slot,label,ip:state.oldIp,
                  createdAt:now,
                  reason:'AWS.SB 显示账号无效'+(replacing?'；正在自动替补':'')
                });
              }
              const phase=replacing?'REPLACING':'INVALID';
              if(state.phase!==phase){state.phase=phase;mark();}
            } else if(pending){
              // A disappearing error banner alone is NOT proof of recovery.
              // Require a real (fresh, not cached) TCP22 OPEN probe result.
              const replacementSettled=!replacing ||
                (state.oldIp && ip && state.oldIp!==ip);
              if(ip && verified && replacementSettled){
                const oldIp=state.oldIp||null;
                append(scope.alerts,{
                  id:'ACCOUNT_RECOVERED:'+scopeKey+':'+slot+':'+now,
                  kind:'ACCOUNT_RECOVERED',slot,label,
                  oldIp,newIp:ip,ip,createdAt:now,
                  failedAt:state.failedAt||0,
                  reason:oldIp && oldIp!==ip
                    ?'已发现替补 IP，且 TCP 22 验证可达'
                    :'账号异常提示已消失，TCP 22 验证可达'
                });
                state.phase='NORMAL';state.lastRecoveredAt=now;
                state.oldIp=null;state.failedAt=0;
                mark();
              }else if(state.phase!=='VERIFYING'){
                state.phase='VERIFYING';mark();
              }
            }
            // Preserve the pre-failure IP until the current episode resolves.
            // Never overwrite oldIp with a newly displayed provisional IP.
            if(ip && !invalid && (!pending||state.phase==='NORMAL') &&
                state.lastIp!==ip){
              state.lastIp=ip;mark();
            }
          }
          scope.alerts=cleanOld(scope.alerts);
        } else if (action==='monitor:ack-hidden') {
          // "已知" applies only to the exact set of previously recorded IPs
          // missing from THIS visible page. It never clears any IP baseline,
          // instance history, reachability status or unrelated alert.
          const submitted=Array.isArray(message.hiddenIPs)?message.hiddenIPs:[];
          if(!submitted.length || submitted.length>50 ||
             submitted.some(ip=>!isIP(ip) || !scope.currentIPs.includes(ip))){
            throw Error('Invalid historic non-visible target list');
          }
          const hidden=[...new Set(submitted)].sort();
          const key=hidden.join('|');
          if(scope.hiddenNoticeAckKey!==key){
            scope.hiddenNoticeAckKey=key;
            mark();
          }
        } else if (action==='monitor:ack-recovered') {
          const ids = new Set(Array.isArray(message.ids) ?
            message.ids.filter(x=>typeof x==='string').slice(0,1000) : []);
          const before=root.globalAlerts.length;
          // Only already-resolved agent/extension events, never active failures.
          root.globalAlerts=root.globalAlerts.filter(e=>!(
            ids.has(e.id) && e.resolvedAt &&
            (e.kind==='AGENT_OFFLINE' || e.kind==='EXTENSION_CONTEXT')));
          if(root.globalAlerts.length!==before)mark();
        } else if (action==='monitor:ack-change-group') {
          const instanceId=message.instanceId;
          if(!validId(instanceId))throw Error('Invalid stable instance ID');
          const before=scope.alerts.length;
          // One click clears ALL pending IP-change detail rows for this
          // instance in the current sgt, even if the user was away for days.
          // No 500-event slice and no cross-sgt deletion.
          scope.alerts=scope.alerts.filter(e=>
            !(e.kind==='IP_CHANGE' && e.instanceId===instanceId));
          if(scope.alerts.length!==before)mark();
        } else if (action==='monitor:ack') {
          const ids = new Set(Array.isArray(message.ids)?
            message.ids.filter(x=>typeof x==='string').slice(0,500):[]);
          const previousCount=scope.alerts.length;
          // Generic event acknowledgement also physically removes IP
          // change detail rows rather than archiving them.
          scope.alerts=scope.alerts.filter(e=>
            !(e.kind==='IP_CHANGE' && ids.has(e.id)));
          if(scope.alerts.length!==previousCount)mark();
          for (const event of [...scope.alerts,...(root.globalAlerts||[])]) {
            if (ids.has(event.id) && !event.acknowledged) {
              event.acknowledged=true;
              event.acknowledgedAt=now;
              mark();
            }
          }
          scope.alerts=cleanOld(scope.alerts);
          root.globalAlerts=cleanOld(root.globalAlerts);
        } else if (action==='monitor:clear') {
          // Clear ONLY this sgt scope; atomically baseline its currently visible instances.
          // Other sgt lists and shared agent faults are left intact.
          const records=Array.isArray(message.records)?message.records.slice(0,50):[];
          const fresh=emptyScope();
          for (const r of records) {
            if (!validId(r.instanceId) || !isIP(r.ip))continue;
            fresh.instances[r.instanceId]={
              ip:r.ip,label:safeLabel(r.label),firstSeenAt:now,lastSeenAt:now,
              lastConfirmedAt:now,changedAt:0,history:[]
            };
          }
          fresh.currentIPs=[...new Set(Object.values(fresh.instances).map(x=>x.ip))].sort();
          fresh.updatedAt=now;
          // Explicit clear should never silently re-trigger a new-list notice.
          fresh.onboardingNotifiedAt=now;
          root.scopes[scopeKey]=fresh;
          // Deleting the global per-IP probe-result cache would corrupt other
          // scopes sharing the same IPv4; UI cache is cleared in this tab.
          dirty=true;
        } else if (action==='monitor:reachability') {
          for (const item of (Array.isArray(message.items)?message.items.slice(0,50):[])) {
            if (!validId(item.instanceId) || !isIP(item.ip)) continue;
            const inst=scope.instances[item.instanceId];
            // Ignore stale page results if that instance already changed IP.
            if (!inst || inst.ip!==item.ip) continue;
            const next=String(item.status||'');
            if (!['OK','PORT22_UNREACHABLE','HOST_UNREACHABLE'].includes(next)) continue;
            const old=scope.conditions[item.instanceId];
            const fingerprint=next+'|'+item.ip;
            if (old===fingerprint) continue;
            scope.conditions[item.instanceId]=fingerprint;
            for(const event of scope.alerts) {
              if(event.instanceId===item.instanceId &&
                 (event.kind==='HOST_UNREACHABLE'||event.kind==='PORT22_UNREACHABLE') &&
                 !event.resolvedAt && event.ip===item.ip && event.kind!==next){
                event.resolvedAt=now;
              }
            }
            if(next!=='OK') append(scope.alerts,{
              id:next+':'+scopeKey+':'+item.instanceId+':'+now,
              kind:next,instanceId:item.instanceId,label:inst.label,ip:item.ip,
              createdAt:now,
              reason:next==='PORT22_UNREACHABLE'?'TCP 22 在本机检测中不可访问':'Ping 与 TCP 22 均未确认可达'
            });
            mark();
          }
          scope.alerts=cleanOld(scope.alerts);
        } else if (action==='monitor:agent') {
          const ok=message.ok===true;
          const reason=safeReason(message.reason);
          const kind=/Extension context invalidated|扩展上下文已失效/i.test(reason)
            ? 'EXTENSION_CONTEXT':'AGENT_OFFLINE';
          const next=ok?'OK':kind;
          if (root.agentState!==next) {
            root.agentState=next;
            if(ok) {
              for (const event of root.globalAlerts) {
                if ((event.kind==='AGENT_OFFLINE'||event.kind==='EXTENSION_CONTEXT') && !event.resolvedAt)
                  event.resolvedAt=now;
              }
            } else append(root.globalAlerts,{
              id:kind+':'+now,kind,createdAt:now,label:'WallCheck',reason
            });
            root.globalAlerts=cleanOld(root.globalAlerts);
            mark();
          }
        } else throw Error('Unsupported monitor operation');
        return {write:dirty,scope:scopeKey,newAlerts:created};
      });
    }
    return {dispatch,key:KEY};
  }
  globalThis.createWallCheckMonitor=createWallCheckMonitor;
})();