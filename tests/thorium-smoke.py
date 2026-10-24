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
wsA=None
wsB=None
wsC=None
seq=0
events=[]
FAKE_HTML='''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>WallCheck isolated synthetic EC2 page</title>
<style>body{font:16px Arial;margin:30px}.card{padding:22px;border:1px solid gray;margin:12px;display:inline-block;vertical-align:top}</style>
<body>
<div class="card" id="card1"><div class="head">#1 ✎ 待定组 29天 剩余25天</div>
<div id="ip1">IP 127.0.0.1</div><div>IPv6 2406:da1e:aaaa:bbbb::1</div></div>
<div class="card" id="card2"><div class="head">#2 🔗 老用户 24小时 剩余25天</div>
<div id="ip2">IP 127.0.0.2</div><div>IPv6 2406:da1e:cccc:dddd::2</div></div>
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
    if '1.9.7' not in result:raise AssertionError('WRONG_EXTENSION_PANEL')
    text=poll('first 2 IP scanned',lambda:ev("document.getElementById('wallcheck-status')?.textContent?.includes('本机探针') && document.getElementById('wallcheck-count')?.textContent || ''"),seconds=18)
    print('FIRST_SCAN',repr(text),flush=True)
    poll('new scoped monitor notice',lambda:ev(
      "document.getElementById('wallcheck-alert-center')?.textContent?.includes('新监控列表已接入')"))
    # True Chromium geometry test: ① alert left of ② status on desktop.
    cdp('Emulation.setDeviceMetricsOverride',
        {'width':1100,'height':780,'deviceScaleFactor':1,'mobile':False})
    ev("window.dispatchEvent(new Event('resize'))")
    poll('desktop side-by-side alert and status',lambda:ev("""(()=>{
      const a=document.getElementById('wallcheck-alert-center').getBoundingClientRect();
      const b=document.getElementById('wallcheck-panel').getBoundingClientRect();
      return a.width>=280 && b.width>=290 && a.right+10<=b.left &&
        Math.abs(a.bottom-b.bottom)<=2 && a.left>=0 && b.right<=innerWidth;
    })()"""))
    print('ALERT_LEFT_OF_STATUS_DESKTOP_PASS',flush=True)
    # Smaller window: stack ① ABOVE ② instead of covering status buttons.
    cdp('Emulation.setDeviceMetricsOverride',
        {'width':600,'height':800,'deviceScaleFactor':1,'mobile':False})
    ev("window.dispatchEvent(new Event('resize'))")
    poll('narrow viewport alert stays above status',lambda:ev("""(()=>{
      const a=document.getElementById('wallcheck-alert-center').getBoundingClientRect();
      const b=document.getElementById('wallcheck-panel').getBoundingClientRect();
      return a.bottom+8<=b.top && a.top>=-1 && a.left>=0 &&
        a.right<=innerWidth+1 && b.right<=innerWidth+1;
    })()"""))
    print('ALERT_STACKS_ABOVE_STATUS_NARROW_PASS',flush=True)
    cdp('Emulation.clearDeviceMetricsOverride')
    ev("window.dispatchEvent(new Event('resize'))")
    ev("""[...document.querySelectorAll('.wc-alert-entry')]
       .find(x=>x.textContent.includes('新监控列表已接入'))
       ?.querySelector('.wc-ack-button')?.click()""")
    poll('new list acknowledged and removed',lambda:ev(
      "![...document.querySelectorAll('.wc-alert-entry')].some(x=>x.textContent.includes('新监控列表已接入'))"))
    print('SCOPE_FIRST_SEEN_ACK_OK',flush=True)
    # Explicit user-style notification test is isolated from daily Thorium.
    ev("document.getElementById('wallcheck-notification-test').click()")
    poll('notification API responded',lambda:ev("""(()=>{
       const s=document.getElementById('wallcheck-notification-test-status');
       return s && (s.textContent.includes('已提交浏览器通知') ||
          s.textContent.includes('通知提交失败'));
    })()"""))
    status=ev("document.getElementById('wallcheck-notification-test-status').textContent")
    if '失败' in status:raise AssertionError('TEST_TOAST_CHROMIUM_API_FAILED: '+status)
    print('TEST_NOTIFICATION_API_ACCEPTED',flush=True)
    # Synthetic account failure. This is a local, intercepted fixture; it
    # NEVER modifies the logged-in AWS account or calls AWS account APIs.
    ev("""(()=>{
      const error=document.createElement('div');
      error.id='fixture-account-invalid';error.textContent='账号无效';
      document.getElementById('card2').appendChild(error);
      const replacing=document.createElement('div');
      replacing.id='fixture-replacing';replacing.textContent=
        '自动替补 · 尝试账号 fictional@invalid.example';
      document.getElementById('card2').appendChild(replacing);
      return true;
    })()""")
    poll('in-page AWS account invalid alert',lambda:ev(
      "document.getElementById('wallcheck-alert-center')?.textContent?.includes('AWS账号已失效')"))
    alert_content=ev("document.getElementById('wallcheck-alert-center').textContent")
    assert 'fictional@invalid.example' not in alert_content,'EMAIL_LEAK_IN_ALERT'
    ev("document.querySelector('#fixture-account-invalid').remove()")
    poll('account alert still pending while replenishment is in progress',lambda:ev(
      "document.getElementById('wallcheck-alert-center')?.textContent?.includes('AWS账号已失效')"))
    assert not ev("document.getElementById('wallcheck-alert-center')?.textContent?.includes('替补后 IP 已验证可达')"),'FALSE_ACCOUNT_RECOVERY'
    ev("document.querySelector('#fixture-replacing').remove()")
    ev("""[...document.querySelectorAll('.wc-alert-entry')]
       .find(x=>x.textContent.includes('AWS账号已失效'))
       ?.querySelector('.wc-ack-button')?.click()""")
    poll('account invalid acknowledged',lambda:ev(
      "!document.getElementById('wallcheck-alert-center')?.textContent?.includes('AWS账号已失效')"))
    print('ACCOUNT_INVALID_E2E_NOTIFICATION_PERSIST_ACK_PASS',flush=True)
    # Previously seen #2 temporarily disappears. It is NOT a fault or
    # pending alert and needs its own persistent "已知" control.
    ev("window.__wcCard2=document.getElementById('card2');window.__wcCard2.remove()")
    poll('historic target shown separately',lambda:ev("""(()=>{
      const box=document.getElementById('wallcheck-hidden-targets');
      return box && box.style.display==='block' &&
        box.textContent.includes('1 个历史目标当前未显示') &&
        !document.getElementById('wallcheck-status').textContent.includes('历史目标');
    })()"""))
    ev("document.querySelector('#wallcheck-hidden-targets details').open=true")
    assert ev("document.getElementById('wallcheck-hidden-targets').textContent.includes('127.0.0.2')"),'HIDDEN_TARGET_IP_DETAILS_MISSING'
    ev("document.querySelector('#wallcheck-hidden-targets .wc-hidden-ack').click()")
    poll('hidden history acknowledged',lambda:ev(
      "document.getElementById('wallcheck-hidden-targets').style.display==='none'"))
    ev("document.getElementById('wallcheck-run').click()")
    poll('ack durable through scan',lambda:ev("""(()=>{
      const box=document.getElementById('wallcheck-hidden-targets');
      const status=document.getElementById('wallcheck-status');
      return box.style.display==='none' && status.textContent.includes('本机探针');
    })()"""))
    # User-reported bug happened specifically after reloading the AWS.SB page:
    # reload the real Chromium tab, then hide the same historic IPv4 again.
    ev("location.reload()")
    poll('extension panel after page reload',lambda:ev(
      "document.getElementById('wallcheck-panel')?.textContent?.includes('1.9.7')"))
    poll('reloaded original list verified',lambda:ev(
      "document.getElementById('wallcheck-status')?.textContent?.includes('本机探针')"))
    ev("window.__wcCard2=document.getElementById('card2');window.__wcCard2.remove()")
    poll('hidden ack survives actual F5',lambda:ev("""(()=>{
      const box=document.getElementById('wallcheck-hidden-targets');
      return box?.style.display==='none' &&
        !document.getElementById('wallcheck-status')?.textContent?.includes('历史目标');
    })()"""))
    print('ACTUAL_PAGE_RELOAD_ACK_PERSISTS_PASS',flush=True)
    # A genuine new hidden target-set must be noticed again, even if the
    # previous one was acknowledged. Existing alert histories are preserved.
    ev("document.body.appendChild(window.__wcCard2)")
    poll('visible target restored',lambda:ev(
      "document.getElementById('card2') !== null && document.querySelectorAll('.wallcheck-badge').length===2"))
    ev("document.getElementById('card2').remove()")
    assert ev("document.getElementById('wallcheck-hidden-targets').style.display==='none'"),'SAME_HIDDEN_SET_ALERT_REPEATED'
    ev("document.body.appendChild(window.__wcCard2)")
    poll('two live cards again',lambda:ev(
      "document.querySelectorAll('.card').length===2"))
    print('HIDDEN_TARGET_ACK_AND_REFRESH_PASS',flush=True)
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
    # Recreate the reported 2026-10-23 #1 case: EC2 was replaced, so
    # both IPv4 AND the stable IPv6 identity differ. The old 1.9.5
    # machine-ID-only path silently recorded a new target with no toast.
    ev("""(()=>{
      document.getElementById('ip1').textContent='IP 127.0.0.7';
      document.querySelector('#card1 div:nth-child(3)').textContent=
        'IPv6 2406:da1e:eeee:ffff::7';
      return true;
    })()""")
    poll('slot #1 replacement visible in alert',lambda:ev("""(()=>{
      const text=document.getElementById('wallcheck-alert-center')?.textContent||'';
      return text.includes('监控组 IP 更新') &&
        text.includes('127.0.0.6 → 127.0.0.7');
    })()"""))
    poll('new instance replacement inline badge',lambda:ev(
      "[...document.querySelectorAll('.wallcheck-change-badge')].some(x=>x.textContent.includes('127.0.0.6 → 127.0.0.7'))"))
    print('EC2_REPLACED_IPV4_AND_IPV6_SLOT_ALERT_OK',flush=True)
    ev("""(()=>{
      document.getElementById('ip1').textContent='IP 127.0.0.8';
      document.querySelector('#card1 div:nth-child(3)').textContent=
        'IPv6 2406:da1e:eeee:ffff::8';
      return true;
    })()""")
    poll('replacement change history accumulates 2',lambda:ev("""(()=>{
      const t=document.getElementById('wallcheck-alert-center')?.textContent||'';
      return t.includes('127.0.0.7 → 127.0.0.8') &&
        t.includes('监控组 IP 更新 2 次');
    })()"""))
    ev("""[...document.querySelectorAll('.wc-alert-entry')]
      .find(x=>x.textContent.includes('监控组 IP 更新'))
      ?.querySelector('.wc-ack-button')?.click()""")
    poll('slot change group ack cleared',lambda:ev(
      "!document.getElementById('wallcheck-alert-center')?.textContent?.includes('监控组 IP 更新')"))
    poll('new slot inline marker ack cleared',lambda:ev(
      "![...document.querySelectorAll('.wallcheck-change-badge')].some(x=>x.textContent.includes('127.0.0.7 → 127.0.0.8'))"))
    print('EC2_REPLACEMENT_ACCUMULATED_HISTORY_AND_ACK_PASS',flush=True)
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
