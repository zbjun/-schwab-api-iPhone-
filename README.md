# THS · 个人 iPhone 交易客户端

原生 SwiftUI 项目，当前版本为 **0.3.0（build 3）**。本轮按参考图更新深色自选、五种行情图表和图下买卖区，已通过原生模拟器验收并完成 iPhone Release 归档；下一阶段安装到 iPhone 16 Pro 调试。iPhone 直接访问 Schwab，不依赖自建服务器或域名。

## 已实现的功能

- 账户：账户选择、净值、现金、购买力、持仓及进入证券详情。
- 自选：最多 50 个代码，深色对齐行情表；左滑切换多股同列分时走势，右滑返回，删除使用编辑或长按菜单。
- 行情：按代码查价；高低开、昨收、成交量、市值、市盈率及换手和量比估算。分时 / 五日为折线和黄色均价估算，日 K / 周 K / 月 K 为蜡烛及 MA5/10/20/30。手动刷新，不提供持续推送。
- 交易：常规时段、整股买入和持仓卖出；市价、限价、止损市价、止损限价；当日有效或撤销前有效。市价单仅支持当日有效。
- 图下买卖：交易编辑与核对在图表下面独立布局；显示账户可买、可卖数量估算。美元预算按限价向下换算整股，预算不含费用。
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

工程包含 THS、THSTests、THSUITests，共享 Scheme 为 THS。本轮有 93 项单元测试和 7 项界面流程测试，使用虚构凭据、替身网络和显式演示模式。Windows 执行工程与静态检查；Swift 编译、原生测试和截图通过自己的 GitHub 私有仓库中的 macOS 工作流完成。

[源代码](https://github.com/zbjun/ths-ios-personal) · [构建工作流](https://github.com/zbjun/ths-ios-personal/actions/workflows/ios.yml)

[0.3.0 验证构建](https://github.com/zbjun/ths-ios-personal/actions/runs/34022718272) 使用 Xcode 26.6 / iOS 26.5、iPhone 17 Pro 模拟器，通过全部 93 项单元测试及 7 项界面流程测试，完成 Release 真机归档。应用提交为 `d46444a8b9c8fc04f9e19918a7bb43689a121136`。开发期间没有发送真实订单，尚未进行 iPhone 16 Pro 真机验证。

`artifacts` 已保存 0.3.0 签名资料包、未签名 IPA、包校验记录和 18 张原生截图预览。预览支持切换和放大，不执行交易。旧版 0.2.0 交付文件仍保留。完整证据见 [实现与验收](ios/IMPLEMENTATION.md)，改动文件及复用说明见 [界面改动记录](ios/UI-REDESIGN.md)，后续步骤见 [安装说明](ios/INSTALL.md)。

## 首次连接

Schwab Callback URL 为 `https://127.0.0.1`。在手机的“连接”页输入应用凭据，打开券商登录；授权后复制最终完整回调链接，回到 App 主动粘贴并完成连接。无自有域名版本使用手动回填，券商密码仅在券商页面输入。

技术依据见 [接口资料](ios/API-REFERENCE.md) 和 [图表与统计依据](ios/UI-DATA-REFERENCE.md)，功能边界见 [开发契约](ios/FEATURE-CONTRACT.md)。Windows 原有诊断工具及测速报告仍保留在本地 tools/schwab-connect 和 reports 中，与手机授权互相独立。
