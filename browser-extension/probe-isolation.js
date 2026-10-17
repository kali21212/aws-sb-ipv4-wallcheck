/* WallCheck v1.8.2: per-IP partial result isolation.
 * No network calls outside the injected localhost probe. No account credentials.
 */
(function(root){
  'use strict';
  const isTransportFailure = reason =>
    /Failed to fetch|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|NetworkError|network request failed|connection refused/i.test(String(reason||''));
  const validResult = value => value && typeof value==='object' &&
    (value.icmp && typeof value.icmp==='object' || Array.isArray(value.ports));
  async function probeWithIsolation(ips,ports,sendProbe){
    const targets=[...new Set(ips)];
    const results={};
    const failed=[];
    if(!targets.length)return {results,failed,transportFailure:false,batchError:null};
    let batchError=null;
    try {
      const batch=await sendProbe(targets,ports);
      for(const ip of targets) {
        const result=batch?.results?.[ip];
        if(validResult(result)) results[ip]=result;
      }
    } catch(error){
      batchError=String(error?.message || error);
    }
    const missing=targets.filter(ip=>!Object.prototype.hasOwnProperty.call(results,ip));
    if(batchError && isTransportFailure(batchError)){
      failed.push(...missing.map(ip=>({ip,reason:batchError})));
      return {results,failed,transportFailure:true,batchError};
    }
    let next=0;
    const workers=Array.from({length:Math.min(3,missing.length)},async()=>{
      while(next<missing.length){
        const ip=missing[next++];
        try {
          const response=await sendProbe([ip],ports);
          const value=response?.results?.[ip];
          if(validResult(value)) results[ip]=value;
          else failed.push({ip,reason:'no valid individual result'});
        } catch(error){
          failed.push({ip,reason:String(error?.message || error)});
        }
      }
    });
    await Promise.all(workers);
    return {results,failed,transportFailure:false,batchError};
  }
  root.wallcheckProbeWithIsolation=probeWithIsolation;
  if(typeof module==='object' && module.exports)
    module.exports={probeWithIsolation,isTransportFailure,validResult};
})(typeof globalThis==='object'?globalThis:this);
