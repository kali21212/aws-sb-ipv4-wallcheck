// Execute the real background worker, monitor core and content scan together.
// Only browser APIs, DOM extraction and the localhost HTTP transport are faked.
// No real network requests, user profiles or browser sessions are accessed.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const extension=path.join(__dirname,'..','browser-extension');
const contentSource=fs.readFileSync(path.join(extension,'content.js'),'utf8');
const resultKey='wallcheck_last_valid_results_v3';
const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const scopeOf=token=>'sgt:'+createHash('sha256').update(token).digest('hex');
const good={icmp:{state:'REACHABLE'},ports:[{port:22,state:'OPEN'}]};
const pingFailure={icmp:{state:'NO_REPLY'},ports:[{port:22,state:'OPEN'}]};
const event=()=>({addListener(){}});

function world(){
  const stored={},listeners=[],requests=[],messages=[],notifications=[];
  const alarms=new Map();
  const tabs=new Map(),timers=new Map();
  let timerId=0,tabId=0;
  const local={
    get(keys,callback){
      const result={};
      for(const key of keys)if(key in stored)result[key]=clone(stored[key]);
      queueMicrotask(()=>callback(result));
    },
    set(values,callback){
      Object.assign(stored,clone(values));
      queueMicrotask(()=>callback?.());
    },
    remove(keys,callback){
      for(const key of Array.isArray(keys)?keys:[keys])delete stored[key];
      queueMicrotask(()=>callback?.());
    }
  };
  const chrome={
    runtime:{
      id:'wallcheck-regression',lastError:null,
      getURL:file=>'chrome-extension://wallcheck-regression/'+file,
      onInstalled:event(),onStartup:event(),
      onMessage:{addListener:listener=>listeners.push(listener)},
      openOptionsPage:callback=>callback?.()
    },
    storage:{local,onChanged:event()},
    alarms:{
      get:(name,callback)=>queueMicrotask(()=>callback(clone(alarms.get(name)))),
      clear:(name,callback)=>{alarms.delete(name);queueMicrotask(()=>callback?.(true));},
      create:async(name,options)=>{alarms.set(name,clone(options));},
      onAlarm:event()
    },
    tabs:{
      query:(_query,callback)=>callback([...tabs.values()].map(tab=>({id:tab.id,url:tab.location.href}))),
      sendMessage(id,message,callback){
        queueMicrotask(()=>{
          for(const listener of tabs.get(id)?.listeners||[])listener(clone(message));
          callback?.();
        });
      },
      update(){},create(){}
    },
    notifications:{
      onClicked:event(),
      create:(id,options,callback)=>{notifications.push({id,options:clone(options)});callback?.(id);}
    }
  };
  const common={
    console,Date,Promise,Map,Set,Array,Object,Error,Number,String,Math,
    AbortController,TextEncoder,URL,URLSearchParams,crypto:webcrypto,queueMicrotask,
    setTimeout:(callback,delay=0,...args)=>{
      const id=++timerId;timers.set(id,{callback,delay,args});return id;
    },
    clearTimeout:id=>timers.delete(id)
  };
  const background=vm.createContext({...common,chrome,
    fetch:(_url,options)=>{
      const payload=JSON.parse(options.body);
      return new Promise((resolve,reject)=>requests.push({
        ips:payload.ips,
        reject(reason='TypeError: Failed to fetch'){reject(Error(reason));},
        resolve(results){
          const data={results};
          resolve({ok:true,status:200,text:async()=>JSON.stringify(data),json:async()=>clone(data)});
        }
      }));
    }
  });
  background.importScripts=(...files)=>{
    for(const file of files)vm.runInContext(fs.readFileSync(path.join(extension,file),'utf8'),background,{filename:file});
  };
  vm.runInContext(fs.readFileSync(path.join(extension,'background.js'),'utf8'),background,{filename:'background.js'});

  function tab(token,ip,instanceId){
    const id=++tabId;
    const fixture={token,ip,instanceId,paints:[]};
    const nodes=new Map();
    const tabListeners=[],windowListeners=new Map(),holdTypes=new Set(),held=[];
    const location={origin:'https://aws.sb',hash:'#/ec2-instances?sgt='+token};
    Object.defineProperty(location,'href',{get(){return this.origin+'/'+this.hash;}});
    const contentChrome={...chrome,runtime:{...chrome.runtime,
      onMessage:{addListener:listener=>tabListeners.push(listener)},
      sendMessage(message,callback){
        messages.push(clone(message));
        let answered=false,async=false;
        const done=response=>{
          if(answered)return;
          answered=true;
          const deliver=()=>queueMicrotask(()=>callback?.(clone(response)));
          if(holdTypes.delete(message.type))held.push({type:message.type,response:clone(response),release:deliver});
          else deliver();
        };
        const sender={id:chrome.runtime.id,tab:{id,url:location.href},url:location.href};
        for(const listener of listeners)if(listener(clone(message),sender,done)===true)async=true;
        if(!answered&&!async)done({ok:false,error:'No message listener'});
      }
    }};
    const context=vm.createContext({...common,chrome:contentChrome,location,__fixture:fixture,
      window:{addEventListener:(type,listener)=>windowListeners.set(type,listener)},
      document:{getElementById(id){
        if(!nodes.has(id))nodes.set(id,{style:{},textContent:'',title:''});
        return nodes.get(id);
      }}
    });
    vm.runInContext(fs.readFileSync(path.join(extension,'probe-isolation.js'),'utf8'),context,{filename:'probe-isolation.js'});
    // Install the actual message and hashchange callbacks without constructing
    // the UI. This keeps background broadcasts and navigation guards real.
    const messageStart=contentSource.indexOf('    chrome.runtime.onMessage.addListener');
    const messageEnd=contentSource.indexOf('    setTimeout(()=>runCheck(true), 600);',messageStart);
    assert(messageStart>=0&&messageEnd>messageStart,'real content listeners must remain discoverable');
    const hook=`
      collectIPCells=()=>new Map([[__fixture.ip,[]]]);
      collectInstanceRecords=()=>new Map([[__fixture.instanceId,{
        instanceId:__fixture.instanceId,ip:__fixture.ip,label:'#1 test'
      }]]);
      collectAccountCards=()=>[];
      domSignature=cells=>[...cells.keys()].join('|');
      accountSignalSignature=()=>'';
      applyBadges=(cells,combined)=>__fixture.paints.push({ips:[...cells.keys()],results:[...combined.keys()]});
      renderAlerts=()=>{};
      renderHiddenNotice=()=>{};
      globalThis.testApi={
        runCheck,scanAccountStatusWithoutProbe,clearThisScope,
        get scope(){return currentScope;},
        get lastFinishedAt(){return lastFinishedAt;}
      };
    `+contentSource.slice(messageStart,messageEnd);
    const marker=/\n\s*install\(\);\s*\n\}\)\(\);\s*$/;
    assert(marker.test(contentSource),'test must replace only the automatic install call');
    vm.runInContext(contentSource.replace(marker,'\n'+hook+'\n})();'),context,{filename:'content.js'});
    tabs.set(id,{id,location,listeners:tabListeners});
    return {
      api:context.testApi,nodes,fixture,held,
      holdNextResponse:type=>holdTypes.add(type),
      send:message=>new Promise(resolve=>contentChrome.runtime.sendMessage(message,resolve)),
      navigate(nextToken,nextIP,nextId){
        const changed=location.hash!=='#/ec2-instances?sgt='+nextToken;
        fixture.token=nextToken;fixture.ip=nextIP;fixture.instanceId=nextId;
        location.hash='#/ec2-instances?sgt='+nextToken;
        if(changed)windowListeners.get('hashchange')?.();
      },
      navigateRoute(hash){location.hash=hash;windowListeners.get('hashchange')?.();}
    };
  }
  return {stored,requests,messages,notifications,tab,
    flushZeroTimers(){
      const due=[...timers.entries()].filter(([,timer])=>timer.delay===0);
      return due.map(([id,timer])=>{timers.delete(id);return timer.callback(...timer.args);});
    }
  };
}

