import base64, json, os, pathlib, shutil, socket, subprocess, sys, tempfile, time
import requests, websocket
sys.stdout.reconfigure(encoding='utf-8',errors='backslashreplace')

REPO=pathlib.Path(__file__).resolve().parent.parent
BROWSER=pathlib.Path(os.environ.get('WALLCHECK_THORIUM_BIN', 'LOCAL_PATH'))
PROFILE=pathlib.Path(tempfile.mkdtemp(prefix='wallcheck-smoke-'))
EXT=REPO/'browser-extension'
assert BROWSER.is_file() and (EXT/'manifest.json').is_file()
port_socket=socket.socket()
port_socket.bind(('127.0.0.1',0))
port=port_socket.getsockname()[1]
port_socket.close()
cmd=[str(BROWSER),'--headless=new','--no-first-run','--no-default-browser-check',
     '--disable-background-networking','--disable-sync',
     '--remote-debugging-address=127.0.0.1',
     '--remote-debugging-port='+str(port),
     '--remote-allow-origins=http://localhost',
     '--user-data-dir='+str(PROFILE),
     '--disable-extensions-except='+str(EXT),
     '--load-extension='+str(EXT),'about:blank']
proc=None
ws=None
wsA=None
wsB=None
wsC=None
seq=0
events=[]
FAKE_HTML='''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>WallCheck isolated synthetic EC2 page</title>
<style>body{font:16px Arial;margin:30px}.card{padding:22px;border:1px solid gray;margin:12px;display:inline-block;vertical-align:top}</style>
<body>
<div class="card" id="card1"><div class="head">#1 ✎ 示例组一 29天 剩余25天</div>
<div id="ip1">IP 127.0.0.1</div><div>IPv6 2001:db8:123::2</div></div>
<div class="card" id="card2"><div class="head">#2 🔗 示例账号二 24小时 剩余25天</div>
<div id="ip2">IP 127.0.0.2</div><div>IPv6 2001:db8:123::3</div></div>
</body></html>'''
fake=base64.b64encode(FAKE_HTML.encode('utf-8')).decode('ascii')

def reply_paused(params):
    global seq
    seq+=1
    cmd={'id':seq,'method':'Fetch.fulfillRequest','params':{
        'requestId':params['requestId'],
        'responseCode':200,
        'responseHeaders':[{'name':'content-type','value':'text/html; charset=utf-8'}],
        'body':fake
    }}
    ws.send(json.dumps(cmd))

def cdp(method,params=None,wait=12):
    global seq
    seq+=1
    current=seq
    ws.send(json.dumps({'id':current,'method':method,'params':params or {}}))
    end=time.monotonic()+wait
    while time.monotonic()<end:
        ws.settimeout(max(0.1,end-time.monotonic()))
        try:raw=json.loads(ws.recv())
        except websocket.WebSocketTimeoutException:continue
        if raw.get('method')=='Fetch.requestPaused':
            reply_paused(raw['params'])
        if raw.get('method')=='Page.javascriptDialogOpening':
            seq+=1
            ws.send(json.dumps({'id':seq,'method':'Page.handleJavaScriptDialog','params':{'accept':True}}))
        if 'method' in raw:
            events.append(raw['method'])
        if raw.get('id')==current:
            if 'error' in raw:raise RuntimeError('CDP '+method+' '+str(raw['error']))
            return raw.get('result',{})
    raise TimeoutError('CDP timeout '+method)

def ev(script):
    data=cdp('Runtime.evaluate',{
      'expression':script,'returnByValue':True,'awaitPromise':True
    },wait=15)
    if 'exceptionDetails' in data:raise RuntimeError(str(data['exceptionDetails']))
    return data.get('result',{}).get('value')

def poll(label,test,seconds=35):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        try:
            value=test()
            if value:return value
        except Exception:pass
        time.sleep(.55)
    raise AssertionError('TIMEOUT: '+label)

