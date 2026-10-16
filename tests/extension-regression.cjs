const fs=require('fs'),vm=require('vm'),assert=require('assert').strict,path=require('path');
const root=path.join(__dirname,'..','browser-extension');
let now=1792160000000,mode='OPEN',offline=false;const db={},calls=[];
const D=class extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
const node=()=>({style:{},children:[],dataset:{},classList:{contains:()=>false},textContent:'',
  appendChild(e){this.children.push(e);},replaceChildren(){this.children=[];},addEventListener(t,f){this[t]=f;},remove(){},closest(){return null;}});
function boot(){
 let src=fs.readFileSync(path.join(root,'content.js'),'utf8');
 assert(src.includes('  install();'));
 src=src.replace('  install();',"  globalThis.api={runCheck,classify,findInstanceLabelNear,isPageMutationRelevant,collectInstanceRecordsOriginal:collectInstanceRecords,acknowledgeAlerts,get events(){return alertEvents;},get changes(){return recentChanges;},set(c,r){collectIPCells=()=>c;collectInstanceRecords=()=>r;}};");
 const ids=['wallcheck-panel','wallcheck-count','wallcheck-status','wallcheck-alert-center'];
 const nodes=new Map(ids.map(id=>[id,node()])),timers=[];
 const chrome={runtime:{lastError:null,sendMessage(m,cb){
   calls.push(m);
   if(m.type==='notify'){cb({ok:true});return;}
   if(offline){queueMicrotask(()=>cb({ok:false,error:'offline'}));return;}
   queueMicrotask(()=>cb({ok:true,data:{results:Object.fromEntries(m.payload.ips.map(ip=>[ip,{
     icmp:{state:mode==='FAIL'?'NO_REPLY':'REACHABLE'},
     ports:[{port:22,state:mode==='OPEN'?'OPEN':'TIMEOUT'}]}]))}}));
 }},storage:{local:{get:(k,cb)=>cb(structuredClone(db)),set:(v,cb)=>{Object.assign(db,structuredClone(v));cb();}}}};
 const document={getElementById:id=>nodes.get(id),querySelectorAll:()=>[],createElement:()=>node(),body:node(),head:node()};
 const ctx={chrome,document,console,Date:D,Map,Set,Promise,queueMicrotask,
  location:{origin:'https://aws.sb',hash:'#/ec2-instances'},
  setTimeout:(f,ms)=>{timers.push(ms);return timers.length;},clearTimeout(){},setInterval(){},window:{addEventListener(){}},
  MutationObserver:class{observe(){}}};
 vm.createContext(ctx);vm.runInContext(src,ctx);return {api:ctx.api,nodes,timers};
}
const cells=ip=>new Map([[ip,[node()]]]);
const records=(ip,label='#1 待定组')=>new Map([['i-abc12345',{instanceId:'i-abc12345',ip,label,cell:node()}]]);
async function scan(c,ip,label){c.api.set(cells(ip),records(ip,label));await c.api.runCheck(true);}
(async()=>{
 let c=boot();
 const raw=node(),card=node();raw.innerText='IP 192.0.2.1';raw.parentElement=card;
 card.innerText='#1 ✎ 待定组\nIP 192.0.2.1';card.parentElement=null;
 assert.equal(c.api.findInstanceLabelNear(raw,'192.0.2.1').label,'#1 待定组');
 card.innerText='#2 🔗 老用户 24小时 剩余25天\nIP 192.0.2.1';
 assert.equal(c.api.findInstanceLabelNear(raw,'192.0.2.1').label,'#2 老用户');
 card.innerText='#1 ✎ 待定组 29天 剩余25天\nIP 192.0.2.1';
 assert.equal(c.api.findInstanceLabelNear(raw,'192.0.2.1').label,'#1 待定组');
 assert(c.api.collectInstanceRecordsOriginal(cells('192.0.2.8')).has('ip-target:192.0.2.8'));
 const intern={nodeType:1,closest:()=>({})};
 assert.equal(c.api.isPageMutationRelevant({type:'childList',target:intern,addedNodes:[{nodeType:1}],removedNodes:[]}),false);
 const page={nodeType:1,closest:()=>null};
 assert.equal(c.api.isPageMutationRelevant({type:'childList',target:page,addedNodes:[{nodeType:1,matches:()=>false,closest:()=>null}],removedNodes:[]}),true);
 assert.equal(c.api.isPageMutationRelevant({type:'childList',target:page,addedNodes:[{nodeType:3,textContent:'IP 127.0.0.3'}],removedNodes:[]}),true);
 await scan(c,'192.0.2.1');
 assert(db.wallcheck_last_valid_results_v1['192.0.2.1::22']);
 assert.equal(calls.find(x=>x.type==='probe').payload.ports.join(','),'22');
 now+=60000;await scan(c,'192.0.2.2');
 now+=60000;await scan(c,'192.0.2.3','#1 新名字');
 let es=c.api.events.filter(x=>x.kind==='IP_CHANGE');
 assert.equal(es.length,2);
 assert.equal(es[0].oldIp,'192.0.2.1');assert.equal(es[0].newIp,'192.0.2.2');
 assert.equal(es[1].oldIp,'192.0.2.2');assert.equal(es[1].newIp,'192.0.2.3');
 assert.equal(es[0].label,'#1 新名字');
 assert(calls.some(x=>x.type==='notify'&&x.event.title.includes('#1')));
 now+=7200000;c=boot();await scan(c,'192.0.2.3','#1 新名字');
 assert.equal(c.api.changes.size,2);
 await c.api.acknowledgeAlerts(es.map(x=>x.id));
 assert.equal(c.api.changes.size,0);
 now+=60000;await scan(c,'192.0.2.4');
 assert.equal(c.api.events.filter(x=>x.kind==='IP_CHANGE'&&!x.acknowledged).length,1);
 mode='CLOSED';now+=60000;await scan(c,'192.0.2.4');
 assert.equal(c.api.events.filter(x=>x.kind==='PORT22_UNREACHABLE').length,1);
 now+=60000;await scan(c,'192.0.2.4');
 assert.equal(c.api.events.filter(x=>x.kind==='PORT22_UNREACHABLE').length,1);
 now+=60000;await scan(c,'192.0.2.5');
 assert.equal(c.api.events.filter(x=>x.kind==='PORT22_UNREACHABLE').length,2);
 mode='OPEN';now+=60000;await scan(c,'192.0.2.5');
 mode='FAIL';now+=60000;await scan(c,'192.0.2.5');
 assert.equal(c.api.events.filter(x=>x.kind==='HOST_UNREACHABLE').length,1);
 offline=true;now+=60000;await scan(c,'192.0.2.5');
 assert.equal(c.api.events.filter(x=>x.kind==='AGENT_OFFLINE').length,1);
 now+=60000;await scan(c,'192.0.2.5');
 assert.equal(c.api.events.filter(x=>x.kind==='AGENT_OFFLINE').length,1);
 assert(c.timers.includes(15000));
 offline=false;mode='OPEN';now+=60000;await scan(c,'192.0.2.5');
 assert.equal(db.wallcheck_condition_states_v1.__agent,'OK');
 const listeners={},created=[];
 const bg={runtime:{lastError:null,getURL:x=>'chrome-extension://test/'+x,
   onInstalled:{addListener:f=>listeners.installed=f},onStartup:{addListener:f=>listeners.startup=f},
   onMessage:{addListener:f=>listeners.message=f}},
   alarms:{get:(n,cb)=>cb(null),clear:(n,cb)=>cb(),create:(n,o)=>created.push(o),
     onAlarm:{addListener:f=>listeners.alarm=f}},
   tabs:{query:(q,cb)=>cb([{id:9}]),sendMessage(){},update(){},create(){}},
   notifications:{create:(id,opts,cb)=>{listeners.lastNote=opts;cb(id);},onClicked:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),
   {chrome:bg,AbortController,Date:D,console,setTimeout,clearTimeout,fetch:async()=>({ok:true,text:async()=>'{}'})});
 assert.equal(created[0].periodInMinutes,10);
 let notif;
 assert.equal(listeners.message({type:'notify',event:{id:'test1',title:'#2 老用户',message:'A to B'}},null,x=>notif=x),true);
 assert(notif.ok);assert.equal(listeners.lastNote.iconUrl,'chrome-extension://test/icon.png');
 assert(require('node:fs').existsSync(path.join(root,'icon.png')));
 assert(JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8')).permissions.includes('notifications'));
 console.log('PASS v1.7: TCP22-only, A-B-C history, custom label, persistent until acknowledged, dedupe, host/22 alarms, agent alert and recovery, notification and alarm');
})().catch(e=>{console.error(e);process.exitCode=1;});
