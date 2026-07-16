# LocalAPI

Local OpenAI-compatible API relay with a Quiet Console admin UI.

**Everything runs on one port: `5555`.**

| Surface | URL |
|---------|-----|
| Admin UI | http://127.0.0.1:5555/ |
| Admin API | http://127.0.0.1:5555/admin/api |
| Proxy | http://127.0.0.1:5555/v1/* |
| Health | http://127.0.0.1:5555/health |

## Features

- **Proxy relay** — Forward `/v1/*` to configured upstream providers
- **API keys** — Client authentication for the proxy (full secret visible in the authenticated admin console)
- **Providers** — Multiple upstreams, multi-key round-robin, model routing
- **Retries** — Configurable max retries for network / 429 / 5xx
- **Streaming** — Transparent SSE passthrough (`stream: true`)
- **Request logs** — Input / output / upstream cache / reasoning tokens
- **Admin console** — Dashboard, providers, keys, logs, settings

## Quick start

```bash
# Install
npm install
npm install --prefix server
npm install --prefix web

# Build UI + start everything on :5555
npm start
# or while developing the server (rebuilds UI once, then watches server):
npm run dev
```

Node.js 22 is recommended (see `.nvmrc`). The production start command builds both
the web console and the server before launching.

### High-concurrency tuning

The relay reuses upstream HTTP connections, streams multipart/binary requests and
responses, and batches SQLite telemetry writes. These environment variables tune
the connection pools and client-side timeouts when needed:

| Variable | Default | Meaning |
|----------|---------|---------|
| `UPSTREAM_MAX_SOCKETS` | `256` | Maximum concurrent sockets per upstream protocol |
| `CLIENT_KEEP_ALIVE_MS` | `65000` | Client keep-alive window |
| `CLIENT_REQUEST_TIMEOUT_MS` | `120000` | Maximum time allowed to receive a request body |
| `HOST` | `127.0.0.1` | Address used by the Node server |
| `CORS_ORIGINS` | empty | Comma-separated browser origins allowed to call the API |
| `ADMIN_TOKEN` | built-in fallback | Admin password injected at startup/deployment |
| `SECRETS_KEY` | empty | Encryption key for provider credentials at rest |
| `LOG_CONTENT` | `false` | Set to `true` only when prompt/output logging is explicitly required |

Large uploads are streamed and are not retried because a live request body cannot
be replayed safely. JSON requests remain replayable for configured upstream retries.
Non-idempotent requests are retried only when the caller supplies an
`Idempotency-Key` or `X-Idempotency-Key` header.

Default **admin password**: `a2366021253`  
A default client API key is printed on first server boot (also listed under **API Keys**).

### Try the proxy

```bash
export KEY=la_...

curl http://127.0.0.1:5555/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}],"stream":false}'

# Streaming
curl -N http://127.0.0.1:5555/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

## Configuration

| Setting | Default | Notes |
|---------|---------|-------|
| Port | `5555` | Override with `PORT` env (still single process) |
| Admin password | `a2366021253` | Change in Settings |
| Max retries | `2` | Settings → Relay |

Data is stored in `server/data/localapi.db`.

## Project layout

```
server/   Express relay + admin API + static UI
web/      React admin (built into web/dist, served by server)
```

Optional mock upstream (only if you need a local echo provider) still runs separately:

```bash
npm run mock   # http://127.0.0.1:8790 — not required for production use
```