try:
    print('LAUNCHING_MANUAL_MONITOR_ISOLATED_THORIUM',flush=True)
    proc=subprocess.Popen(cmd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    end=time.monotonic()+20
    while time.monotonic()<end:
        if proc.poll() is not None:raise RuntimeError('Browser exited '+str(proc.returncode))
        try:
            all_targets=requests.get(f'http://127.0.0.1:{port}/json',timeout=.8).json()
            pages=[x for x in all_targets if x.get('type')=='page']
            if pages:break
        except Exception:pass
        time.sleep(.35)
    else:raise TimeoutError('No initial browser page')
    aws_target=pages[0]['id']
    ws=websocket.create_connection(pages[0]['webSocketDebuggerUrl'],
        origin='http://localhost',timeout=5)
    cdp('Page.enable')
    cdp('Runtime.enable')
    cdp('Fetch.enable',{'patterns':[{'urlPattern':'https://aws.sb/*',
      'resourceType':'Document','requestStage':'Request'}]})
    cdp('Page.navigate',{'url':'https://aws.sb/#/ec2-instances?sgt=synthetic-manual-smoke'})
    poll('WallCheck 1.9.9 panel',lambda:ev(
      "document.getElementById('wallcheck-panel')?.textContent?.includes('1.9.9')"))
    ev("document.getElementById('wallcheck-manual-open').click()")
    page=poll('manual monitor option tab',lambda:next((x for x in
      requests.get(f'http://127.0.0.1:{port}/json',timeout=1).json()
      if x.get('type')=='page' and 'manual-monitor.html' in x.get('url','')
      and x.get('webSocketDebuggerUrl')),None))
    wsA=ws
    wsM=websocket.create_connection(page['webSocketDebuggerUrl'],
      origin='http://localhost',timeout=5)
    ws=wsM
    cdp('Page.enable')
    cdp('Runtime.enable')
    poll('manual manager form',lambda:ev("!!document.querySelector('#target-form')"))
    assert ev("document.querySelector('h1')?.textContent?.includes('手动 IPv4 监控')")
    poll('initial empty list loaded',lambda:ev("document.querySelector('#summary')?.textContent?.includes('保存 0 个')"))
    ev("""document.getElementById('ip').value='127.0.0.1';
      document.getElementById('label').value='我的测试 IP';
      document.getElementById('mode').value='ping';
      document.getElementById('interval').value='1';
      document.getElementById('target-form').requestSubmit()""")
    poll('manual target added',lambda:ev(
      "document.querySelector('.target .ip')?.textContent?.includes('127.0.0.1')"))
    poll('manual target probed',lambda:ev(
      "document.querySelector('.target .status')?.textContent==='检测可达'"),seconds=25)
    print('MANUAL_ADD_FIRST_PING_OK',flush=True)
    ev("""[...document.querySelectorAll('.target button')].find(x=>x.textContent==='编辑 IP').click()""")
    ev("""document.getElementById('ip').value='127.0.0.2';
      document.getElementById('mode').value='tcp22';
      document.getElementById('target-form').requestSubmit()""")
    poll('edited address current',lambda:ev(
      "document.querySelector('.target .ip')?.textContent?.includes('127.0.0.2')"))
    poll('manual change history',lambda:ev(
      "document.querySelector('.target details summary')?.textContent?.includes('1 条')"))
    print('MANUAL_EDIT_IP_AND_HISTORY_OK',flush=True)
    # Switch back to known loopback with newly selected status mode.
    ev("""[...document.querySelectorAll('.target button')].find(x=>x.textContent==='编辑 IP').click()""")
    ev("""document.getElementById('ip').value='127.0.0.1';
      document.getElementById('mode').value='ping';
      document.getElementById('target-form').requestSubmit()""")
    poll('restored manual target',lambda:ev(
      "document.querySelector('.target .ip')?.textContent?.includes('127.0.0.1')"))
    poll('manual restored monitored',lambda:ev(
      "document.querySelector('.target .status')?.textContent==='检测可达'"))
    assert '2 条' in ev("document.querySelector('.target details summary')?.textContent")
    print('MANUAL_A_B_A_HISTORY_OK',flush=True)
    ev("""[...document.querySelectorAll('.target button')].find(x=>
      x.textContent.includes('已知')).click()""")
    poll('manual group acknowledge',lambda:ev(
      "document.querySelector('.target details')===null"))
    assert ev("document.querySelector('.target .ip')?.textContent?.includes('127.0.0.1')")
    print('MANUAL_ACK_PRESERVES_TARGET_OK',flush=True)
    # UI regression: only a disposable browser profile; inject a synthetic
    # stored failure state without probing another person's public IP.
    ev("""new Promise(ok=>chrome.storage.local.get('wallcheck_manual_ipv4_v1',d=>{
       const root=d.wallcheck_manual_ipv4_v1,t=root.items[0];
       const first=Date.now()-120000;
       t.state='DOWN';t.lastStable='DOWN';t.downSince=first;
       t.lastCheckedAt=Date.now();
       t.events=[{id:'test-first-down',kind:'DOWN',ip:t.ip,
         mode:t.mode,time:first}];
       chrome.storage.local.set({'wallcheck_manual_ipv4_v1':root},()=>ok(true));
    }))""")
    poll('red first-detected time visible',lambda:ev("""(()=>{
       const el=document.querySelector('.target .outage-time');
       return !!el && el.textContent.includes('首次检测未确认可达：') &&
         getComputedStyle(el).color==='rgb(180, 35, 24)' &&
         /\\d{4}\\/\\d{1,2}\\/\\d{1,2}/.test(el.textContent);
    })()"""))
    first_text=ev("document.querySelector('.target .outage-time').textContent")
    print('MANUAL_RED_DOWN_TIME='+first_text,flush=True)
    ev("""[...document.querySelectorAll('.target button')].find(x=>
      x.textContent.includes('已知')).click()""")
    poll('ack leaves red active outage time',lambda:ev("""(()=>{
       const el=document.querySelector('.target .outage-time');
       return !!el && el.textContent.includes('首次检测未确认可达：') &&
         !document.querySelector('.target details');
    })()"""))
    print('MANUAL_ACK_ACTIVE_OUTAGE_TIMESTAMP_PRESERVED',flush=True)
    ev("""new Promise(ok=>chrome.storage.local.get('wallcheck_manual_ipv4_v1',d=>{
       const root=d.wallcheck_manual_ipv4_v1,t=root.items[0],from=t.downSince;
       t.state='UP';t.lastStable='UP';t.lastOutageSince=from;
       t.downSince=0;t.recoveredAt=Date.now();t.lastCheckedAt=t.recoveredAt;
       t.events=[{id:'test-recovered',kind:'RECOVERED',ip:t.ip,
         mode:t.mode,time:t.recoveredAt}];
       chrome.storage.local.set({'wallcheck_manual_ipv4_v1':root},()=>ok(true));
    }))""")
    poll('green recovery timestamp visible',lambda:ev("""(()=>{
       const el=document.querySelector('.target .recovery-time');
       return !!el && el.textContent.includes('已恢复可达：') &&
         getComputedStyle(el).color==='rgb(22, 101, 52)' &&
         !!document.querySelector('.target .resolved-outage-time') &&
         !document.querySelector('.target .outage-time');
    })()"""))
    ev("""[...document.querySelectorAll('.target button')].find(x=>
      x.textContent.includes('已知')).click()""")
    poll('ack hides recovered history banner',lambda:ev(
      "document.querySelector('.target .recovery-time')===null"))
    print('MANUAL_GREEN_RECOVERY_AND_ACK_PASS',flush=True)
    # Close the aws.sb tab; manual targets must continue independently.
    cdp('Target.closeTarget',{'targetId':aws_target})
    print('AWS_TAB_CLOSED',flush=True)
    # Force an actually-alarm-delivered probe of due targets from the extension
    # options page: only disposable test profile storage is affected.
    last=ev("""new Promise(ok=>chrome.storage.local.get('wallcheck_manual_ipv4_v1',
      d=>ok(d.wallcheck_manual_ipv4_v1.items[0].lastCheckedAt)))""")
    ev("""new Promise(ok=>chrome.storage.local.get('wallcheck_manual_ipv4_v1',d=>{
       const item=d.wallcheck_manual_ipv4_v1.items[0];
       item.lastCheckedAt=0;
       chrome.storage.local.set({'wallcheck_manual_ipv4_v1':d.wallcheck_manual_ipv4_v1},
         ()=>chrome.alarms.create('wallcheck-manual-ip-1m',
           {when:Date.now()+1300,periodInMinutes:1}).then(()=>ok(true)));
    }))""")
    # Close the manager too: only an empty browser tab remains.
    manager_url=page['url']
    blank_id=cdp('Target.createTarget',{'url':'about:blank'})['targetId']
    blank=poll('empty browser tab',lambda:next((x for x in
      requests.get(f'http://127.0.0.1:{port}/json',timeout=1).json()
      if x.get('id')==blank_id and x.get('webSocketDebuggerUrl')),None))
    wsB=websocket.create_connection(blank['webSocketDebuggerUrl'],
      origin='http://localhost',timeout=5)
    cdp('Target.closeTarget',{'targetId':page['id']})
    ws=wsB
    cdp('Page.enable');cdp('Runtime.enable')
    print('MANAGER_CLOSED_BACKGROUND_ONLY',flush=True)
    time.sleep(5)
    open_id=cdp('Target.createTarget',{'url':manager_url})['targetId']
    reopened=poll('reopened manual manager',lambda:next((x for x in
      requests.get(f'http://127.0.0.1:{port}/json',timeout=1).json()
      if x.get('id')==open_id and x.get('webSocketDebuggerUrl')),None))
    wsC=websocket.create_connection(reopened['webSocketDebuggerUrl'],
      origin='http://localhost',timeout=5)
    ws=wsC
    cdp('Page.enable');cdp('Runtime.enable')
    poll('alarm scans with no active extension or aws page',lambda:ev("""new Promise(ok=>
      chrome.storage.local.get('wallcheck_manual_ipv4_v1',d=>{
        const t=d.wallcheck_manual_ipv4_v1.items[0];ok(t.lastCheckedAt>0 &&
          t.ip==='127.0.0.1' && t.state==='UP')
      }))"""),seconds=30)
    print('MANUAL_BACKGROUND_ALARM_NO_AWS_OR_MANAGER_TAB_PASS',flush=True)
    poll('target rendered after reopening manager',lambda:ev(
      "[...document.querySelectorAll('.target button')].some(x=>x.textContent==='删除')"))
    ev("""[...document.querySelectorAll('.target button')].find(x=>x.textContent==='删除').click()""")
    poll('manual target deleted',lambda:ev(
      "document.querySelectorAll('.target').length===0"))
    print('MANUAL_DELETE_OK',flush=True)
    print('MANUAL_BROWSER_E2E_PASS',flush=True)
except Exception as e:
    print('MANUAL_BROWSER_E2E_FAIL',repr(e),flush=True)
    try:print('MANUAL_PAGE_DEBUG',repr(ev("document.body.innerText.slice(0,900)")),flush=True)
    except Exception as debug:print('MANUAL_DEBUG_FAILED',repr(debug),flush=True)
    sys.exit(2)
finally:
    for conn in (ws,wsA,wsB,wsC):
        try:
            if conn:conn.close()
        except Exception:pass
    if proc:
        try:proc.terminate();proc.wait(timeout=7)
        except Exception:
            try:proc.kill()
            except Exception:pass
    try:shutil.rmtree(PROFILE,ignore_errors=True)
    except Exception:pass
