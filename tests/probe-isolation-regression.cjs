const assert=require('node:assert/strict');
const {probeWithIsolation}=require('../browser-extension/probe-isolation.js');
const good={icmp:{state:'REACHABLE'},ports:[{port:22,state:'OPEN'}]};
(async()=>{
  let calls=[];
  const partial=await probeWithIsolation(['192.0.2.1','192.0.2.2','192.0.2.3'],[22],async ips=>{
    calls.push(ips);
    if(ips.length>1)return {results:{'192.0.2.1':good,'192.0.2.3':good}};
    throw Error('HTTP 400 malformed target');
  });
  assert.equal(Object.keys(partial.results).length,2);
  assert.equal(partial.failed.length,1);
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1],['192.0.2.2']);
  const malformed=await probeWithIsolation(['192.0.2.4','192.0.2.5'],[22],async ips=>
    ({results:ips.length>1?{'192.0.2.4':good,'192.0.2.5':{error:'invalid target'}}:
      {'192.0.2.5':{error:'still invalid'}}}));
  assert.equal(Object.keys(malformed.results).length,1);
  assert.equal(malformed.failed[0].ip,'192.0.2.5');
  const fallback=await probeWithIsolation(['198.51.100.1','198.51.100.2'],[22],async ips=>{
    if(ips.length>1)throw Error('HTTP 500 batch rejected');
    if(ips[0]==='198.51.100.1')return {results:{'198.51.100.1':good}};
    throw Error('single target rejected');
  });
  assert.equal(Object.keys(fallback.results).length,1);
  assert.equal(fallback.failed.length,1);
  let transportCalls=0;
  const down=await probeWithIsolation(['203.0.113.1','203.0.113.2'],[22],async()=>{
    transportCalls++;throw Error('TypeError: Failed to fetch');
  });
  assert.equal(transportCalls,1);
  assert.equal(down.transportFailure,true);
  const healthy=await probeWithIsolation(['203.0.113.22'],[22],async()=>
    ({results:{'203.0.113.22':good}}));
  assert.equal(healthy.failed.length,0);
  let inflight=0,peak=0;
  const many=['198.18.0.1','198.18.0.2','198.18.0.3','198.18.0.4','198.18.0.5'];
  const bounded=await probeWithIsolation(many,[22],async ips=>{
    if(ips.length>1)return {results:{}};
    inflight++;peak=Math.max(peak,inflight);
    await new Promise(resolve=>setTimeout(resolve,3));
    inflight--;
    return {results:{[ips[0]]:good}};
  });
  assert.equal(Object.keys(bounded.results).length,5);
  assert(peak<=3);
  assert.equal((await probeWithIsolation([],[22],async()=>{throw Error('should not call')})).failed.length,0);
  console.log('PASS 1.8.2 isolation: partial success, malformed response, single-IP retry, transport outage, bounded concurrency');
})().catch(e=>{console.error(e);process.exitCode=1});
