# AWS.SB IPv4 WallCheck Portable

A small Windows utility for monitoring IPv4 reachability on the `aws.sb` EC2 instances page.

It combines a Chromium extension with a localhost probe to:

- automatically detect IPv4 addresses on `aws.sb/#/ec2-instances`;
- never probe IPv6 (it may identify the instance when EC2 ID is not visible);
- test ICMP reachability plus TCP port 22 only;
- automatically recheck every 10 minutes;
- detect IPv4 changes only within the same sgt account scope and stable instance identity;
- retain unacknowledged IPv4 change history until manually acknowledged (no flashing) and immediately probe the new IPv4;
- keep the local probe bound to `127.0.0.1:17654`.

## 3-minute recurring ICMP/TCP22 checks and accurate last-check time (v1.9.8)

- AWS.SB Chromium alarm cadence changed 10 -> 3 minutes. On upgrade,
  an existing 10-minute wallcheck-auto-recheck browser alarm is
  replaced with one 3-minute repeating alarm, and an already correct
  3-minute alarm is kept intact. Every alarm forces a NEW local
  ICMP and TCP22 probe, never a reused cache result.
- Content-side DOM-refresh cache is shortened 5 -> 2 minutes to
  remain below the auto recheck interval without triggering excessive
  probes for every small page repaint or countdown mutation.
- The main panel prints "上次实测 HH:mm:ss" when a real probe finishes.
  A cached repaint is labeled "缓存结果（未重测）" and retains the real
  timestamp, not the current wall clock. Partial outcomes show their
  current actual check time. Transport failures show their FAILED
  attempt time separately.
- Both ICMP Ping and TCP 22 still run on each target. Existing strict
  RED policy remains: either failed leg triggers severe warning;
  repeated identical conditions are deduplicated. IP/account changes
  continue to request immediate checks.
- With 6 visible IPv4s, expected nominal traffic is about
  6 targets * 2 probes * 20 cycles/hour = 240 checks/hour.
  More frequent checks can expose transient ICMP-only failures,
  but are normally light for a desktop network and EC2 host.
- Manual IPv4 checks keep independent per-target 1/5/10-minute alarms.
  The local Windows Guardian watchdog is unchanged.
  Browser/Windows sleeping may delay alarms. No 24/7 cloud monitor.
- No new permissions, AWS writes, saved account credentials,
  extra TCP ports, Guardian modifications or deletion of history.

Unit: node tests/three-minute-recheck-regression.cjs verifies
old alarm 10 -> 3 migration, stable new alarm, cache interval,
forced network probe and clear measured-at labeling.
Existing unit suite and isolated Thorium browser tests remain.

## Strict OR critical alerts and non-overlapping popup layout (v1.9.7)

**User-requested severe alert policy:** one failed leg is sufficient.
On the AWS.SB EC2 list, when the local probe reports ICMP NO_REPLY
or ICMP ERROR while TCP 22 is OPEN, the IPv4 badge is RED and
the background worker creates a durable PING_UNREACHABLE event and
immediately requests a high-priority Chromium/Windows toast. The same
applies to TCP22 REFUSED, TIMEOUT, UNREACHABLE or ERROR even if Ping
succeeds (PORT22_UNREACHABLE); both failures produce HOST_UNREACHABLE.
ONLY Ping REACHABLE plus TCP 22 OPEN is GREEN. No response/unknown
data is NOT falsely asserted as a server outage; it is unverified.

An unchanged failure remains a single episode (no repeated toast every
10 minutes). A new failure status after recovery creates a new event.
The probe interval is still 10 minutes; "immediate notification" means
immediate when a scan detects a failed leg, NOT continuous sub-minute
server monitoring. ICMP can legitimately be blocked while SSH works;
the red label always distinguishes Ping failure vs. TCP 22 failure,
never claims SSH is broken merely because Ping fails.

