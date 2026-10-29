const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'../browser-extension');
const bkg=fs.readFileSync(path.join(root,'background.js'),'utf8');
const content=fs.readFileSync(path.join(root,'content.js'),'utf8');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
assert.equal(manifest.version,'1.9.8');
assert.match(bkg,/const AUTO_RECHECK_MINUTES = 3;/);
assert.match(content,/const AUTO_RECHECK_MINUTES = 3;/);
assert.match(content,/const CACHE_MS = 2 \* 60 \* 1000;/);
assert.match(content,/上次实测/);
assert.match(content,/缓存结果（未重测）/);
assert.match(content,/本轮实测/);
assert.match(content,/const checkedAt = Date\.now\(\);/);
assert.match(content,/lastFinishedAt = new Date\(checkedAt\);/);
assert.match(content,/if\(msg\?\.type==='auto-recheck' \|\| msg\?\.type==='startup-recheck'\)\s*\{\s*runCheck\(true\);/);
assert.match(bkg,/if \(alarm\.name !== AUTO_ALARM\) return;/);
assert.match(bkg,/chrome\.tabs\.sendMessage\(tab\.id, \{type:'auto-recheck'\}/);

// Execute the ACTUAL alarm scheduling function without any external browser,
// AWS calls, OS tasks or persistent settings.
const begin=bkg.indexOf('function ensureAutoAlarm() {');
const end=bkg.indexOf('chrome.runtime.onInstalled.addListener',begin);
assert(begin>=0 && end>begin,'unable to isolate alarm function');
const fn=bkg.slice(begin,end).trim();
const createCtx=(existing)=>{
  const calls=[];
  const chrome={alarms:{
    get:(name,cb)=>{calls.push(['get',name]);cb(existing);},
    clear:(name,cb)=>{calls.push(['clear',name]);cb(true);},
    create:(name,opts)=>calls.push(['create',name,opts])
  }};
  const c={chrome,calls};
  vm.createContext(c);
  vm.runInContext("const AUTO_ALARM = 'wallcheck-auto-recheck';\n"+
    "const AUTO_RECHECK_MINUTES = 3;\n"+fn+
    "\nglobalThis.verify=ensureAutoAlarm;",c);
  c.verify();
  return calls;
};
let calls=createCtx(null);
assert.equal(calls[1][0],'clear');
assert.equal(calls[2][0],'create');
assert.equal(calls[2][2].delayInMinutes,3);
assert.equal(calls[2][2].periodInMinutes,3);
calls=createCtx({periodInMinutes:10});
assert.equal(calls[1][0],'clear','upgrade existing 10min alarm');
assert.equal(calls[2][2].periodInMinutes,3,'replace old 10min alarm');
calls=createCtx({periodInMinutes:3});
assert.equal(calls.length,1,'existing 3min alarm must not be recreated constantly');
console.log('THREE_MIN_RECHECK_REGRESSION_PASS: 10->3 migration, stable alarm, forced fresh probe, short cache, accurately labeled timestamp');
