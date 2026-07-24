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
- **API keys** — Client authentication for the proxy
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
| `TRUST_PROXY` | `loopback` | Express proxy trust setting; the default safely accepts Nginx headers from localhost |
| `CORS_ORIGINS` | empty | Comma-separated browser origins allowed to call the API |
| `ADMIN_TOKEN` | random on first boot | Admin password injected at startup/deployment |
| `SECRETS_KEY` | empty | Encryption key for provider credentials at rest |
| `LOG_CONTENT` | `false` | Set to `true` only when prompt/output logging is explicitly required |

Large uploads are streamed and are not retried because a live request body cannot
be replayed safely. JSON requests remain replayable for configured upstream retries.
Non-idempotent requests are retried only when the caller supplies an
`Idempotency-Key` or `X-Idempotency-Key` header.

Set `ADMIN_TOKEN` in production. Without it, a random initial password is printed once on first boot.
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
| Admin password | random on first boot | Prefer setting `ADMIN_TOKEN` in the environment |
| Max retries | `2` | Settings → Relay |

Data is stored in `server/data/localapi.db`.

### 微信支付（API v3）

微信支付已经和支付宝共用同一套充值订单、异步回调、查单、幂等入账和全额退款流程。配置位置：管理员后台 → **支付订单** → **微信支付**。

启用前准备好以下微信商户资料：

| 后台字段 | 来源 |
|---------|------|
| 商户号（mchid） | 微信商户平台 → 账户中心 → 商户信息 |
| 应用 AppID | 绑定到商户号的公众号/小程序/开放平台应用 AppID |
| API v3 密钥 | 微信商户平台 → 账户中心 → API 安全 |
| 商户证书序列号 | `openssl x509 -in apiclient_cert.pem -noout -serial`，去掉 `serial=` 前缀 |
| 商户 API 私钥 | 下载的 `apiclient_key.pem` 全文 |
| 微信支付验签公钥 / 平台证书 | 公钥模式填写 `pub_key.pem` 全文；平台证书模式填写平台证书 PEM 全文 |
| 验签标识 | 公钥模式填写 `PUB_KEY_ID_...`；平台证书模式填写平台证书序列号 |

还需要在后台“设置”中填写公开的 HTTPS 域名（或设置 `PUBLIC_BASE_URL`），并在微信商户平台配置支付通知地址：

```text
https://你的域名/payment/wechatpay/notify
```

电脑浏览器默认使用 Native 扫码支付，手机浏览器默认使用 H5 支付。H5 支付还需要在微信商户平台配置 H5 支付域名；如果只做电脑扫码，可以关闭“手机端 H5 支付”。生产环境请设置 `SECRETS_KEY`，商户私钥、API v3 密钥和验签公钥/证书会加密保存。建议先用小额订单验证“下单 → 回调 → 入账 → 查单 → 退款”完整链路。

## Project layout

```
server/   Express relay + admin API + static UI
web/      React admin (built into web/dist, served by server)
```

Optional mock upstream (only if you need a local echo provider) still runs separately:

```bash
npm run mock   # http://127.0.0.1:8790 — not required for production use
```
