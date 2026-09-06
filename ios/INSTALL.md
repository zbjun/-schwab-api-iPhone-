# 在个人 iPhone 上安装 THS

首个未签名安装包已生成：**THS 0.1.0（build 1）**。云端 Swift 编译成功，20 项 XCTest 全部通过，iPhone Release 归档成功。安装包已在 Windows 下载，并通过 SHA-256、ZIP 完整性、应用信息及 arm64 真机程序检查。

本地文件：`artifacts/THS-0.1.0-unsigned.ipa`。最低系统为 iOS 17，Bundle ID 为 `app.personal.ths`。它仍需签名才能安装；尚未验证你的 iPhone 16 Pro、Safari 授权及手机网络。

[本次构建与原始附件](https://github.com/zbjun/ths-ios-personal/actions/runs/34010504808)位于你的私有仓库，需要登录自己的 GitHub 账户查看。云端附件保留 14 天，本地下载副本不受这个期限影响。

## 现在怎么安装

1. 把 `THS-0.1.0-unsigned.ipa` 交给你安排的签名服务，告知 Bundle ID 为 `app.personal.ths`。
2. 按签名服务要求登记设备并完成签名，再按其提供的方式安装到 iPhone。签名方不需要你的 Schwab Client Secret 或账户授权链接。
3. 安装后先打开“连接”页的“查看演示数据”，确认页面能正常使用。
4. 关闭演示模式，在手机上填写自己的 Schwab 应用凭据。开发者门户中的 Callback URL 应为 `https://127.0.0.1`。
5. 点击“打开 Schwab 登录”，在券商页面完成授权。跳转到本机地址后，复制 Safari 地址栏中的完整链接，回到 App 粘贴并点击“完成连接”。

安装包签名前的 SHA-256 为：

```text
49d4e66b88a9670cae306803389d3b609f6bca816f4cd334bb19a0ac2d346ee0
```

签名会修改安装包，签名后的文件校验值会变化。

## 没有 Mac 时

后续需要重新构建时，在[自己的 GitHub 私有仓库](https://github.com/zbjun/ths-ios-personal)中手动启动 **Build personal iPhone app** 工作流。构建机执行模拟器测试后，生成 **THS-unsigned-iPhone** 附件，其中包含：

- `THS-unsigned.ipa`：供签名服务处理的未签名应用。
- SHA-256 校验文件。
- 本说明。

工作流的 Bundle ID 默认 `app.personal.ths`；如果你的签名服务要求指定标识符，在启动构建时按对方提供的值填写。工作流不会读取你手机上或本地电脑上的 Schwab 凭据。

将 IPA 交给你安排的签名服务，按其安装方式安装。**仅有未签名 IPA 无法直接安装。** 如果采用自己的 ad hoc 签名，需要匹配 Bundle ID 的证书/私钥和包含这台 iPhone UDID 的描述文件。签名方式、有效期及设备登记以实际服务为准；本项目没有安装或信任任何第三方证书。

## 有 Mac 时

打开 `ios/THS.xcodeproj`，选择 `THS` Scheme、自己的开发团队和目标 iPhone。先跑 Test，再 Build/Run。项目只需要标准 App 签名，没有关联域名或钥匙串共享 entitlement。

## 安装后验证

1. 先开启演示模式，查看账户、自选和连接页面，确认界面适合 iPhone 16 Pro；演示金额旁应有明确标记。
2. 关闭演示模式，在手机上配置应用凭据并完成首次手动授权。
3. 确认真实账户号码只显示尾号、持仓数量和可见金额与 Schwab 官方 App 一致。
4. 分别使用 Wi-Fi 和蜂窝网络刷新账户/行情；对比 App 显示的响应耗时，注意区分报价时间与请求完成时间。
5. 关闭重开 App 验证钥匙串持久化；访问令牌临近到期时验证刷新。失效后应重新登录，不能无限重试。

当前版本读取账户和行情，没有提交、修改或撤销订单的入口。后续手动交易功能应先完成订单草稿、价格/数量校验和提交前确认，再由本人验证真实下单。
