const assert=require('node:assert/strict');
const {probeWithIsolation,classifyProbeFailure,isTransportFailure}=require('../browser-extension/probe-isolation.js');
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
  assert.equal(down.failureCategory,'NETWORK_TRANSPORT');
  assert.match(down.failureReason,/Failed to fetch/);
  const healthy=await probeWithIsolation(['203.0.113.22'],[22],async()=>
    ({results:{'203.0.113.22':good}}));
  assert.equal(healthy.failed.length,0);
  assert.equal(healthy.failureCategory,null);
  assert.equal(healthy.failureReason,null);
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
  const systemicErrors=[
    [Error('AbortError: This operation was aborted'),'PROBE_TIMEOUT'],
    [new DOMException('The operation timed out','TimeoutError'),'PROBE_TIMEOUT'],
    [new DOMException('aborted','AbortError'),'PROBE_TIMEOUT'],
    [Error('Extension context invalidated.'),'EXTENSION_CONTEXT'],
    [Error('The message port closed before a response was received.'),'MESSAGE_CHANNEL'],
    [Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'),'MESSAGE_CHANNEL'],
    [Error('Could not establish connection. Receiving end does not exist.'),'MESSAGE_CHANNEL']
  ];
  for(const [error,category] of systemicErrors){
    let requests=0;
    const outcome=await probeWithIsolation(many,[22],async()=>{requests++;throw error;});
    assert.equal(requests,1,'shared failure must not become one retry per target');
    assert.equal(outcome.failureCategory,category);
    assert.equal(outcome.failureReason,error.message);
    assert.equal(outcome.transportFailure,false,'extension/timeout failures do not prove the agent is offline');
    assert.equal(outcome.failed.length,many.length);
    assert.equal(isTransportFailure(error),false);
  }
  assert.equal(classifyProbeFailure(Error('TCP22 target timed out')),null,
    'ordinary target timeouts must not be mistaken for a global fetch timeout');
  assert.equal(classifyProbeFailure(Error('HTTP 400 malformed target')),null);
  assert.equal(fallback.failureCategory,null,'target isolation survives non-global batch errors');
  // A batch can have good results before an individual retry discovers a
  // shared failure. Keep successes and stop the rest of the retry queue.
  let lateCalls=0;
  const manyWithGood=['192.0.2.99',...many];
  const lateChannel=await probeWithIsolation(manyWithGood,[22],async ips=>{
    lateCalls++;
    if(ips.length>1)return {results:{'192.0.2.99':good}};
    if(ips[0]===many[1])return {results:{[ips[0]]:good}};
    throw Error('The message port closed before a response was received.');
  });
  assert(lateCalls<=4,'only the batch and already-started retry workers may run');
  assert.equal(lateChannel.failureCategory,'MESSAGE_CHANNEL');
  assert.equal(lateChannel.transportFailure,false);
  assert.deepEqual(Object.keys(lateChannel.results).sort(),['192.0.2.99',many[1]].sort());
  assert.equal(new Set(lateChannel.failed.map(x=>x.ip)).size,manyWithGood.length-2);
  assert.equal(lateChannel.failed.length,manyWithGood.length-2);
  assert(lateChannel.failed.every(x=>!lateChannel.results[x.ip]));
  let lateNetworkCalls=0;
  const lateNetwork=await probeWithIsolation(many,[22],async ips=>{
    lateNetworkCalls++;
    if(ips.length>1)return {results:{}};
    throw Error('TypeError: Failed to fetch');
  });
  assert(lateNetworkCalls<=4);
  assert.equal(lateNetwork.failureCategory,'NETWORK_TRANSPORT');
  assert.equal(lateNetwork.transportFailure,true);
  assert.equal(lateNetwork.failed.length,many.length);
  const partialNetwork=await probeWithIsolation(manyWithGood,[22],async ips=>{
    if(ips.length>1)return {results:{'192.0.2.99':good}};
    throw Error('TypeError: Failed to fetch');
  });
  assert.equal(partialNetwork.failureCategory,'NETWORK_TRANSPORT');
  assert.equal(partialNetwork.transportFailure,false,
    'legacy total-failure flag must not hide valid partial probe results');
  assert.deepEqual(Object.keys(partialNetwork.results),['192.0.2.99']);
  assert.equal(partialNetwork.failed.length,many.length);
  assert.equal((await probeWithIsolation([],[22],async()=>{throw Error('should not call')})).failed.length,0);
  console.log('PROBE_ISOLATION_PASS: partial success, target retry, bounded concurrency, shared timeout/context/channel classification, no per-IP retry amplification');
})().catch(e=>{console.error(e);process.exitCode=1});
