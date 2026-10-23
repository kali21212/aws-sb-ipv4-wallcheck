const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const crypto=require('node:crypto').webcrypto;
const {TextEncoder}=require('node:util');
const cp=require('node:child_process');
const dir=path.resolve(__dirname,'..','browser-extension');
const src=fs.readFileSync(path.join(dir,'content.js'),'utf8');
const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
assert.equal(manifest.version,'1.9.5');
assert.deepEqual(manifest.permissions.slice().sort(),['alarms','notifications','storage']);
assert(src.includes("const ONLY_PORTS = [22]"));
assert(!src.includes('aws-sb-slot-')); // never use display ordinals as identity
assert(!src.includes('wallcheck_ip_change_toast'));
assert(src.includes('清空本页记录'));
const node=(text,parent=null)=>({
 innerText:text,textContent:text,parentElement:parent,children:[],
 closest:()=>null,querySelectorAll:()=>[],querySelector:()=>null
});
const card1=node('#1 ✎ 备用 6天\nIP 192.0.2.1\nIPv6 2406:da1e:aaaa:bbbb::1');
const cell1=node('IP 192.0.2.1',card1);
const card2=node('#1 ✎ 待定组 29天\nIP 192.0.2.2\nIPv6 2406:da1e:cccc:dddd::2');
const cell2=node('IP 192.0.2.2',card2);
const document={body:node('ROOT')};
const location={origin:'https://aws.sb',hash:'#/ec2-instances?sgt=synthetic-scope-A-123'};
const context={
 console,document,location,crypto,TextEncoder,URLSearchParams,
 chrome:{storage:{local:{}},runtime:{}},
 Map,Set,Promise,Uint8Array,queueMicrotask,Date,
 setTimeout:()=>{},clearTimeout:()=>{}
};
vm.createContext(context);
const inject='  globalThis.api={scopeFromURL,parsePorts,classify,findInstanceLabelNear,findStableIPv6Near,collectInstanceRecords,refreshChangeMarkers};';
vm.runInContext(src.replace('  install();',inject),context);
const api=context.api;
const first=new Map([['192.0.2.1',[cell1]]]);
const second=new Map([['192.0.2.2',[cell2]]]);
const a=api.collectInstanceRecords(first);
const b=api.collectInstanceRecords(second);
const ai=[...a.keys()][0],bi=[...b.keys()][0];
assert(ai.startsWith('ipv6:'));
assert(bi.startsWith('ipv6:'));
assert.notEqual(ai,bi,'different #1 cards must not be one instance');
assert.equal([...a.values()][0].label,'#1 备用');
assert.equal([...b.values()][0].label,'#1 待定组');
assert.equal(JSON.stringify([...api.parsePorts()]),'[22]');
assert.equal(api.classify('192.0.2.1',{results:{'192.0.2.1':{
 icmp:{state:'REACHABLE'},ports:[{port:22,state:'OPEN'}]}}}).key,'LOCAL_OK');
assert.equal(api.classify('192.0.2.1',{results:{'192.0.2.1':{
 icmp:{state:'REACHABLE'},ports:[{port:22,state:'TIMEOUT'}]}}}).key,'PORT_22_UNREACHABLE');
assert.equal(api.classify('192.0.2.1',{results:{'192.0.2.1':{
 icmp:{state:'NO_REPLY'},ports:[{port:22,state:'TIMEOUT'}]}}}).key,'LOCAL_FAIL');
(async()=>{
 const scopedA=await api.scopeFromURL();
 assert(/^sgt:[a-f0-9]{64}$/.test(scopedA));
 assert(!scopedA.includes('synthetic-scope-A-123'));
 location.hash='#/ec2-instances?sgt=synthetic-scope-B-789';
 const scopedB=await api.scopeFromURL();
 assert.notEqual(scopedA,scopedB);
 // The old global results/alert keys are no longer used for active IP changes.
 assert(!src.includes('wallcheck_alert_events_v1'));
 assert(!src.includes('wallcheck_instance_state_v1'));
 assert(!src.includes('wallcheck_ipv4_list_v2'));
 cp.execFileSync(process.execPath,[path.join(__dirname,'scoped-monitor-regression.cjs')],{stdio:'inherit'});
 cp.execFileSync(process.execPath,[path.join(__dirname,'account-dom-regression.cjs')],{stdio:'inherit'});
 cp.execFileSync(process.execPath,[path.join(__dirname,'account-events-regression.cjs')],{stdio:'inherit'});
 cp.execFileSync(process.execPath,[path.join(__dirname,'hidden-history-regression.cjs')],{stdio:'inherit'});
 cp.execFileSync(process.execPath,[path.join(__dirname,'card-identity-regression.cjs')],{stdio:'inherit'});
 cp.execFileSync(process.execPath,[path.join(__dirname,'false-ip-history-regression.cjs')],{stdio:'inherit'});
 cp.execFileSync(process.execPath,[path.join(__dirname,'new-scope-regression.cjs')],{stdio:'inherit'});
 cp.execFileSync(process.execPath,[path.join(__dirname,'recovered-ack-regression.cjs')],{stdio:'inherit'});
 cp.execFileSync(process.execPath,[path.join(__dirname,'manual-regression.cjs')],{stdio:'inherit'});
 cp.execFileSync(process.execPath,[path.join(__dirname,'down-time-regression.cjs')],{stdio:'inherit'});
 console.log('PASS extension v1.8: hashed sgt scope, independent #1 cards, stable IPv6, 22-only classifications and scoped core');
})().catch(e=>{console.error(e);process.exitCode=1;});