Manual IPv4 monitoring (separate Chromium options page) retains the
existing per-target 1/5/10-minute schedules. Its default "either"
mode is now presented as "双重检测（任一失败红色告警）" and is RED/DOWN
if either measured leg fails, GREEN/UP only if BOTH succeed.
Explicitly chosen "仅按 Ping" and "仅按 TCP22" still assess only the
user-selected leg. A missing/unverified result does not falsely
count as a proven outage. Existing manual targets and events are
preserved, never reset. Manual DOWN now has an explicit high-priority
critical title and records a privacy-safe notification API attempt.

**Popup placement:** ① WallCheck warning center is to the LEFT of
② WallCheck status panel at bottom right in a desktop-sized viewport,
both bottom-aligned with at least 12px gap. Position is recomputed
using the status panel's REAL bounding rectangle on content expansion,
font/UI resize and window resize. On narrow viewports ① stacks above
② and both panels scroll independently; they cannot overlap.
This replaces prior independent hardcoded right=16px positions.

No changes to AWS account credentials, scope isolation, saved IP
history, manual target IPs, original Windows Guardian/Agent processes,
or browser permissions. All historical events are retained.
Test with node tests/strict-alert-policy-regression.cjs and
python tests/thorium-smoke.py real Chromium geometry assertions
(1100px desktop and 600px narrow). Regression includes all old tests.

## Same sgt, same monitored #n, replaced EC2 instance alerts (v1.9.6)

The 2026-10-23 production screenshots exposed a 1.9.5 false negative:
#1 displayed IPv4 203.0.113.109, then 203.0.113.105. Its IPv6 also
changed (2001:db8:bb4:... -> 2001:db8:bf00:...). Since the original
machine-identity IP_CHANGE monitor is keyed by stable IPv6/EC2 ID, the
replacement was inserted as a different instance, leaving the old IPv4 in
"historical targets" but emitting NO actual IP-change notification.

1.9.6 introduces a **distinct monitoring SLOT_IP_CHANGE event**, NOT a
claim that the new address belongs to the same EC2 machine.

- Use only a single, individually bounded EC2 card's #n slot, with the same
  hashed signed sgt scope and its last observed IPv4. Recreated EC2
  instances (new IPv6 plus new IPv4) trigger a desktop notification and a
  durable in-page/inline "监控组 IP 已更新" A->B event.
- If the underlying stable EC2/IPv6 ID has NOT changed, continue to use the
  existing IP_CHANGE path; never submit two popups for one change.
- Alert promptly when AWS.SB's card changes: reachability is indicated by
  the separate ICMP/TCP22 indicator; a card update alone is not proof
  that the new IP is already reachable. Account invalidity and separately
  verified account recovery remain their own 1.9.5 events.
- Keep EVERY unacknowledged A->B->C slot change for that #n until the
  user clicks its own group "已知"; one click removes its entire group,
  retaining the latest baseline, other slots, other sgt accounts and other
  alert categories. Browser notifications are attempted per new event.
- Prevent false changes caused by two card rows using one IPv4: compare
  against both other visible #n cards and other slots' current baselines.
  Never borrow another card's IPv6 or machine ID.
- Protect against delayed/older browser tabs undoing a new address. Preserve
  last-seen address and up to 40 local dedupe history entries per slot.
  Do not generate "historical" 2026-10-23 popups retrospectively from
  screenshots or old hidden targets without an observed actual transition.
- No account API calls, AWS changes, browser privilege additions, new TCP
  ports, Guardian modifications, or clearing of previous event history.
  No emails, passwords or raw sgt tokens are stored in new events.

Tests: node tests/slot-ip-transition-regression.cjs (before patch FAIL,
after patch PASS); full node tests/extension-regression.cjs; and an
isolated real Thorium tests/thorium-smoke.py fixture that changes both IPv4
and IPv6 twice while preserving all existing AWS.SB scoped tests.

## AWS account failure and automatic replacement notifications (v1.9.5)

