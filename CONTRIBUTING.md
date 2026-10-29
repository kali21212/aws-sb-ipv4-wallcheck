# Contributing

Issues and pull requests are welcome.

Please keep changes focused and preserve these invariants:

- Never probe IPv6; its displayed text may identify an instance when its EC2 ID is absent.
- The local probe binds to localhost by default.
- Do not add telemetry or external data collection without explicit documentation and opt-in.
- Do not treat a single local timeout as definitive proof that an IP is blocked.
- Do not commit credentials, cookies, tokens, `sgt` values, or private account data.

For release-impacting changes, update `CHANGELOG.md` and the version metadata.

## Version labels

The current release label is 2.0.2. Treat versions as strings in JSON, storage,
exports and UI; never convert a whole version to a decimal number. Compare
numeric components from left to right when ordering versions.

For WallCheck releases, keep the patch component between 1 and 9. After
2.0.9, use 2.1.1; after 2.9.9, use 3.0.1. This is the project owner's release
numbering preference and does not itself imply a breaking API change.

Update the extension manifest, both visible page versions, VERSION.txt, current
setup instructions, changelog, test expectations and portable package metadata
together. Preserve historical release entries, component versions, storage schema
versions and checksums. Never rewrite an already published release archive.
