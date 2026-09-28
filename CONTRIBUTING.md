# Contributing

Issues and pull requests are welcome.

Please keep changes focused and preserve these invariants:

- IPv6 is ignored.
- The local probe binds to localhost by default.
- Do not add telemetry or external data collection without explicit documentation and opt-in.
- Do not treat a single local timeout as definitive proof that an IP is blocked.
- Do not commit credentials, cookies, tokens, `sgt` values, or private account data.

For release-impacting changes, update `CHANGELOG.md` and the version metadata.