The 2026-10-23 local Windows logs show a healthy Guardian and local probe,
but 1.9.4 had NO handler for the AWS.SB card's "账号无效" and "自动替补"
messages. The real website could replace an invalid account without causing
a WallCheck notification. These missing historical account events cannot
be reconstructed from the local probe/watchdog log.

- Read invalid-account status by individual visible #n cards scoped by
  SHA256(sgt). The account-card #n is NEVER used as EC2 instance identity
  for normal IP-change inference.
- On a new failure, persist exactly one ACCOUNT_INVALID event in the
  single-writer scope and submit an optional desktop notification.
  Observe ongoing automatic replacement without spamming alerts.
- After the invalid banner disappears, require an ACTUAL FRESH TCP22 OPEN
  result for the visible IPv4 before recording ACCOUNT_RECOVERED.
  An in-progress replacement that still has the original IP does NOT
  count as recovery just because the old port is still open.
- Show old->new IP if both addresses were actually observed; preserve
  every episode's timestamps, including repeat failure after recovery.
  Pending records have independent "已知" acknowledgements.
- User-visible account labels are sanitized and truncated. Email addresses,
  raw account tokens, AWS keys/credentials and page text are NEVER stored.
  No current AWS account state is modified by this extension feature.
- The new panel "测试通知" button makes a deliberate, harmless Chromium
  notification request. A separately stored, bounded diagnostic
  wallcheck_notification_attempts_v1 log keeps only time, event kind,
  slot and API_ACCEPTED/API_ERROR.
- API_ACCEPTED proves only that Chromium accepted the notification call,
  NOT that Windows actually displayed its toast. The in-page alert is
  the durable fallback for OS-level notification suppression.
- Detection requires AWS.SB to be open and Chromium running. No background
  login or cloud-account poller is installed; actions that happened while
  the page/browser were closed cannot be backfilled.
- This update does not change the Guardian, ICMP/TCP22 frequencies, existing
  IP-change baselines, historical alerts, manual monitoring or browser
  permissions.

Regression: tests/account-dom-regression.cjs, tests/account-events-regression.cjs
and isolated Chromium tests/thorium-smoke.py, using synthetic local fixtures
without touching real accounts.

## Historic targets not visible: independent acknowledgement (v1.9.4)

In versions <=1.9.3, the status line appended "N 个历史目标本页未显示"
from the difference between saved target count and current visible IP count.
This was NOT a pending alert. Acknowledging agent/port/IP-change alerts could
not clear it, making old informational state look like an active failure.

- The status line now contains probe-health and checked time ONLY.
- A separate small, expandable historic-target notice appears only when
  saved IPs in THIS hashed sgt scope are absent from currently visible IPs.
  It lists the exact historic IPv4, saved instance label, and last-seen time
  (if known). The count uses a SET difference, not subtracting two lengths.
- The new independent "已知" button acknowledges ONLY the exact missing-IP
  set, stored as hiddenNoticeAckKey in the single-writer scoped coordinator.
  It is durable across reload and multiple tabs on the same sgt.
- Ack does NOT delete recorded targets, unacknowledged IP changes, other
  alarms, current-IP baselines, manual targets or watchdog logs.
- A NEW set of hidden IPs reopens the informational notice; different sgt
  scopes have independent acknowledgement state.
- This is not proof that a hidden target is offline or its AWS account has
  failed authentication. An AWS.SB page may simply show fewer instances.
- No additional extension permissions, ports, external endpoints or changes
  to the existing Guardian or local agent executable.

Tests: node tests/hidden-history-regression.cjs and synthetic Chromium
tests/thorium-smoke.py, including hide target, inspect IP/label, acknowledge,
reprobe without reappearing, restore target and ordinary IP change alerts.

## Startup/resume probe and stable instance parsing (v1.9.3)

1.9.3 addresses two production-observed issues: intermittent local agent
unavailability after Windows power resume/fast startup, and false IPv4-change
alerts when partially loaded EC2 cards borrow an IPv6 ID from an adjacent
card.

