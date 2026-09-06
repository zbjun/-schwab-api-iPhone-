# 第一阶段实现与验收

## 已确定的范围

目标设备为用户的 iPhone 16 Pro；使用原生 SwiftUI，部署目标 iOS 17+，构建 SDK 采用云端 Xcode 提供的当前版本。此阶段完成个人授权、账户/持仓读取、自选股票/ETF 报价与请求耗时展示。原始需求中的交易功能属于后续阶段，当前源码没有订单写接口。

网络路径为 iPhone → Schwab；没有自建后端。设备的透明 VPN/TUN 和上游网络仍可能影响路径，不能仅凭 App 的连接设置排除。

## 模块边界

- `THS/Services/KeychainVault.swift`：设备解锁可读且不迁移的钥匙串单项存储，不同步到 iCloud。
- `THS/Services/SchwabClient.swift`：固定券商地址、OAuth state、一次性回调、令牌刷新合并、HTTP/JSON 边界和经过脱敏的错误。
- `THS/Models/TradingModels.swift`：页面使用的账户、持仓及行情模型；缺失金额保持可选值。
- `THS/App/AppStore.swift`：主线程页面状态、账户/行情并行刷新、切换与退出时清除金融页面数据。UserDefaults 仅保存非凭据的自选代码。
- `THS/Views/`：原生页面和显式演示状态；粘贴由用户主动触发，提交敏感输入后立即清空文本框。
- `THSTests/`：模拟网络、虚构凭据和账户的 XCTest，禁止真实账户调用。

## 验收边界

本机可运行 Node 工程生成/一致性检查，并检查工程引用、XML、源码文件和提交包。它们不能证明 Swift 编译或 iOS 运行成功。真正的编译与 XCTest 需要 macOS/Xcode，界面、Safari 回调复制和手机网络需要模拟器或真机验证。

云端测试前不传任何 Schwab 密钥；构建产物由用户另行签名。安装后首次授权才把用户输入的凭据写入手机钥匙串。

实盘能力需要在后续单独加入：账户 ID 映射、股票/ETF 订单草稿、价格与数量校验、订单确认、券商错误反馈、订单列表及状态核对。不能用目前的 HTTP 读取耗时推算成交速度。

## 已核验的参考资料

- 手动 OAuth 流程与 token 周期依据为客户端维护者资料：[schwab-py 授权说明](https://schwab-py.readthedocs.io/en/latest/auth.html)、[Schwabdev token 实现](https://github.com/tylerebowers/Schwabdev/blob/main/schwabdev/tokens.py)。Schwab 官方 portal 未提供本次可读取的文档，因此不把库实现描述为券商官方保证。
- [Apple HTTPS callback 文档](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/callback/https(host:path:))要求关联域名；本机 IP 不是可替代的关联域名。
- [Apple 设备钥匙串可访问性](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly)说明解锁后且限本设备的存储属性。
- [GitHub macOS 26 镜像清单](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)、[Apple Xcode 系统要求](https://developer.apple.com/xcode/system-requirements)用于构建机选择。
- [Apple ad hoc 描述文件要求](https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile)及[GitHub Xcode 签名指南](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)用于后续装机。

引用核验日期：2026-09-05。令牌过期时间以实际 `expires_in` 为准；刷新令牌失效由真实接口结果处理，不在 App 内假定无限有效。
