# deepseek-harness-quota-monitor

DeepSeek Harness 多供应商额度监控插件。侧边栏实时卡片 + 「设置 → 插件」可视化配置，支持**余额型**（主动查询供应商 API）与**限额型**（本地滑动窗口计量）两类额度模型。

> 本版本适配 **DSH 0.1.7-alpha.1** 起的插件接口：设置 schema 改为**导出 `Config` 声明式注册**（不再有 `installSection`），配置页注册到插件管理页的 `plugins.item` 插槽，配置改写入 profile 的 `cordis.patch.yml`（`settings.yaml` 已被上游移除）。旧版（0.1.5-rc.1 及更早）的 `installSection` / `settings.plugin.item` 接口在本版本已不适用。

## 特性

- **余额型**：主动查询供应商余额/用量 API（地址 + API Key 引用 + JS 解析器），如 DeepSeek 官方 `GET /user/balance`
- **限额型**：本地滑动窗口用量统计（5h / 7d / 1m 等，按 `llm/stream` 瀑布采集真实 token 用量，持久化到 `$DSH_HOME/storages/quota-monitor-usage.jsonl`），对照配额上限显示剩余
- **今日已用**：自然日桶，跨重启保留；主数字含缓存（输入 + 输出 + 缓存读），附输入/输出/缓存分项与缓存命中率（3 位小数）
- **翻转卡片**：点击今日已用区翻转 3D 卡片，查看**输入/输出/缓存三线小时折线图**（平滑曲线、峰值标注）
- **自动发现**：有确定预设的官方供应商（DeepSeek、OpenCode GO、Command Code 等）自动进入监控；无预设的自建网关不自动发现，需手动添加
- **逐个启用/禁用**：自动发现与手动配置的每个供应商都可单独暂停/恢复监控（即时生效，配置保留）
- **预设一键添加**：`deepseek-official` / `opencode-go` / `commandcode` / `new-api` / `sub2api` 等整体方案，选中即填好 kind/url/解析器
- **金额按供应商实报**：供应商在 usage 里返回价格才显示金额（无价格表、不推断），按模型明细展示
- **供应商显示名**：卡片打印人类可读的名字（路由声明的 `displayName`，或配置的 `label`），而不是 `commandcode` 这类路由 id；两者在悬停提示里同时可见
- **刷新有反馈**：点卡片立刻出现转圈指示并短暂锁定按钮，不再依赖一闪而过的顶部横幅
- **消耗动画**：每次模型调用从卡片飘出一个 `-N` 并轻微抖动，连续消耗连续抖；设置页可关闭
- **限流事件**：模型请求被 429 限流时记录 `retry-after`，随快照返回
- **主题适配**：明/暗色均使用产品 token，暗色下更贴近页面背景

UI 两处：侧边栏设置按钮上方的圆角卡片（`sidebar.footer.action`，点击刷新，5 分钟自动轮询）、插件管理页「Plugins」中的额度监控页（`plugins.item`，仅当 Host 正在提供 `quota-monitor` 命名空间时注册）。

## 安装

从 npm registry 安装（推荐）：

```sh
dsh plugin --profile web add deepseek-harness-quota-monitor
# 然后重启 dsh web 服务
```

> `dsh plugin` 会把参数转发给 pnpm，包名会从 npm registry 拉取。若本机 pnpm 不在 PATH 导致失败，可用 corepack 手动安装（效果相同，之后需手动把包名追加进 profile `package.json` 的 `dsh.profile.bundles`）：
>
> ```sh
> corepack pnpm --dir "$DSH_HOME/profiles/web" add deepseek-harness-quota-monitor
> ```

开发模式（本地目录安装，改动即时生效）：

```sh
dsh plugin --profile web add <本仓库路径>
```

安装后 profile 的 `package.json` 应形如：

```jsonc
{
  "dependencies": { "deepseek-harness-quota-monitor": "link:<本仓库路径>" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "deepseek-harness-quota-monitor"   // ← 必须在这一层里，否则插件不会被挂载
      ],
      "patchReload": "live"
    }
  }
}
```

