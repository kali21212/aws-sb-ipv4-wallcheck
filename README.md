# AWS.SB IPv4 WallCheck Portable

A small Windows utility for monitoring IPv4 reachability on the `aws.sb` EC2 instances page.

It combines a Chromium extension with a localhost probe to:

- automatically detect IPv4 addresses on `aws.sb/#/ec2-instances`;
- ignore IPv6 completely;
- test ICMP reachability plus TCP ports 22/80/443;
- automatically recheck every 10 minutes;
- detect when the IPv4 of the same EC2 instance ID changes;
- highlight IP changes for 1 hour and immediately probe the new IPv4;
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

## Result meanings

Examples:

- `✅ 主机可达｜端口可用:22` — the host is reachable and TCP 22 is open.
- `✅ 主机可达｜未发现开放端口` — ICMP is reachable, but none of the configured ports were found open.
- `✅ 端口可用:22｜Ping无回应` — ICMP did not reply, but TCP 22 is reachable.
- `⚠ 本机未确认可达` — this machine obtained no positive ICMP/TCP evidence in that probe.

A failed local probe is **not** an absolute determination that an IP is blocked by the Great Firewall. Security groups, firewalls, routing, rate limits, packet loss, or temporary network conditions can produce similar symptoms.

## IPv4 change tracking

The extension associates observed IPv4 addresses with EC2 instance IDs.

When the same instance ID changes from one IPv4 to another:

- the new address gets a `🔄 IP已变更` marker;
- hovering the marker shows old IP → new IP and the change time;
- the new IPv4 is immediately rechecked;
- the old IPv4 is removed from the active scan list;
- limited local history is retained;
- the orange change marker remains for 1 hour.

## Privacy

The extension sends only detected IPv4 addresses, configured TCP ports, and probe settings to the local agent on `127.0.0.1:17654`.

It does not intentionally send aws.sb cookies, account credentials, page URLs, `sgt` values, or IPv6 addresses to an external service.

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
