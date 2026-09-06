# THS · 个人 iPhone 交易客户端

原生 SwiftUI 项目，当前版本为 **0.2.0（build 2）**。股票 / ETF 功能与原生界面已实现，并通过模拟器验证；下一阶段再安装到 iPhone 16 Pro 调试。iPhone 直接访问 Schwab，不依赖自建服务器或域名。

## 已实现的功能

- 账户：账户选择、净值、现金、购买力、持仓及进入证券详情。
- 行情：最多 50 个自选、按股票代码查价、报价详情、1 日 / 5 个交易日 / 1 月 / 1 年价格图表。手动刷新，不提供持续推送。
- 交易：常规时段、整股买入和持仓卖出；市价、限价、止损市价、止损限价；当日有效或撤销前有效。市价单仅支持当日有效。
- 确认：重新读取账户和证券信息，生成不可变的本地核对页面，由本人点击确认后发送。
- 订单：近 30 天、最多 200 笔订单查询、状态筛选、详情和刷新；按最新券商标记撤单或修改未成交的简单股票单。
- 演示：虚构账户、报价与图表，可完整演练创建、修改和撤销订单，不调用券商。
- 连接：手动 OAuth、设备钥匙串、刷新令牌、脱敏错误和响应耗时展示。

复杂单、特殊执行条件、指定税批次/路由/到期、超过本版价格精度的已有订单不会被简单编辑器重写。期权、卖空、碎股、盘前盘后、组合单和自动交易不在本轮范围内。

## 订单结果与凭据

订单写请求不会自动重试。发送前先将无账户/价格内容的待核对标记写入独立钥匙串项；超时、服务端异常、缺失回执编号或进程中断后保留。本人核对券商订单后才能解除提示。模拟模式不会清除真实操作的标记。

应用凭据、令牌和 OAuth state 留在设备钥匙串，源码和 CI 不包含真实凭据。UserDefaults 只保存自选代码。收到订单回执只表示请求已被接收，不代表成交；行情请求耗时也不等于成交速度。

## 开发与验证

App 只使用 Apple 自带的 SwiftUI、Charts、Foundation、Observation 和 Security，无第三方 App 依赖。

新增或删除 Swift 文件后运行：

```powershell
node tools/ios/generate-project.mjs
node tools/ios/generate-project.mjs --check
```

工程包含 THS、THSTests、THSUITests，共享 Scheme 为 THS。63 项单元测试和 5 项界面流程测试已全部通过，使用虚构凭据、替身网络和显式演示模式。Windows 执行工程与静态检查；Swift 编译、原生测试和截图通过自己的 GitHub 私有仓库中的 macOS 工作流完成。

[源代码](https://github.com/zbjun/ths-ios-personal) · [构建工作流](https://github.com/zbjun/ths-ios-personal/actions/workflows/ios.yml)

[0.2.0 成功构建](https://github.com/zbjun/ths-ios-personal/actions/runs/34015712967) 使用 Xcode 26.6 / iOS 26.5、iPhone 17 Pro 模拟器，完成 68 项测试及 Release 真机归档。开发期间没有发送真实订单，尚未进行 iPhone 16 Pro 真机验证。

本地交付位于 `artifacts`：`THS-0.2.0-signing-kit.zip`、`THS-0.2.0-unsigned.ipa`、包校验记录，以及 `preview-0.2.0/index.html` 的 10 张原生截图预览。预览支持切换和放大，不执行交易。完整证据见 [实现与验收](ios/IMPLEMENTATION.md)，后续步骤见 [安装说明](ios/INSTALL.md)。

## 首次连接

Schwab Callback URL 为 `https://127.0.0.1`。在手机的“连接”页输入应用凭据，打开券商登录；授权后复制最终完整回调链接，回到 App 主动粘贴并完成连接。无自有域名版本使用手动回填，券商密码仅在券商页面输入。

技术依据见 [接口资料](ios/API-REFERENCE.md)，功能边界见 [开发契约](ios/FEATURE-CONTRACT.md)。Windows 原有诊断工具及测速报告仍保留在本地 tools/schwab-connect 和 reports 中，与手机授权互相独立。
