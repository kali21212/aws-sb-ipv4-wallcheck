# Security

## Local-only probe

WallCheck Agent listens only on `127.0.0.1:17654` by default. It should not be exposed on a LAN or the public Internet.

## Data handled

The browser extension sends only:
- detected IPv4 addresses
- configured TCP port numbers
- probe timeout/retry settings

to the local probe.

The project does not intentionally send aws.sb cookies, account credentials, page URLs, `sgt` values, or IPv6 addresses to external services.

## Reporting issues

Please report security issues privately to the repository owner through GitHub contact channels when possible. Do not include credentials, cookies, access tokens, or other secrets in public issues.

## Binary verification

Use the SHA256 checksum published alongside each GitHub Release artifact before running a downloaded ZIP.
