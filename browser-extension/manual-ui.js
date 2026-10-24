/* Manual IPv4 manager UI. Data is stored only by the background worker. */
'use strict';
(() => {
  const $=id=>document.getElementById(id);
  let editingId=null,busy=false;
  const make=(tag,value='',css='')=>{
    const el=document.createElement(tag);
    el.textContent=String(value);if(css)el.className=css;return el;
  };
  function btn(label,fn){
    const b=make('button',label);b.type='button';b.addEventListener('click',fn);return b;
  }
  const time=t=>t?new Date(t).toLocaleString('zh-CN',{hour12:false}):'尚未检测';
  const modeName=m=>({ping:'Ping',tcp22:'TCP 22',either:'Ping + TCP 22（任一失败告警）'}[m]||m);
  const stamp=v=>Number.isFinite(v)&&v>0?v:0;
  function legacyDownSince(t){
    const events=Array.isArray(t.events)?t.events:[];
    for(let i=events.length-1;i>=0;i--){
      const e=events[i];
      if(e.kind==='IP_EDIT'||e.kind==='RECOVERED')break;
      if(e.kind==='DOWN' && e.ip===t.ip && e.mode===t.mode)return stamp(e.time);
    }
    return 0;
  }
  function status(t){
    if(!t.enabled)return ['已暂停','unknown'];
    if(t.lastCheckedAt && Date.now()-t.lastCheckedAt>t.intervalMinutes*60000+125000)
      return ['采集已过期','error'];
    return ({UP:[t.mode==='either'?'两项正常':'检测可达','up'],DOWN:['严重告警：检测失败','down'],ERROR:['探针异常','error'],
      UNKNOWN:['检测不确定','unknown'],PENDING:['等待首次检测','unknown']})[t.state]||
      ['等待首次检测','unknown'];
  }
  function eventText(e){
    if(e.kind==='IP_EDIT')return '手动换 IP：'+e.oldIp+' → '+e.newIp;
    if(e.kind==='DOWN')return '🔴 严重：监控模式所需检测失败';
    if(e.kind==='RECOVERED')return '目标已恢复可达';
    if(e.kind==='PROBE_ERROR')return '本地探针故障：'+(e.details||'');
    return e.kind;
  }
  function request(action,payload={}){
    return new Promise((resolve,reject)=>{
      chrome.runtime.sendMessage({type:'manual:action',action,payload},resp=>{
        const e=chrome.runtime.lastError;
        if(e||!resp?.ok)reject(Error(e?.message||resp?.error||'后台未响应'));
        else resolve(resp.data);
      });
    });
  }
  function notice(msg,failed=false){
    $('notice').textContent=String(msg||'');
    $('notice').style.color=failed?'#b42318':'#176437';
  }
  function reset(){
    editingId=null;$('target-form').reset();$('submit').textContent='添加并立即检测';
    $('cancel-edit').hidden=true;$('add-title').textContent='添加监控 IP';
  }
  async function action(name,payload,message){
    if(busy)return;busy=true;
    try{
      const data=await request(name,payload);
      if(message)notice(message);
      render(data.items);
    }catch(e){notice(e.message||String(e),true);}
    finally{busy=false;}
  }
  function edit(t){
    editingId=t.id;$('ip').value=t.ip;
    $('label').value=t.label===t.ip?'':t.label;
    $('mode').value=t.mode;$('interval').value=String(t.intervalMinutes);
    $('add-title').textContent='编辑 '+t.label;
    $('submit').textContent='保存并重新检测';$('cancel-edit').hidden=false;
    $('ip').focus();
  }
  function render(items){
    const enabled=items.filter(t=>t.enabled).length;
    const pending=items.reduce((sum,t)=>sum+(t.events?.length||0),0);
    $('summary').textContent='保存 '+items.length+' 个 IP · 运行中 '+enabled+
      ' · 待确认记录 '+pending+' 条';
    const list=$('targets');list.replaceChildren();
    if(!items.length){
      list.appendChild(make('div','尚无手动监控目标。填写上方 IPv4 即可开始。','panel empty'));
      return;
    }
    for(const t of items){
      const card=make('article','','target');card.dataset.id=t.id;
      const heading=make('div','','row');const label=make('div');
      label.append(make('div',t.label,'name'),
        make('div',t.ip+' · '+modeName(t.mode)+' · 每 '+t.intervalMinutes+' 分钟','ip'));
      heading.appendChild(label);
      const [name,css]=status(t);heading.appendChild(make('span',name,'status '+css));
      card.appendChild(heading);
      const data=make('div','','detail');
      const latency=ms=>typeof ms==='number'?' ('+ms+' ms)':'';
      data.textContent='Ping：'+(t.result?.ping||'--')+latency(t.result?.pingMs)+
        '　TCP 22：'+(t.result?.tcp||'--')+latency(t.result?.tcpMs)+
        '\n最近检测：'+time(t.lastCheckedAt);
      data.style.whiteSpace='pre-line';card.appendChild(data);
      const firstDown=stamp(t.downSince)||
        (t.lastStable==='DOWN'?legacyDownSince(t):0);
      if(t.enabled && t.state==='DOWN' && css==='down'){
        const line=make('div',firstDown ?
          '● 首次检测未确认可达：'+time(firstDown) :
          '● 本次未确认可达，首次发现时间待记录','outage-time');
        card.appendChild(line);
      } else if(t.enabled && t.state==='UP' && stamp(t.recoveredAt) &&
        t.events?.some(e=>e.kind==='RECOVERED'&&e.time===t.recoveredAt&&e.ip===t.ip)){
        const line=make('div','✓ 已恢复可达：'+time(t.recoveredAt),'recovery-time');
        card.appendChild(line);
        if(stamp(t.lastOutageSince))card.appendChild(
          make('div','上次首次检测不可达：'+time(t.lastOutageSince),'resolved-outage-time'));
      } else if(firstDown && t.lastStable==='DOWN'){
        card.appendChild(make('div','上次检测未确认可达：'+time(firstDown)+
          '（已暂停或待重新验证）','stale-outage-time'));
      }
      const actions=make('div','','actions');
      actions.append(
        btn('立即检测',()=>action('probeNow',{id:t.id},'检测已提交')),
        btn('编辑 IP',()=>edit(t)),
        btn(t.enabled?'暂停':'继续',()=>action('enable',{id:t.id,enabled:!t.enabled},
          t.enabled?'已暂停此 IP':'目标已重新启用')),
        btn('删除',()=>{if(confirm('确定删除 '+t.label+' ('+t.ip+') 及全部监控记录？'))
          action('remove',{id:t.id},'目标已删除');})
      );
      card.appendChild(actions);
      if(t.events?.length){
        const history=make('details');history.appendChild(make('summary',
          '未确认历史 '+t.events.length+' 条（展开）'));
        history.appendChild(btn('已知 · 清除此组',()=>action('ack',{id:t.id},
          '已确认这组记录，最新 IP 继续监控')));
        const rows=make('ul','','history');
        for(const ev of [...t.events].reverse().slice(0,80))
          rows.appendChild(make('li',time(ev.time)+' · '+eventText(ev)));
        if(t.events.length>80)rows.appendChild(make('li',
          '较早 '+(t.events.length-80)+' 条仍保存在扩展存储中'));
        history.appendChild(rows);card.appendChild(history);
      }
      list.appendChild(card);
    }
  }
  $('target-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const payload={
      ip:$('ip').value.trim(),label:$('label').value.trim(),
      mode:$('mode').value,intervalMinutes:Number($('interval').value)
    };
    if(busy)return;busy=true;
    try{
      const data=await request(editingId?'update':'add',
        editingId?{...payload,id:editingId}:payload);
      reset();render(data.items);notice('已保存并对新 IP 发起检测');
    }catch(e){notice(e.message||String(e),true);}
    finally{busy=false;}
  });
  $('cancel-edit').addEventListener('click',reset);
  $('check-all').addEventListener('click',()=>action('probeNow',{},'已完成检测'));
  chrome.storage.onChanged.addListener((updates,where)=>{
    if(where!=='local')return;
    const root=updates.wallcheck_manual_ipv4_v1?.newValue;
    if(root?.version===1&&Array.isArray(root.items))render(root.items);
  });
  request('get').then(result=>render(result.items))
    .catch(e=>notice('无法连接后台：'+e.message,true));
})();
