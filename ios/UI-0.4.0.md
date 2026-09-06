# 0.4.0 系统配色、分钟 K 线与图下撤单

本轮按用户追加的三项要求实施，复用 0.3.0 的图表、订单校验与撤单服务。没有新增第三方 App 依赖；当前正在完成原生验证。

## 界面与行为

- 自选、行情详情和图下交易区域跟随 iPhone 系统明暗模式；上涨红色、下跌绿色。浅色使用深色价格线和金黄色均价线，深色使用浅色价格线和黄色均价线。
- 保留分时、日 K、周 K、月 K、五日五个主选项。“更多”加入 1、5、15、30、60、120 分钟 K 线，选中后按钮显示当前分钟周期。六种均为 OHLC 蜡烛及 MA5/10/20/30。
- 分钟图显示最近 120 根蜡烛，样本不足时显示实际数量；均线先用完整读取历史计算再截取显示。时间轴采用美东时间，跨日显示日期。暂不提供向更早历史拖动。
- 图下入口为“买 / 卖 / 撤”；买卖表单也可直接切到撤单。撤单仅展示当前账户、当前股票、券商标记可撤的简单股票委托。
- 选择一笔委托后，在主图下方核对账户、订单号、方向、剩余数量与价格；可以保留订单返回列表。确认后复用已有撤单服务，重新读取最新券商状态、单次提交并刷新结果。
- 撤单核对绑定当前账户与会话，有效期 120 秒；账户或会话变化后失效。撤单请求不自动重试，结果不确定时沿用既有待核对状态。

## 主要文件与复用

| 文件 | 改动 |
| --- | --- |
| `THS/Views/MarketTheme.swift`、`WatchlistView.swift`、`TradeView.swift` | 动态颜色替换固定深色，保留已有自选及完整交易表单交互 |
| `THS/Views/MarketChartView.swift`、`StockDetailView.swift` | 更多周期、分钟蜡烛窗口、完整历史 MA、自适应图表与买卖撤入口 |
| `THS/Views/InlineTradePanel.swift`、`InlineCancelPanel.swift` | 三项切换、图下撤单列表与确认，保留图表和独立滚动区域 |
| `THS/Models/PriceHistory.swift`、`ChartAnalytics.swift` | 分钟周期枚举、纽约交易时段 OHLCV 聚合；复用原均线计算 |
| `THS/Services/SchwabClient.swift`、`THS/App/DemoData.swift` | 支持的分钟请求和独立演示数据；订单写请求实现不变 |
| `THSTests/MinuteCandleTests.swift`、既有模型测试、`THSUITests/TradingFlowTests.swift` | 聚合边界、请求形状、明暗切换、六周期和图下撤单验证 |

## 验证与边界

工程计划执行 107 项单元测试、10 项原生界面测试并导出 31 张演示截图。Windows 工程与脚本检查已通过，原生编译、测试、截图和 Release 归档完成后在 [实现与验收](IMPLEMENTATION.md) 记录最终证据。

本轮使用隔离的演示环境和替身网络，不连接真实券商。后续仍需在 iPhone 16 Pro 上验证签名安装、实际显示和网络授权。订单列表仍限近 30 天、最多 200 笔；更早的未完成委托需在 Schwab 查看。

分钟数据来源、合成时段、缺失值和半日市限制见 [图表与数据依据](UI-DATA-REFERENCE.md)。系统外观测试使用 Apple 的 [XCUIDevice.appearance](https://developer.apple.com/documentation/xcuiautomation/xcuidevice/appearance-swift.property) 切换模拟器系统设置，并检查实际原生截图，没有给应用加入测试专用配色开关。
