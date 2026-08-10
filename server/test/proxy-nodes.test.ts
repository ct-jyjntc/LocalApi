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

/**
 * Minimal SOCKS5 server (no auth) that ignores the requested destination and
 * forwards to a fixed target — the "tunnel" model used to prove the relay
 * actually routed through this node.
 */
function socksServer(targetPort: number) {
  const server = net.createServer((client) => {
    let stage = 0;
    client.on("data", (buf) => {
      if (stage === 0) {
        client.write(Buffer.from([0x05, 0x00]));
        stage = 1;
        return;
      }
      if (stage === 1) {
        // Handshake done; open the fixed tunnel regardless of the destination.
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

test("proxy nodes: CRUD, provider assignment and round-robin across socks proxies", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localapi-proxy-nodes-"));
  process.env.LOCALAPI_DATA_DIR = dir;
  process.env.SECRETS_KEY = "proxy-nodes-test-secret";

  // Two upstream targets that report which one answered.
  const answerA = http.createServer((_req, res) => jsonResponse(res, 200, { who: "A" }));
  const answerB = http.createServer((_req, res) => jsonResponse(res, 200, { who: "B" }));
  const [portA, portB] = await Promise.all([listen(answerA), listen(answerB)]);

  // Two socks proxies, each tunneling to a different target.
  const socksA = socksServer(portA);
  const socksB = socksServer(portB);
  const [socksPortA, socksPortB] = await Promise.all([listen(socksA), listen(socksB)]);

  const { default: express } = await import("express");
  const { db, initDb } = await import("../src/db");
  const { createProxyNode, listProxyNodes, updateProxyNode, deleteProxyNode, sanitizeProxyNode } =
    await import("../src/services/proxies");
  const { createProvider, sanitizeProvider, pickProviderProxy } = await import("../src/services/providers");
  const { handleProxyHttp } = await import("../src/services/proxy");

  let relay: http.Server | null = null;
  try {
    initDb();

    // --- node CRUD ---
    const nodeA = createProxyNode({ name: "proxy-a", url: `socks5://127.0.0.1:${socksPortA}` });
    const nodeB = createProxyNode({ name: "proxy-b", url: `socks5://127.0.0.1:${socksPortB}` });
    assert.ok(nodeA && nodeB);
    assert.equal(listProxyNodes().length, 2);
    // Stored url is encrypted; sanitized view shows plaintext.
    assert.ok(nodeA!.url.includes("enc:v1:"));
    const viewA = sanitizeProxyNode(nodeA!);
    assert.equal(viewA.url, `socks5://127.0.0.1:${socksPortA}`);
    assert.equal(viewA.enabled, true);
    // Invalid scheme rejected by the service layer contract.
    assert.equal(createProxyNode({ name: "bad", url: "http://127.0.0.1:1" }), null);
    // Update + disable
    const updated = updateProxyNode(nodeA!.id, { enabled: false });
    assert.equal(updated?.enabled, 0);

    // --- provider assignment ---
    const provider = createProvider({
      name: "proxied",
      base_url: "http://192.0.2.1:9",
      models: ["proxy-model"],
      proxy_ids: [nodeA!.id, nodeB!.id],
    });
    const sanitized = sanitizeProvider(provider);
    assert.deepEqual(sanitized.proxy_ids, [nodeA!.id, nodeB!.id]);
    // Disabled node is skipped by the picker.
    const pick1 = pickProviderProxy(provider);
    assert.equal(pick1, nodeB!.id);
    const pick2 = pickProviderProxy(provider);
    assert.equal(pick2, nodeB!.id);

    // --- end-to-end: two requests round-robin across two socks proxies ---
    updateProxyNode(nodeA!.id, { enabled: true });
    const proxiedProvider = createProvider({
      name: "proxied-e2e",
      base_url: "http://192.0.2.1:9", // unreachable directly — proxy must carry the traffic
      models: ["proxy-model-e2e"],
      proxy_ids: [nodeA!.id, nodeB!.id],
    });

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
    const body = {
      model: "proxy-model-e2e",
      messages: [{ role: "user", content: "hi" }],
    };
    const headers = { "content-type": "application/json" };

    const first = await fetch(`http://127.0.0.1:${relayPort}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const firstJson = (await first.json()) as { who?: string };
    assert.equal(first.status, 200);
    assert.match(first.headers.get("x-provider") || "", new RegExp(`^${proxiedProvider.id}:`));

    const second = await fetch(`http://127.0.0.1:${relayPort}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const secondJson = (await second.json()) as { who?: string };
    assert.equal(second.status, 200);

    // Round-robin: the two requests must have been carried by different socks nodes.
    assert.deepEqual([firstJson.who, secondJson.who].sort(), ["A", "B"]);

    // --- delete node: provider falls back to direct (unreachable) → failure ---
    deleteProxyNode(nodeA!.id);
    deleteProxyNode(nodeB!.id);
    const third = await fetch(`http://127.0.0.1:${relayPort}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(third.status, 502);
  } finally {
    if (relay) await close(relay);
    await Promise.all([
      close(answerA),
      close(answerB),
      close(socksA),
      close(socksB),
    ]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