async function until(predicate){
  const deadline=Date.now()+3000;
  while(!predicate()){
    if(Date.now()>deadline)throw Error('controlled browser operation did not reach expected state');
    await new Promise(resolve=>setImmediate(resolve));
  }
}

async function crossScope(){
  const w=world(),tokenA='scope-token-A-async-test',tokenB='scope-token-B-async-test';
  const ipA='203.0.113.11',ipB='203.0.113.12';
  const t=w.tab(tokenA,ipA,'ec2:i-00000000000000019');
  const scan=t.api.runCheck(true);
  await until(()=>w.requests.length===1);
  assert.equal(t.api.scope,scopeOf(tokenA));
  t.navigate(tokenB,ipB,'ec2:i-0000000000000001b');
  // This is the real lightweight MutationObserver path, allowed during a scan.
  await t.api.scanAccountStatusWithoutProbe();
  assert.equal(t.api.scope,scopeOf(tokenB));
  w.requests[0].resolve({[ipA]:good});
  await scan;
  const keys=Object.keys(w.stored[resultKey]||{});
  assert(!keys.some(key=>key.startsWith(scopeOf(tokenB)+'|'+ipA+'::')),
    'late probe from scope A must never be stored under scope B: '+JSON.stringify(keys));
  assert(!w.messages.some(message=>message.type==='monitor:reachability'&&message.scope===scopeOf(tokenB)&&message.items?.some(item=>item.ip===ipA)),
    'late scope A results must not be submitted as scope B reachability');
  assert.equal(t.api.lastFinishedAt,null,'new page must not claim a completed measurement from the old page');
}

