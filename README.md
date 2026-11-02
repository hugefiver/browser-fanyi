# 网页译读

独立实现的 Chromium / Firefox 网页翻译扩展。用户主动启动后，将普通展示文本发送到自己配置的 OpenAI 兼容 Chat Completions 服务。没有内置服务、默认模型、账户、遥测或云同步。

## 安装

先使用 PATH 中的 Node.js 与 pnpm：

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

设置页为随扩展打包的 React + MUI 本地静态页面，无需启动应用服务器。

### Chromium / Edge

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启开发者模式，选择“加载解压缩的扩展”。
3. 选择本项目 `dist/chromium` 目录。
4. 固定工具栏图标，打开设置配置服务。

### Firefox

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 选择“临时载入附加组件”，打开 `dist/firefox/manifest.json`。
3. 接受所声明的网页文本及服务认证信息传输范围，然后配置服务。

临时扩展在 Firefox 退出后卸载；此产物未签名、未发布，不能当作已签名的商店安装包。Firefox 使用非持久后台页面，Chromium 使用 service worker。

## 配置与使用

1. 在设置中填写 **API 前缀地址**与**模型标识**，按服务要求填写可选密钥。前缀后自动追加 `/chat/completions`，例如本机服务前缀 `http://127.0.0.1:8000/v1`。
2. 点击“保存设置”：仅保存本机配置，不发送文本。
3. 点击“授权主机权限”：浏览器单独询问是否允许访问所选服务主机，不进行连接测试。
4. 点击“测试服务连接”：向已保存并已授权的服务发送固定文本 `Hello.`。此操作可能计费。
5. 打开普通网页，通过扩展工具栏选择“开始翻译”。双语与仅译文之间切换复用当前成功结果。
6. 暂停保留已有译文；继续处理未完成和新内容；“重试失败”只重试失败片段；还原撤销扩展显示，不回退网站状态。
7. 选中网页文字后使用右键菜单或工具栏选区按钮。结果在扩展本地页面显示，点击复制才写入剪贴板。

云端地址仅允许 HTTPS。HTTP 只接受明确的 `localhost` 或 `127.0.0.1`，不接受局域网或其他本机别名。地址不能带用户名、密码、查询或片段。浏览器主机授权不区分端口；实际请求仍使用你保存的完整地址。更换服务 origin 会清除旧密钥，新接收方需要重新填写密钥。

无密钥的本机服务也可使用。连接测试成功只表示这次接口返回了有效文本，无法保证翻译质量、后续额度或所有模型行为。

## 数据、权限与限制

- 只在主动操作后发送所需文本及语言参数；不附带网页 URL、标题、Cookie 或浏览历史。
- 默认跳过脚本、样式、隐藏文字、表单字段和可编辑草稿。显式选择的文字仍可能包含个人信息，请自行确认接收方与费用。
- 密钥保存在扩展 origin 的 IndexedDB，不进内容脚本、浏览器同步或日志。本机存储不是加密保险箱，无法抵御本机恶意软件。
- 原文与译文只在当前会话内存中保存，不持久缓存。清除配置后不再使用原凭据发出新请求，不能撤回服务端已收到的数据。
- `activeTab` / `scripting` 用于主动访问当前顶层网页；服务主机按需授权。`webNavigation` 用于结束活动会话的完整或 SPA 导航，不保存导航记录。剪贴板权限仅用于主动复制，不读取剪贴板。
- 单片最多 2000 个 Unicode 字符；长文本节点完整分片。每次主动网页操作最多 100 次请求，达到上限需点击继续。并发上限 2，远程请求超时 25 秒，无自动重试。选区超过 2000 字符请缩小范围。
- 不覆盖浏览器系统页、受限商店页面、iframe、Shadow DOM 或已卸载的虚拟列表历史内容。不含自动站点翻译、字幕、OCR、图片、文件、输入写回、账户与云同步。
- 网站文字更新会使旧译文失效；还原保留原节点、网站新内容、事件和输入。暂停、还原或导航后迟到结果不会写入页面；已经发送的远程请求可能已被处理或计费。
- 刷新、SPA 导航或后台中断后需主动重新启动。扩展面板关闭不等于暂停网页会话。

## 开发与验证

- `src/shared`：公开合同及服务地址规则。
- `src/background`：平台入口、权限、配置、服务请求和选区任务。
- `src/content`：文本采集、动态更新、队列与无损显示。
- `src/ui`：本地设置、工具栏和选区页面。
- `tests`：独立虚构数据与确定性回归。
- `node scripts/browser-test.mjs`：Playwright 配套 Chromium、全新隔离 profile、本机受控服务的真实扩展验收；使用 Playwright/CDP 加载扩展，Windows UI Automation 确认原生主机授权。
- `node scripts/firefox-check.mjs`：使用 Playwright 安装的 Firefox，通过其内置 WebDriver BiDi 临时安装扩展并验证行为；不使用用户 profile。

