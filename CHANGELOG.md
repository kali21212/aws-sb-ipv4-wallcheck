# Changelog

## 2.0.2 - observable scheduling, bounded recovery and panel layout (2026-10-29)

- Display last valid measurement, current attempt and actual next alarm separately.
- Check the executing worker version/protocol before scanning; surface invalidated
  contexts and version mismatches instead of retrying them indefinitely.
- Bound message waits and temporary retries; stop per-IP fan-out for global
  transport/channel failures and preserve valid partial measurements.
- Keep successful measurement data/time when cache or alert synchronization fails,
  and report the failed stage explicitly. Ignore label-only changes during a probe.
- Record bounded privacy-safe alarm, delivery and probe diagnostics; show the
  latest entries in an on-demand collapsed panel without persistent polling.
- Align panel controls and times, isolate styles from the host page and retain
  responsive non-overlapping alert placement. Keep production port 17654.
- Add recovery, scheduling and privacy regressions plus an isolated two-cycle
  natural 5-minute browser test. Preserve prior scope and clear-generation guards.

## 2.0.1 - async page isolation and concurrent result persistence (2026-10-29)

- Discard delayed probe results/errors after account, route or target changes;
  never repaint the new page with the old scan timestamp or reachability.
- Move last-valid result writes and clears to one background queue with
  scoped deltas, newer-result protection and persisted clear generations.
- Preserve existing histories, result cache and saved 1–60-minute intervals.
- Add eight asynchronous integration regression cases and cache concurrency,
  clear, restart, validation and storage-failure regression coverage.
- Correct current setup documentation that still described the 1.6 behavior.
- Adopt the requested 2.0.1 release label for the preceding local repair
  build; align the main panel, manual monitor, manifest and package docs.
- Document string-based version storage and single-digit patch rollover.

## 1.9.9 - user-adjustable AWS.SB probe interval, default 5 minutes (2026-10-29)

- Replace fixed 3-minute alarm with one persisted browser-profile
  configurable interval, default 5, accepting integer 1..60.
- Edit in the WallCheck status panel and press 保存; immediately
  rearm the single alarm without restarting Windows or clearing IPs.
- Upgrade fixed 3/10-minute alarms to 5 when no user setting exists;
  preserve explicit saved intervals on browser restart/page reload.
- Serialize schedule writes across tabs; sync the displayed setting
  across active AWS.SB pages using chrome.storage.onChanged.
- Keep cached timestamps honest, shorten DOM repaint cache to 1min,
  and preserve strict Ping OR TCP22 severe alerts, manual-IP and Guardian.
- Unit and actual isolated-Thorium setting/reload/validation tests.

## 1.9.8 - 3-minute auto recheck and explicit measured-at time (2026-10-29)

- Change recurring AWS.SB browser alarm from 10 to 3 minutes and
  migrate existing 10-minute alarm when the extension reloads.
- Shorten DOM repaint cache from 5 to 2 minutes; every alarm
  uses a forced fresh ICMP/TCP22 probe.
- Display "上次实测 HH:mm:ss" when results finish, and distinguish
  cached results from freshly tested outcomes and failed attempts.
- Preserve severe Ping OR TCP22 alerts, per-sgt IP transitions,
  account alerts, manual targets, history, and Guardian.
- Add unit and isolated Chromium regression for new interval/time.

## 1.9.7 - critical OR alerts and separate bottom-right panels (2026-10-24)

- Severe red event + immediate Chromium notification attempt whenever
  either ICMP Ping (NO_REPLY/ERROR) OR TCP 22 (TIMEOUT/REFUSED/etc.) fails.
  The old false-green Ping:NO_REPLY + TCP:OPEN classification is removed.
- Add PING_UNREACHABLE event with proper state changes and deduplication;
  preserve separate TCP22 and combined failure details.
- In manual IPv4 default dual-monitor mode, either leg failing now
  means DOWN and native critical toast; both must pass to show UP.
  Explicit Ping-only/TCP-only user modes remain unchanged.
- Place pending alert panel left of the status panel, bottom-aligned,
  adapting to status-panel height and viewport width. On a narrow
  browser window, stack the alert panel above the status panel.
- Add standalone strict failure regression plus actual Chromium layout
  assertions at desktop and narrow widths; no data reset or agent change.

## 1.9.6 - detect replacement instance IP changes in the same monitored #n (2026-10-23)

