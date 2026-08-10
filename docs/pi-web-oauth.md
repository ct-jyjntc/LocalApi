# Pi-Web OAuth 集成设计 — LocalApi 作为提供商

> 状态：**已实现并本地联调通过**（M1–M4 完成，2026-08-10）

## 1. 结论与已确认方向

**可行。** Pi-Web 仓库内已有同款先例（`lib/atomgit-provider.ts`，AtomGit Coding Plan 订阅提供商），LocalApi 侧用户/订阅/API key/钱包/计费基础设施齐全，LinuxDo 模块提供了可复用的 OAuth 安全模式。

已确认的四个方向：

| 决策点 | 选择 |
|---|---|
| OAuth 流程 | **AtomGit broker 轮询**（`GET /oauth/login` → `{login_url, state}` → 轮询 check → 换 token），无需回调端口 |
| 账号体系 | **LocalApi 自有账号**（用户名/密码，可叠加现有 LinuxDo 绑定） |
| 端点族 | **登录后 Pi-Web 侧让用户选通道（钱包 `/v1` / 订阅 `/coding`），选完才拉模型/调用** |
| 分工 | **我们写两侧代码**（LocalApi 服务端 + Pi-Web provider 模块），交给 Pi-Web 合入 |

## 2. 整体流程

```
Pi-Web (provider)                        LocalApi (:5555)              用户浏览器
     │  GET /oauth/login                      │                             │
     │◄──── {login_url, state}                │                             │
     │  notify(auth_url)                      │                             │
     │                                        │◄──── 打开 login_url ────────┤
     │                                        │   GET /oauth/authorize?state │
     │                                        │   （无会话 → 登录页）          │
     │                                        │   （已登录 → 授权确认页）       │
     │                                        │   POST /oauth/authorize      │
     │  GET /oauth/check?state= （轮询 2s）     │  （state 标记 authorized）   │
     │◄──── {valid:true}                      │                             │
     │  GET /oauth/token?state=               │                             │
     │◄──── {access_token, refresh_token,     │                             │
     │       expires_in, user}                │                             │
     │  interaction.select(钱包 / 订阅)        │                             │
     │  GET {base}/v1/models 或 /coding/v1/models （Bearer access_token）    │
     │  POST .../chat/completions             │                             │
     │  POST /oauth/refresh （过期时）          │                             │
```

- **通道选择发生在 OAuth 登录完成之后、模型列表拉取之前**（用户答：「登录完让用户选，选完才调用」）。
- OAuth token 本身不限定通道：同一 token 可访问 `/v1/*`（钱包）和 `/coding/v1/*`（订阅），选择只决定 Pi-Web 侧默认走哪套端点。

## 3. LocalApi 服务端设计

### 3.1 新端点（挂 `/oauth/*`，公开路由，在 userRouter 之前挂载）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/oauth/login` | GET | 生成 `state`（32B hex，服务端存 `oauth_states`，TTL 10min），返回 `{ login_url: "/oauth/authorize?state=…", state }` |
| `/oauth/authorize` | GET | 带 state 访问；未登录 → 渲染登录页（复用现有登录 API + LoginPage 样式）；已登录 → 渲染授权确认页（「Pi-Web 请求访问你的 LocalApi 账号」） |
| `/oauth/authorize` | POST | body `{ state, action: "allow" \| "deny" }`，会话 cookie / `x-user-token` 鉴权；allow → 标记 state `authorized`，deny → 标记 `denied` |
| `/oauth/check` | GET | `?state=` → `{ valid: true \| false }`（state 存在且已授权；denied/过期/不存在均为 false） |
| `/oauth/token` | GET | `?state=` → 签发 token 对；**state 单次使用即销毁**；返回 `{ access_token, refresh_token, token_type: "bearer", expires_in, user: { id, username } }` |
| `/oauth/refresh` | POST | body `{ refresh_token }` → 新 token 对；**整对轮换**：旧 access 与旧 refresh 同时失效（明文不落库，轮换后无法重放；Pi-Web 在凭据锁内刷新，无并发窗口） |

安全细节照 LinuxDo 模块既有模式：state 单次使用、TTL、登录/授权失败限速（复用 `services/rate-limit.ts`）、token 只存哈希。

### 3.2 令牌即用户级凭据（关键设计）

`access_token` 直接作为 `/v1/*` 与 `/coding/v1/*` 的 `Authorization: Bearer` 使用，**无需再签发 `la_` key**：

- 新表 `oauth_tokens`：`access_hash`（`sha256("localapi:oauth:" + token)`）、`refresh_hash`（唯一）、`user_id`、`access_expires_at`、`refresh_expires_at`、`created_at`、`rotated_from`。
- `services/keys.ts` 的 `authenticateApiKey` 增加 OAuth token 分支：命中 → 返回该 `user_id` 的用户绑定 key 上下文。
- 下游全部复用：`maintainActiveSubscription`（`/coding` 订阅校验）、计划 `allowed_models` 白名单、钱包 `reserveUsage/settleUsage` 计费、tier/plan 限速 —— **零改动**。
- 无订阅访问 `/coding` → 现有 402 `coding_plan_required`；模型不在计划内 → 现有 403 `model_not_allowed`，透传给 Pi-Web 展示。