> 只安装了 `node_modules` 而 `dsh.profile.bundles` 里没有这个名字时，插件不会加载（bundle 层列表就是挂载清单）。这一条是升级后「插件失效」的常见原因之一。

## 快速开始（零配置）

不配置任何东西时：当前默认供应商（`agent-default-model`）如果是 `deepseek-official`，自动用内置余额解析器查询（key 取 `DEEPSEEK_API_KEY` 凭据引用）；其他已注册供应商自动走本地窗口计量（默认窗口 5h / 7d / 1m，无配额上限时只显示用量文本）。

## 配置

设置页「插件 → 额度监控」，或 profile 的 `cordis.patch.yml`，同一套 schema：

```yaml
- insert:
    - id: quota-monitor
      name: deepseek-harness-quota-monitor
      config:
        refreshMs: 300000          # 小组件轮询间隔（毫秒）
        cacheTtlMs: 60000          # 余额查询缓存
        lowBalanceThreshold: 20    # 全局低额阈值
        showTodayUsed: true
        usageAnimation: true       # 额度消耗动画（飘 -N + 抖动），纯视觉
        windows:                   # 全局默认窗口（限额型）
          - { label: 5h, seconds: 18000 }
          - { label: 7d, seconds: 604800 }
          - { label: 1m, seconds: 2592000 }
        providers:
          opencode-go:
            kind: windows
            windows:
              - { label: 5h, seconds: 18000, limitTokens: 100000 }
              - { label: 7d, seconds: 604800, limitTokens: 1000000 }
```

> 行必须放在 `insert:` 块里（新行都是新增，不是覆盖）。插件自身 bundle 的 `cordis.patch.yml` 只插入不带 config 的空行；配置由设置页写入**当前 profile 的 patch 文件**（DSH 0.1.7 起为 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，用 `ctx.profileContext.patchPath` 定位）。

### 每个供应商的字段

| 字段 | 含义 |
|---|---|
| `kind` | `balance`（查询 API）或 `windows`（本地统计） |
| `url` | 余额/用量 API 地址（`windows` 型可留空） |
| `apiKeyEnv` | API Key 的凭据引用（环境变量名），值存于 credentials 域，不进配置 |
| `parse` | JS 解析器，三选一：`builtin` / `source` / `file` |
| `windows` | 该供应商的限额窗口列表 |
| `lowBalanceThreshold` | 该供应商的低额阈值（留空继承全局） |
| `currency` | 金额显示币种（`CNY`/`USD`/…，默认 CNY；预设已带：DeepSeek=CNY、OpenCode GO=USD） |
| `auth` | `bearer`（默认，自动加 `Bearer ` 前缀）或 `raw`（原样发送，如 new-api 的 System Access Token） |
| `headers` | 附加请求头（如 new-api 的 `New-Api-User`） |
| `platform` | 多平台网关的平台选择（sub2api 等） |
| `label` | 卡片上的显示名。留空则用 LLM 路由自己声明的 `displayName`，再退回路由 id |
| `planId` | 套餐 id，用于推导月额度（见 Command Code 一节） |
| `monthlyCredits` | 月额度直接给数字（优先级高于 `planId`） |

> 统计严格**按供应商隔离**：每个供应商的窗口用量、今日已用只计该供应商的调用，互不混算；金额币种取该供应商配置的 `currency`。

> **显示名与路由 id 是两回事**：快照里的 `provider` 始终是路由 id（配置键、凭据作用域、本地计量、`llm/stream` 的 `provider` 字段全按它寻址），卡片另用 `label` 渲染。所以一个叫 `commandcode` 的路由可以显示成「Command Code」而不必改名——悬停时会同时给出两者。解析顺序：配置 `label` → 路由 `displayName` → 预设标签 → 路由 id。

