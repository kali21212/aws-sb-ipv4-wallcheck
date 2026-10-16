# AWS.SB IPv4 WallCheck Portable

A small Windows utility for monitoring IPv4 reachability on the `aws.sb` EC2 instances page.

It combines a Chromium extension with a localhost probe to:

- automatically detect IPv4 addresses on `aws.sb/#/ec2-instances`;
- ignore IPv6 completely;
- test ICMP reachability plus TCP port 22 only;
- automatically recheck every 10 minutes;
- detect when the IPv4 of the same EC2 instance ID changes;
- retain unacknowledged IPv4 change history until manually acknowledged (no flashing) and immediately probe the new IPv4;
- keep the local probe bound to `127.0.0.1:17654`.

## Portable release

For normal Windows use, download the ZIP from the latest GitHub Release.

The portable package does **not** require Python, Go, a VPS, an SSH tunnel, or an overseas baseline.

Supported browsers:

- Thorium
- Google Chrome
- Microsoft Edge
- Brave
- other Chromium-family browsers that support Manifest V3 unpacked extensions

Supported OS: Windows 10/11 x64.

## Quick start

1. Download and extract the portable ZIP.
2. Run `启动 WallCheck.cmd`.
3. Open your browser's extension page and enable Developer mode.
4. Choose **Load unpacked** and select `browser-extension`.
5. Open or refresh the `aws.sb` EC2 instances page.

See `docs/操作步骤.txt` for the full Chinese guide.

### Startup and failure recovery

The current source includes recovery fixes on top of 1.6.1. Published 1.6.1 release ZIPs predate these fixes.

For the local v1.7 upgrade on this Windows host, an installed per-user Startup launcher runs a hidden watchdog. The persistent supervisor checks localhost every minute within its own process; during healthy cycles it does not launch a new PowerShell child. The existing guarded recovery script is invoked only if the local probe fails. Recovery events are written to `logs/watchdog-events.jsonl`. The portable 1.6.1 release ZIP alone does not install this watchdog. Manual Stop pauses the watchdog until manual Start.

The extension restores its latest completed results from `chrome.storage.local` and immediately rechecks on page load. Browser startup also restores the 10-minute alarm and requests a recheck. If the local probe or message channel fails, the extension retains previous results, displays the error, and retries after 15 seconds. A completed probe with no positive reachability evidence is still a new result and updates the displayed status.

Results are keyed by IPv4 and TCP port 22, so changes cannot reuse another target's result.

### Restored fault history (local v1.7.1)

A probe or extension context failure remains active only while unresolved. A fresh successful probe marks historical agent/extension failures as recovered; the original fault event remains locally persisted and can be expanded from the small "检测已恢复" history under the panel. An IPv4 address change remains unacknowledged until the user explicitly selects "已知".

Windows watchdog notifications are emitted from the standalone local \`notifier/WallCheck.exe\`, assembled from the auditable C# source under \`notifier/WallCheck.cs\`. This removes the "Windows PowerShell" sender identity caused by direct PowerShell NotifyIcon calls. The notifier is independent of the probe executable, does not need a server, and does not access network or account data. Sender display can vary by Windows notification settings.

The notifier identity is registered per user by `Install-WallCheck-Notifier.ps1`, which creates a Start Menu shortcut and assigns the matching `Charlie.WallCheck` AppUserModelID. See `notifier/README.md` for reproducible build and install steps.

## Result meanings

Examples:

- `✅ 22端口可达｜Ping可达` — ICMP and TCP 22 both respond.
- `✅ 22端口可达｜Ping无回应` — TCP 22 is open even if ICMP replies are blocked.
- `🔴 主机可达｜22端口不可访问` — the host responds but TCP 22 is not open.
- `⚠ 本机未确认主机可达` — neither ICMP nor TCP 22 confirms reachability.

A failed local probe is **not** an absolute determination that an IP is blocked by the Great Firewall. Security groups, firewalls, routing, rate limits, packet loss, or temporary network conditions can produce similar symptoms.

## IPv4 change tracking

The extension associates observed IPv4 addresses with EC2 instance IDs.

When the same instance ID changes from one IPv4 to another:

- the new address gets a `🔄 IP已变更` marker;
- hovering the marker shows old IP → new IP and the change time;
- the new IPv4 is immediately rechecked;
- the old IPv4 is removed from the active scan list;
- limited local history is retained;
- consecutive changes A->B and B->C are shown as separate unacknowledged events;
- the yellow change marker never blinks or expires until the user presses \`已知\`;
- the label uses the EC2 instance number and its displayed custom name where available;
- desktop notifications are sent once per new event; the on-page alert panel persists if system notifications are unavailable.

## Local v1.7 notifications

Reload the unpacked extension once from \`thorium://extensions\`, then refresh \`https://aws.sb/#/ec2-instances\`. Browser notifications require the operating system to allow notifications. If the extension itself is disabled, it cannot generate a browser notification; the Windows watchdog covers the local agent, not the browser extension.

## Privacy

The extension sends only detected IPv4 addresses, configured TCP ports, and probe settings to the local agent on `127.0.0.1:17654`.

It does not intentionally send aws.sb cookies, account credentials, page URLs, `sgt` values, or IPv6 addresses to an external service.

## Tests

Run `node tests/extension-regression.cjs` for isolated JavaScript regression checks. On a Windows machine with Thorium and a running localhost WallCheck agent, `python tests/thorium-smoke.py` runs an isolated browser profile against a synthetic EC2 page to verify real DOM changes, A→B→C history, display-name updates and the "已知" acknowledgement button. The optional browser test needs Python packages `requests` and `websocket-client`, and never uses real account credentials or changes production AWS instances.

## Build from source

See [BUILD.md](BUILD.md).

## Project provenance

See [PROVENANCE.md](PROVENANCE.md).

The repository history, release tag, release record, source code, and published SHA256 checksum provide a timestamped project provenance trail. They are useful evidence of project ownership/maintenance, but they do not replace any identity verification that a third-party platform may independently require.

## License

MIT License. See [LICENSE](LICENSE).

Third-party runtime/build notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Disclaimer

This is an independent third-party utility. It is not affiliated with, endorsed by, or sponsored by Amazon Web Services, aws.sb, OpenAI, Google, Microsoft, Brave Software, or the Chromium project.
