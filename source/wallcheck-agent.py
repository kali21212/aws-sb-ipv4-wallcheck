import argparse
import concurrent.futures
import ipaddress
import json
import os
import socket
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NODE = "local"
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

def valid_ipv4(value):
    try:
        return isinstance(ipaddress.ip_address(value.strip()), ipaddress.IPv4Address)
    except Exception:
        return False

def probe_icmp(ip, timeout_ms):
    start = time.perf_counter()
    if os.name == "nt":
        args = ["ping", "-4", "-n", "1", "-w", str(timeout_ms), ip]
    else:
        secs = max(1, (timeout_ms + 999) // 1000)
        args = ["ping", "-4", "-c", "1", "-W", str(secs), ip]
    try:
        cp = subprocess.run(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=(timeout_ms / 1000.0) + 0.8,
            creationflags=CREATE_NO_WINDOW,
        )
        elapsed = round((time.perf_counter() - start) * 1000, 3)
        if cp.returncode == 0:
            return {"state": "REACHABLE", "latency_ms": elapsed}
        return {"state": "NO_REPLY", "latency_ms": elapsed}
    except subprocess.TimeoutExpired:
        elapsed = round((time.perf_counter() - start) * 1000, 3)
        return {"state": "NO_REPLY", "latency_ms": elapsed, "error": "icmp timeout"}
    except Exception as exc:
        elapsed = round((time.perf_counter() - start) * 1000, 3)
        return {"state": "ERROR", "latency_ms": elapsed, "error": str(exc)}

def probe_tcp(ip, port, timeout_ms, retries):
    last_state = "ERROR"
    last_error = ""
    last_latency = 0.0
    for attempt in range(max(1, retries)):
        start = time.perf_counter()
        try:
            with socket.create_connection((ip, port), timeout=timeout_ms / 1000.0):
                latency = round((time.perf_counter() - start) * 1000, 3)
                return {"port": port, "state": "OPEN", "latency_ms": latency}
        except ConnectionRefusedError as exc:
            last_state, last_error = "REFUSED", str(exc)
        except (TimeoutError, socket.timeout) as exc:
            last_state, last_error = "TIMEOUT", str(exc)
        except OSError as exc:
            if getattr(exc, "winerror", None) in (10051, 10065) or exc.errno in (101, 113):
                last_state = "UNREACHABLE"
            else:
                last_state = "ERROR"
            last_error = str(exc)

        last_latency = round((time.perf_counter() - start) * 1000, 3)
        if last_state in ("REFUSED", "UNREACHABLE"):
            break
        if attempt + 1 < retries:
            time.sleep(0.1)

    result = {"port": port, "state": last_state, "latency_ms": last_latency}
    if last_error:
        result["error"] = last_error
    return result

def normalize_request(data):
    raw_ips = data.get("ips") or []
    ips = []
    seen = set()
    for raw in raw_ips:
        value = str(raw).strip()
        if not valid_ipv4(value) or value in seen:
            continue
        seen.add(value)
        ips.append(value)
        if len(ips) >= 1000:
            break

    raw_ports = data.get("ports") or [22, 80, 443]
    ports = sorted({
        int(p) for p in raw_ports
        if str(p).isdigit() and 1 <= int(p) <= 65535
    })
    if not ports:
        ports = [22, 80, 443]

    timeout_ms = int(data.get("timeout_ms") or 1500)
    timeout_ms = timeout_ms if 1 <= timeout_ms <= 10000 else 1500
    retries = int(data.get("retries") or 2)
    retries = retries if 1 <= retries <= 5 else 2
    concurrency = int(data.get("concurrency") or 32)
    concurrency = concurrency if 1 <= concurrency <= 128 else 32
    return ips, ports, timeout_ms, retries, concurrency

def run_probe(data):
    ips, ports, timeout_ms, retries, concurrency = normalize_request(data)
    results = {
        ip: {"ip": ip, "icmp": {"state": "ERROR"}, "ports": []}
        for ip in ips
    }
    tasks = []
    for ip in ips:
        tasks.append(("icmp", ip, 0))
        for port in ports:
            tasks.append(("tcp", ip, port))

    def do_task(task):
        kind, ip, port = task
        if kind == "icmp":
            return kind, ip, probe_icmp(ip, timeout_ms)
        return kind, ip, probe_tcp(ip, port, timeout_ms, retries)
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        for kind, ip, value in pool.map(do_task, tasks):
            if kind == "icmp":
                results[ip]["icmp"] = value
            else:
                results[ip]["ports"].append(value)

    for item in results.values():
        item["ports"].sort(key=lambda x: x["port"])

    return {
        "node": NODE,
        "agent": "wallcheck-portable-v1.6",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "results": results,
    }

class Handler(BaseHTTPRequestHandler):
    server_version = "WallCheckV2/1.0"

    def log_message(self, fmt, *args):
        return

    def send_json(self, code, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path == "/healthz":
            self.send_json(200, {
                "ok": True,
                "node": NODE,
                "agent": "wallcheck-portable-v1.6",
                "python": sys.version.split()[0],
            })
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/api/probe":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1024 * 1024:
                self.send_json(400, {"error": "invalid content length"})
                return
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            self.send_json(200, run_probe(data))
        except Exception as exc:
            self.send_json(400, {"error": str(exc)})

def main():
    global NODE
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", default="127.0.0.1:17654")
    parser.add_argument("--node", default="local")
    args = parser.parse_args()
    NODE = args.node

    host, port_text = args.listen.rsplit(":", 1)
    server = ThreadingHTTPServer((host, int(port_text)), Handler)
    print(f"WallCheck Agent V2 node={NODE} listening on http://{args.listen}", flush=True)
    server.serve_forever()

if __name__ == "__main__":
    main()
