const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const crypto=require('node:crypto').webcrypto;
const {TextEncoder}=require('node:util');
const src=fs.readFileSync(path.join(__dirname,'../browser-extension/content.js'),'utf8');
const mk=(text,parent=null)=>({innerText:text,textContent:text,parentElement:parent,
 children:[],closest:()=>null,querySelectorAll:()=>[],querySelector:()=>null});
const body=mk('BODY');
const left=mk('#1 待定组\nIP 54.46.44.121 (动态)\n地区 香港',null);
const right=mk('#6 极图悟空\nIP 18.162.225.248 (动态)\nIPv6 2406:da1e:43ff:9df9:9ec4:49d:9ff2:ede7',null);
const grid=mk(left.innerText+'\n'+right.innerText,body);
left.parentElement=grid;right.parentElement=grid;
const firstCell=mk('IP 54.46.44.121 (动态)',left);
const sixthCell=mk('IP 18.162.225.248 (动态)',right);
const document={body};
const location={origin:'https://aws.sb',hash:'#/ec2-instances?sgt=test-shared-list'};
const ctx={console,document,location,crypto,TextEncoder,URLSearchParams,
 chrome:{storage:{local:{}},runtime:{}},Map,Set,Promise,Uint8Array,
 queueMicrotask,Date,setTimeout:()=>{},clearTimeout:()=>{}};
vm.createContext(ctx);
const injected=src.replace('  install();',
  '  globalThis.testApi={collectInstanceRecords,findStableIPv6Near,findInstanceLabelNear};');
assert.notEqual(injected,src,'needs insertion marker');
vm.runInContext(injected,ctx);
const api=ctx.testApi;
const one=api.collectInstanceRecords(new Map([['54.46.44.121',[firstCell]]]));
const six=api.collectInstanceRecords(new Map([['18.162.225.248',[sixthCell]]]));
const oneKey=[...one.keys()][0],sixKey=[...six.keys()][0];
assert.equal(oneKey,'ip-target:54.46.44.121',
  'missing IPv6 inside #1 must NEVER steal #6 IPv6 from common grid');
assert.equal(sixKey,'ipv6:2406:da1e:43ff:9df9:9ec4:49d:9ff2:ede7',
  '#6 must keep its own IPv6 ID');
assert.notEqual(oneKey,sixKey,'cross-card identity collision forbidden');
assert.equal(one.get(oneKey).label,'#1 待定组');
assert.equal(six.get(sixKey).label,'#6 极图悟空');
const together=api.collectInstanceRecords(new Map([
 ['54.46.44.121',[firstCell]],['18.162.225.248',[sixthCell]]
]));
assert.equal(together.size,2,'both real card targets must survive');
assert.equal(together.get(oneKey).ip,'54.46.44.121');
assert.equal(together.get(sixKey).ip,'18.162.225.248');
// The official EC2 identifier, if visible in a card, outranks IPv6.
left.innerText='#1 i-086d87ec69f855186\nIP 54.46.44.121 (动态)\n地区 香港';
grid.innerText=left.innerText+'\n'+right.innerText;
const official=api.collectInstanceRecords(new Map([['54.46.44.121',[firstCell]]]));
assert([...official.keys()][0].startsWith('ec2:i-086d87ec69f855186'));
// An IP-looking historical datum elsewhere in the same grid is not
// sufficient evidence of a current card / stable machine mapping.
const unlabelled=mk('IP 192.0.2.65',grid);
const unknown=api.collectInstanceRecords(new Map([['192.0.2.65',[unlabelled]]]));
assert.equal(unknown.size,0,'unscoped cells must not be assigned another card identity');
console.log('CARD_IDENTITY_REGRESSION_PASS: no adjacent IPv6 theft, #1/#6 isolated, true EC2 IDs, ambiguous cells rejected');
