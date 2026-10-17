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
    print('LAUNCHING_ISOLATED_THORIUM',str(BROWSER),flush=True)
    proc=subprocess.Popen(cmd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    end=time.monotonic()+15
    while time.monotonic()<end:
        if proc.poll() is not None:raise RuntimeError('Browser exited '+str(proc.returncode))
        try:
            targets=requests.get(f'http://127.0.0.1:{port}/json',timeout=.7).json()
            pages=[x for x in targets if x.get('type')=='page']
            if pages:break
        except Exception:pass
        time.sleep(.35)
    else:raise TimeoutError('NO_CDP_PAGE')
    ws=websocket.create_connection(pages[0]['webSocketDebuggerUrl'],origin='http://localhost',timeout=5)
    cdp('Page.enable')
    cdp('Runtime.enable')
    cdp('Fetch.enable',{'patterns':[{'urlPattern':'https://aws.sb/*','resourceType':'Document','requestStage':'Request'}]})
    cdp('Page.navigate',{'url':'https://aws.sb/#/ec2-instances?sgt=synthetic-scope-A-123'})
    result=poll('extension panel injection',lambda:ev("document.getElementById('wallcheck-panel')?.textContent || ''"))
    print('PANEL_PRESENT',repr(result[:150]),flush=True)
    if '1.8.3' not in result:raise AssertionError('WRONG_EXTENSION_PANEL')
    text=poll('first 2 IP scanned',lambda:ev("document.getElementById('wallcheck-status')?.textContent?.includes('本机探针') && document.getElementById('wallcheck-count')?.textContent || ''"),seconds=18)
    print('FIRST_SCAN',repr(text),flush=True)
    def update(ip):
        ev("document.getElementById('ip1').textContent='IP "+ip+"'")
    update('127.0.0.3')
    ev("void 0")
    poll('A->B alert',lambda:ev("document.querySelector('#wallcheck-alert-center')?.textContent?.includes('127.0.0.1 → 127.0.0.3') || false"))
    print('A_TO_B_ALERT_OK',flush=True)
    update('127.0.0.4')
    poll('B->C alert',lambda:ev("document.querySelector('#wallcheck-alert-center')?.textContent?.includes('127.0.0.3 → 127.0.0.4') || false"))
    details=ev("document.getElementById('wallcheck-alert-center')?.textContent || ''")
    if '#1 示例组一' not in details:raise AssertionError('INSTANCE_LABEL_MISSING: '+details[:400])
    print('A_B_C_HISTORY_OK',repr(details[:400]),flush=True)
    ev("document.querySelector('#card1 .head').textContent='#1 我的服务器 29天 剩余25天'")
    poll('custom label refresh',lambda:ev("[...document.querySelectorAll('.wc-alert-title')].some(x=>x.textContent.includes('#1 我的服务器') && x.textContent.includes('IP变化'))"))
    print('CUSTOM_LABEL_OK',flush=True)
    ev("[...document.querySelectorAll('.wc-alert-entry')].find(x=>x.querySelector('.wc-alert-title')?.textContent.includes('IP变化'))?.querySelector('.wc-ack-button')?.click()")
    poll('acknowledge clears IP change history',lambda:ev("!document.getElementById('wallcheck-alert-center')?.textContent?.includes('127.0.0.1 → 127.0.0.3')"))
    print('ACK_BUTTON_OK',flush=True)
    print('A_SCOPE_ACK_OK',flush=True)
    wsA=ws
    # Open a second browser tab with a DIFFERENT sgt but identical ordinal #1.
    second=cdp('Target.createTarget',{'url':'about:blank'})['targetId']
    target=poll('B browser tab target',lambda:next((x for x in
        requests.get(f'http://127.0.0.1:{port}/json',timeout=1).json()
        if x.get('id')==second and x.get('webSocketDebuggerUrl')),None))
    wsB=websocket.create_connection(target['webSocketDebuggerUrl'],
        origin='http://localhost',timeout=5)
    ws=wsB
    cdp('Page.enable')
    cdp('Runtime.enable')
    cdp('Fetch.enable',{'patterns':[{'urlPattern':'https://aws.sb/*',
      'resourceType':'Document','requestStage':'Request'}]})
    cdp('Page.navigate',{'url':'https://aws.sb/#/ec2-instances?sgt=synthetic-scope-B-789'})
    poll('second scope scanning',lambda:ev(
      "document.getElementById('wallcheck-status')?.textContent?.includes('本机探针')"))
    assert ev("document.querySelectorAll('.wallcheck-change-badge').length")==0, \
        'NEW_SGT_OLD_IP_FALSE_ALERT'
    print('TWO_SGT_ISOLATION_OK',flush=True)
    ev("document.getElementById('ip1').textContent='IP 127.0.0.5'")
    poll('second scope B A->B',lambda:ev(
      "document.getElementById('wallcheck-alert-center')?.textContent?.includes('127.0.0.1 → 127.0.0.5')"))
    ws=wsA
    # No B change event may appear in A's notification panel.
    assert not ev("document.getElementById('wallcheck-alert-center')?.textContent?.includes('127.0.0.1 → 127.0.0.5')"), \
      'B_SCOPE_EVENT_LEAKED_TO_A'
    ws=wsB
    print('CROSS_TAB_SCOPED_ALERTS_OK',flush=True)
    # Clear B records explicitly. It re-baselines B, not A, and does not
    # resurrect untrusted global 1.7.1 IP-change history.
    ev("document.getElementById('wallcheck-clear').click()")
    poll('clear B scope change history',lambda:ev(
      "document.querySelectorAll('.wallcheck-change-badge').length===0 && "
      "!document.getElementById('wallcheck-alert-center')?.textContent?.includes('127.0.0.1 → 127.0.0.5')"))
    print('CLEAR_B_SCOPE_OK',flush=True)
    ws=wsA
    assert not ev("document.getElementById('wallcheck-alert-center')?.textContent?.includes('127.0.0.1 → 127.0.0.5')")
    print('CLEAR_B_DID_NOT_TOUCH_A',flush=True)
    # A third tab on sgt A may load a stale initial A address after A->B->C.
    # It must not reverse the accepted A state back to old A.
    third=cdp('Target.createTarget',{'url':'about:blank'})['targetId']
    targetC=poll('C browser tab target',lambda:next((x for x in
        requests.get(f'http://127.0.0.1:{port}/json',timeout=1).json()
        if x.get('id')==third and x.get('webSocketDebuggerUrl')),None))
    wsC=websocket.create_connection(targetC['webSocketDebuggerUrl'],
        origin='http://localhost',timeout=5)
    ws=wsC
    cdp('Page.enable')
    cdp('Runtime.enable')
    cdp('Fetch.enable',{'patterns':[{'urlPattern':'https://aws.sb/*',
      'resourceType':'Document','requestStage':'Request'}]})
    cdp('Page.navigate',{'url':'https://aws.sb/#/ec2-instances?sgt=synthetic-scope-A-123'})
    poll('same-sgt stale tab scan',lambda:ev(
      "document.getElementById('wallcheck-status')?.textContent?.includes('本机探针')"))
    assert not ev("document.querySelector('.wallcheck-change-badge')?.textContent?.includes('127.0.0.4 → 127.0.0.1')"),'FALSE_REVERSE_AFTER_SAME_SGT_STALE_OPEN'
    print('SAME_SGT_STALE_TAB_GUARD_OK',flush=True)
    ws=wsA
    ev("document.getElementById('ip1').textContent='IP 127.0.0.6'")
    poll('A new change',lambda:ev(
      "document.getElementById('wallcheck-alert-center')?.textContent?.includes('127.0.0.4 → 127.0.0.6')"))
    ws=wsC
    poll('same-sgt alert broadcast to C',lambda:ev(
      "document.getElementById('wallcheck-alert-center')?.textContent?.includes('127.0.0.4 → 127.0.0.6')"))
    ev("[...document.querySelectorAll('.wc-alert-entry')].find(x=>x.textContent.includes('127.0.0.4 → 127.0.0.6'))?.querySelector('.wc-ack-button')?.click()")
    poll('C acknowledgement removed change',lambda:ev(
      "!document.getElementById('wallcheck-alert-center')?.textContent?.includes('127.0.0.4 → 127.0.0.6')"))
    ws=wsA
    poll('C acknowledgement broadcast to A',lambda:ev(
      "!document.getElementById('wallcheck-alert-center')?.textContent?.includes('127.0.0.4 → 127.0.0.6')"))
    print('CROSS_TAB_ACK_BROADCAST_OK',flush=True)
    print('THORIUM_E2E_PASS',flush=True)
except Exception as e:
    print('THORIUM_E2E_FAIL',repr(e),flush=True)
    if ws:
        for label,expr in [
          ('PAGE_STATUS',"JSON.stringify({ip1:document.getElementById('ip1')?.outerHTML,card:document.getElementById('card1')?.innerText,status:document.getElementById('wallcheck-status')?.textContent,count:document.getElementById('wallcheck-count')?.textContent,alert:document.getElementById('wallcheck-alert-center')?.textContent})"),
          ('BODY_SAMPLE',"document.body.innerText.slice(-750)"),
        ]:
            try:print(label,repr(ev(expr)),flush=True)
            except Exception as details:print('DEBUG_ERROR',repr(details),flush=True)
    sys.exit(2)
finally:
    for conn in (ws,wsA,wsB,wsC):
        try:
            if conn: conn.close()
        except Exception:pass
    if proc:
        try:proc.terminate();proc.wait(timeout=7)
        except Exception:
            try:proc.kill()
            except Exception:pass
    try:shutil.rmtree(PROFILE,ignore_errors=True)
    except Exception:pass
