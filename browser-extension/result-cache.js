/* Single background writer for last-valid results shared by aws.sb tabs.
 * Keep the existing flat cache format; scope epochs invalidate probes that
 * started before a user cleared that scope. This store owns no alert history.
 */
(function(host) {
  'use strict';
  const RESULT_KEY='wallcheck_last_valid_results_v3';
  const EPOCH_KEY='wallcheck_result_scope_epochs_v1';
  const MAX_RESULTS=2000;
  const validScope=x=>typeof x==='string' && /^sgt:[a-f0-9]{64}$/.test(x);
  const object=x=>!!x && typeof x==='object' && !Array.isArray(x);
  const validEpoch=x=>Number.isSafeInteger(x) && x>=0;
  function validResultKey(key) {
    if(typeof key!=='string')return false;
    const match=/^(sgt:[a-f0-9]{64})\|((?:\d{1,3}\.){3}\d{1,3})::22$/.exec(key);
    return !!match && match[2].split('.').every(part=>
      /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part)<=255);
  }
  function copyEntry(entry) {
    if(!object(entry) || !Number.isFinite(entry.checkedAt) || entry.checkedAt<0 ||
       !object(entry.value) || typeof entry.value.key!=='string' ||
       !entry.value.key || typeof entry.value.text!=='string')return null;
    return {value:{key:entry.value.key,text:entry.value.text},checkedAt:entry.checkedAt};
  }
  function storedEntries(raw) {
    const entries={};
    for(const [key,entry] of Object.entries(object(raw)?raw:{})){
      const clean=copyEntry(entry);
      if(validResultKey(key) && clean)entries[key]=clean;
    }
    return entries;
  }
  function storedEpochs(raw) {
    return Object.fromEntries(Object.entries(object(raw)?raw:{})
      .filter(([scope,epoch])=>validScope(scope) && validEpoch(epoch)));
  }
  function bounded(entries) {
    return Object.fromEntries(Object.entries(entries)
      .sort((a,b)=>b[1].checkedAt-a[1].checkedAt || a[0].localeCompare(b[0]))
      .slice(0,MAX_RESULTS));
  }
  function createWallCheckResultCache({read,write}) {
    let queue=Promise.resolve();
    async function dispatch(message) {
      const action=message?.type;
      if(!['results:get','results:merge','results:clear'].includes(action))
        throw Error('Unsupported result cache action');
      const scope=message.scope;
      if(!validScope(scope))throw Error('Missing or invalid isolated page scope');
      const prefix=scope+'|';
      const requestedEpoch=message.epoch;
      const delta={};
      if(action==='results:merge'){
        if(!validEpoch(requestedEpoch))throw Error('Invalid result cache epoch');
        if(!object(message.entries))throw Error('Invalid result cache entries');
        // Capture and validate the entire delta before queuing or writing it.
        // A caller cannot overwrite another scope or add a non-TCP22 key.
        for(const [key,entry] of Object.entries(message.entries)){
          const clean=copyEntry(entry);
          if(!validResultKey(key) || !key.startsWith(prefix) || !clean)
            throw Error('Invalid scoped result cache entry');
          delta[key]=clean;
        }
      }
      const operation=queue.catch(()=>{}).then(async()=>{
        // Read fresh state INSIDE the single writer queue: concurrent tabs
        // submit deltas, never competing whole-cache snapshots.
        const stored=await read([RESULT_KEY,EPOCH_KEY]);
        const entries=storedEntries(stored?.[RESULT_KEY]);
        const epochs=storedEpochs(stored?.[EPOCH_KEY]);
        const epoch=epochs[scope]??0;
        if(action==='results:get')return {
          entries:Object.fromEntries(Object.entries(entries)
            .filter(([key])=>key.startsWith(prefix))),epoch
        };
        if(action==='results:clear'){
          if(epoch===Number.MAX_SAFE_INTEGER)throw Error('Result cache epoch exhausted');
          for(const key of Object.keys(entries))if(key.startsWith(prefix))delete entries[key];
          epochs[scope]=epoch+1;
          // Store the clear and its invalidation together. Old in-flight
          // merges must never repopulate data the user has just cleared.
          await write({[RESULT_KEY]:bounded(entries),[EPOCH_KEY]:epochs});
          return {applied:true,epoch:epoch+1};
        }
        if(requestedEpoch!==epoch)return {applied:false,epoch};
        let changed=false;
        for(const [key,entry] of Object.entries(delta)){
          const prior=entries[key];
          if(prior && prior.checkedAt>entry.checkedAt)continue;
          if(prior && prior.checkedAt===entry.checkedAt &&
             prior.value.key===entry.value.key && prior.value.text===entry.value.text)continue;
          entries[key]=entry;
          changed=true;
        }
        if(changed)await write({[RESULT_KEY]:bounded(entries)});
        return {applied:true,epoch};
      });
      // A storage failure rejects its caller but does not poison later work.
      queue=operation.then(()=>{},()=>{});
      return operation;
    }
    return {dispatch,key:RESULT_KEY,epochKey:EPOCH_KEY};
  }
  host.createWallCheckResultCache=createWallCheckResultCache;
  if(typeof module==='object' && module.exports)
    module.exports={createWallCheckResultCache,RESULT_KEY,EPOCH_KEY};
})(typeof globalThis==='object'?globalThis:this);