async function simultaneousTabs(){
  const w=world(),tokenA='parallel-token-A',tokenB='parallel-token-B';
  const ipA='198.51.100.21',ipB='198.51.100.22';
  const a=w.tab(tokenA,ipA,'ec2:i-00000000000000019'),b=w.tab(tokenB,ipB,'ec2:i-0000000000000001b');
  const first=a.api.runCheck(true),second=b.api.runCheck(true);
  await until(()=>w.requests.length===2);
  const requestA=w.requests.find(request=>request.ips.includes(ipA));
  const requestB=w.requests.find(request=>request.ips.includes(ipB));
  requestA.resolve({[ipA]:good});
  await first;
  requestB.resolve({[ipB]:good});
  await second;
  const entries=w.stored[resultKey]||{};
  assert(entries[scopeOf(tokenA)+'|'+ipA+'::22'],
    'the later-completing tab must retain the earlier tab last-valid result');
  assert(entries[scopeOf(tokenB)+'|'+ipB+'::22'],
    'both scopes must retain their own last-valid result');
}

async function ipChangesDuringProbe(){
  const w=world(),token='same-scope-ip-replacement',oldIP='192.0.2.31',newIP='192.0.2.32';
  const t=w.tab(token,oldIP,'ec2:i-0000000000000001c');
  const scan=t.api.runCheck(true);
  await until(()=>w.requests.length===1);
  // The DOM now contains a different IP for the same stable EC2 instance.
  // runCheck is still busy; its next full observe transaction has not run yet.
  t.navigate(token,newIP,'ec2:i-0000000000000001c');
  await t.api.scanAccountStatusWithoutProbe();
  const before=w.messages.length;
  w.requests[0].resolve({[oldIP]:pingFailure});
  await scan;
  assert.equal(t.api.lastFinishedAt,null,'replacement IP has not been measured yet');
  assert(!w.messages.slice(before).some(message=>message.type==='monitor:reachability'&&message.items?.some(item=>item.ip===oldIP)),
    'old-IP failure must not be submitted after the visible target changes');
  assert(!w.notifications.some(item=>/严重/.test(item.options.title)),
    'old-IP failure must not create a new critical toast for the replaced target');
  assert(!Object.keys(w.stored[resultKey]||{}).some(key=>key.includes('|'+oldIP+'::')),
    'obsolete visible-target result must not replace the current last-valid cache');
}

async function leavesEC2Route(){
  const w=world(),t=w.tab('leave-route-during-probe','192.0.2.41','ec2:i-0000000000000001d');
  const scan=t.api.runCheck(true);
  await until(()=>w.requests.length===1);
  t.navigateRoute('#/dashboard');
  const before=w.messages.length;
  w.requests[0].resolve({'192.0.2.41':pingFailure});
  await scan;
  assert.equal(t.api.lastFinishedAt,null,'a probe from a departed EC2 page must not update its completion time');
  assert(!w.messages.slice(before).some(message=>message.type==='monitor:reachability'),
    'the departed EC2 route must not receive a late reachability result');
  assert(!w.notifications.some(item=>/严重/.test(item.options.title)),
    'a departed EC2 page must not emit a new critical target notification');
}

async function delayedFailureAfterNavigation(){
  const w=world(),t=w.tab('failure-scope-A','198.51.100.51','ec2:i-0000000000000001e');
  const scan=t.api.runCheck(true);
  await until(()=>w.requests.length===1);
  t.navigate('failure-scope-B','198.51.100.52','ec2:i-0000000000000001f');
  await t.api.scanAccountStatusWithoutProbe();
  const before=w.messages.length;
  w.requests[0].reject();
  await scan;
  assert(!w.messages.slice(before).some(message=>message.type==='monitor:agent'&&message.ok===false),
    'a late transport failure from the previous page must not raise a fresh agent alarm');
  assert(!/本轮检测失败/.test(t.nodes.get('wallcheck-status').textContent),
    'a new page must not display the previous page failed-at timestamp');
  assert.equal(t.api.lastFinishedAt,null,'a failed stale attempt must never advance measured time');
  const globalAlerts=w.stored.wallcheck_scoped_monitor_v3?.globalAlerts||[];
  assert(!globalAlerts.some(item=>item.kind==='AGENT_OFFLINE'&&!item.resolvedAt),
    'stale failed transport must not persist an active agent-offline event');
}