### 3.3 数据表（沿用 `initDb()` 的 `PRAGMA table_info` + `ALTER TABLE` 迁移模式）

```
oauth_states   (state_hash PK, user_id, authorized, denied, expires_at, created_at)
oauth_tokens   (access_hash PK, refresh_hash UNIQUE, user_id,
                access_expires_at, refresh_expires_at, created_at, rotated_from)
```

### 3.4 复用清单

`utils/secrets.ts`（若需加密）、`utils/public-url.ts`（`getPublicBaseUrl()` 拼 login_url）、`services/rate-limit.ts`、`createUserSession`（授权页会话）、scrypt 登录、`LoginPage.tsx` 视觉、`request_logs`/`admin_audit_logs` 记录 OAuth 事件。

### 3.5 错误码

| 码 | 场景 |
|---|---|
| 400 `invalid_state` | state 缺失/格式错/已使用 |
| 410 `state_expired` | state 超过 TTL |
| 401 `invalid_token` / `invalid_grant` | token 校验失败、refresh 轮换冲突 |
| 429 `rate_limited` | 登录/授权限速 |
| 402 `coding_plan_required` / 403 `model_not_allowed` | 现有订阅门控，透传 |

## 4. Pi-Web 侧设计（交付物：`pi-web-integration/` 目录，交给 Pi-Web 合入）

### 4.1 文件

- `lib/localapi-constants.ts` — provider id、显示名、默认 baseUrl（`http://127.0.0.1:5555`，支持环境变量/常量覆盖）。
- `lib/localapi-provider.ts` — 仿 `lib/atomgit-provider.ts`（约 300 行）：
  - `createProvider({ id: "localapi", name: "LocalApi", baseUrl, auth: { oauth }, models: [], fetchModels, api: openAICompletionsApi() })`
  - OAuth 轮询登录：`GET /oauth/login` → `notify({type:"auth_url"})` → 轮询 `check`（2s 间隔，5min 超时）→ `GET /oauth/token`。
- `lib/model-runtime.ts` — 加一行 `runtime.registerNativeProvider(createLocalApiProvider())`（Pi-Web 侧合入点）。

### 4.2 OAuthAuth 实现

```ts
const localApiOAuth: OAuthAuth = {
  name: "LocalApi",
  loginLabel: "使用 LocalApi 账号登录",
  async login(interaction) {
    const { loginUrl, state } = await startLogin();          // GET /oauth/login
    interaction.notify({ type: "auth_url", url: loginUrl, instructions: "…" });
    await pollAuthorized(state, interaction.signal);          // GET /oauth/check
    const tokenResp = await exchangeToken(state);             // GET /oauth/token
    // 「登录完让用户选，选完才调用」：
    const channel = await interaction.select({
      message: "选择 LocalApi 调用通道",
      options: [
        { id: "coding", label: "订阅套餐（Coding Plan，按订阅配额）" },
        { id: "wallet", label: "普通 API（按钱包余额计费）" },
      ],
    });
    return { type: "oauth", access, refresh, expires, userId, username, channel };
  },
  async refresh(credential) { /* POST /oauth/refresh，轮换 */ },
  async toAuth(credential) {
    return {
      apiKey: credential.access,
      baseUrl: credential.channel === "coding"
        ? `${base}/coding/v1` : `${base}/v1`,     // 或 fetchModels 返回的模型自带 baseUrl
    };
  },
};
```

### 4.3 通道选择语义

- 选择写入 `OAuthCredential.channel`（pi-ai 允许 credential 携带任意扩展字段并持久化）。
- `fetchModels` 按 channel 拉 `GET {base}/v1/models`（钱包，全部启用模型）或 `GET {base}/coding/v1/models`（订阅，按计划 `allowed_models` + `model_prices.enabled` 过滤）。
- 模型对象的 `baseUrl` 跟随通道，`toAuth` 的 `apiKey` 即 access_token。
- 换通道 = 重新登录（Pi-Web 现有 logout/login 流程即可）。

### 4.4 兼容确认项（联调时验证）

- LocalApi `/v1/models` 与 `/coding/v1/models` 返回 `{ data: [{ id, … }] }`（OpenAI 兼容），满足 Pi-Web `parseOpenAIStyleIds`。
- `/coding/v1/models` 的 402/403 在 Pi-Web 侧能正常展示（fetchModels 软失败走 stored catalog，与 AtomGit 行为一致）。

## 5. 里程碑

| # | 内容 | 位置 |
|---|---|---|
| M1 | OAuth 服务：表迁移 + 6 个端点 + `authenticateApiKey` OAuth 分支 + 单测 | `server/src/` |
| M2 | 登录/授权确认页 | `web/src/` |
| M3 | Pi-Web provider 模块（交付件，含合入说明） | `pi-web-integration/` |
| M4 | 本地联调：LocalApi dev + Pi-Web dev，全流程走通 | — |

## 6. 需要 Pi-Web 配合的点

1. 合入 `lib/localapi-provider.ts` + `model-runtime.ts` 注册（我们交付代码，他们 review 合入）。
2. baseUrl 的配置方式确认（默认 `127.0.0.1:5555`，生产走环境变量）。
3. 联调环境：他们本地能起 Pi-Web dev + 我们的 LocalApi。
