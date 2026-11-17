const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.resolve(__dirname,'../browser-extension/content.js'),'utf8');
const body={tagName:'BODY',innerText:'',textContent:'',parentElement:null,children:[],matches:()=>false,closest:()=>null};
const all=[];
function node(tag,text,parent=null,attrs={}){
  const n={tagName:tag.toUpperCase(),innerText:text,textContent:text,
    parentElement:parent,children:[],attrs,classes:new Set(String(attrs.class||'').split(/\s+/).filter(Boolean)),
    get id(){return this.attrs.id||'';},
    getAttribute(name){return this.attrs[name]??null;},
    matches(selector){
      return selector.split(',').map(x=>x.trim()).some(sel=>{
        if(!sel)return false;
        if(sel===this.tagName.toLowerCase())return true;
        if(sel.startsWith('#'))return this.id===sel.slice(1);
        if(sel.startsWith('.'))return this.classes.has(sel.slice(1));
        const role=/^\[role=["']?([^"'\]]+)["']?\]$/.exec(sel);
        if(role)return this.attrs.role===role[1];
        const aria=/^\[aria-modal=["']?([^"'\]]+)["']?\]$/.exec(sel);
        if(aria)return this.attrs['aria-modal']===aria[1];
        return false;
      });
    },
    closest(selector){
      for(let p=this;p;p=p.parentElement)if(p.matches(selector))return p;
      return null;
    },
    querySelector(){return null;},
    querySelectorAll(){return [];},
    cloneNode(){return node(tag,text,parent,attrs);}
  };
  if(parent)parent.children.push(n);
  all.push(n);return n;
}
const app=node('div','',body);
const card1=node('div','#1 EC2 test one\nIP 192.0.2.10 (dynamic)\nIPv6 2001:db8:100::2',app);
const line1=node('div','IP 192.0.2.10 (dynamic)',card1);
const value1=node('span','192.0.2.10 (dynamic)',line1);
const card4=node('div','#4 EC2 test four\nIP 192.0.2.20 (dynamic)\nIPv6 2001:db8:100::4',app);
const line4=node('div','IP 192.0.2.20 (dynamic)',card4);
const value4=node('span','192.0.2.20 (dynamic)',line4);
// Reproduce the AWS.SB Change-IP dialog with documentation-only CIDR samples.
const modal=node('div','Change IP\n7 days\nType\nDynamic\nStatic\nCIDR\n198.51.100.0/24 203.0.113.0/24',app,
  {id:'change-ip-modal',role:'dialog','aria-modal':'true',class:'ant-modal'});
const cidrField=node('div','198.51.100.0/24 203.0.113.0/24',modal,{class:'cidr-field'});
node('span','198.51.100.0/24',cidrField,{class:'cidr-example'});
node('span','203.0.113.0/24',cidrField,{class:'cidr-example'});
// A non-modal help/example block must also never become an EC2 probe target.
node('div','Help example\nCIDR 192.0.2.200/32',app,{id:'page-help'});
const document={body,querySelectorAll(selector){
  assert.equal(selector,'td,.ant-table-cell,[role="cell"],div,span');
  return all.filter(x=>['DIV','SPAN','TD'].includes(x.tagName));
}};
const context={console,document,location:{origin:'https://aws.sb',hash:'#/ec2-instances?sgt=modal-test'},
  chrome:{runtime:{},storage:{local:{}}},Map,Set,Promise,Uint8Array,Date,
  crypto:require('node:crypto').webcrypto,TextEncoder,URLSearchParams,
  queueMicrotask,setTimeout:()=>0,clearTimeout:()=>{}};
vm.createContext(context);
const injected=src.replace('  install();',
  '  globalThis.__modalTest={collectIPCells,collectInstanceRecords,extractIPv4,findInstanceCardRoot};');
assert.notEqual(injected,src,'test hook anchor must exist');
vm.runInContext(injected,context);
const api=context.__modalTest;
assert.equal(JSON.stringify(api.extractIPv4('198.51.100.0/24 203.0.113.0/24')),
  JSON.stringify(['198.51.100.0','203.0.113.0']));
assert.equal(api.findInstanceCardRoot(value1,'192.0.2.10'),card1);
assert.equal(api.findInstanceCardRoot(value4,'192.0.2.20'),card4);
const cells=api.collectIPCells();
const found=[...cells.keys()].sort();
const expected=['192.0.2.10','192.0.2.20'];
assert.deepEqual(found,expected,
  'only IPs on numbered AWS.SB EC2 cards may be probed; CIDR examples and page help must be excluded');
assert.equal(cells.get('192.0.2.10')[0],value1);
assert.equal(cells.get('192.0.2.20')[0],value4);
const records=api.collectInstanceRecords(cells);
assert.equal(records.size,2);
assert([...records.values()].every(x=>x.label.startsWith('#')));
console.log('MODAL_CIDR_ISOLATION_PASS: only numbered EC2 card IPv4s are probe targets');