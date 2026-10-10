# catpawrunner

一个基于 Fastify 的 Node.js 服务，用于：

- 提供 `/config` / `/spider/...` 等接口（与“在线脚本 runtime”协作运行）
- 提供内置网盘解析 API（Quark / UC / 139 / Baidu / Tianyi-189）
- 提供 mock 拦截 + 记录日志（用于适配网盘解析，不真实发包）

> 说明：本文档以“运行目录（runtime root）”为基准。开发时通常就是你启动 `npm run dev` 的那个目录（例如 `catpawrunner/` 或你自己的打包 exe 同目录）。

## 启动

### 环境要求

- 推荐 Node.js `18.x ~ 22.x`（`package.json` 里声明 `>17 <23`）

### 开发启动

```bash
cd catpawrunner
npm i
npm run dev
```

默认监听 `0.0.0.0:9988`，也可以用环境变量改端口：

- `PORT=xxxx`
- `DEV_HTTP_PORT=xxxx`

## 运行目录文件

### `config.json`

位置：运行目录根下的 `config.json`

常用字段：

- `proxy`: 全局代理（字符串，空串表示不启用）
- `siteProxy`: 按“站点”走代理（对象；key 为站点名，value 为代理地址字符串；空串表示该站点强制不走代理）
- `pan_mock`: 是否开启“网盘 mock/拦截”（布尔；启动时若缺失会自动写回 `false`；支持运行中切换）
- `packet_capture`: 是否开启“在线脚本出站抓包”（布尔；仅抓子进程脚本发出的 `fetch/http/https` 请求，不含客户端入站请求）
- 支持的网盘始终由内置实现接管；`pan_mock=false` 由 Runner 完成列表/播放，`pan_mock=true` 将标准分享链接交给 MeowFilm 完成列表/播放。旧的 `panBuiltinResolverEnabled` / `panResolver` 开关不再生效。
- `onlineConfigs`: 在线脚本配置（会下载到 `custom_spider/` 并启动子进程 runtime）

可通过管理接口查看/修改：

- `GET /admin/settings`
- `PUT /admin/settings`

#### `siteProxy` 示例

```json
{
  "proxy": "http://127.0.0.1:7890",
  "siteProxy": {
    "*": "http://127.0.0.1:7890",
    "某个站点": "",
    "另一个站点": "http://127.0.0.1:7891"
  }
}
```

优先级（从高到低）：

1. `siteProxy[站点名]`（存在即生效；空串表示禁用代理）
2. `siteProxy["*"]`
3. `proxy`（全局）

> 站点名来自请求路径 `/spider/<site>/...` 中的 `<site>`。

> `pan_mock`：可通过 `PUT /admin/settings` 在不重启 online runtime 子进程的情况下切换 mock 拦截开关（通过 IPC 下发配置，通常秒级生效）。

### `db.json`

位置：运行目录根下的 `db.json`

用于保存部分网盘的 cookie / token（由 API 或脚本逻辑写入/读取）。

### `custom_spider/`

位置：运行目录根下的 `custom_spider/`

在线脚本 runtime 会从这里选择入口脚本运行（优先 `custom_spider/0119.js`，否则按目录内第一个 `*.js|*.cjs|*.mjs`）。

`onlineConfigs` 生效时，会把远程脚本下载到 `custom_spider/` 并自动拉起/重启对应 runtime。

入口函数默认会自动挑选一个全局启动函数并调用（兼容 `Ndr` 及打包压缩后的函数名）。如遇到无法自动识别/启动，可在 `onlineConfigs` 单项里配置 `entryFn`（或设置环境变量 `ONLINE_ENTRY_FN`）指定实际要调用的全局函数名。

### 手动重启单份配置

`POST /admin/online-configs/restart`，请求体：`{ "id": "<配置 ID>" }`。

- 不限制配置原来的状态；先结束该配置的旧 runtime 子进程，再启动新实例，不重启主程序或其他配置。
- 优先使用本地脚本，文件缺失时才下载；不等同于“更新”，不改变最后更新时间和更新状态。
- 返回 `202`、`pending: true` 表示任务已提交；同一配置重启期间重复请求返回 `skipped: true`，不会重复排队。
- 通过 `GET /admin/settings` 读取结果：配置状态由 `checking` 变为 `pass` 或 `error`，失败原因见 `message`。启动失败不会恢复旧进程。
- 必须指定已保存的配置 ID；缺失返回 `400`，不存在返回 `404`，不会重启全部配置。

