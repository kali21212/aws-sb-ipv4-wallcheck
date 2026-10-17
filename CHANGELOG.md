# Changelog

## 1.9.0 - independent manual IPv4 monitoring 2026-10-17

- Add manual IPv4 manager via popup, options page and original AWS.SB panel.
- Check each saved target by Ping, TCP22, or both every 1/5/10 minutes with
  MV3 background alarms while Chromium remains running.
- Retain and acknowledge each target's address changes, downtime and recovery.
- Non-blocking IP replacement and generation-guarded late result rejection.
- Keep signed AWS.SB scopes, detection agent 1.6.1, Guardian and 1.8.3
  recovery notification behavior unchanged.
- Add isolated multi-IP core regression plus real browser background tests.

## 1.8.3 - manually acknowledge recovered health notice 2026-10-17

- Keep the restored-health green notification visible until manually confirmed.
- Add compact "已知" button next to history toggle; preserve expandable timestamps.
- Atomically purge only already-resolved agent/extension faults by event ID.
- Never purge live failures, IP-change chains, port alerts or disk health logs.
- Synchronize acknowledgement between signed sgt pages and future fault cycles.
- Regress with isolated browser and direct single-writer monitor tests.

## 1.8.2 - per-target partial probe isolation 2026-10-17

- Probe only visible IPv4 for each sgt page; ignore hidden stale baselines in a batch.
- Retry individual missing/invalid targets with bounded concurrency (max three).
- Preserve valid peer results and mark missing targets as UNVERIFIED, never unreachable.
- Do not report global agent failure for AWS AuthFailure/DOM/storage errors.
- Preserve 1.8.1 per-sgt state, A-to-B-to-C history, manual ack and Guardian.
- Validate via scoped regression and isolated three-tab Thorium browser run.

## 1.8.1 - acknowledge and purge an entire IP-change group 2026-10-16

- Keep every observed unacknowledged IPv4 transition per sgt and stable instance ID; no two-event / 500-event group limit.
- Clicking either "已知" button atomically deletes ALL pending IP-change detail events for that instance and scope, then removes its inline and center alerts.
- Preserve current latest-IP baseline and compact anti-stale metadata so future changes are detected without replaying old IPs.
- Preserve unrelated pending port/host/agent faults and alerts for other signed sgt lists.
- Automatically clean up IP-change events that were acknowledged under 1.8.0 but remained archived in browser storage.
- Stress-test 610 pending changes, one-click group deletion, independent fault retention, subsequent fresh changes, and multitab Thorium updates.
- Clarify that "清空本页记录" clears only the current signed list's stored monitor state, not Windows log files or other accounts.

## 1.8.0 - per-sgt isolation 2026-10-16

- Fix false IPv4 A-to-B-to-A changes caused by two independent instance-list URLs sharing #1 and #2.
- Scope all monitoring by SHA-256 of the URL hash query sgt; do not store raw session tokens.
- Use stable EC2 ID or IPv6 as instance identity, not position or display name. IPv6 is not probed.
- Serialize all monitor writes and acknowledgements inside the MV3 background worker.
- Ignore stale same-sgt tabs attempting to reverse accepted changes, preserving genuine A-to-B-to-C transitions.
- Replace clear button with scoped "清空本页记录"; clear saved list, alerts, baseline and result cache for that scope.
- Quarantine old unscoped v1.7 mixed IP history, preserving it only for forensic/rollback purposes.
- Verify in isolated Thorium with two distinct sgt pages, third stale same-sgt tab, broadcast acknowledgements and scoped clear.

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
