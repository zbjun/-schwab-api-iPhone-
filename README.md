# THS · 个人 iPhone 交易客户端

原生 SwiftUI 项目，当前第一阶段为账户、持仓、自选行情和个人 OAuth 授权。iPhone 直接调用 Schwab HTTPS API，不依赖自己的业务服务器或域名。当前版本没有下单、撤单或自动交易接口。

## 当前进度

- 已准备 iOS 17+ 原生工程：`ios/THS.xcodeproj`，共享 Scheme 为 `THS`。
- 已实现用户手动输入应用凭据、外部浏览器授权、手动回填 `https://127.0.0.1` 回调。
- 凭据、访问/刷新令牌和待完成授权保存在设备钥匙串；源码与构建流程不含真实凭据。
- 账户和行情并行读取，支持手动刷新及自选增删；错误、缺失字段和演示数据均明确区分。
- 已准备 XCTest 和 macOS 云端构建流程。
- **当前 Windows 环境没有 Xcode；Swift 编译、模拟器测试、签名和真机验证尚未完成。不能把源码准备完成等同于已有可安装 IPA。**

账户和行情读取已经在 Windows 本机成功验证，网络对比见 `reports/authenticated-proxy-comparison-20260905-230612.md`。iPhone 网络仍需真机验证。

## 开发与构建

工程使用 Apple 自带的 SwiftUI、Foundation、Observation 和 Security，没有第三方 App 依赖。

新增/删除 Swift 文件后，用 Node.js 重建项目文件：

```powershell
node tools/ios/generate-project.mjs
node tools/ios/generate-project.mjs --check
```

macOS 上可用 Xcode 打开工程，选择 iPhone 模拟器，然后执行 Test。设备安装步骤见 [iPhone 安装说明](ios/INSTALL.md)。

GitHub Actions 工作流 `.github/workflows/ios.yml` 仅由 `workflow_dispatch` 手动启动：检查项目、模拟器构建与 XCTest、设备 archive，再打包为 `THS-unsigned.ipa`。未签名 IPA 需要你安排的签名服务或自己的 Apple 签名才能安装。工作流不需要 Schwab 密钥，也不会发布 App Store。

仓库上传及云端工作流尚未执行。云端机器使用已核验的 `macos-26` / Xcode 26.6；若 GitHub 后续移除该版本，需按官方镜像清单更新路径。

## 首次连接

1. Schwab 开发者门户的 Callback URL 保持为 `https://127.0.0.1`，应用状态须可用。
2. 在 iPhone App 的“连接”页填写 Client ID、Client Secret；券商账户密码仅在券商登录页填写。
3. 打开 Schwab 登录。完成授权后，浏览器转到本机地址而显示无法连接是当前手动流程的预期现象。
4. 复制最终地址栏中的完整链接，回到 App，点击系统粘贴按钮并完成连接。不要把链接发到聊天或第三方网站。
5. 打开账户、自选页面读取数据；演示模式必须主动开启，示例金额不会冒充真实账户。

原生自动 HTTPS 回调需要 App 的关联域名；无域名版本采用手动回填。技术依据及未验证项见 [实现与验收说明](ios/IMPLEMENTATION.md)。

## 本地诊断工具

原有 Windows 授权和网络测速工具保留在 `tools/schwab-connect`，用法见其 README。它和 iOS App 的令牌存储彼此独立，不会自动把电脑授权传到手机。
