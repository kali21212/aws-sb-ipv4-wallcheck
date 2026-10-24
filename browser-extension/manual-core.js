/* WallCheck 1.9.0 standalone manual IPv4 targets, separate from signed aws.sb scopes.
 * Single writer in MV3 background. Unacknowledged transitions never expire.
 */
(function(host) {
  'use strict';
  const KEY='wallcheck_manual_ipv4_v1';
  const MODES=['ping','tcp22','either'];
  const INTERVALS=[1,5,10];
  const MAX_TARGETS=30;
  const clean=x=>String(x??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  function ipValid(v) {
    if(typeof v!=='string')return false;
    const parts=v.split('.');
    return parts.length===4 && parts.every(x=>/^(0|[1-9][0-9]{0,2})$/.test(x)&&+x<=255);
  }
  function modeValid(v){return MODES.includes(v);}
  function settings(raw) {
    const ip=clean(raw?.ip);
    if(!ipValid(ip))throw Error('请输入有效 IPv4，例如 1.1.1.1');
    const label=clean(raw?.label).slice(0,60)||ip;
    const mode=raw?.mode ?? 'either';
    if(!modeValid(mode))throw Error('无效的检测模式');
    const intervalMinutes=Number(raw?.intervalMinutes??1);
    if(!INTERVALS.includes(intervalMinutes))throw Error('检测间隔只能为 1、5 或 10 分钟');
    return {ip,label,mode,intervalMinutes};
  }
  function evaluate(mode,result) {
    if(!result || typeof result!=='object')return {state:'UNKNOWN',ping:'UNKNOWN',tcp:'UNKNOWN'};
    const ping=String(result.icmp?.state||'UNKNOWN').toUpperCase();
    const tcp=String((Array.isArray(result.ports)?result.ports:[])
      .find(x=>x.port===22)?.state||'UNKNOWN').toUpperCase();
    const pingUp=ping==='REACHABLE';
    const tcpUp=tcp==='OPEN';
    const pingDown=['NO_REPLY','ERROR'].includes(ping);
    const tcpDown=['REFUSED','TIMEOUT','UNREACHABLE','ERROR'].includes(tcp);
    let state='UNKNOWN';
    if(mode==='ping')state=pingUp?'UP':pingDown?'DOWN':'UNKNOWN';
    else if(mode==='tcp22')state=tcpUp?'UP':tcpDown?'DOWN':'UNKNOWN';
    // In dual-mode, a failure in EITHER leg is critical, not a green
    // reachable verdict from the other leg. Unknown is not proof of DOWN.
    else state=(pingDown||tcpDown)?'DOWN':(pingUp&&tcpUp)?'UP':'UNKNOWN';
    const port=(Array.isArray(result.ports)?result.ports:[]).find(x=>x.port===22);
    const finiteLatency=v=>Number.isFinite(v)&&v>=0 ? Math.round(v*10)/10 : null;
    return {state,ping,tcp,
      pingMs:finiteLatency(result.icmp?.latency_ms),
      tcpMs:finiteLatency(port?.latency_ms)};
  }
  const createRoot=()=>({version:1,revision:0,nextId:1,nextEvent:1,items:[]});
  const copy=x=>JSON.parse(JSON.stringify(x));
  function createManualMonitor({read,write,clock=()=>Date.now()}) {
    let chain=Promise.resolve();
    const transact=op=>{
      const run=chain.catch(()=>{}).then(async()=>{
        const stored=await read(KEY);
        const root=stored?.version===1 && Array.isArray(stored.items)?stored:createRoot();
        const result=await op(root);
        if(result.changed) {
          root.revision=(root.revision||0)+1;
          await write(KEY,root);
        }
        return {items:copy(root.items),revision:root.revision||0,events:copy(result.events||[]),
          ...(result.addedId?{addedId:result.addedId}:{})};
      });
      chain=run.then(()=>{},()=>{});
      return run;
    };
    // Migrate a still-DOWN 1.9.1 target without inventing the start time.
    // Old versions kept the DOWN timestamp only in its pending event list.
    const previousDownEventAt=t=>{
      const history=Array.isArray(t.events)?t.events:[];
      for(let i=history.length-1;i>=0;i--){
        const e=history[i];
        if(e.kind==='IP_EDIT' || e.kind==='RECOVERED')break;
        if(e.kind==='DOWN' && e.ip===t.ip && e.mode===t.mode &&
          Number.isFinite(e.time) && e.time>0)return e.time;
      }
      return 0;
    };
    const event=(root,item,kind,details={})=>{
      const ev={id:'manual-'+(root.nextEvent++),targetId:item.id,ip:item.ip,
        kind,time:clock(),...details};
      item.events.push(ev); // never expire unacknowledged events
      return ev;
    };
    async function dispatch(action,payload={}) {
      if(action==='get')return transact(async()=>({changed:false}));
      if(action==='due')return transact(async()=>({changed:false}));
      if(action==='add')return transact(async root=>{
        if(root.items.length>=MAX_TARGETS)throw Error('最多可同时保存 30 个手动监控目标');
        const input=settings(payload);
        if(root.items.some(t=>t.ip===input.ip))throw Error('此 IPv4 已经加入手动监控');
        const when=clock();
        const target={id:'m'+root.nextId++, ...input,enabled:true,
          generation:1,createdAt:when,updatedAt:when,lastCheckedAt:0,
          state:'PENDING',lastStable:'PENDING',result:null,events:[],
          downSince:0,lastOutageSince:0,recoveredAt:0};
        root.items.push(target);
        return {changed:true,addedId:target.id};
      });
      if(action==='update')return transact(async root=>{
        const t=root.items.find(x=>x.id===payload.id);
        if(!t)throw Error('监控目标不存在');
        const next=settings(payload);
        if(next.ip!==t.ip && root.items.some(x=>x.id!==t.id && x.ip===next.ip))
          throw Error('此 IPv4 已由其他目标监控');
        const old=t.ip;
        const substantive=old!==next.ip || t.mode!==next.mode;
        const configChange=substantive || t.label!==next.label ||
          t.intervalMinutes!==next.intervalMinutes;
        if(!configChange)return {changed:false};
        Object.assign(t,next);
        t.updatedAt=clock();
        if(substantive){
          t.generation+=1;
          t.lastCheckedAt=0;
          t.state='PENDING';
          t.lastStable='PENDING';
          t.result=null;
          // An IP or criterion edit starts a fresh monitoring episode.
          t.downSince=0;t.lastOutageSince=0;t.recoveredAt=0;
          if(old!==next.ip)event(root,t,'IP_EDIT',{oldIp:old,newIp:next.ip});
        }
        return {changed:true};
      });
      if(action==='enable')return transact(async root=>{
        const t=root.items.find(x=>x.id===payload.id);
        if(!t)throw Error('目标不存在');
        const enabled=payload.enabled===true;
        if(t.enabled===enabled)return {changed:false};
        t.enabled=enabled;t.generation+=1;t.updatedAt=clock();
        if(enabled){t.lastCheckedAt=0;t.state='PENDING';t.result=null;}
        return {changed:true};
      });
      if(action==='remove')return transact(async root=>{
        const i=root.items.findIndex(x=>x.id===payload.id);
        if(i<0)throw Error('目标不存在');
        root.items.splice(i,1);
        return {changed:true};
      });
      if(action==='ack')return transact(async root=>{
        const t=root.items.find(x=>x.id===payload.id);
        if(!t)throw Error('目标不存在');
        const before=t.events.length;
        t.events=[]; // "已知" clears ALL of this target's pending history.
        return {changed:before>0};
      });
      if(action==='apply')return transact(async root=>{
        const notices=[];
        let changed=false;
        for(const item of (Array.isArray(payload.results)?payload.results.slice(0,MAX_TARGETS):[])){
          const t=root.items.find(x=>x.id===item.id);
          if(!t || !t.enabled || t.generation!==item.generation || t.ip!==item.ip)continue;
          // A delayed result for an old address can NEVER overwrite its replacement.
          if(item.when<=t.lastCheckedAt)continue;
          const prev=t.state;
          const stableBefore=t.lastStable;
          const persistedStart=(Number.isFinite(t.downSince)&&t.downSince>0)
            ? t.downSince : (stableBefore==='DOWN'?previousDownEventAt(t):0);
          const verdict=item.error?{state:'ERROR',ping:'UNKNOWN',tcp:'UNKNOWN'}:
            evaluate(t.mode,item.result);
          t.state=verdict.state;t.result=verdict;t.lastCheckedAt=item.when;
          changed=true;
          if(verdict.state==='DOWN'){
            // Never slide the FIRST detection time on repeated 1/5/10m polls.
            t.downSince=stableBefore==='DOWN'?(persistedStart||item.when):item.when;
            t.recoveredAt=0;
            if(stableBefore!=='DOWN'){
              notices.push(event(root,t,'DOWN',{mode:t.mode,time:item.when,
                details:'当前检测方式未确认目标可达'}));
            }
          } else if(verdict.state==='UP' && stableBefore==='DOWN'){
            // A recovery is timestamped on the successful probe completion.
            t.lastOutageSince=persistedStart;
            t.recoveredAt=item.when;
            t.downSince=0;
            notices.push(event(root,t,'RECOVERED',{mode:t.mode,time:item.when}));
          } else if(verdict.state==='ERROR' && prev!=='ERROR'){
            notices.push(event(root,t,'PROBE_ERROR',{time:item.when,
              details:clean(item.error).slice(0,150)}));
          }
          if(verdict.state==='UP'||verdict.state==='DOWN')t.lastStable=verdict.state;
        }
        return {changed,events:notices};
      });
      throw Error('不支持的手动监控操作');
    }
    async function due(now, ids=null, force=false){
      const state=await dispatch('get');
      return state.items.filter(t=>t.enabled &&
        (!ids || ids.includes(t.id)) &&
        (force || t.lastCheckedAt===0 ||
         now-t.lastCheckedAt>=t.intervalMinutes*60000))
        .map(t=>({id:t.id,ip:t.ip,mode:t.mode,
          generation:t.generation,lastStable:t.lastStable}));
    }
    return {dispatch,due,key:KEY};
  }
  host.createManualMonitor=createManualMonitor;
  if(typeof module==='object' && module.exports)
    module.exports={createManualMonitor,evaluate,settings,ipValid};
})(typeof globalThis==='object'?globalThis:this);
