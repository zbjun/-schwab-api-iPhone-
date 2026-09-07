# 0.4.3：盘前盘后行情

本版为原生 SwiftUI App，版本 0.4.3 / build 7。分钟行情请求扩展时段，并在价格与成交量图上同步区分盘前、盘中、盘后。

## 行为

- 分时、五日和 1 / 5 / 15 / 30 / 60 / 120 分钟包含扩展时段数据；日、周、月保持原有请求。
- 橙色盘前、蓝色盘后，图内标记与图例跟随系统明暗。可见时段摘要由实际可见蜡烛生成，缩放和拖动后同步更新。
- 60 / 120 分钟在纽约各时段起点分别分组，不跨开盘、收盘或交易日混合。盘前盘后稀疏成交仅使用实际源分钟；盘中保留连续分钟完整性检查。
- MA5/10/20/30 按完整已读取历史计算。均价估算按纽约日期重置。价格、成交量、时段底色共用横轴和手势窗口。
- 已公布的 2026–2028 休市日及半日市纳入时段分类。依据和范围见 [数据说明](UI-DATA-REFERENCE.md)。
- 买 / 卖 / 撤仍在图表下面，订单执行时段未扩展。

## 实现与复用

- `PriceHistory.swift` 提供共用时段与日历；`ChartAnalytics.swift` 和 `SchwabClient.swift` 复用该边界处理请求及合成。
- `MarketChartView.swift`、`MarketTheme.swift` 在现有 Charts 图表背景绘制时段，复用原手势、视窗与系统配色，不引入图表依赖。
- `DemoData.swift` 复用同一日历生成完整演示时段；模型、请求及界面测试覆盖时段边界、稀疏成交、DST、半日市和缩放。
- 工程版本和截图预览脚本同步至 0.4.3；新增原生截图 `37-extended-intraday`、`38-extended-candles`。

## 验证

本地项目同步和空白检查通过，30 项安装包工具测试通过。[最终 EAS 构建](https://expo.dev/accounts/fried_chicken_cn/projects/ths-ios-personal/builds/359cd9dd-ec3d-4722-be2f-9088a870ab8c) 在 Xcode 26.6 / iOS 26.5 的 iPhone 17 Pro 模拟器上通过 **157 项单元测试、14 项界面测试（171 项，零失败）**，完成 Release 真机归档。原生源码提交为 `0d2a996291aec2416406abd7a68a184191ebadf5`。

通用 IPA 与云端校验记录一致；个人配置仅在本机追加，个人 IPA 校验通过（arm64、未签名、build 7、无 UI 测试开关）。个人包 SHA-256：`c510f0b502dc45931a417437476a218266d79eb0403d7159857c7da5e5183075`。38 张截图直接从 XCTest 导出并逐一校验哈希，预览位于 `artifacts/preview-0.4.3`。

首轮测试因旧手势测试无法解析 `1,801` 等本地化千位分隔符失败，已修正测试读取逻辑并完整重跑；没有删除或放宽手势及布局断言。首轮诊断保留在 `artifacts/eas-diagnostics-0.4.3-first`，最终证据在 `artifacts/eas-diagnostics-0.4.3-success`。

真实 Schwab 数据覆盖、实际账户权限和 iPhone 16 Pro 尚未验证。请求扩展时段不保证每分钟都有成交或接口返回；没有补造行情。

## Expo Go

当前工程使用 SwiftUI，EAS 只负责云端 Xcode 构建。Expo Go 运行 Expo / React Native 的 JavaScript 项目及其内置原生模块，不能导入当前 IPA 或直接热更新 SwiftUI。若采用 Expo Go，需要迁移客户端；目前继续签名安装 IPA 验证原生版本。[Expo 官方说明](https://docs.expo.dev/develop/development-builds/faq/)
