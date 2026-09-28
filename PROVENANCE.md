# Project Provenance

Project: **AWS.SB IPv4 WallCheck Portable**  
Version: **1.6.0**  
Repository owner / publisher: **kali21212**  
Canonical repository: **https://github.com/kali21212/aws-sb-ipv4-wallcheck**  
Initial public release date: **2026-09-28**

## Provenance statement

This project was directed, reviewed, tested, packaged, and published by the repository owner. Development was AI-assisted using ChatGPT for implementation, debugging, documentation, and review.

The public Git history, release tag, GitHub Release record, source files, release artifact checksums, and this provenance statement together provide a timestamped project history. They are useful evidence of project provenance and maintenance, but they are not a substitute for any identity verification that a platform may independently require.

## Release artifact

The canonical Windows portable artifact is published in the GitHub Release for tag `v1.6.0`.

Verify the release ZIP against the adjacent SHA256 checksum file before use.

## Privacy / scope

The tool scans IPv4 addresses visible on the aws.sb EC2 instances page and sends only IPv4 values and configured TCP ports to a localhost probe bound to `127.0.0.1:17654`.

It does not intentionally transmit aws.sb cookies, account data, page URLs, or `sgt` values to an external service. IPv6 addresses are ignored.

## v1.6.0 canonical release checksum

`AWS-SB-IPv4-WallCheck-Portable-V1.6.zip`

SHA256:

`4620208e6bf4fbecf43e47f906c95ac6aa40b541596c9c2612c69f400f4e0914`
