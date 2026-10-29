const assert=require('node:assert/strict');
const {createWallCheckResultCache,RESULT_KEY,EPOCH_KEY}=
  require('../browser-extension/result-cache.js');
const A='sgt:'+'a'.repeat(64),B='sgt:'+'b'.repeat(64);
const key=(scope,ip)=>scope+'|'+ip+'::22';
const entry=(checkedAt,label='LOCAL_OK')=>({value:{key:label,text:label},checkedAt});
const aKey=key(A,'203.0.113.11'),bKey=key(B,'203.0.113.12');
const clone=x=>structuredClone(x);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(initial={}) {
  const data=clone(initial),writes=[];
  let failRead=false,failWrite=false;
  const adapters={
    read:async keys=>{
      await tick();
      if(failRead){failRead=false;throw Error('simulated read failure');}
      return Object.fromEntries(keys.filter(k=>k in data).map(k=>[k,clone(data[k])]));
    },
    write:async values=>{
      await tick();
      if(failWrite){failWrite=false;throw Error('simulated write failure');}
      writes.push(clone(values));
      Object.assign(data,clone(values));
    }
  };
  return {data,writes,adapters,cache:createWallCheckResultCache(adapters),
    failRead:()=>{failRead=true;},failWrite:()=>{failWrite=true;}};
}
const get=(cache,scope)=>cache.dispatch({type:'results:get',scope});
const merge=(cache,scope,epoch,entries)=>cache.dispatch({type:'results:merge',scope,epoch,entries});
(async()=>{
  const untouched={version:3,scopes:{retained:'pending alerts'}};
  const h=harness({[RESULT_KEY]:{[aKey]:entry(100)},
    wallcheck_scoped_monitor_v3:untouched});
  const legacy=await get(h.cache,A);
  assert.deepEqual(legacy,{entries:{[aKey]:entry(100)},epoch:0},'legacy cache reads without migration');
  assert.equal(h.writes.length,0,'read is side-effect free');
  legacy.entries[aKey].value.text='caller changed snapshot';
  assert.equal((await get(h.cache,A)).entries[aKey].value.text,'LOCAL_OK','snapshot is detached');

  // Both tabs begin with the same old storage, then their asynchronous probes
  // finish concurrently. The second completion must preserve the first delta.
  const [startA,startB]=await Promise.all([get(h.cache,A),get(h.cache,B)]);
  await Promise.all([
    merge(h.cache,A,startA.epoch,{[aKey]:entry(200)}),
    merge(h.cache,B,startB.epoch,{[bKey]:entry(201,'PING_UNREACHABLE')})
  ]);
  assert.deepEqual(h.data[RESULT_KEY],{[bKey]:entry(201,'PING_UNREACHABLE'),[aKey]:entry(200)},
    'parallel scoped completions are merged rather than replacing one another');
  await merge(h.cache,A,0,{[aKey]:entry(150,'LOCAL_FAIL')});
  assert.deepEqual(h.data[RESULT_KEY][aKey],entry(200),'older completion cannot overwrite newer cache');
  const sameWrites=h.writes.length;
  await merge(h.cache,A,0,{[aKey]:entry(200)});
  assert.equal(h.writes.length,sameWrites,'identical repeated delivery is idempotent');

  const cleared=await h.cache.dispatch({type:'results:clear',scope:A});
  assert.deepEqual(cleared,{applied:true,epoch:1});
  assert(!Object.hasOwn(h.data[RESULT_KEY],aKey));
  assert.deepEqual(h.data[RESULT_KEY][bKey],entry(201,'PING_UNREACHABLE'),'clear preserves the other scope');
  assert.deepEqual(h.data.wallcheck_scoped_monitor_v3,untouched,'cache never owns or clears alert history');
  assert(h.writes.at(-1)[RESULT_KEY] && h.writes.at(-1)[EPOCH_KEY],
    'clear and epoch are committed in one storage update');
  assert.deepEqual(await merge(h.cache,A,0,{[aKey]:entry(500)}),{applied:false,epoch:1});
  assert(!Object.hasOwn(h.data[RESULT_KEY],aKey),'old in-flight probe cannot resurrect cleared cache');
  const restarted=createWallCheckResultCache(h.adapters);
  assert.equal((await get(restarted,A)).epoch,1,'clear guard persists across worker restart');
  assert.deepEqual(await merge(restarted,A,0,{[aKey]:entry(600)}),{applied:false,epoch:1});
  await merge(restarted,A,1,{[aKey]:entry(700)});
  assert.equal(h.data[RESULT_KEY][aKey].checkedAt,700,'new post-clear probe may repopulate its scope');

  // A malformed message is rejected as a whole before any persistent mutation.
  const before=clone(h.data);
  for(const msg of [
    {type:'results:get',scope:'raw-sgt-token'},
    {type:'results:unknown',scope:A},
    {type:'results:merge',scope:A,epoch:-1,entries:{}},
    {type:'results:merge',scope:A,epoch:1,entries:[]},
    {type:'results:merge',scope:A,epoch:1,entries:{[bKey]:entry(800)}},
    {type:'results:merge',scope:A,epoch:1,entries:{[A+'|203.0.113.11::443']:entry(800)}},
    {type:'results:merge',scope:A,epoch:1,entries:{[key(A,'999.0.0.1')]:entry(800)}},
    {type:'results:merge',scope:A,epoch:1,entries:{[key(A,'01.0.0.1')]:entry(800)}},
    {type:'results:merge',scope:A,epoch:1,entries:{[aKey]:entry(NaN)}},
    {type:'results:merge',scope:A,epoch:1,entries:{[aKey]:{value:null,checkedAt:800}}}
  ])await assert.rejects(()=>h.cache.dispatch(msg));
  assert.deepEqual(h.data,before,'invalid deltas do not partially commit');

  const corrupted=harness({[RESULT_KEY]:{junk:null,[aKey]:entry(5,'LEGACY_CUSTOM_CLASS'),
    [bKey]:{value:{key:'LOCAL_OK',text:'ok'},checkedAt:Infinity}},
    [EPOCH_KEY]:{[A]:'bad',nonscope:3}});
  assert.deepEqual(await get(corrupted.cache,A),
    {entries:{[aKey]:entry(5,'LEGACY_CUSTOM_CLASS')},epoch:0},
    'bad legacy data is ignored without restricting valid historical classifications');
  await merge(corrupted.cache,B,0,{[bKey]:entry(9)});
  assert.equal(Object.keys(corrupted.data[RESULT_KEY]).length,2);

  // Cache bound protects browser storage while selecting the newest results.
  const many={};
  for(let i=0;i<2005;i++)many[key(A,'10.'+Math.floor(i/256)+'.'+(i%256)+'.1')]=entry(i+1);
  const capped=harness();
  await merge(capped.cache,A,0,many);
  assert.equal(Object.keys(capped.data[RESULT_KEY]).length,2000);
  assert.equal(Math.min(...Object.values(capped.data[RESULT_KEY]).map(x=>x.checkedAt)),6);

  // Failed storage calls do not poison the queue or manufacture success.
  const failing=harness();
  failing.failRead();
  await assert.rejects(()=>get(failing.cache,A),/simulated read failure/);
  failing.failWrite();
  await assert.rejects(()=>merge(failing.cache,A,0,{[aKey]:entry(100)}),/simulated write failure/);
  assert.equal(failing.data[RESULT_KEY],undefined);
  await merge(failing.cache,A,0,{[aKey]:entry(101)});
  failing.failWrite();
  await assert.rejects(()=>failing.cache.dispatch({type:'results:clear',scope:A}),/simulated write failure/);
  assert.equal((await get(failing.cache,A)).epoch,0,'failed clear cannot advertise a new epoch');
  assert.equal(failing.data[RESULT_KEY][aKey].checkedAt,101);
  await failing.cache.dispatch({type:'results:clear',scope:A});
  assert.equal((await get(failing.cache,A)).epoch,1);
  console.log('RESULT_CACHE_REGRESSION_PASS: concurrent scoped deltas, newest result wins, clear epochs, restart, legacy cache, corrupt input, 2000 bound, storage failure recovery');
})().catch(error=>{console.error(error);process.exitCode=1;});
