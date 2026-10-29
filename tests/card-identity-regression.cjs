const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const crypto=require('node:crypto').webcrypto;
const {TextEncoder}=require('node:util');
const src=fs.readFileSync(path.join(__dirname,'../browser-extension/content.js'),'utf8');
const mk=(text,parent=null)=>({innerText:text,textContent:text,parentElement:parent,
 children:[],closest:()=>null,querySelectorAll:()=>[],querySelector:()=>null});
const body=mk('BODY');
const left=mk('#1 示例组一\nIP 203.0.113.112 (动态)\n地区 香港',null);
const right=mk('#6 示例实例六\nIP 203.0.113.108 (动态)\nIPv6 2001:db8:100::1',null);
const grid=mk(left.innerText+'\n'+right.innerText,body);
left.parentElement=grid;right.parentElement=grid;
const firstCell=mk('IP 203.0.113.112 (动态)',left);
const sixthCell=mk('IP 203.0.113.108 (动态)',right);
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
const one=api.collectInstanceRecords(new Map([['203.0.113.112',[firstCell]]]));
const six=api.collectInstanceRecords(new Map([['203.0.113.108',[sixthCell]]]));
const oneKey=[...one.keys()][0],sixKey=[...six.keys()][0];
assert.equal(oneKey,'ip-target:203.0.113.112',
  'missing IPv6 inside #1 must NEVER steal #6 IPv6 from common grid');
assert.equal(sixKey,'ipv6:2001:db8:123::6',
  '#6 must keep its own IPv6 ID');
assert.notEqual(oneKey,sixKey,'cross-card identity collision forbidden');
assert.equal(one.get(oneKey).label,'#1 示例组一');
assert.equal(six.get(sixKey).label,'#6 示例实例六');
const together=api.collectInstanceRecords(new Map([
 ['203.0.113.112',[firstCell]],['203.0.113.108',[sixthCell]]
]));
assert.equal(together.size,2,'both real card targets must survive');
assert.equal(together.get(oneKey).ip,'203.0.113.112');
assert.equal(together.get(sixKey).ip,'203.0.113.108');
// The official EC2 identifier, if visible in a card, outranks IPv6.
left.innerText='#1 i-00000000000000002\nIP 203.0.113.112 (动态)\n地区 香港';
grid.innerText=left.innerText+'\n'+right.innerText;
const official=api.collectInstanceRecords(new Map([['203.0.113.112',[firstCell]]]));
assert([...official.keys()][0].startsWith('ec2:i-00000000000000002'));
// An IP-looking historical datum elsewhere in the same grid is not
// sufficient evidence of a current card / stable machine mapping.
const unlabelled=mk('IP 192.0.2.65',grid);
const unknown=api.collectInstanceRecords(new Map([['192.0.2.65',[unlabelled]]]));
assert.equal(unknown.size,0,'unscoped cells must not be assigned another card identity');
console.log('CARD_IDENTITY_REGRESSION_PASS: no adjacent IPv6 theft, #1/#6 isolated, true EC2 IDs, ambiguous cells rejected');