先显式安装配套浏览器，再运行验证：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $PWD '.playwright-browsers'
node node_modules/playwright-core/cli.js install chromium firefox
node scripts/browser-test.mjs
node scripts/firefox-check.mjs
```

浏览器下载保存到项目专用缓存，验证脚本不会自行下载。测试会短暂打开独立窗口。受控服务仅监听 `127.0.0.1`，返回带前缀的测试文本；它不是翻译模型。

### 验证状态

| 验证层级 | 实际结果 |
|---|---|
| Vitest | 全量 99 项通过；随后增加 SPA 授权回归，受影响的 controller 文件 15 项全部通过。当前共 100 项行为测试。 |
| TypeScript | `tsc --noEmit` 通过。 |
| 双平台 Vite 构建 | `dist/chromium`、`dist/firefox` 均构建成功。 |
| Playwright Chromium 156.0.8078.4 | 安装成功；使用 Playwright/CDP 实际加载扩展。设置与原生授权、受控服务、网页翻译、模式、动态内容、暂停/继续、失败重试、还原、选区复制、SPA 重启、凭据隔离、service worker 停止/唤醒、撤权及清除全部通过。 |
| Playwright Firefox 157.0 | 下载成功，扩展验收阻塞。配套浏览器在加载扩展前崩溃、提前退出或启动连接超时；独立 Playwright 空白启动同样失败。有界面日志包含 GPU 子进程 `0x80070005` 及退出码 `3221225477`；未关闭浏览器沙箱或改动全局策略，不能认定扩展验证通过。 |
| Edge 156.0.4314.58 | 空白隔离 profile；实际加载、设置页面、原生主机授权、受控连接测试、工具栏授予 activeTab、网页翻译、两模式切换、事件和输入保持、动态增改、暂停/继续、失败部分重试、无损还原、选区显示/主动复制、SPA 停止及重新启动均通过。 |
| Edge 生命周期与隔离 | 实际停止 service worker 并唤醒后清除旧显示、不重新发送；撤销服务权限后停止发送；清除配置；实际内容脚本不能读取凭据库或特权设置。受控 Cookie 不随服务请求发送。 |
| Firefox Nightly 161.0a1 | 全新隔离 profile 与内置 BiDi 实测通过：临时安装、运行中的 DOM event page、本地消息、无密钥配置、未授权拒绝、主机授权、受控服务、扩展菜单授予 activeTab、网页翻译、缓存模式切换、动态文本、暂停/继续、失败部分重试、无损还原、选区结果/主动复制、SPA 停止/重新启动及权限撤销后零新增请求。 |
| Mozilla 官方发行版 | 未验证官方安装包；Playwright 配套测试构建的结果不等同于 Mozilla 官方发行版验证。 |
| 真实外部服务 | 未使用真实凭据、未调用收费服务，未验证连通性或翻译质量。受控服务的前缀输出仅证明协议和行为链路。 |

Edge 原生弹出面板曾通过 Windows UI Automation 实际点击开始并完成翻译；自动回归的其余指令通过本地扩展页面消息接口驱动。Firefox 验证在 headless Nightly 中执行：主机授权入口使用真实指针输入，原生许可和扩展菜单动作通过该隔离实例的浏览器界面 DOM 激活。Firefox event page 休眠/唤醒没有单独强制实测；退出时 Nightly 输出了 Remote Agent 导航错误和内容脚本终止超时警告，功能断言全部通过，退出行为仍保留观察项。不能由此宣称稳定版或所有桌面界面均已验证。原生权限拒绝按钮、所有网站兼容性与全部异常网络环境未穷尽实测。

组件测试有 Emotion 重复加载提示；测试通过，双端生产构建和实际扩展页面可正常运行。当前 Windows 环境默认临时目录曾阻止 esbuild 删除临时文件，本次构建使用项目自有临时目录完成，未修改系统权限。遇到相同环境问题时可使用：

```powershell
New-Item -ItemType Directory -Force .build-temp | Out-Null
$env:TEMP = (Resolve-Path .build-temp).Path
$env:TMP = $env:TEMP
pnpm build
```

## 净室范围

本项目依据本地维护的净室行为规格独立实现，未使用参考产品品牌、素材、提示词或私有接口。净室规格、实施计划及隔离分析材料通过本仓库的本地 Git 排除规则留在工作区，不随本提交分发。本项目采用工程隔离方式，不构成法律层面的净室保证。
