"""Two real five-minute Chrome alarms in an isolated Windows Thorium profile.

No alarm creation/firing, interval edits, forced-recheck clicks, production
profile access, external AWS requests or probe substitution. The synthetic
page uses only loopback targets through the existing localhost probe.
Worker CDP connections are short-lived; idle intervals do not retain a worker
debugger session that would otherwise interfere with MV3 suspension.
"""
import argparse
import base64
import datetime
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import requests
import websocket

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")

REPO = pathlib.Path(__file__).resolve().parent.parent
TOKEN = "synthetic-natural-schedule-only-20261029"
TARGET_COUNT = 2
PERIOD_SECONDS = 300
ROUNDS = 2
FAKE_HTML = """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>WallCheck natural-schedule isolated fixture</title><body>
<div class="card"><div>#1 自然定时验收甲 29天 剩余25天</div>
<div>IP 127.0.0.1</div><div>IPv6 2001:db8:100::2</div></div>
<div class="card"><div>#2 自然定时验收乙 29天 剩余25天</div>
<div>IP 127.0.0.2</div><div>IPv6 2001:db8:100::5</div></div>
</body></html>"""
FAKE_BODY = base64.b64encode(FAKE_HTML.encode("utf-8")).decode("ascii")
DIAGNOSTIC_FIELDS = {
    "at", "trigger", "phase", "ok", "targetCount", "durationMs",
    "errorCategory", "description",
}


class SmokeFailure(Exception):
    def __init__(self, category):
        self.category = category
        super().__init__(category)


def utc_time(milliseconds=None):
    when = time.time() if milliseconds is None else milliseconds / 1000
    return datetime.datetime.fromtimestamp(when, datetime.timezone.utc).isoformat(timespec="seconds")


def emit(phase, **fields):
    print(json.dumps({"at": utc_time(), "phase": phase, **fields}, ensure_ascii=False), flush=True)


class CDP:
    def __init__(self, url, fulfill_fixture=False):
        self.ws = websocket.create_connection(url, origin="http://localhost", timeout=5)
        self.seq = 0
        self.fulfill_fixture = fulfill_fixture

    def send(self, method, params=None):
        self.seq += 1
        self.ws.send(json.dumps({"id": self.seq, "method": method, "params": params or {}}))
        return self.seq

    def call(self, method, params=None, timeout=12):
        current = self.send(method, params)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.ws.settimeout(max(0.1, deadline - time.monotonic()))
            try:
                message = json.loads(self.ws.recv())
            except websocket.WebSocketTimeoutException:
                continue
            if message.get("method") == "Fetch.requestPaused" and self.fulfill_fixture:
                paused = message["params"]
                is_document = paused.get("resourceType") == "Document"
                self.send("Fetch.fulfillRequest", {
                    "requestId": paused["requestId"],
                    "responseCode": 200 if is_document else 204,
                    "responseHeaders": [{"name": "content-type", "value": "text/html; charset=utf-8"}],
                    "body": FAKE_BODY if is_document else "",
                })
            if message.get("id") == current:
                if "error" in message:
                    raise SmokeFailure("CDP_COMMAND_ERROR")
                return message.get("result", {})
        raise SmokeFailure("CDP_COMMAND_TIMEOUT")

    def evaluate(self, expression):
        result = self.call("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": True,
        })
        if "exceptionDetails" in result:
            raise SmokeFailure("CDP_EVALUATION_ERROR")
        return result.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def targets(port):
    return requests.get(f"http://127.0.0.1:{port}/json", timeout=2).json()