### 按脚本协议同步网盘账号

MeowFilm 仍调用 `POST /admin/pan/sync`，请求格式保持 `{ "pans": { "<账号标识>": { ... } } }`。无需修改站源或脚本原生路由。

脚本启动后自动通过只读请求识别管理协议；重启、更新替换进程时重新识别，未知类型在同步时重试。`GET /admin/settings` 的配置项 `scriptType` 返回：

- `website-v1`：通过 `/website/pans/list` 识别，账号同步前检查对应原生读取接口，再调用 `/website/{网盘}/cookie` 或 `/account`。
- `website-api-v1`：通过 `/website/api/credentials` 识别支持的账号字段，再调用原生 `/website/api/...` 保存接口。
- `detecting` / `unknown`：识别中或未匹配，不向未知接口发送凭据；不影响视频脚本运行。

映射定义集中在 `src/util/onlineScriptAdapters.js`，包括协议识别条件、账号标识、原生路径及字段转换。例如新协议中 `115` 对应 `pan115`，`189` 对应 `pan189`，账号字段 `username` 转为 `account`。增加其他协议只需增加对应适配定义，不按作者名或脚本文件名判断。

同步规则：

- 保留 CatPawRunner 内置账号的 `config.json` 保存逻辑；即使没有脚本运行也可保存。
- 每份支持该账号的运行中脚本都通过自己的保存接口同步，不直接改脚本的 `db.json`。一个脚本失败不会阻止其他脚本保存。
- 两种已适配协议均没有可直接导入本项目 `139 authorization`、`quark_tv` 或 `uc_tv` 的 `refresh_token + device_id` 的兼容映射，所以这些账号目前仅供内置解析使用。旧脚本的 UC-TV 扫码接口、新脚本的 `new139` 短信登录不等同于凭据导入接口，不混用。
- 不支持的账号或缺失的原生接口跳过；保存失败、要求短信确认会明确报告，不视为同步完成。
- 保留 `okCount` / `failCount` / `results` 返回格式，并在每个结果附加 `builtin` 和 `scripts`，区分内置保存与各配置的同步结果。计数按账号项统计，任何一次实际保存失败，该账号计入 `failCount`；全部跳过不计成功。

## 内置网盘 API

这些接口主要用于：

- `POST /api/<provider>/list`：用 `flag` 获取一份 0119 风格的 `vod_play_url`
- `POST /api/<provider>/play`：把 `vod_play_url` 里的 `id` 转成可播放直链（或中转链）

### Quark（夸克）

- `POST /api/quark/list`：`{ "flag": "夸父-<shareId>", "passcode"?: "" }` → `{ ok, vod_play_url }`
- `POST /api/quark/play`：`{ "id": "..." }` → `{ ok, url, headers }`

### UC（优夕）

- `POST /api/uc/list`：`{ "flag": "优夕-<shareId>", "passcode"?: "" }` → `{ ok, vod_play_url }`
- `POST /api/uc/play`：`{ "id": "..." }` → `{ ok, url, headers }`

### 139（移动云盘/和彩云 OutLink）

- `POST /api/139/list`：`{ "flag": "逸动-<linkID>" }` → `{ ok, vod_play_url }`
- `POST /api/139/play`：`{ "id": "...", "want"?: "download_url"|"play_url" }` → `{ ok, url, headers }`（默认 `download_url`）
  - `vod_play_url` 展示名为 `目录路径/文件名`（根目录显示为 `/文件名`；若根目录仅 1 个文件夹会自动下沉为根目录）。

### Baidu（百度网盘）

- `POST /api/baidu/list`：`{ "flag": "百度*-<surl>#...", "pwd"?: "" }` → `{ ok, vod_play_url }`
- `POST /api/baidu/play`：`{ "id": "..." }` → `{ ok, url, headers }`

### Tianyi 189（天翼云盘 / cloud.189.cn）

- `POST /api/189/list`：`{ "flag": "天意-<shareCode>", "shareCode"?: "<shareCode>", "accessCode"?: "" }` → `{ ok, vod_play_url, shareId }`
  - `vod_play_url` 的 `id` 为 `<fileId>*<shareId>*<fileName?>`
