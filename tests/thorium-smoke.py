import base64, json, os, pathlib, shutil, socket, subprocess, sys, tempfile, time
import requests, websocket
sys.stdout.reconfigure(encoding='utf-8',errors='backslashreplace')

REPO=pathlib.Path(__file__).resolve().parent.parent
BROWSER=pathlib.Path(os.environ.get('WALLCHECK_THORIUM_BIN', 'E:/2浏览器/thorium浏览器新版/BIN/thorium.exe'))
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
seq=0
events=[]
FAKE_HTML='''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>WallCheck isolated synthetic EC2 page</title>
<style>body{font:16px Arial;margin:30px}.card{padding:22px;border:1px solid gray;margin:12px;display:inline-block;vertical-align:top}</style>
<body>
<div class="card" id="card1"><div class="head">#1 ✎ 待定组 29天 剩余25天</div>
<div id="ip1">IP 127.0.0.1</div></div>
<div class="card" id="card2"><div class="head">#2 🔗 老用户 24小时 剩余25天</div>
<div id="ip2">IP 127.0.0.2</div></div>
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

def poll(label,test,seconds=16):
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
    cdp('Page.navigate',{'url':'https://aws.sb/#/ec2-instances'})
    result=poll('extension panel injection',lambda:ev("document.getElementById('wallcheck-panel')?.textContent || ''"))
    print('PANEL_PRESENT',repr(result[:150]),flush=True)
    if '1.7.1' not in result:raise AssertionError('WRONG_EXTENSION_PANEL')
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
    if '#1 待定组' not in details:raise AssertionError('INSTANCE_LABEL_MISSING: '+details[:400])
    print('A_B_C_HISTORY_OK',repr(details[:400]),flush=True)
    ev("document.querySelector('#card1 .head').textContent='#1 我的服务器 29天 剩余25天'")
    poll('custom label refresh',lambda:ev("[...document.querySelectorAll('.wc-alert-title')].some(x=>x.textContent.includes('#1 我的服务器') && x.textContent.includes('IP变化'))"))
    print('CUSTOM_LABEL_OK',flush=True)
    ev("[...document.querySelectorAll('.wc-alert-entry')].find(x=>x.querySelector('.wc-alert-title')?.textContent.includes('IP变化'))?.querySelector('.wc-ack-button')?.click()")
    poll('acknowledge clears IP change history',lambda:ev("!document.getElementById('wallcheck-alert-center')?.textContent?.includes('127.0.0.1 → 127.0.0.3')"))
    print('ACK_BUTTON_OK',flush=True)
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
    try:
        if ws: ws.close()
    except Exception:pass
    if proc:
        try:proc.terminate();proc.wait(timeout=7)
        except Exception:
            try:proc.kill()
            except Exception:pass
    try:shutil.rmtree(PROFILE,ignore_errors=True)
    except Exception:pass
