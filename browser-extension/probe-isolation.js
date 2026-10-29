/* WallCheck v1.8.2: per-IP partial result isolation.
 * No network calls outside the injected localhost probe. No account credentials.
 */
(function(root){
  'use strict';
  function classifyProbeFailure(error){
    const reason=String(error?.message || error || '');
    const detail=String(error?.name || '')+' '+reason;
    if(/Extension context invalidated/i.test(detail))return 'EXTENSION_CONTEXT';
    if(/message (?:port|channel) closed|extension port was disconnected|Receiving end does not exist|Could not establish connection/i.test(detail))
      return 'MESSAGE_CHANNEL';
    if(/\bAbortError\b|\bTimeoutError\b|operation was aborted|user aborted a request|signal is aborted/i.test(detail))
      return 'PROBE_TIMEOUT';
    if(/Failed to fetch|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|NetworkError|network request failed|connection refused/i.test(detail))
      return 'NETWORK_TRANSPORT';
    return null;
  }
  const isTransportFailure = reason => classifyProbeFailure(reason)==='NETWORK_TRANSPORT';
  const validResult = value => value && typeof value==='object' &&
    (value.icmp && typeof value.icmp==='object' || Array.isArray(value.ports));
  async function probeWithIsolation(ips,ports,sendProbe){
    const targets=[...new Set(ips)];
    const results={};
    const failed=[];
    if(!targets.length)return {results,failed,transportFailure:false,batchError:null,
      failureCategory:null,failureReason:null};
    let batchError=null;
    let failureCategory=null;
    let failureReason=null;
    try {
      const batch=await sendProbe(targets,ports);
      for(const ip of targets) {
        const result=batch?.results?.[ip];
        if(validResult(result)) results[ip]=result;
      }
    } catch(error){
      batchError=String(error?.message || error);
      failureCategory=classifyProbeFailure(error);
      if(failureCategory)failureReason=batchError;
    }
    const missing=targets.filter(ip=>!Object.prototype.hasOwnProperty.call(results,ip));
    // A dead extension channel or timed-out localhost request affects every
    // target. Repeating it per IP cannot isolate a target-specific failure.
    // Only a network transport failure keeps the legacy offline flag true.
    if(failureCategory){
      failed.push(...missing.map(ip=>({ip,reason:batchError})));
      return {results,failed,transportFailure:failureCategory==='NETWORK_TRANSPORT',
        batchError,failureCategory,failureReason};
    }
    let next=0;
    const workers=Array.from({length:Math.min(3,missing.length)},async()=>{
      while(next<missing.length && !failureCategory){
        const ip=missing[next++];
        try {
          const response=await sendProbe([ip],ports);
          const value=response?.results?.[ip];
          if(validResult(value)) results[ip]=value;
          else failed.push({ip,reason:'no valid individual result'});
        } catch(error){
          const reason=String(error?.message || error);
          failed.push({ip,reason});
          const category=classifyProbeFailure(error);
          if(category && !failureCategory){
            failureCategory=category;
            failureReason=reason;
          }
        }
      }
    });
    await Promise.all(workers);
    // Up to three retries may already be in flight. Preserve their successes,
    // but do not enqueue the remaining targets after a shared channel failure.
    if(failureCategory)failed.push(...missing.slice(next).map(ip=>({ip,reason:failureReason})));
    // Legacy callers use transportFailure as a total-round failure gate.
    // A channel loss during retries must not discard already verified results.
    return {results,failed,transportFailure:failureCategory==='NETWORK_TRANSPORT' && !Object.keys(results).length,
      batchError,failureCategory,failureReason};
  }
  root.wallcheckProbeWithIsolation=probeWithIsolation;
  if(typeof module==='object' && module.exports)
    module.exports={probeWithIsolation,isTransportFailure,validResult,classifyProbeFailure};
})(typeof globalThis==='object'?globalThis:this);