> **编辑器不会丢弃未知字段**：设置页保存时只归一化它自己拥有的字段，其余原样透传（早期版本用手写白名单，导致任何未列出的字段——例如 `planId`——在保存时被静默删除）。

### 供应商预设（一键添加）

设置页「添加供应商」下拉选择后，kind / url / apiKeyEnv / parse **整套填充**，只需填 API Key：

| 预设 | 类型 | 内容 |
|---|---|---|
| `deepseek-official` | 余额 | DeepSeek 官方余额 API + `deepseek-balance` 解析器 |
| `opencode-go` | 限额 | OpenCode GO 用量 API（5h/7d/1m 百分比）+ `opencode-go-usage` 解析器 |
| `commandcode` | 限额 + 余额 | Command Code `GET /alpha/billing/credits`（5h/7d 滚动窗口百分比 + Credits 余额）+ `commandcode-credits` 解析器，见下节 |
| `new-api` | 余额 | one-api 系网关 `GET /api/user/self`（System Access Token，**无 Bearer** + `New-Api-User` 头，quota ÷ 500000 = 美元）+ `new-api-self` 解析器；URL 和用户 id 改成你自己的 |
| `sub2api` | 余额 | 订阅配额网关 `GET /v1/usage`（Bearer）+ `sub2api-usage` 解析器（remaining/unit）；高级：平台配额窗口用 `sub2api-platform-quotas`（1d/7d/1m 美元限额，配 `platform` 字段选平台） |

预设目录由 host 的 `/api/quota-monitor/presets` 提供（设置页拉取，同时返回系统内已注册供应商列表），扩展预设只改 host 一处。

### Command Code

