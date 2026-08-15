# deepseek-harness-quota-monitor

DeepSeek Harness 多供应商额度监控插件。侧边栏实时卡片 + 设置页可视化配置，支持**余额型**（主动查询供应商 API）与**限额型**（本地滑动窗口计量）两类额度模型。

## 特性

- **余额型**：主动查询供应商余额/用量 API（地址 + API Key 引用 + JS 解析器），如 DeepSeek 官方 `GET /user/balance`
- **限额型**：本地滑动窗口用量统计（5h / 7d / 1m 等，按 `llm/stream` 瀑布采集真实 token 用量，持久化到 `$DSH_HOME/storages/quota-monitor-usage.jsonl`），对照配额上限显示剩余
- **今日已用**：自然日桶，跨重启保留；主数字含缓存（输入 + 输出 + 缓存读），附输入/输出/缓存分项与缓存命中率（3 位小数）
- **翻转卡片**：点击今日已用区翻转 3D 卡片，查看**输入/输出/缓存三线小时折线图**（平滑曲线、峰值标注）
- **自动发现**：系统内已注册的 LLM 供应商自动进入监控列表（有预设的自动套预设查询，没有的走本地计量）
- **预设一键添加**：`deepseek-official` / `opencode-go` / `new-api` / `sub2api` 等整体方案，选中即填好 kind/url/解析器
- **金额按供应商实报**：供应商在 usage 里返回价格才显示金额（无价格表、不推断），按模型明细展示
- **限流事件**：模型请求被 429 限流时记录 `retry-after`，随快照返回
- **主题适配**：明/暗色均使用产品 token，暗色下更贴近页面背景

UI 两处：侧边栏设置按钮上方的圆角卡片（`sidebar.footer.action`，点击刷新，5 分钟自动轮询）、设置页「额度监控」区块（`settings.section`）。

## 安装

```sh
# <路径> 指向本插件目录
dsh plugin --profile web add <路径>/deepseek-harness-quota-monitor
# 然后重启 dsh web 服务
```

> `dsh plugin` 会把参数转发给 pnpm。若本机 pnpm 不在 PATH 导致失败，可用 corepack 手动安装（效果相同，之后需手动把包名追加进 profile `package.json` 的 `dsh.profile.bundles`）：
>
> ```sh
> corepack pnpm --dir "$DSH_HOME/profiles/web" add "<路径>/deepseek-harness-quota-monitor"
> ```

## 快速开始（零配置）

不配置任何东西时：当前默认供应商（`agent-default-model`）如果是 `deepseek-official`，自动用内置余额解析器查询（key 取 `DEEPSEEK_API_KEY` 凭据引用）；其他已注册供应商自动走本地窗口计量（默认窗口 5h / 7d / 1m，无配额上限时只显示用量文本）。

## 配置

设置页「额度监控」或 profile 的 `cordis.patch.yml`，同一套 schema：

```yaml
- id: quota-monitor
  name: deepseek-harness-quota-monitor
  config:
    refreshMs: 300000          # 小组件轮询间隔（毫秒）
    cacheTtlMs: 60000          # 余额查询缓存
    lowBalanceThreshold: 20    # 全局低额阈值
    showTodayUsed: true
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

> 统计严格**按供应商隔离**：每个供应商的窗口用量、今日已用只计该供应商的调用，互不混算；金额币种取该供应商配置的 `currency`。

### 供应商预设（一键添加）

设置页「添加供应商」下拉选择后，kind / url / apiKeyEnv / parse **整套填充**，只需填 API Key：

| 预设 | 类型 | 内容 |
|---|---|---|
| `deepseek-official` | 余额 | DeepSeek 官方余额 API + `deepseek-balance` 解析器 |
| `opencode-go` | 限额 | OpenCode GO 用量 API（5h/7d/1m 百分比）+ `opencode-go-usage` 解析器 |
| `new-api` | 余额 | one-api 系网关 `GET /api/user/self`（System Access Token，**无 Bearer** + `New-Api-User` 头，quota ÷ 500000 = 美元）+ `new-api-self` 解析器；URL 和用户 id 改成你自己的 |
| `sub2api` | 余额 | 订阅配额网关 `GET /v1/usage`（Bearer）+ `sub2api-usage` 解析器（remaining/unit）；高级：平台配额窗口用 `sub2api-platform-quotas`（1d/7d/1m 美元限额，配 `platform` 字段选平台） |

预设目录由 host 的 `/api/quota-monitor/presets` 提供（设置页拉取，同时返回系统内已注册供应商列表），扩展预设只改 host 一处。

### 添加供应商（系统优先）

设置页「添加供应商」下拉**优先列出系统内已注册的 LLM 供应商**（`ctx.llm.listProviders()` + `listConfigurableProviders()`，如 deepseek-official、pi-ai），**配置键名自动使用其路由 id**——本地流量（瀑布按路由 id 打标）必然归入同名卡片，杜绝手写名字不一致。选中后有预设的自动套预设（如 DeepSeek 余额查询），没有的建空白限额条目（本地计量）。预设方案（如 opencode-go）和手动自定义名保留为兜底（外部订阅账号等）。

### 自动发现

已注册的 LLM 供应商自动进入监控列表：有预设的自动按预设查询，没有预设的自动走本地窗口计量。手动配置的 providers 总是叠加监控。可在全局设置关闭。

### JS 解析器三种形态

1. **内置预设**（设置页下拉选择）：

   | 预设 | 适用 | 响应结构 |
   |---|---|---|
   | `deepseek-balance` | DeepSeek 官方余额 | `{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }` |
   | `opencode-go-usage` | OpenCode GO 订阅（5h/7d/1m 三窗口百分比） | `{ usage: { rolling\|weekly\|monthly: { percent, resetsAt } } }` |
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

## 开发与测试

目录结构：

```
deepseek-harness-quota-monitor/
├── lib/
│   ├── index.js          # host 端：计量、查询、解析器、预设、路由
│   └── client.js         # client 端：侧边栏 widget + 设置页（CJS bundle）
├── cordis.patch.yml      # 默认挂载条目
├── test/
│   ├── verify-quota-e2e.mjs   # 端到端：mock ctx 驱动 host，验证余额/窗口/今日统计/设置读写
│   └── verify-patch-rewrite.mjs # profile patch 改写 round-trip（!!js 表达式保留）
└── package.json
```

运行测试：

```sh
cd test
node verify-quota-e2e.mjs
node verify-patch-rewrite.mjs
```

> e2e 需要真实凭据（读 `~/.dsh/.credentials.yaml` 的 OPENCODE_API_KEY / DEEPSEEK_API_KEY）；用量存储写入系统临时目录，不污染真实数据。

## 已知边界

- 本地计量只统计经过 DSH 的请求（其他工具用同一 key 的用量不计入）
- 响应头级配额（`x-ratelimit-*`）目前拿不到（llm 抽象层不暴露），限流信息来自 429 错误
- 侧边栏折叠态只显示第一个（默认）供应商的紧迫信息
- 余额查询结果有 60s 缓存（`cacheTtlMs`），修改配置后最多 60s 内生效

## License

[MIT](./LICENSE)
