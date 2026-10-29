const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.resolve(__dirname,'../browser-extension/content.js'),'utf8');
const node=(value,parent=null)=>({innerText:value,textContent:value,parentElement:parent,
  children:[],closest:()=>null,querySelector:()=>null,querySelectorAll:()=>[]});
const body=node('full root');
const grid=node('#1 示例组一\nIP 203.0.113.115\n#2 示例账号二\n账号无效\n自动替补',body);
const one=node('#1 示例组一\nIP 203.0.113.115\n型号 c5n.large',grid);
const two=node('#2 示例账号二\n账号无效\n自动替补\n尝试账号 private@example.test\n型号 c5n.large',grid);
const head1=node('#1 示例组一',one);
const head2=node('#2 示例账号二',two);
const document={body,querySelectorAll:()=>[head1,head2]};
const context={console,document,location:{origin:'https://aws.sb',hash:'#/ec2-instances?sgt=UNIT_TEST'},
  crypto:require('node:crypto').webcrypto,TextEncoder,URLSearchParams,
  chrome:{storage:{local:{}},runtime:{}},Map,Set,Promise,Uint8Array,Date,
  setTimeout:()=>{},clearTimeout:()=>{},queueMicrotask:()=>{}};
vm.createContext(context);
const patched=src.replace('  install();',
  '  globalThis.testAccountDetector={collectAccountCards,accountSignalSignature};');
assert.notEqual(patched,src);
vm.runInContext(patched,context);
const f=context.testAccountDetector;
let result=f.collectAccountCards();
assert.equal(result.length,2);
const user=result.find(r=>r.slot==='2');
assert(user);
assert.equal(user.invalid,true);
assert.equal(user.replacing,true);
assert.equal(user.ip,null);
assert.equal(user.label,'#2 示例账号二');
assert.equal(result.find(r=>r.slot==='1').invalid,false);
assert(!JSON.stringify(result).includes('private@example.test'),
  'account email must never be emitted by content detector');
const initial=f.accountSignalSignature(result);
two.innerText=two.textContent='#2 示例账号二\n自动替补\n尝试账号 another@example.test\n型号 c5n.large';
result=f.collectAccountCards();
assert.equal(result.find(r=>r.slot==='2').invalid,false);
assert.equal(result.find(r=>r.slot==='2').replacing,true);
assert.notEqual(f.accountSignalSignature(result),initial);
const inProgress=f.accountSignalSignature(result);
two.innerText=two.textContent='#2 示例账号二\n自动替补\n尝试账号 third@example.test\n型号 c5n.large';
assert.equal(f.accountSignalSignature(f.collectAccountCards()),inProgress,
  'new email inside retry UI must not trigger extra scans');
two.innerText=two.textContent='#2 示例账号二\n设置新实例\nIP 203.0.113.108\n型号 c5n.large';
result=f.collectAccountCards();
assert.equal(result.find(r=>r.slot==='2').ip,'203.0.113.108');
assert.equal(result.find(r=>r.slot==='2').replacing,false);
assert.equal(result.find(r=>r.slot==='2').invalid,false);
assert.equal(result.find(r=>r.slot==='1').ip,'203.0.113.115');
assert.notEqual(f.accountSignalSignature(result),inProgress);
console.log('ACCOUNT_DOM_REGRESSION_PASS: card-local invalid/replenishing/healthy signals, no neighboring contamination, email-agnostic signature, zero private text leakage');
