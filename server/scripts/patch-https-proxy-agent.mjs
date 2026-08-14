#!/usr/bin/env node
// Idempotent patch for https-proxy-agent v9 (https://github.com/TooTallNate/proxy-agents).
// Bug: during CONNECT, a TLS socket created by `tls.connect()` can emit an
// 'error' (e.g. ECONNRESET against a dead https proxy) before any request has
// attached to it. With no listener that error becomes an uncaughtException and
// kills the whole process. Attaching a noop 'error' listener lets the failure
// flow through parseProxyResponse() → connect() rejection → request error.
// Re-run after every `npm ci` (wired via package.json "postinstall").
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "node_modules", "https-proxy-agent", "dist", "index.js");
const src = readFileSync(target, "utf8");

const probe = `socket = tls.connect(setServernameFromNonIpHost(this.connectOpts));`;
const guard = `socket.on('error', () => {}); // patched: prevent uncaughtException on dead https proxy`;

if (src.includes(guard)) {
  console.log("[patch-https-proxy-agent] already patched");
  process.exit(0);
}

const count = src.split(probe).length - 1;
if (count !== 2) {
  console.error(`[patch-https-proxy-agent] expected 2 probe sites, found ${count}; aborting`);
  process.exit(1);
}

const patched = src.replaceAll(probe, `${probe}\n            ${guard}`);
writeFileSync(target, patched);
console.log(`[patch-https-proxy-agent] patched ${count} site(s) in ${target}`);
