// Prevent real machine/account data from entering public source or test fixtures.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tracked = execFileSync('git', ['ls-files','-z'], {cwd:root}).toString('utf8').split('\0').filter(Boolean);
const problems = [];
const ignore = new Set(['LICENSE','PYTHON-LICENSE.txt','PYINSTALLER-LICENSE.txt','THIRD_PARTY_NOTICES.md']);
const sourceLike = /\.(?:md|txt|json|js|cjs|py|ps1|cs|ya?ml)$/i;
const ipv4 = /(?<![0-9.])(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g;
const ipv6 = /(?<![0-9a-f:])(?:[0-9a-f]{1,4}:){2,}[0-9a-f:.]{1,44}/gi;
const ec2id = /\bi-[a-f0-9]{8,17}\b/gi;
function allowedFixtureIPv4(ip) {
  return ip.startsWith('127.') || ip.startsWith('192.0.2.') ||
    ip.startsWith('198.51.100.') || ip.startsWith('203.0.113.') ||
    ip.startsWith('10.20.') || ip.startsWith('10.10.') ||
    ip.startsWith('198.18.') || ip.startsWith('198.19.') ||
    ip === '0.0.0.0' || ip === '255.255.255.255';
}
for (const name of tracked) {
  if (!sourceLike.test(name) || ignore.has(name)) continue;
  const data = fs.readFileSync(path.join(root,name));
  if (data.includes(0)) continue;
  const text = data.toString('utf8');
  const sensitivePath = /(?:^|[\s'"(=])[a-z]:[\\/](?![\\/])(?:Users|Documents|Desktop|AppData|2[^\\/\s]*|[^\\/\s]+[\\/]+(?:Temp|Desktop|AppData))/im;
  if (sensitivePath.test(text)) problems.push(name + ': machine-specific absolute path');
  if (/(?:ghp_|github_pat_)[a-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----/i.test(text)) {
    problems.push(name + ': secret-like material');
  }
  if (/\\b(?:ORCID|passport number|personal email address)\\b/i.test(text)) {
    problems.push(name + ': personal machine information indicator');
  }
  if (name.startsWith('tests/') || name.startsWith('docs/') || name === 'README.md') {
    for (const match of text.matchAll(ipv4)) {
      if (net.isIP(match[0])===4 && !allowedFixtureIPv4(match[0])) problems.push(name + ': real-looking IPv4 fixture');
    }
    const normalized = text.replace(/ipv6:(?=[0-9a-f:])/gi,'');
    for (const match of normalized.matchAll(ipv6)) {
      const ip = match[0].replace(/\.+$/,'');
      if (net.isIP(ip)===6 &&
          !ip.toLowerCase().startsWith('2001:db8:') &&
          !ip.toLowerCase().startsWith('fe80:')) {
        problems.push(name + ': real-looking IPv6 fixture');
      }
    }
    for (const match of text.matchAll(ec2id)) {
      if (!/^i-0{12,16}[0-9a-f]$/i.test(match[0])) problems.push(name + ': non-synthetic EC2 ID');
    }
    for (const match of text.matchAll(/\bsgt=([a-z0-9_-]+)/gi)) {
      if (!/^(?:test|demo|example|synthetic|unit|private|secret|local)/i.test(match[1])) problems.push(name + ': account token-like fixture');
    }
    for (const match of text.matchAll(/\b[\w.+-]+@([\w.-]+\.[a-z]{2,})\b/gi)) {
      if (!/^(?:example\.com|example\.test|invalid\.example)$/i.test(match[1])) {
        problems.push(name + ': non-example email fixture');
      }
    }
  }
}
if (problems.length) {
  console.error('PUBLIC_PRIVACY_GATE_FAILED');
  for (const p of [...new Set(problems)]) console.error(' - ' + p);
  process.exit(1);
}
console.log('PUBLIC_PRIVACY_GATE_PASS: no machine-specific records or real-world account fixtures');
