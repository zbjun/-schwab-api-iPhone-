# 股票 / ETF 完整工作流

用户于 2026-09-06 确认：先在本地完成股票 / ETF 功能和 UI，之后再安装到 iPhone 调试。保留 iPhone 直接访问 Schwab 的结构。当前开发不调用真实订单接口。

## 本轮范围与验收

- 原生中文界面，账户、自选、交易、订单、连接五个入口。统一颜色、卡片、数值排版、加载/空/错误状态，支持深浅色及大字体。
- 账户选择、余额与持仓；持仓点击查看证券，买卖操作进入订单草稿。
- 自选增删、证券代码查价、行情详情及 1 日 / 1 周 / 1 月 / 1 年图表。缺失报价和空历史使用空态，不填造真实数据。
- 常规交易时段、整股、买入 / 卖出持仓；市价、限价、止损、止损限价；DAY / GOOD_TILL_CANCEL，市价只允许 DAY。
- 草稿 -> 刷新账户与证券信息 -> 本地核对 -> 本人确认 -> 券商回执 -> 订单列表/详情。核对页面不声称已获券商预审，回执不声称已成交。
- 最近 30 天订单，状态筛选与详情；只有最新详情明确允许的简单股票单可撤改。替换发送完整订单并跟踪新 ID。
- 写请求不自动重试。发送前持久化无敏感内容的“有待核对订单操作”标记，结果不确定/进程结束时保留；本人核对券商订单后可主动解除。模拟模式不修改这个真实操作标记。
- 演示数据支持查价、图表、确认、下单回执、订单撤改，不访问真实券商，不把模拟结果标成实盘。
- 核心 fixture 测试、状态测试和原生 UI 流程测试，云端模拟器截图核对；之后才进行用户手机签名安装和真实授权调试。

不纳入本轮：期权、卖空、碎股、盘前盘后、组合/条件联动单、自动交易。已有复杂订单可查看，不能被简单股票编辑器改写。

## AppStore / UI 契约

保留现有账户、报价、授权、演示、自选属性与方法。新增如下接口供 UI 使用：

```swift
enum AppTab: Hashable { case accounts, watchlist, trade, orders, connection }

// Observable properties
activeTab: AppTab
tradeSymbol: String
tradeSide: OrderSide
tradeReplacement: BrokerageOrder?
orders: [BrokerageOrder]
ordersUpdatedAt: Date?
isLoadingOrders: Bool
ordersError: String?
isSubmittingOrder: Bool
unresolvedOrderOperation: Bool
tradeError: String?
tradeNotice: String?
preparedOrder: PreparedOrder?

func selectAccount(_ id: String) async
func openTrade(symbol: String, side: OrderSide)
func beginReplacement(_ order: BrokerageOrder)
func clearTradePreparation()
func prepareOrder(_ draft: OrderDraft) async -> Bool
func submitPreparedOrder() async -> Bool
func refreshOrders() async
func orderDetail(_ id: String) async throws -> BrokerageOrder
func cancelOrder(_ order: BrokerageOrder) async -> Bool
func acknowledgeOrderReconciliation()
func lookupQuote(_ symbol: String) async throws -> StockQuote
func priceHistory(symbol: String, range: HistoryRange) async throws -> PriceHistory
```

`PreparedOrder` 为 Sendable/Identifiable 的不可变本地核对快照：`id: UUID`、`draft: OrderDraft`、`accountID: String`、`accountDisplay: String`、`accountHash: String`、`quote: StockQuote`、`estimatedValue: Double?`、`availableShares: Double`、`buyingPower: Double?`、`preparedAt: Date`、`replacementOrderID: String?`、`isDemo: Bool`。确认后只提交这个快照；切换账户、授权、演示状态时失效。

行情查找与历史请求返回值由详情页自己的状态保存，不把旧证券结果覆盖新证券。订单详情页自己的状态管理加载与错误，列表使用 store.orders。表单在用户修改时清除旧核对快照。`prepareOrder` / `submitPreparedOrder` 共用 `isSubmittingOrder`，UI 在此期间禁用输入、重复提交及账户/演示切换。

## 文件责任

- 核心实现：SchwabClient、TradingModels、OrderModels、PriceHistory、核心订单测试。
- 界面实现：Views 目录和 THSUITests，使用上述稳定接口。
- 主代理：AppStore、PreparedOrder、DemoData、AppStore 测试、工程生成器、云端验证、整合与文档。

## 数据与界面规则

涨红跌绿，价格与数量用等宽数字，颜色之外仍展示正负号。美元价格允许显示至 4 位有效小数；百分比字段为百分数值而非比例。首页不把缺失金额当零。真实行情显示报价时间，历史图表显示所选区间；显式演示标志贯穿交易及订单确认页。

默认股票代码 AAPL 只是初始输入，不是购买建议。交易时用户必须选数量、类型及适用价格，再完成独立确认。所有当前开发及 CI 使用虚构凭据和数据。
