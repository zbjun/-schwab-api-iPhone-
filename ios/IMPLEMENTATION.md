# 实现与验收

个人股票 / ETF 客户端 **0.2.0（build 2）** 已完成功能和原生 UI 实现、模拟器验证及未签名 iPhone 包归档。之后再安装到用户的 iPhone 16 Pro 调试。部署目标 iOS 17+，网络路径 iPhone → Schwab；透明 VPN/TUN 和上游路由仍取决于设备网络。

## 模块与边界

- Services/SchwabClient.swift：OAuth、令牌刷新、固定主机及请求白名单、账户与行情、历史、订单查询和写请求回执。
- Services/KeychainVault.swift：仅本设备解锁后可用的钥匙串项；会话与待核对操作使用不同 account key。
- Models：账户/行情模型、订单草稿、订单状态、历史蜡烛及不可变核对快照。
- App/AppStore.swift：账户、授权、自选、演示与会话上下文。
- App/TradingStore.swift：交易核对、一次性提交、撤改、订单缓存和持久待核对标记。
- App/DemoData.swift：显式演示行情、历史和订单；不当作真实账户或真实成交。
- Views：五标签原生界面、证券详情、核对页、订单详情；深浅色和大字体布局。
- THSTests / THSUITests：替身网络测试、页面状态测试和原生演示流程；不调用真实券商。

订单仅支持常规时段、整股股票/ETF。卖出必须有对应持仓；券商仍执行最终可卖数量、购买力、价格档位及账户权限校验。改单刷新详情并要求证券/方向一致、未成交且明确 editable；不会用简单草稿覆盖特殊条件、自定义到期或不支持精度的订单。

每次确认快照有效期 120 秒，切换账户、授权或演示模式后失效。写入前持久化待核对标记；明确拒绝或完整回执可清除，结果不确定时不自动重发。演示模式既不发送真实订单，也不清除真实待核对记录。

## 本轮验证结果

[构建 34015712967](https://github.com/zbjun/ths-ios-personal/actions/runs/34015712967) 于 2026-09-06 成功，应用代码提交为 `dfacac2f19fd151ed6da71474c5791154470f504`。使用 Xcode 26.6、iOS 26.5、iPhone 17 Pro 模拟器。随后仅更新交付文档，应用与测试代码保持该提交版本。

| 验证项目 | 结果 |
| --- | --- |
| 本地工程一致性、差异空白检查 | 通过；17 个 App 源文件、3 个单元测试源文件、1 个界面测试源文件 |
| Swift 编译与类型检查 | Debug 模拟器构建及 Release iPhone 归档通过 |
| 单元测试 | 63 项通过，0 失败；覆盖 OAuth、模型、四种订单、撤改、失效快照、重复提交与不确定结果恢复 |
| 原生界面流程 | 5 项通过，0 失败；五主页面、无效数量拦截、查价和四区间图表、模拟下单撤单、修改价格及旧单已替换 |
| 截图导出 | 10 张命名原生截图；预览保留原图并记录每张 SHA-256 |
| 视觉检查与本地预览 | 已查看五主页面、图表、订单核对、撤单结果、修改核对及无效数量截图；桌面浏览器验证页面选择、前后翻页、首尾禁用状态和放大关闭 |
| Release 包检查 | ZIP 完整、iPhoneOS 平台、arm64、版本 0.2.0 / build 2、未签名；无 DEBUG 测试入口 |
| 下载一致性 | 本地 IPA 的 SHA-256 与云端产物一致 |

已根据原生截图修复报价拥挤，并给订单限价提供独立的可访问性名称和值。界面测试依据实际可见区域操作表单，避免点击落在底部导航栏；确认页和旧单状态断言完整保留。复用原生控件和格式化工具，无新增第三方 App 依赖。

测试通过 DEBUG 启动参数使用隔离存储与禁止网络的演示环境，不读取设备会话或待核对记录。生产版仍保留钥匙串失败和真实订单结果不确定时的保护；Release 不接受测试启动参数。

本地证据：`artifacts/logs-34015712967/0_build.txt`、`artifacts/ui-curl-34015712967/manifest.json`、`artifacts/preview-0.2.0/evidence.json` 及 `artifacts/THS-0.2.0-verification.json`。

IPA：`THS-0.2.0-unsigned.ipa`，494,564 字节，SDK `iphoneos26.5`。SHA-256：

```text
e820e0eef2ed66c8931bc49ccea0eb24c8ae3a2bc252814fb629ea7603696307
```

## 后续真机边界

尚未验证签名安装、iPhone 16 Pro 上的 Safari 回填与钥匙串、Wi-Fi/蜂窝直连、真实交易和券商回执。深浅色和大字体有布局支持，本轮截图验收使用默认浅色与默认字号；真机还需检查这些设置。开发期间未向真实券商发送下单、撤单或改单请求。

本版手动刷新行情；只读取最近 30 天、最多 200 笔订单，不代表完整历史或更早的未完成 GTC 订单。新订单仅限常规时段、整股股票 / ETF；已有复杂订单不会被简单编辑器重写。

## 历史基线

0.1.0 在 [构建 #34010504808](https://github.com/zbjun/ths-ios-personal/actions/runs/34010504808) 通过了 20 项核心测试及 Release 归档，使用 Xcode 26.6 / iOS 26.5。此记录不能替代本轮新增功能的验证。

Windows 账户和报价读取已成功验证，直连优于当时的代理结果。测速报告保留在本地 reports；不能据此推断手机耗时或订单成交速度。

## 参考资料

接口、回执和验证工具的证据及不确定性集中在 [API-REFERENCE.md](API-REFERENCE.md)。Schwab Portal 未返回本次可读取的规范正文，维护者源码明确标成实现参考，不能当作券商官方保证。

- [Apple HTTPS callback](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/callback/https(host:path:))：自动 HTTPS 回调要求关联域名；无域名版本手动回填。
- [Apple Keychain 可访问性](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly)：设备解锁与不迁移属性。
- [GitHub macOS 镜像](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)：当前云端 Xcode 工具链。