Command Code（`cmd` CLI / [commandcode.ai](https://commandcode.ai)）的余额与滚动窗口**一次请求即可拿全**：

```sh
curl -sS 'https://api.commandcode.ai/alpha/billing/credits' \
  -H "Authorization: Bearer $COMMANDCODE_API_KEY"
```

预设 `commandcode` 已内置该地址与解析器，只需配置 API Key（凭据引用默认 `COMMANDCODE_API_KEY`，也兼容官方的 `COMMAND_CODE_API_KEY`；key 从 [Studio](https://commandcode.ai/studio) 或 `cmd auth login` 写入的 `~/.commandcode/auth.json` 获取）。

真实响应形如（下面是实测抓到的字段）：

```jsonc
{
  "credits": { "monthlyCredits": 55.9, "purchasedCredits": 0, "freeCredits": 0,
               "belowThreshold": false, "creditThreshold": 0 },
  "windowLimits": {
    "limited": true,          // 静态标记「存在窗口」，不是「已被限流」
    "exceeded": null,         // 非 null / 非空 / true 才是真的被限流
    "fiveHour": { "used": 0.45, "cap": 14, "exceeded": false, "resetAt": 1790100955323 },
    "weekly":   { "used": 14.1, "cap": 35, "exceeded": false, "resetAt": 1790315960042 }
  }
}
```

解析器处理的坑：

1. **窗口没有 `percent` 字段** —— 百分比由 `used / cap` 现算；
2. **重置字段是 `resetAt`（epoch 毫秒）**，不是 `resetsAt`；解析器同时容忍 epoch 秒与 ISO 字符串；
3. **`windowLimits` 有时嵌在 `credits` 里**而不是与它平级，解析器两种位置都认；
4. **`exceeded` 有三种形态**：`false` / `null` / 字符串（`""` 或窗口名）。只有明确的 `true` 或非空字符串才算「已用尽」，`null` 按未用尽处理。

#### 月额度（1m 窗口）

**API 没有月窗口对象**——`/alpha/billing/credits` 只给 `monthlyCredits`（**剩余额**），既不给总额也不给 `planId`，所以月额度只能推导。请在供应商配置里声明其一：

```yaml
planId: individual-goat     # 按内置套餐表换算总额
# 或直接给数字（优先级更高）
monthlyCredits: 70
```

内置套餐表（Credits）：Go=10 / GOAT=70 / Pro=30 / pro-v1=80 / Provider=15 / Max=150 / Ultra=300 / Teams=40。

两者都留空则**不显示月条**——宁可少一条，也不拿猜的数字当额度。声明后卡片显示 `余额 $55.9 / $70.00` 加一条 `1m 20.5%` 进度条。

> 订阅接口 `/alpha/billing/subscriptions` 能拿到 `planId`，但本插件**不为它多发一次请求**；需要月条时手写 `planId` 更省事。

> ⚠️ `/alpha/*` 是 Command Code CLI 自己在用的**未公开文档化**接口（官方文档只公开 `/provider/v1/*`），上游可能随时改动，且 **Go 套餐没有 API 权限**（返回 403 `upgrade_required`）。余额字段是**剩余额**而非总额，响应里也没有币种字段（按 USD 显示）。

> 关于 `User-Agent`：早期资料称 Cloudflare 会拒绝无 UA 的请求（403 / error 1010）。**实测不成立**——自定义 UA、仅带 `Authorization`、显式空 UA 三种情况均返回 200。预设仍附带一个说明性 UA（无害），但它不是必需项。

### 添加供应商（系统优先）

设置页「添加供应商」下拉**优先列出系统内已注册的 LLM 供应商**（`ctx.llm.listProviders()` + `listConfigurableProviders()`，如 deepseek-official、pi-ai），**配置键名自动使用其路由 id**——本地流量（瀑布按路由 id 打标）必然归入同名卡片，杜绝手写名字不一致。选中后有预设的自动套预设（如 DeepSeek 余额查询），没有的建空白限额条目（本地计量）。预设方案（如 opencode-go）和手动自定义名保留为兜底（外部订阅账号等）。

### 自动发现

自动发现只覆盖**有确定预设**的供应商（官方 API，如 deepseek-official、opencode-go）：它们自动进入监控列表并按预设查询。**没有预设的供应商不会被自动发现**——自建/自定义网关（如 sub2api 自建站）无法匹配查询配置、也无法判断余额/限额类型，需要时请手动添加。手动配置的 providers 总是叠加监控。可在全局设置关闭自动发现；也可在设置页对**任意供应商单独禁用/启用**（`disabledProviders` 配置，`{ [id]: true }`），禁用的供应商不监控但配置保留。

### JS 解析器三种形态

1. **内置预设**（设置页下拉选择）：

   | 预设 | 适用 | 响应结构 |
   |---|---|---|
   | `deepseek-balance` | DeepSeek 官方余额 | `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }` |
   | `opencode-go-usage` | OpenCode GO 订阅（5h/7d/1m 三窗口百分比） | `{ usage: { rolling\|weekly\|monthly: { percent, resetsAt } } }` |
   | `commandcode-credits` | Command Code（5h/7d 窗口 + Credits 余额，可推导月条） | `{ credits: { monthlyCredits, purchasedCredits, freeCredits, planId? }, windowLimits: { fiveHour\|weekly: { used, cap, exceeded, resetAt } } }`（`windowLimits` 也容忍嵌在 `credits` 下；月条需配置 `planId` 或 `monthlyCredits`） |
   | `generic-balance` | 通用余额：`balance_infos` 数组或扁平 `{ balance\|total_balance\|total\|amount, currency }`（可包在 `data` 下） | 自动识别两种形态 |
   | `generic-percent-windows` | 通用百分比窗口：`{ usage: { <键>: { percent, resetsAt } } }`，任意窗口键 | 键名直用为 label，秒数按 label 匹配配置窗口 |
   | `new-api-self` | new-api 网关 `/api/user/self` | `{ data: { quota, used_quota } }`，单位 ÷ 500000 = 美元 |
   | `sub2api-usage` | sub2api `/v1/usage` | `{ remaining\|quota.remaining\|balance, unit\|quota.unit }` |
   | `sub2api-platform-quotas` | sub2api 平台配额 | `{ data: [{ platform, *_limit_usd, *_usage_usd }] }`，配 `platform` 字段选平台 |

2. **粘贴代码**：`parse: { source: '(raw) => ({ kind: "balance", balance: { currency: raw.balance_infos[0].currency, total: raw.balance_infos[0].total_balance } })' }` —— host 端 `new Function` 执行，输入为查询响应的 JSON。

3. **脚本文件**：`parse: { file: 'C:/quota/opencode-go.js' }` —— 文件默认导出一个 `(raw) => snapshotPart` 函数（ESM 或 CJS 均可）。

解析器返回约定（返回快照片段，未提供的字段省略）：

```js
// 余额型
{ kind: 'balance', balance: { currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00', available: true } }
// 限额型（只补配额上限；已用量恒来自本地计量）
{ kind: 'windows', windows: [ { label: '5h', limitTokens: 100000 } ] }
// 限额型 + 余额：窗口型快照也可带 balance，卡片会在进度条上方一并显示（Command Code 走这条）
{ kind: 'windows', windows: [ { label: '5h', percent: 32.1, limitMoney: 14, usedMoney: 4.5, resetsAt: '…', exceeded: false } ],
  balance: { currency: 'USD', remaining: '52.5', total: '70' } }
```

### 示例：带用量 API 的限额型供应商

假设某供应商用量 API `GET https://api.xxx.com/v1/usage` 返回：

```json
{ "limits": [ { "period": "5h", "limit": 100000 }, { "period": "7d", "limit": 1000000 } ] }
```

配置：

```yaml
providers:
  xxx:
    kind: windows
    url: https://api.xxx.com/v1/usage
    apiKeyEnv: XXX_API_KEY
    parse:
      source: '(raw) => ({ kind: "windows", windows: raw.limits.map(w => ({ label: w.period, limitTokens: w.limit })) })'
```

侧边栏显示「5h 12k/100k · 7d 210k/1M」，进度条着色按 70%/90% 阈值。

## 快照模型

`GET /api/quota-monitor` 返回当前（默认）供应商与全部已配置供应商的快照数组：

```ts
{
  provider: string,
  kind: 'balance' | 'windows',
  balance?: { currency, total, granted?, toppedUp?, available },
  windows?: [{ label, seconds, limitTokens?, limitRequests?, percent?, resetsAt?, usedTokens, usedRequests }],
  todayUsed?: { tokens, requests, cacheRatio?, cost?, byModel?, series? },  // DSH 本地自然日用量；cost 仅当供应商 usage 返回价格时存在；series 为 24 小时桶（t/i/o/c）供折线图
  lastRateLimit?: { at, retryAfterMs },
  fetchedAt: number,
  error?: string                   // no-key | no-url | network | http-<status> | bad-json | parse:<msg>
}
```

## 接口与适配要点

### 设置：声明式 `Config`（0.1.7 起）

**没有注册调用**——插件导出 `Config` schema 就是注册本身，设置服务读取该 schema 并投影成表单。两个要点：

1. **`apply(ctx, config)` 收到的是 `Volatile` 包装**，不是普通对象；读取用 `config.get()`，且它每次返回最新已提交的分区（无需自己维护 `onChange`）。
2. **根级 `.volatile()` 是必需的，不是装饰**。schemastery 明确拒绝 `dict`/`array` 之下的 volatile 字段（报 `volatile fields require a fixed object path without an enclosing volatile field`），而本插件的 `providers` 是动态 map、下面还嵌着窗口数组——逐字段标记根本无法表达。标记**根节点**即可让其下所有路径（含 `providers.<名>.url`）可实时编辑。

### 端点：认证 `/api` 通道

host 端点都挂在**经认证的 `/api` 通道**上——`/api` 前缀整体由 `@deepseek-ai/dsh-client-connection` 接管，先做 Host/Origin 信任检查与浏览器会话认证，再分发。因此插件端点用 `ctx.connection.fetch.register` 注册为**精确 Fetch 路由**：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/quota-monitor` | GET | 快照数组，`?provider=<id>` 只取一个 |
| `/api/quota-monitor/events` | GET | SSE：每次模型调用的 token 增量（仅供动画） |
| `/api/quota-monitor/presets` | GET | 供应商预设 + 系统内已注册 LLM 供应商 |
| `/api/quota-monitor/settings` | GET | 只读的自动发现供应商列表（配置读写走 Remote，见下） |
| `/api/quota-monitor/profile-provider` | POST | 从 profile patch（base 层）移除供应商 |

**配置读写**不走自有端点，而走 DSH 自带的 Remote 设置通道：`ctx.remote.settings.describe()` 读、`ctx.remote.settings.mutate(ns, ops, revision)` 写（带 revision 冲突检测，过期写入被拒绝而不是覆盖）。API Key 同理走 `ctx.remote.credentials.{describe,set,unset}`，明文永不回传。

> 旧的 `ctx.webServer.register({ path: '/api/...' })` 写法会被 connection 的 `/api` 前缀路由遮蔽并返回 **401**——这是升级后端点全部 401 的原因。

### 客户端插槽

配置页注册到 `plugins.item`（**不再是** `settings.plugin.item`），并用 `ctx.configForms.whileServed([ns], …)` 包裹：命名空间未被 Host 提供时不留任何痕迹。该插槽对每个条目渲染两次——`view: 'summary'` 取卡片一行简介，`view: 'page'` 取详情正文——所以组件必须两种情况都能答。

客户端 `inject` 必须逐个列出所用面（嵌套命名空间不会隐式带出根服务）：`slots`、`connection`、`remote`、`remote.settings`、`remote.credentials`、`configForms`。

### 消耗动画与实时推送（SSE）

卡片需要一个「刚刚花了多少」的**实时**信号，而 host 侧本来就有：`llm/stream` 瀑布逐个 usage 块采集用量，插件早就在监听它记账。

问题在于怎么推给浏览器。**没有用 `ctx.remote.$on`**，因为那套事件是一份**编译期固定白名单**——`API_REMOTE_FORWARDED_EVENTS` 定义在 `@deepseek-ai/dsh-api-remotes` 里，第三方 bundle 无法往里加键。

所以改用 **SSE**（`GET /api/quota-monitor/events`）。这不是绕路，而是被支持的通道：

- 连接层的 http↔fetch 桥接**逐块转发 `response.body`**（带背压与 drain 处理），流式响应不会被攒成一坨；
- web server 明确对 `text/event-stream` **豁免 gzip 压缩**（否则压缩中间件会缓冲整个流），说明流式响应是预期用法。

两条关键约束：

1. **流里没有任何账目**。帧只携带一次调用的 token 增量，卡片上的每个数字仍然来自快照端点。连接断掉只损失动画，不损失准确性。
2. **开关在 host 侧就拦掉发布**（`usageAnimation === false` 时 `publishUsage` 直接返回），所以关掉动画后每次模型调用不产生任何序列化开销，而不只是「推了但前端不画」。

动画本身：每次事件在卡片右上角生成一个绝对定位的 `-N`，1.15s 向上飘散淡出；同时给卡片加 `.qm-cardShake` 触发 0.45s 抖动。抖动通过**移除 class → 强制 reflow → 重新加回**来保证每个事件都从零重放（否则重复加同名 class 是空操作），所以连续消耗会读作持续颤动。并发飘字上限 5 条，防止并行子代理时叠成一片；`prefers-reduced-motion` 下抖动关闭、飘字退化为原地淡出。

刷新反馈：手动刷新会显示 `.qm-spinner` 并禁用按钮，且**至少保持 450ms**——本机往返可能几毫秒就结束，短于一个渲染帧，用户会以为「点了没反应」，这正是原来那个 toast 想解决却解决得不好的问题。

### profile patch 移除

profile patch 的移除是**逐字编辑**：js-yaml 能读 `!!js` 表达式但**不能写出**该标签，整文件 `load → dump` 会把用户 patch 里的 `!!js` 表达式改写成普通映射。所以这里用 js-yaml 判断「这一行确实声明了该供应商」，再按缩进从原文删掉那一个条目的字节，其余行保持逐字不变；上游 `providers:` / `config:` 变空时一并清理，避免留下会解析成 `null` 的空键。

patch 文件位置从 `ctx.profileContext.patchPath` 取（0.1.7 起 profile 在 `$DSH_HOME/profiles/<name>/`，不再是 `$DSH_HOME/settings.yaml` 那种写法）。

## 开发与测试

目录结构：

```
deepseek-harness-quota-monitor/
├── lib/
│   ├── index.js          # host 端：计量、查询、解析器、预设、设置与路由
│   ├── patch.js          # profile patch 的逐字编辑（无 harness 依赖，可单测）
│   └── client.js         # client 端：侧边栏 widget + 插件配置页（CJS bundle）
├── cordis.patch.yml      # 默认挂载条目
├── test/
│   ├── verify-quota-e2e.mjs            # host 端到端：volatile Config、Fetch 路由、快照、瀑布计量、SSE 用量流、patch 移除
│   ├── verify-commandcode-parser.mjs   # CommandCode 解析器（嵌套 windowLimits / epoch 换算 / 套餐推导）
│   └── verify-patch-rewrite.mjs        # profile patch 逐字编辑（嵌套 insert / 裸行 / !!js 保留 / 幂等）
└── package.json
```

> 测试**不得**写入真实用量账本：`verify-quota-e2e.mjs` 通过 `settings.documentPath` 与 `profileContext.patchPath` 把存储重定向到临时目录（`$DSH_HOME/storages/quota-monitor-usage.jsonl` 是用户的额度历史，误写不可逆）。

运行测试（无需网络与凭据，`js-yaml` 从 DSH 安装目录解析）：

```sh
cd test
node verify-quota-e2e.mjs
node verify-commandcode-parser.mjs
node verify-patch-rewrite.mjs
```

验证真实 DSH 挂载（隔离 home，不影响正在运行的 GUI）：

```sh
# 1. 用独立 DSH_HOME 从内置模板建一个临时 profile
$env:DSH_HOME = "<临时目录>"
dsh rescue --from-default-profile web
# 2. 把本插件装进该 profile（link: 指向本仓库）
dsh plugin --profile rescue add "link:<本仓库路径>"
# 3. 用另一个端口启动；--no-open 是必须的，否则会弹出浏览器窗口
dsh rescue --port 3199 --no-open
# 4. 浏览器打开打印出的带 token URL：侧边栏出现额度卡片
#    插件管理页 Plugins 出现「额度监控」页
```

## 已知边界

- 本地计量只统计经过 DSH 的请求（其他工具用同一 key 的用量不计入）
- 响应头级配额（`x-ratelimit-*`）目前拿不到（llm 抽象层不暴露），限流信息来自 429 错误
- 侧边栏折叠态只显示第一个（默认）供应商的紧迫信息
- 余额查询结果有 60s 缓存（`cacheTtlMs`），修改配置后最多 60s 内生效
- 配置页内的编辑是**暂存式**：改完点「保存」才写入；供应商启用/禁用与删除是即时写入
- 消耗动画是**装饰**：它由实时事件驱动，卡片数字仍按 `refreshMs` 更新，所以动画出现后额度数字可能要等下一次刷新才变；关闭动画不影响任何统计
- 动画依赖一条常驻 SSE 连接（每开一个页面一条，空闲时 25s 一次心跳）；连接不可用时只是没有动画
- Command Code 的 `/alpha/*` 为未公开接口；其「月窗口」是按 `planId`/`monthlyCredits` 推导而非 API 返回值，未声明时不显示月条
- 卡片上的名字取自路由 `displayName` 或配置 `label`；本地计量与配置键**始终**按路由 id 寻址，改名不影响统计

## 友情链接

- [LINUX DO](https://linux.do) —— 技术社区

## License

[MIT](./LICENSE)