- `POST /api/189/play`：`{ "id": "<fileId>*<shareId>*<fileName?>", "accessCode"?: "" }` → `{ ok, url }`

辅助接口（调试/适配用）：

- `POST /api/189/share/info`
- `POST /api/189/share/list`
- `POST /api/189/file/download`

## Mock 拦截（仅用于“子进程 online runtime”）

用途：当你需要“保留线路/flag 展示”，但不希望脚本真的去请求网盘 API 时，开启 mock 拦截，让请求直接返回占位数据，并记录日志用于分析“脚本到底请求了什么”。

### 开启方式（推荐：config.json）

通过 `PUT /admin/settings` 设置：

- `pan_mock: true|false`

该开关会通过 IPC 下发到 online runtime 子进程（不需要重启子进程）。

### 开启方式（环境变量，备用）

在启动 `npm run dev` 前设置：

- `CATPAW_MOCK=1`：开启 mock
- `CATPAW_MOCK_DEBUG=1`：写入 debug 日志（jsonl）
- `CATPAW_MOCK_PROVIDERS=quark,uc,139,baidu,tianyi`：指定要拦截的网盘（逗号分隔）
  - 也可用 `CATPAW_MOCK_PROVIDER=quark` 指定单个
- `CATPAW_MOCK_DIR=debug_log`：日志目录（可选；相对路径会基于运行目录）

示例：

```bash
CATPAW_MOCK=1 CATPAW_MOCK_DEBUG=1 CATPAW_MOCK_PROVIDERS=quark,uc,139,baidu,tianyi npm run dev
```

### 日志位置与格式

日志默认写到：

- `debug_log/<provider>-intercept.<onlineId>.log`

其中：

- `<provider>`：`quark|uc|139|baidu|tianyi`
- `<onlineId>`：来自在线配置的 `id`（例如 `3b7108d3a7`）

日志为 JSONL（每行一个 JSON），常见 `type`：

- `http` / `fetch`：脚本尝试访问网盘 API 的请求信息
- `mock`：返回了哪类 mock 响应（例如 token / detail_placeholder）

## 在线脚本抓包（出站流量）

用途：排查自定义脚本实际发了哪些网络请求（包括请求头/请求体、响应状态/响应体摘要）。

开启方式：

- `PUT /admin/settings` 设置 `packet_capture: true`
- 或在 `config.json` 中手动设置 `"packet_capture": true`

抓包日志默认写入：

- `net/<domain>.net`（按域名分文件，例如 `net/pan.baidu.com.net`）

说明：

- 仅记录 online runtime 子进程发起的出站请求（`fetch/http/https`）。
- 不记录客户端打到 catpawrunner 的入站请求及其回包。
- 记录格式为类 Fiddler 文本块，包含：请求方法、请求路径、请求 payload、响应内容（含状态与头）。
- `pan_mock` 与抓包开关独立：当 `pan_mock` 命中拦截时，抓包记录会标注 `PanMockIntercepted: true`。
- 若请求或响应带 `content-encoding`（如 `gzip/deflate/br`），抓包会自动尝试解码后再写入。
- 为避免日志过大，请求/响应体会截断（默认最多 16KB，文本中会标出 `truncated=true`）。

### 占位文件名（用于把“分享码/提取码”带回脚本侧）

mock 会在“分享列表”里返回一个占位视频文件（保证脚本能生成 `vod_play_url`）：

- `tianyi`：`<shareCode>-<accessCodeOrNopass>.MP4`
- 其他网盘：`<passcodeOrNopass>.mp4`

占位文件名只保留安全字符（非字母数字会被替换为 `_`）。

## error.log（提取码缺失提示）

当某些分享需要提取码/访问码但未提供时，内置 API 会把关键信息写入运行目录的 `error.log`（用于你后续补全适配/抓包）。

---

### 快速 curl 测试

只看 `vod_play_from` / `vod_play_url`：

```bash
curl -sS -X POST 'http://127.0.0.1:9988/<runtimeId>/spider/<site>/<ver>/detail' \
  -H 'content-type: application/json' \
  --data '{"id":"..."}' | jq -r '.. | objects | .vod_play_from? // empty, .. | objects | .vod_play_url? // empty'
```
