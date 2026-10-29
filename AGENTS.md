# WallCheck repository instructions

This public repository is the source for the AWS.SB IPv4 WallCheck Portable extension and its companion Windows localhost agent. Follow the canonical governance at `kali21212/GitHub-source-of-truth/AGENTS.md` and the relevant routing, CI/resource, and repository rules there. These instructions are project-specific; do not copy the full central governance here.

## Local-first development and release boundaries

- First inspect the current branch, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `BUILD.md`, current tests and relevant rule revisions. Do not assume a previous chat's version or publication status is current.
- Develop and test against the real target or isolated test browser locally. Record the exact source SHA, portable-package SHA256 and readback; do not start GitHub Actions simply for local development.
- Commit and push changes to an isolated feature/fix branch using already-authorized native Git. Never force-push or manually push development changes to `main`.
- A GitHub-hosted source release needs an authorized PR, exact-head checks, independent review and expected-head merge verification before publication. A pushed branch or locally installed extension is NOT a merged source release or GitHub Release.
- For GitHub PR, review, comment or merge operations use the authorized GitHub connector. If that connector returns an authorization or safety denial, retain the error, diagnose the app installation and authorization, and do NOT replay the denied action through `gh`, a second account, another connector, or direct `main` pushes. Read-only local `gh` inspection is allowed.
- Publish Windows binaries as verified release assets with checksums and license/provenance notices; do not commit portable ZIPs, browser profiles or account-specific data as source. Keep `CHANGELOG.md` and version metadata consistent. Never include real monitored IPs, account names, screenshots, local incident logs, hardware IDs or usernames in public fixtures.
- Follow the owner's version-label convention in `CONTRIBUTING.md`: store versions as strings, not decimal numbers. Preserve historical releases.

## Runtime and privacy invariants

- The production local probe binds only to `127.0.0.1:17654`; `17655` is not a production dependency. Probe IPv4 ICMP and TCP port 22 only; do not probe IPv6. Ping failure OR TCP22 failure must remain a red severe alert.
- Preserve scoped account and IP-change history, acknowledge semantics, persisted interval settings, and the current extension identity during updates. Do not overwrite or clear browser profile data, Windows logs or user settings.
- Never commit or publish cookies, passwords, API tokens, raw `sgt`, account-identifying data, personal contact details, unredacted logs or machine-specific secret paths. For test data use loopback/synthetic identifiers.
- Keep GitHub App permission diagnostics and machine-specific incident details in private local records, never in this public repository.
