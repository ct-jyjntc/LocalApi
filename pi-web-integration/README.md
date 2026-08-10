# Pi-Web × LocalApi 集成交付件

这是给 Pi-Web 仓库（`/Users/luna/Desktop/pi-web`）合入用的 **LocalApi OAuth provider** 模块。LocalApi 侧的 OAuth 服务端已经实现并测试通过（见 LocalApi 仓库 `docs/pi-web-oauth.md`）。

## 文件清单

| 文件 | 合入位置 | 说明 |
|---|---|---|
| `lib/localapi-constants.ts` | pi-web `lib/` | 端点常量；默认实例 `http://127.0.0.1:5555`，可用环境变量 `LOCALAPI_BASE_URL` 覆盖 |
| `lib/localapi-provider.ts` | pi-web `lib/` | provider：OAuth broker 登录 + 通道选择 + 模型目录 + chat completions |
| （本次不提供）`lib/model-runtime.ts` 修改 | pi-web `lib/model-runtime.ts` | 注册，见下 |

## 合入步骤（Pi-Web 侧，约 3 处改动）

1. 拷贝 `lib/localapi-constants.ts`、`lib/localapi-provider.ts` 到 `lib/`。
2. `lib/model-runtime.ts` 注册（与 `createAtomGitProvider()` 并列）：

```ts
import { createLocalApiProvider } from "./localapi-provider";
// 在 registerNativeProvider 区域：
runtime.registerNativeProvider(createLocalApiProvider());
```

3. 无需改任何 API 路由：`buildOAuthProviderList` 自动识别 `provider.auth.oauth`，Models 面板自动出现「LocalApi」和「使用 LocalApi 账号登录」入口。

## 行为说明

- **登录**：provider 调 `GET {base}/oauth/login` 拿 `login_url`+`state` → 打开浏览器授权页 → 轮询 `GET /oauth/check?state=`（2s 间隔，5 分钟超时）→ `GET /oauth/token?state=` 换取 access/refresh。
- **通道选择（登录完成后、拉模型前）**：`interaction.prompt({ type: "select" })` 让用户在 **订阅套餐（/coding/v1）** 与 **普通 API（/v1）** 之间选择。选择持久化在 credential 的 `channel` 字段，模型列表与调用 baseUrl 都跟随该通道。换通道 = 重新登录（Pi-Web 现有 logout → login 流程即可）。
- **模型列表**：`GET {base}/v1/models`（钱包，全部启用模型）或 `GET {base}/coding/v1/models`（订阅，按用户套餐白名单过滤）。无订阅时 `/coding/v1/models` 返回 402，provider 会抛出可读提示（"请先购买套餐，或选择普通 API 通道"）。
- **调用**：标准 OpenAI Chat Completions，`Authorization: Bearer <access_token>`。订阅通道 402 `coding_plan_required` / 403 `model_not_allowed` 由 LocalApi 现有门控返回。
- **刷新**：`POST /oauth/refresh` 轮换整个 token 对（旧 access 与旧 refresh 同时失效）。

## LocalApi 侧端点契约（已实现，测试覆盖）

| 端点 | 说明 |
|---|---|
| `GET /oauth/login` | `{ login_url, state, expires_in }` |
| `GET /oauth/check?state=` | `{ valid: boolean }`（轮询，不消费 state） |
| `GET /oauth/token?state=` | 消费 state（单次）→ `{ access_token, refresh_token, token_type, expires_in, user }` |
| `POST /oauth/refresh` | `{ refresh_token }` → 新 token 对 |
| `POST /oauth/authorize` | 浏览器授权页 API（`x-user-token` 会话）→ `{ state, action: "allow"\|"deny" }` |
| `GET /oauth/authorize?state=` | SPA 授权页（未登录先显示登录表单） |

错误码：`400 invalid_state`、`410 state_expired`、`401 invalid_grant`、`429 rate_limited`。

## 联调建议

1. LocalApi：`npm run dev`（:5555），首次启动会自动 seed「Mock Echo」provider 与默认 key。
2. Pi-Web：dev 模式启动，Models 面板 → LocalApi → 登录 → 授权 → 选通道 → 模型列表 → 试聊。
3. 生产部署：LocalApi 侧设置 `PUBLIC_BASE_URL`（授权页/登录 URL 用），Pi-Web 侧设置 `LOCALAPI_BASE_URL`。
