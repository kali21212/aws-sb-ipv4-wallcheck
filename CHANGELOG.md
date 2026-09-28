# Changelog

## 1.6.1 — 2026-09-28

- Reduced the EC2 IPv4-change orange marker retention from 24 hours to 1 hour.
- No probe protocol, privacy behavior, default ports, or 10-minute recheck cadence changed.

## 1.6.0 — 2026-09-28

- Portable Windows release with standalone `WallCheck-Agent.exe`.
- Removed the overseas baseline and SSH-tunnel dependency.
- Local ICMP + TCP reachability checks.
- Default TCP ports: 22, 80, 443.
- Automatic forced recheck every 10 minutes.
- IPv6 is ignored.
- Tracks EC2 instance IDs and highlights IPv4 changes for 24 hours.
- New IPv4 is probed immediately after a detected instance IP change.
- Old IPv4 is removed from the active scan list while limited history is retained locally.
- Added portable start/stop/status launchers.
