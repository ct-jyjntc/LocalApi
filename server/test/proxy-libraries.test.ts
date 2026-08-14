import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

function listen(server: http.Server | net.Server) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: http.Server | net.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Minimal SOCKS5 server (no auth) that tunnels to a fixed target. */
function socksServer(targetPort: number) {
  const server = net.createServer((client) => {
    let stage = 0;
    client.on("data", () => {
      if (stage === 0) {
        client.write(Buffer.from([0x05, 0x00]));
        stage = 1;
        return;
      }
      if (stage === 1) {
        const target = net.connect(targetPort, "127.0.0.1", () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.pipe(target);
          target.pipe(client);
        });
        target.on("error", () => client.destroy());
        stage = 2;
        return;
      }
    });
    client.on("error", () => {});
  });
  return server;
}

/**
 * Minimal HTTP forward proxy: absolute-URL requests are forwarded to the real
 * target; relative-path requests go to the Host header. Used as a "live"
 * http:// node for health checks and routing.
 */
function forwardProxy() {
  const server = http.createServer((req, res) => {
    let targetUrl: URL;
    try {
      targetUrl =
        req.url!.startsWith("http://") || req.url!.startsWith("https://")
          ? new URL(req.url!)
          : new URL(`http://${req.headers.host}${req.url}`);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const up = http.request(
      {
        host: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: { ...req.headers, host: targetUrl.host },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    req.pipe(up);
    up.on("error", () => {
      res.writeHead(502);
      res.end();
    });
  });
  return server;
}

test("proxy libraries: import with health checks, incremental refresh, read-only nodes and round-robin", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-proxy-libraries-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "proxy-libraries-test-secret";

  // Library upstream: serves plain-text proxy lists.
  let libraryText = "";
  const libraryServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(libraryText);
  });
  const libraryPort = await listen(libraryServer);

  const target = http.createServer((_req, res) => jsonResponse(res, 200, { ok: true }));
  const targetPort = await listen(target);
  const forward = forwardProxy();
  const forwardPort = await listen(forward);
  const socks = socksServer(targetPort); // socks tunnel forwards straight to the mock upstream (alive for probes, reachable for e2e)
  const socksPort = await listen(socks);

  const { db, initDb, setSetting } = await import("../src/db");
  const {
    createProxyLibrary,
    refreshProxyLibrary,
    listProxyLibraries,
    listProxyNodesByLibrary,
    normalizeProxyLine,
    parseProxyUrl,
    updateProxyNode,
    deleteProxyNode,
    deleteProxyLibrary,
    updateProxyLibrary,
  } = await import("../src/services/proxies");
  const { createProvider, sanitizeProvider, pickProviderProxy } = await import("../src/services/providers");
  const { handleProxyHttp } = await import("../src/services/proxy");

  let relay: http.Server | null = null;
  try {
    initDb();
    // Health probes must hit a local endpoint: 200 from the mock upstream.
    setSetting("proxy_test_url", `http://127.0.0.1:${targetPort}/health`);

    // --- protocol parsing ---
    assert.equal(parseProxyUrl("http://h:8080")?.type, "http");
    assert.equal(parseProxyUrl("https://h:443")?.type, "https");
    assert.equal(parseProxyUrl("socks5://h:1080")?.type, "socks5");
    assert.equal(parseProxyUrl("socks4://h:1080")?.type, "socks4");
    assert.equal(parseProxyUrl("ftp://h:21"), null);
    assert.equal(parseProxyUrl("socks5://user:pass@h:1080")?.userId, "user");
    // bare lines get the default protocol
    assert.equal(normalizeProxyLine("1.2.3.4:9999", "socks5"), "socks5://1.2.3.4:9999");
    assert.equal(normalizeProxyLine("1.2.3.4:9999", "http"), "http://1.2.3.4:9999");
    assert.equal(normalizeProxyLine("no-port-here", "http"), null);

    // --- import: live nodes enter the pool, dead ones are dropped ---
    libraryText = [
      `127.0.0.1:${forwardPort}`, // bare line → default protocol (http), live
      `http://127.0.0.1:${forwardPort}`, // live
      `socks5://127.0.0.1:${socksPort}`, // live via tunnel
      "http://127.0.0.1:1", // dead (connection refused)
      "garbage-line", // skipped
    ].join("\n");
    const lib = createProxyLibrary({
      name: "public-pool",
      url: `http://127.0.0.1:${libraryPort}/list.txt`,
      default_protocol: "http",
      auto_update: true,
      update_interval_ms: 60_000,
    });
    assert.ok(lib);
    const first = await refreshProxyLibrary(lib!.id);
    assert.ok(first);
    assert.equal(first!.total, 3); // duplicate forward line merged + garbage skipped
    assert.equal(first!.alive, 2);
    assert.equal(first!.dead, 1);
    assert.equal(first!.added, 2);

    const nodes = listProxyNodesByLibrary(lib!.id);
    assert.equal(nodes.length, 2); // dead node never entered the pool
    const urls = nodes.map((n) => n.url).sort();
    assert.ok(urls[0].includes("enc:v1:")); // encrypted at rest

    // Library nodes are read-only against direct edits.
    assert.equal(updateProxyNode(nodes[0].id, { enabled: false }), null);
    assert.equal(deleteProxyNode(nodes[0].id), false);

    // --- incremental refresh: add one live node, keep the rest ---
    libraryText = [
      `127.0.0.1:${forwardPort}`,
      `http://127.0.0.1:${forwardPort}`,
      `socks5://127.0.0.1:${socksPort}`,
      `http://127.0.0.1:${targetPort}`, // new live node (answers 200)
      "http://127.0.0.1:1", // still dead
    ].join("\n");
    const second = await refreshProxyLibrary(lib!.id);
    assert.equal(second?.added, 1);
    assert.equal(second?.removed, 0);
    assert.equal(second?.total, 4);
    assert.equal(second?.alive, 3);
    assert.equal(listProxyNodesByLibrary(lib!.id).length, 3);

    // --- refresh that removes a live node drops it ---
    libraryText = [
      `127.0.0.1:${forwardPort}`,
      `http://127.0.0.1:${forwardPort}`,
      `socks5://127.0.0.1:${socksPort}`,
      "http://127.0.0.1:1",
    ].join("\n");
    const third = await refreshProxyLibrary(lib!.id);
    assert.equal(third?.removed, 1); // target node dropped
    assert.equal(third?.alive, 2);
    assert.equal(listProxyNodesByLibrary(lib!.id).length, 2);

    // --- all-dead guard: environment issue keeps the pool untouched ---
    const deadLib = createProxyLibrary({
      name: "dead-pool",
      url: `http://127.0.0.1:${libraryPort}/dead.txt`,
      default_protocol: "http",
    });
    assert.ok(deadLib);
    libraryText = ["http://127.0.0.1:1", "http://127.0.0.1:2"].join("\n");
    const dead = await refreshProxyLibrary(deadLib!.id);
    assert.equal(dead?.skipped, true);
    assert.equal(dead?.added, 0);
    assert.equal(listProxyNodesByLibrary(deadLib!.id).length, 0);

    // --- library expands into its nodes when picked ---
    const provider = createProvider({
      name: "lib-proxied",
      base_url: "http://192.0.2.1:9", // unreachable directly
      models: ["lib-model"],
      proxy_ids: [lib!.id],
    });
    const sanitized = sanitizeProvider(provider);
    assert.deepEqual(sanitized.proxy_ids, [lib!.id]);
    const picked = pickProviderProxy(provider);
    assert.ok(picked); // a node inside the library
    assert.ok(nodes.some((n) => n.id === picked));

    // --- end-to-end through a library-assigned socks node ---
    // Second library whose only entry is the local socks tunnel; the channel
    // references the library, and routing must expand it to that node.
    libraryText = `socks5://127.0.0.1:${socksPort}`;
    const tunnelLib = createProxyLibrary({
      name: "tunnel",
      url: `http://127.0.0.1:${libraryPort}/tunnel.txt`,
      default_protocol: "socks5",
    });
    assert.ok(tunnelLib);
    await refreshProxyLibrary(tunnelLib!.id);
    assert.equal(listProxyNodesByLibrary(tunnelLib!.id).length, 1);
    const viaLib = createProvider({
      name: "lib-e2e",
      base_url: "http://192.0.2.1:9",
      models: ["lib-model-e2e"],
      proxy_ids: [tunnelLib!.id],
    });

    const { default: express } = await import("express");
    const app = express();
    app.use(express.json());
    app.post("/chat", async (req, res) => {
      await handleProxyHttp(
        {
          method: "POST",
          path: "/v1/chat/completions",
          query: {},
          headers: { "content-type": "application/json" },
          body: req.body,
          apiKeyId: "test-key",
        },
        res,
      );
    });
    relay = http.createServer(app);
    const relayPort = await listen(relay);
    const body = { model: "lib-model-e2e", messages: [{ role: "user", content: "hi" }] };
    const resp = await fetch(`http://127.0.0.1:${relayPort}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("x-provider") || "", new RegExp(`^${viaLib.id}:`));

    // --- library update + delete cascades ---
    const updatedLib = updateProxyLibrary(lib!.id, { auto_update: false });
    assert.equal(updatedLib?.auto_update, 0);
    assert.equal(listProxyLibraries().length, 3);
    assert.equal(deleteProxyLibrary(lib!.id), true);
    assert.equal(deleteProxyLibrary(deadLib!.id), true);
    assert.equal(deleteProxyLibrary(tunnelLib!.id), true);
    assert.equal(listProxyLibraries().length, 0);
    assert.equal(listProxyNodesByLibrary(lib!.id).length, 0);
  } finally {
    if (relay) await close(relay);
    await Promise.all([close(libraryServer), close(target), close(forward), close(socks)]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