- Fix missed #1 monitor IP changes when AWS.SB reprovisions a new EC2 and
  both IPv4 and IPv6 change: add separately scoped SLOT_IP_CHANGE alerts.
- Show old->new IPv4 in browser toast, webpage history and inline card badge.
  Keep per-group A->B->C transitions until one "已知" acknowledgement.
- Keep original stable-instance IP_CHANGE, and avoid duplicate alerts when
  original EC2/IPv6 identity remains unchanged.
- Strict same-sgt scope and single-card slot detection, stale-tab protection,
  cross-card contamination checks and a stronger replay regression.
- Preserve AWS-account invalidity/recovery alerts, independent manual IP
  monitoring, Guardian, local agent and original saved history.
- No new permissions or AWS write operations.

## 1.9.5 - account invalidity and replacement notifications 2026-10-23

- Capture "账号无效" and "自动替补" card status in addition to TCP22/ICMP.
- Per-sgt single-writer account incident history, deduplicated failures,
  and explicitly TCP22-verified replacement recovery desktop alerts.
- Disallow spurious recovery when a replacement spinner is active and only
  the original IP was found available. Keep previous and new IPv4 when known.
- Add privacy-safe diagnostic audit of browser notification API submissions
  and a manual "测试通知" button to check Windows notification visibility.
- Never persist replacement emails or credentials. No modifications to
  authenticated AWS APIs or account settings.
- Unit and isolated-browser regressions for this incident path.

## 1.9.4 - separately acknowledge invisible historic targets 2026-10-18

- Remove historical hidden-target count from the active probe health line.
- Show a dedicated expandable list of missing historic IPs, old labels
  and last-seen times with a separate "已知" button.
- Persist acknowledgement of the exact hidden IP set in its hashed sgt scope,
  without deleting any baseline or genuine warning; reshow if set changes.
- Fix hidden count using the actual saved/visible IPv4 set difference.
- Keep Agent Guardian, manually monitored IPv4, ICMP+TCP22 probes, and
  existing scoped-change notification rules unchanged.
- Add persistent ack / cross-account isolation regression and a real browser
  sequence hiding, acknowledging and rescanning a previously visible IP.

## 1.9.3 - wake recovery and cross-card false IP change prevention 2026-10-17

- Constrain IP/IPv6/EC2-ID matching to each individual AWS.SB instance
  card, eliminating accidental borrowing from a partially loaded neighbor.
- Preserve but quarantine historical likely-cross-bound #6 IP changes as
  IP_LINK_SUSPECT, never removing the underlying event without user ack.
- Suppress redundant probes from countdown and uptime UI updates; during
  re-probe retain the last valid badge or explicitly show a pending state.
- Upgrade local Guardian with singleton protection, immediate guarded agent
  recovery on wake and truthful health states.
- Supply administrator-reviewed wake/unlock Task Scheduler triggers plus
  nonprivileged login Startup fallback, preserving 5-minute task cadence.
- No new extension permissions, probe ports, external endpoints, or changes
  to AWS.SB signed account tokens.
- Add before/after reproducible #1/#6 collision and false history regression.

## 1.9.2 - visible manual IPv4 downtime timestamp 2026-10-17

- Show red first-observed unreachability date and time inside the manual card
  while keeping the latest probe time updated separately.
- Preserve first failure time through repeated checks, manual acknowledgement
  and transient probe errors.
- Display green recovery time and muted previous outage time until ack.
- Stale/paused results are not presented as live connectivity evidence.
- Migrate existing unacknowledged DOWN events safely; no fabricated history.
- Keep manual IP edit, AWS.SB scoped alerts, agent, Guardian and permissions.
- Add single-writer transition and real browser visual regression tests.

## 1.9.1 - first-seen account-list notification 2026-10-17

- Show one persisted new-monitor-list notice when a new signed sgt scope
  first contains at least one valid IPv4, with optional desktop toast and
  in-page "已知" acknowledgement.
- Do not conflate account switches with same-instance A to B IP changes,
  and do not notify retrospectively for existing scope baselines.
- Empty/login-failed pages, return visits and clear-page actions do not
  regenerate onboarding warnings.
- Preserve AWS.SB 10-minute dual ICMP/TCP22 probes, manual 1/5/10-minute
  polling, existing reachability alerts, guardian and saved history.
- Add isolated scoped regression and real-browser acknowledge test.

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