async function ownClearThenContinue(){
  const w=world(),token='own-clear-during-probe',ip='192.0.2.61';
  const t=w.tab(token,ip,'ec2:i-00000000000000012');
  const old=t.api.runCheck(true);
  await until(()=>w.requests.length===1);
  await t.api.clearThisScope();
  w.requests[0].resolve({[ip]:pingFailure});
  await old;
  assert.equal(t.api.lastFinishedAt,null,'clearing this page invalidates its in-flight completion');
  assert(!Object.keys(w.stored[resultKey]||{}).length,'old response must not repopulate cleared results');
  assert(!w.notifications.some(item=>/严重/.test(item.options.title)),'cleared in-flight result must not recreate an alert');
  const fresh=w.flushZeroTimers();
  assert(fresh.length>0,'cleared in-flight scan must arrange a fresh scan');
  await until(()=>w.requests.length===2);
  w.requests[1].resolve({[ip]:good});
  await Promise.all(fresh);
  assert(t.api.lastFinishedAt,'fresh scan after a clear must complete normally');
  assert(w.stored[resultKey]?.[scopeOf(token)+'|'+ip+'::22'],'fresh epoch result must be saved');
}

async function otherTabClearsBeforeMerge(){
  const w=world(),token='shared-clear-before-merge',ip='192.0.2.71';
  const a=w.tab(token,ip,'ec2:i-00000000000000015'),b=w.tab(token,ip,'ec2:i-00000000000000015');
  const scan=a.api.runCheck(true);
  await until(()=>w.requests.length===1);
  await b.api.scanAccountStatusWithoutProbe();
  await b.api.clearThisScope();
  w.requests[0].resolve({[ip]:pingFailure});
  await scan;
  assert.equal(a.api.lastFinishedAt,null,'another tab clear invalidates this tab completion');
  assert(!Object.keys(w.stored[resultKey]||{}).length,'pre-clear response cannot repopulate scope cache');
  assert(!w.notifications.some(item=>/严重/.test(item.options.title)),'pre-clear response cannot recreate critical alert');
  const fresh=w.flushZeroTimers();
  await until(()=>w.requests.length===2);
  w.requests[1].resolve({[ip]:good});
  await Promise.all(fresh);
  assert(a.api.lastFinishedAt,'other-tab clear must leave monitoring able to continue');
}

async function otherTabClearsAfterAcceptedMerge(){
  const w=world(),token='shared-clear-after-merge',ip='192.0.2.81';
  const a=w.tab(token,ip,'ec2:i-00000000000000016'),b=w.tab(token,ip,'ec2:i-00000000000000016');
  a.holdNextResponse('results:merge');
  const scan=a.api.runCheck(true);
  await until(()=>w.requests.length===1);
  w.requests[0].resolve({[ip]:pingFailure});
  await until(()=>a.held.length===1);
  assert.equal(a.held[0].response.data.applied,true,'merge really committed before its response was held');
  assert(w.stored[resultKey]?.[scopeOf(token)+'|'+ip+'::22'],'accepted old-epoch merge exists before clear');
  await b.api.scanAccountStatusWithoutProbe();
  await b.api.clearThisScope();
  assert(!Object.keys(w.stored[resultKey]||{}).length,'clear removed the already accepted result');
  // Even if a stale post-probe message has already left a page, the real
  // background queue must reject it atomically after the epoch changes.
  const rejected=await a.send({type:'monitor:reachability',scope:scopeOf(token),resultEpoch:0,
    items:[{instanceId:'ec2:i-00000000000000016',ip,status:'PING_UNREACHABLE'}]});
  assert(rejected.stale||rejected.ok===false,'background must reject old-epoch reachability after clear');
  a.held[0].release();
  await scan;
  assert.equal(a.api.lastFinishedAt,null,'accepted old-epoch reply must not advance time after another tab clears');
  assert(!w.notifications.some(item=>/严重/.test(item.options.title)),
    'an accepted pre-clear merge or stale reachability message must not recreate cleared alerts');
  const snapshot=await a.send({type:'monitor:get',scope:scopeOf(token)});
  assert(!snapshot.data.alerts.some(item=>item.kind==='PING_UNREACHABLE'&&!item.resolvedAt),
    'old result must not repopulate durable critical alerts after clear');
}

(async()=>{
  let failures=0;
  for(const [name,test] of [
    ['late result after sgt navigation',crossScope],
    ['concurrent tabs preserve last-valid results',simultaneousTabs],
    ['same-scope IP replacement during probe',ipChangesDuringProbe],
    ['leaving EC2 route during probe',leavesEC2Route],
    ['late transport failure after navigation',delayedFailureAfterNavigation],
    ['clear own page and continue scanning',ownClearThenContinue],
    ['other tab clears before merge',otherTabClearsBeforeMerge],
    ['other tab clears after accepted merge',otherTabClearsAfterAcceptedMerge]
  ]){
    try{await test();console.log('PASS '+name);}
    catch(error){failures++;console.error('FAIL '+name+'\n'+error.stack);}
  }
  if(failures)process.exitCode=1;
  else console.log('ASYNC_SCOPE_REGRESSION_PASS');
})();
