# Changelog

## 1.7.1 - local maintenance 2026-10-16

- Reduce Event Log noise from the Windows watchdog: use an in-process one-minute localhost heartbeat and spawn the guarded recovery script only when agent health fails; preserve manual pause, recovery and logs.
- Recovered agent/extension context failures move out of active alerts after a successful fresh probe.
- Preserve the resolved error timestamp and reason in a collapsed history entry beneath the control panel.
- Do not auto-acknowledge, archive, or otherwise alter unresolved IPv4 A->B->C change alerts.
- Run local recovery notifications from a dedicated WallCheck.exe with application identity "WallCheck" instead of PowerShell.
- Register per-user Start Menu shortcut with explicit AppUserModelID `Charlie.WallCheck`, matching the notifier process identity.
- No changes to ICMP/TCP22 probing interval, existing agent executable, instance mapping, or manual IP acknowledgement.

## 1.7.0 - local upgrade 2026-10-16

- Front-end probes ICMP plus TCP port 22 only (TCP 80/443 removed).
- Persistent IPv4 A->B->C transition history, keyed by EC2 ID or numbered card, with manual acknowledgement.
- Unacknowledged IP-change markers do not blink or expire after one hour.
- Alerts for host unconfirmed reachable, SSH port 22 failure, and local agent/API failure; transition deduplication.
- Browser notification permission and persistent on-page fallback alert panel.
- User-scoped Windows watchdog, health-state and recovery JSONL logging, optional scheduled-task installer.
- Existing portable agent binary remains 1.6.1 and runs with frontend-provided port 22; rebuilt future source enforces 22 only.
- Observe DOM text-node replacement (not just characterData) to catch actual reactive-page IP updates.
- Scope reachability transitions to the current IPv4, preventing failure status from leaking across IP replacements.
- Attempt a rate-limited Windows notification on local-agent recovery; log notification attempts and availability separately.
- Add a real isolated Thorium end-to-end smoke test for A→B→C history, custom names, and acknowledgements.
- Reload unpacked extension once in Thorium to activate these JavaScript updates.

## Unreleased — recovery fixes for 1.6.1

- Persist the latest completed probe results by IPv4 and port configuration and restore them before startup revalidation.
- Preserve previous results on probe/API/message failure, show the failure reason, and retry after 15 seconds.
- Force an immediate check on page load and browser startup while retaining the 10-minute alarm cadence.
- Bound background requests and queue checks requested during an active scan.
- Detect IPv4 text-node changes and expire orange change markers at the one-hour boundary.
- Add isolated extension regression checks covering recovery, forced checks, storage, IP changes, alarms, and messaging.
- The Windows probe still requires manual startup after login; no login startup item is installed.

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