def runtime_status(port, timeout=12):
    """Read the exact runtime:status implementation in the real worker.

    Connecting only after a page measurement lets the idle interval exercise
    natural alarms without a persistent worker debugger or status polling.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            candidates = [item for item in targets(port)
                          if item.get("type") == "service_worker"
                          and item.get("url", "").startswith("chrome-extension://")
                          and item.get("url", "").endswith("/background.js")
                          and item.get("webSocketDebuggerUrl")]
        except Exception:
            candidates = []
        for item in candidates:
            connection = None
            try:
                connection = CDP(item["webSocketDebuggerUrl"])
                connection.call("Runtime.enable")
                status = connection.evaluate(
                    "typeof runtimeStatus==='function' ? runtimeStatus() : null")
                if isinstance(status, dict) and "protocol" in status:
                    return status
            except Exception:
                pass
            finally:
                if connection:
                    connection.close()
        time.sleep(0.35)
    raise SmokeFailure("WORKER_STATUS_UNAVAILABLE")


def dom_snapshot(page):
    return page.evaluate("""(() => {
      const panel=document.getElementById('wallcheck-panel');
      const status=document.getElementById('wallcheck-status');
      const success=document.getElementById('wallcheck-last-success');
      const numeric=Number(success?.dataset?.timestamp || 0);
      const failure=document.getElementById('wallcheck-failure');
      return {panel:!!panel,versionText:panel?.firstElementChild?.textContent || '',
        successAt:Number.isFinite(numeric)&&numeric>0?numeric:null,
        interval:Number(document.getElementById('wallcheck-auto-minutes')?.value || 0),
        severeFailure:!!(failure&&!failure.hidden) ||
          /本轮(?:检测|检查)失败|需.*刷新|版本不一致/.test(status?.textContent || '')};
    })()""")


def check_runtime(status, expected_version):
    if status.get("workerVersion") != expected_version or status.get("protocol") != 2:
        raise SmokeFailure("EXECUTING_WORKER_VERSION_MISMATCH")
    if status.get("savedMinutes") != 5 or (status.get("alarm") or {}).get("periodInMinutes") != 5:
        raise SmokeFailure("DEFAULT_FIVE_MINUTE_SCHEDULE_MISMATCH")
    if status.get("statusErrors"):
        raise SmokeFailure("WORKER_STATUS_READ_ERROR")


def check_diagnostics(status):
    events = status.get("diagnostics")
    if not isinstance(events, list) or len(events) > 100:
        raise SmokeFailure("DIAGNOSTIC_BOUND_FAILED")
    for event in events:
        if not isinstance(event, dict) or set(event) - DIAGNOSTIC_FIELDS:
            raise SmokeFailure("DIAGNOSTIC_FIELD_WHITELIST_FAILED")
    serialized = json.dumps(events, ensure_ascii=False)
    if (TOKEN in serialized or "sgt:" in serialized.lower()
            or re.search(r"(?:https?|wss?)://|chrome-extension://", serialized, re.I)
            or re.search(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)", serialized)
            or re.search(r"(?i)(?:[0-9a-f]{1,4}:){3,}[0-9a-f:]{1,39}", serialized)):
        raise SmokeFailure("DIAGNOSTIC_PRIVACY_FAILED")
    return len(events)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", default=os.environ.get(
        "WALLCHECK_THORIUM_BIN", "thorium"))
    parser.add_argument("--extension-dir", default=str(REPO / "browser-extension"))
    parser.add_argument("--expected-version", default="2.0.2")
    parser.add_argument("--timeout-seconds", type=int, default=1080)
    parser.add_argument("--allow-delay-seconds", type=int, default=180)
    args = parser.parse_args()
    browser = pathlib.Path(args.browser).resolve()
    extension = pathlib.Path(args.extension_dir).resolve()
    if not browser.is_file() or not (extension / "manifest.json").is_file():
        raise SmokeFailure("BROWSER_OR_EXTENSION_MISSING")
    manifest = json.loads((extension / "manifest.json").read_text(encoding="utf-8-sig"))
    if manifest.get("version") != args.expected_version:
        raise SmokeFailure("DISK_MANIFEST_VERSION_MISMATCH")
    if args.timeout_seconds < 650 or args.allow_delay_seconds < 30:
        raise SmokeFailure("NATURAL_TEST_TIMEOUT_TOO_SHORT")

    profile = pathlib.Path(tempfile.mkdtemp(prefix="wallcheck-natural-5m-"))
    frozen_extension = profile / "extension-under-test"
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    command = [str(browser), "--headless=new", "--no-first-run", "--no-default-browser-check",
               "--disable-background-networking", "--disable-sync",
               "--remote-debugging-address=127.0.0.1", f"--remote-debugging-port={port}",
               "--remote-allow-origins=http://localhost", f"--user-data-dir={profile}",
               f"--disable-extensions-except={frozen_extension}", f"--load-extension={frozen_extension}", "about:blank"]
    process = page = None
    start = time.monotonic()
    rounds = 0
    try:
        # Freeze the candidate bytes so packaging/deployment in parallel cannot
        # hot-change the code being observed during this ten-minute run.
        shutil.copytree(extension, frozen_extension)
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        emit("NATURAL_START", version=args.expected_version, targetCount=TARGET_COUNT,
             periodSeconds=PERIOD_SECONDS, requiredRounds=ROUNDS)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise SmokeFailure("ISOLATED_BROWSER_EXITED")
            try:
                pages = [item for item in targets(port)
                         if item.get("type") == "page" and item.get("webSocketDebuggerUrl")]
                if pages:
                    page = CDP(pages[0]["webSocketDebuggerUrl"], fulfill_fixture=True)
                    break
            except Exception:
                pass
            time.sleep(0.35)
        if page is None:
            raise SmokeFailure("ISOLATED_PAGE_UNAVAILABLE")
        page.call("Page.enable")
        page.call("Runtime.enable")
        page.call("Fetch.enable", {"patterns": [{"urlPattern": "https://aws.sb/*", "requestStage": "Request"}]})
        page.call("Page.navigate", {"url": "https://aws.sb/#/ec2-instances?sgt=" + TOKEN})
        deadline = time.monotonic() + 90
        snapshot = None
        while time.monotonic() < deadline:
            snapshot = dom_snapshot(page)
            if snapshot.get("panel") and snapshot.get("successAt"):
                break
            time.sleep(0.5)
        else:
            raise SmokeFailure("INITIAL_REAL_MEASUREMENT_TIMEOUT")
        if args.expected_version not in snapshot.get("versionText", ""):
            raise SmokeFailure("PAGE_VERSION_MISMATCH")
        status = runtime_status(port)
        check_runtime(status, args.expected_version)
        check_diagnostics(status)
        if snapshot.get("interval") != 5:
            raise SmokeFailure("PAGE_INTERVAL_MISMATCH")
        next_expected = (status.get("alarm") or {}).get("scheduledTime")
        if not isinstance(next_expected, (int, float)):
            raise SmokeFailure("NEXT_ALARM_TIME_MISSING")
        seen_alarm = status.get("lastAlarmAt") or 0
        observed_success = snapshot["successAt"]
        initial_success = observed_success
        previous_round_alarm = None
        emit("INITIAL_MEASUREMENT_PASS", targetCount=TARGET_COUNT,
             nextAlarmAt=utc_time(next_expected), diagnosticCount=len(status["diagnostics"]))
        last_progress = time.monotonic()

        while rounds < ROUNDS:
            elapsed = time.monotonic() - start
            if elapsed > args.timeout_seconds:
                raise SmokeFailure("NATURAL_TWO_ROUND_TIMEOUT")
            if process.poll() is not None:
                raise SmokeFailure("ISOLATED_BROWSER_EXITED")
            # Read DOM only while idle. Do not call worker APIs to keep it awake.
            snapshot = dom_snapshot(page)
            success = snapshot.get("successAt")
            if success and success < observed_success:
                raise SmokeFailure("PAGE_SUCCESS_CLOCK_MOVED_BACKWARD")
            if success and success > observed_success:
                observed_success = success
                status = runtime_status(port)
                check_runtime(status, args.expected_version)
                diagnostic_count = check_diagnostics(status)
                alarm_at = status.get("lastAlarmAt") or 0
                probe = status.get("lastProbe") or {}
                if alarm_at > seen_alarm and probe.get("trigger") == "automatic":
                    if alarm_at < next_expected - 2000:
                        raise SmokeFailure("ALARM_FIRED_BEFORE_NATURAL_DUE_TIME")
                    if (not probe.get("ok") or probe.get("targetCount") != TARGET_COUNT
                            or (probe.get("finishedAt") or 0) < alarm_at):
                        raise SmokeFailure("AUTOMATIC_PROBE_COMPLETION_MISMATCH")
                    if snapshot.get("severeFailure"):
                        raise SmokeFailure("PAGE_STILL_REPORTS_SCAN_FAILURE")
                    if previous_round_alarm is not None:
                        delta = (alarm_at - previous_round_alarm) / 1000
                        if not 270 <= delta <= PERIOD_SECONDS + args.allow_delay_seconds:
                            raise SmokeFailure("NATURAL_ALARM_INTERVAL_OUT_OF_RANGE")
                    else:
                        delta = None
                    rounds += 1
                    seen_alarm = previous_round_alarm = alarm_at
                    next_expected = (status.get("alarm") or {}).get("scheduledTime") or alarm_at + PERIOD_SECONDS * 1000
                    emit("NATURAL_ROUND_PASS", round=rounds, alarmAt=utc_time(alarm_at),
                         probeFinishedAt=utc_time(probe["finishedAt"]), targetCount=probe["targetCount"],
                         intervalSeconds=round(delta, 2) if delta is not None else None,
                         diagnosticCount=diagnostic_count, errorCategory=probe.get("errorCategory", "NONE"))
            if time.time() * 1000 > next_expected + (args.allow_delay_seconds + 60) * 1000 and rounds < ROUNDS:
                # One final short diagnostic read after a missed deadline; it
                # cannot convert a missed round into a passing observation.
                try:
                    status = runtime_status(port, timeout=5)
                    probe = status.get("lastProbe") or {}
                    category = probe.get("errorCategory", "UNKNOWN")
                    emit("MISSED_DEADLINE_STATE", completedRounds=rounds, errorCategory=category)
                except Exception:
                    pass
                raise SmokeFailure("NATURAL_ALARM_OR_PAGE_PROGRESS_MISSED")
            if time.monotonic() - last_progress >= 30:
                emit("NATURAL_WAIT", elapsedSeconds=round(elapsed), completedRounds=rounds,
                     requiredRounds=ROUNDS)
                last_progress = time.monotonic()
            time.sleep(2)

        if observed_success <= initial_success:
            raise SmokeFailure("PAGE_SUCCESS_CLOCK_DID_NOT_ADVANCE")
        while True:
            remaining = PERIOD_SECONDS * ROUNDS - (time.monotonic() - start)
            if remaining <= 0:
                break
            time.sleep(min(2, remaining))
        emit("NATURAL_SCHEDULE_BROWSER_PASS", completedRounds=rounds,
             elapsedSeconds=round(time.monotonic() - start), errorCategory="NONE")
        return 0
    finally:
        if page:
            try:
                page.call("Browser.close", timeout=3)
            except Exception:
                pass
            page.close()
        if process and process.poll() is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        pass
        for attempt in range(3):
            try:
                shutil.rmtree(profile)
                break
            except FileNotFoundError:
                break
            except OSError:
                if attempt == 2:
                    emit("NATURAL_CLEANUP_WARNING", errorCategory="ISOLATED_PROFILE_STILL_LOCKED")
                else:
                    time.sleep(0.5)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SmokeFailure as error:
        emit("NATURAL_SCHEDULE_BROWSER_FAIL", errorCategory=error.category)
        sys.exit(2)
    except Exception:
        # Never dump CDP payloads, URLs, filesystem profiles or page text.
        emit("NATURAL_SCHEDULE_BROWSER_FAIL", errorCategory="UNEXPECTED_TEST_ERROR")
        sys.exit(2)