### Safe EC2 instance identity boundary
- IPv4, the ordinal name (#1 etc), EC2 instance ID and stable IPv6 are read
  ONLY from a common, single-heading instance card. Never search the entire
  card grid for missing IPv6 metadata.
- Until a card has its own stable ID, its IPv4 is still probed but keyed as
  an untrusted ip-target baseline (no inferred A->B instance transitions).
- The same stable identity on two different visible cards in one scan is
  treated as ambiguous rather than recorded as a genuine server IP change.
- A legacy 1.9.2 IP_CHANGE that uses an old IP still displayed by another
  instance is flagged IP_LINK_SUSPECT, preserving its original timestamps
  and IP values. It ceases to appear as a confirmed IP-change banner; the
  in-page event remains available for manual acknowledgement.
- Timers and countdown-bar DOM mutations do NOT schedule expensive network
  rescans if no IP, label or stable machine ID changed. Badge display uses
  last valid local result or an explicit pending placeholder, avoiding
  transient gray "未检测" after a previously successful observation.
- Background periodic scans still run every 10 minutes for AWS.SB;
  manual targets still run at independent 1/5/10-minute intervals.

### Resume/wake Guardian
- The Guardian now has a process mutex and reports healthy/paused/error/
  recovering status truthfully in logs/guardian-health.json. If the agent
  is absent at login or wake but the supervisor is running, it performs one
  guarded recovery immediately instead of waiting up to 60 seconds.
- The existing scheduled task keeps its at-logon and 5-minute fallback.
  An optional **admin-approved, non-elevating-runtime** companion installer
  adds TaskScheduler System Power-Troubleshooter Event ID 1 and session-unlock
  triggers, each after 3 seconds. It never replaces the original actions
  or raises the task RunLevel. The task XML is backed up before changes.
- For predictable interactive Windows logins, a user Startup-folder shortcut
  may also invoke the nonprivileged Guardian hidden. The Guardian mutex and
  watchdog mutex prevent duplicate recovery loops.
- Task registration may require a one-time Windows Administrator UAC
  confirmation. Failure is reported; NO approvals or task rights are bypassed.
- An OS wake/logon test must be observed separately from source tests. An
  "AGENT_OFFLINE" toast generated while the probe is truly unavailable may
  persist as history until acknowledged; do not invent uptime guarantees.
- No passwords, cookies, AWS credentials, IP change history, agent executable
  or Windows networking settings are modified in this release.

Unit tests: node tests/card-identity-regression.cjs,
node tests/false-ip-history-regression.cjs and
node tests/extension-regression.cjs.
Browser tests: python tests/thorium-smoke.py and
python tests/manual-browser-smoke.py.
Activation: reload the WallCheck extension in thorium://extensions without
deleting its stored browser profile. Run the local administrator-approved
Install-WallCheck-Resume-Task.ps1 only after exact task preflight.

## Visible manual-IP downtime and recovery timestamps (v1.9.2)

The standalone manual monitor now shows the **first OBSERVED failure
timestamp** in bold red while a target is currently DOWN under its selected
reachability criterion. This is NOT proof of the actual instant a server went
offline: a 5-minute scan interval can discover a failure later than onset.

- The first failure is stored in the downSince field (local browser storage).
  Later unsuccessful scans and "已知" do not overwrite or delete this active
  time. The existing "最近检测" timestamp continues to update each probe.
- After a valid recovery, show a green recovery timestamp and a muted last
  failure start. The recovery-history notice disappears once acknowledged.
  New failures start a new episode.
- Pause, overdue/stale data, and probe errors never claim a fresh live
  outage. A stale prior failure is labeled as awaiting re-verification.
- Existing 1.9.1 targets remain intact. An outstanding DOWN event can supply
  its original timestamp on the next poll. If the older history was already
  acknowledged, that original time cannot be reconstructed; the next valid
  DOWN observation creates the display baseline without fabrication.
- Editing an IP or monitoring criterion resets the active episode, blocks
  late results from the old address, and keeps unacknowledged change history.
- No changes to ICMP+TCP22 probing, 1/5/10-minute intervals, AWS.SB scopes,
  system notifications or the Windows Guardian. No extra permissions.

Tests: node tests/down-time-regression.cjs and
python tests/manual-browser-smoke.py (red CSS/date, green recovery, ack,
and background alarm with no AWS.SB tab).

## First-seen AWS.SB monitor-list notice (v1.9.1)

The existing signed sgt-account isolation rule is unchanged. The plugin **never**
compares two accounts' identically numbered instance labels such as #1 and
does not invent a cross-account IPv4 transition.

If a previously unseen sgt monitor list FIRST provides at least one valid,
visible IPv4, the background single-writer emits a DISTINCT
SCOPE_ONBOARDED notice. It shows an in-page "已知" acknowledgement and makes
one Windows browser-notification attempt with a first-seen IP example and
instance label. The notice says a new monitor list was detected, NOT that
an old account changed its IP or that AWS validated a new account.

The notice is persisted once for that scope. Acknowledgement hides it without
deleting the new baseline, other scopes, any IP-change history, or target
reachability alerts. Reload/revisit does not repeat it. Empty pages, login
errors and 1.9.0 account lists with already recorded instances do NOT
generate retroactive "new account" notices. Raw sgt tokens are never
shown in alerts. Explicitly clearing a scope cannot recreate this notice.

Unreachability notifications continue to appear only on new state
transitions, and depend on browser and Windows notification permissions.
Original AWS.SB targets are checked every 10 minutes using both ICMP
and TCP 22. Separate manual targets use per-target 1/5/10-minute intervals;
the probe always measures BOTH Ping and TCP22 and the chosen mode merely
selects the criterion for UP/DOWN.

Regression: node tests/new-scope-regression.cjs and isolated
python tests/thorium-smoke.py (new account notice plus manually acknowledging
it, then the existing two-sgt IP transition and cross-tab tests).

## Standalone manual IPv4 monitoring (v1.9.0)

The new toolbar popup, options page and AWS.SB panel button support **manual
IPv4 targets** completely independently from signed sgt-account lists.

- Add up to 30 separately named IPv4 targets, persisted in Chrome local storage.
- Choose Ping, TCP 22, or Ping OR TCP 22 as the status **criterion**. The
  unchanged prebuilt 1.6.1 agent always collects both ICMP and TCP 22; no
  arbitrary TCP port or external servers are added.
- Set per-target interval to 1, 5, or 10 minutes. A Chrome MV3 alarm wakes
  each minute and checks due targets through the existing localhost probe.
- Saved targets continue to be checked with AWS.SB and management tabs closed
  **while the browser itself runs**. Closing the browser or suspending Windows
  pauses monitoring; monitoring resumes on next browser launch. Windows
  Guardian protects only the localhost agent and cannot keep Chrome running.
- Edit an IP and the old address immediately stops being monitored; a
  monotonically increasing generation field protects against delayed results
  from the old IP. New IP is queued immediately without blocking the editor.
- Pause/resume targets, check immediately, or delete them. Keep unacknowledged
  address changes, offline/recovery events, and probe failures until the
  target's own "已知" acknowledgement button is pressed.
- One target's events and settings never touch any AWS.SB account baseline.
  The probe traffic is strictly loopback at 127.0.0.1:17654.
- A DOWN result means the selected method did not confirm connectivity. It
  cannot prove that a network provider or state firewall blocked the IP.
  ERROR explicitly denotes probe failure, not target unreachability.
- No account credentials, raw signed sgt URL tokens or cookies are stored
  or sent by the manual monitor. Manual state does not sync between computers.

Regression: node tests/manual-regression.cjs and
python tests/manual-browser-smoke.py (disposable Chromium profile and local
127.x loopback IPs, including background alarm with no monitor tabs open).

## Continuous unacknowledged change history (v1.8.1)

For each stable instance inside its own signed sgt scope, every IPv4 transition that the active browser actually observes is saved as a separate detail row, without a fixed two-event or 500-event limit. A grouped header counts the still-pending changes. The records remain pending across refreshes and browser restarts until the user confirms them. Clicking the group or inline "已知" button deletes ALL pending IPv4-change detail rows for THAT instance inside THAT sgt scope in one background transaction, and closes its change notification. The latest confirmed IPv4 baseline and bounded anti-stale metadata remain so monitoring continues without repeated false transitions; other groups, port errors, agent failures and different sgt scopes are unaffected.

The separate "清空本页记录" action clears the WHOLE CURRENT sgt-scope list, its alert history and probe-result cache, then resets its baseline to the currently shown IPs. It does NOT delete Windows watchdog logs, real AWS instances, isolated legacy v1.7.x backup state, or other signed-account lists. This action requires confirmation.

The extension cannot reconstruct unseen IP changes from times when a browser tab was suspended, closed or the computer was asleep. Unacknowledged events that WERE observed do not expire automatically, subject to Chromium extension storage availability.

## Acknowledge recovered health notice (v1.8.3)

The green "检测已恢复" banner is a historical notice, not an active fault. It
has no time-based auto-dismissal. Expand it to see original failure and recovery
times, or click its adjacent "已知" button to remove all recovered agent/extension
history that is currently shown in the extension's snapshot. Acknowledgement is
serialized by the MV3 background coordinator and immediately synchronized across
open sgt tabs. It never removes active failures, IPv4 change records, port/host
warnings, or Windows watchdog logs. Future new failures still trigger alerts.

## Version 1.8.2 partial-probe isolation

Only IPv4 addresses currently visible on the active sgt account page are probed.
Historic baselines remain intact, but invisible targets are excluded from each
batch. A missing or invalid IP result triggers a bounded individual retry
(three concurrent fallbacks maximum); successful peers remain visible. Missing
results are labeled UNVERIFIED, never falsely labeled unreachable or cached
as a verified success. Only confirmed localhost transport loss creates a
global agent-offline alert. Bad AWS credentials are handled by AWS.SB, not by
WallCheck. The probe still uses ICMP + TCP 22 only.

## Multi-page and multi-tab isolation (local v1.8.0)

Different aws.sb instance-list URLs containing sgt query values represent separate lists even if each contains #1 or #2. WallCheck hashes the sgt in memory using SHA-256 and stores ONLY the hash as its scope key; raw sgt tokens are not copied to notification messages or saved state. Identity uses a reliable EC2 ID, otherwise a stable visible IPv6 (never probed), otherwise the current IPv4. Ordinals and custom display names are labels only.

- Per-sgt baselines, saved IP lists, recent status caches, alerts and acknowledgements stay separate.
- All state-changing updates and acknowledgement are serialized by the extension background worker, preventing two tabs from overwriting saved records.
- Open tabs using the same sgt receive acknowledgement broadcasts; stale tabs are not accepted as reverse-IP changes.
- A-to-B-to-C transitions within the same instance stay pending until manually acknowledged.
- The button named "清空本页记录" resets only the current sgt list, its history and result cache, then establishes a new baseline from the current page, leaving other sgt pages alone.
- Old unscoped 1.7.x global history is quarantined in browser storage as a rollback backup, not used as evidence for new alerts.
- With no stable instance identity, the IPv4 still gets reachability checks but the plugin will not invent change events from reused #1/#2 labels.
- To prevent stale-page false alarms, a return to a historical IPv4 may require fresh on-page evidence before being reported.

Regression: node tests/extension-regression.cjs; node tests/scoped-monitor-regression.cjs; on Windows with Thorium and a running local agent: python tests/thorium-smoke.py. Browser tests use disposable profiles and synthetic inputs only.

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
