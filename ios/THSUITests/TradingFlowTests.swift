import XCTest
import UIKit

@MainActor
final class TradingFlowTests: XCTestCase {
    private var app: XCUIApplication!
    private var originalAppearance = XCUIDevice.Appearance.unspecified

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        executionTimeAllowance = 240
        originalAppearance = XCUIDevice.shared.appearance
        XCUIDevice.shared.appearance = .light
        app = XCUIApplication()
    }

    override func tearDown() {
        if (testRun?.failureCount ?? 0) > 0 {
            capture("failure-screen")
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "failure-accessibility-tree"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
        XCUIDevice.shared.appearance = originalAppearance
        super.tearDown()
    }

    func testPersonalFirstLaunchOpensLoginWithoutCredentialFields() {
        app.launchArguments = ["--uitesting-personal-config"]
        app.launch()
        XCTAssertTrue(element("connection.authorize").waitForExistence(timeout: 10))
        XCTAssertTrue(element("connection.credentialsSaved").exists)
        XCTAssertFalse(element("connection.clientID").exists)
        XCTAssertFalse(element("connection.clientSecret").exists)
        XCTAssertFalse(element("connection.saveCredentials").exists)
        capture("36-personal-first-launch")
    }

    func testFiveMainScreensHaveDemoContextAndScreenshots() {
        launch()
        for (identifier, tab, name) in [("tab.accounts", "账户", "01-accounts"), ("tab.watchlist", "自选", "02-watchlist"),
                                        ("tab.trade", "交易", "03-trade"), ("tab.orders", "订单", "04-orders"),
                                        ("tab.connection", "连接", "05-connection")] {
            selectTab(identifier)
            XCTAssertTrue(app.navigationBars[tab].waitForExistence(timeout: 5))
            if tab == "连接" {
                XCTAssertTrue(element("connection.demo").exists)
            } else {
                XCTAssertTrue(element("demo.notice").exists)
            }
            capture(name)
        }
    }

    func testWatchlistLookupAndFiveChartRanges() {
        launch(tab: "watchlist")
        let apple = element("watchlist.symbol.AAPL")
        XCTAssertTrue(apple.waitForExistence(timeout: 5))
        apple.tap()
        XCTAssertTrue(element("detail.lastPrice").waitForExistence(timeout: 5))
        XCTAssertTrue(element("detail.chart").waitForExistence(timeout: 5))
        for (range, screenshot) in [("intraday", "06-stock-detail-chart"), ("daily", "11-daily-candles"),
                                    ("weekly", "12-weekly-candles"), ("monthly", "13-monthly-candles"),
                                    ("fiveDay", "14-five-day-chart")] {
            element("history.\(range)").tap()
            XCTAssertTrue(element("detail.chart").waitForExistence(timeout: 5))
            let line = range == "intraday" || range == "fiveDay"
            let legend = element(line ? "chart.average" : "chart.movingAverages")
            XCTAssertTrue(legend.waitForExistence(timeout: 5))
            if line { XCTAssertTrue(legend.label.contains("均价估算")) }
            else {
                for average in ["MA5", "MA10", "MA20", "MA30"] { XCTAssertTrue(legend.label.contains(average)) }
            }
            capture(screenshot)
        }
        XCTAssertTrue(app.buttons["detail.buy"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["detail.buy"].isEnabled)
        XCTAssertTrue(app.buttons["detail.sell"].isEnabled)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        replaceText("watchlist.search", with: "QQQ")
        element("watchlist.lookup").tap()
        XCTAssertTrue(app.navigationBars["QQQ"].waitForExistence(timeout: 5))
        XCTAssertTrue(element("detail.lastPrice").waitForExistence(timeout: 5))
    }

    func testWatchlistSwipesBetweenQuotesAndMultipleCharts() {
        launch(tab: "watchlist")
        let apple = element("watchlist.symbol.AAPL")
        XCTAssertTrue(apple.waitForExistence(timeout: 5))
        apple.swipeLeft()
        XCTAssertTrue(app.navigationBars["自选"].exists)
        XCTAssertFalse(element("detail.chart").exists)
        for symbol in ["AAPL", "MSFT", "SPY", "QQQ"] {
            let row = element("watchlist.symbol.\(symbol)")
            let loaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "分时走势，390"), object: row)
            XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 5), .completed)
        }
        capture("15-watchlist-charts")
        element("watchlist.symbol.AAPL").swipeRight()
        XCTAssertEqual(element("watchlist.symbol.AAPL").value as? String, "行情列表")
        XCTAssertTrue(element("watchlist.symbol.AAPL").exists)
        XCTAssertTrue(app.navigationBars["自选"].exists)
        element("watchlist.symbol.AAPL").tap()
        XCTAssertTrue(element("detail.chart").waitForExistence(timeout: 5))
    }

    func testInlineAmountBuyKeepsChartVisibleWithKeyboardAndReview() {
        // This end-to-end flow covers two keyboard sessions, geometry, review and order detail.
        // Shared CI simulators can spend several minutes obtaining accessibility snapshots.
        executionTimeAllowance = 600
        launch(tab: "watchlist")
        element("watchlist.symbol.AAPL").tap()
        XCTAssertTrue(element("detail.chart").waitForExistence(timeout: 5))
        element("history.daily").tap()
        XCTAssertTrue(element("chart.movingAverages").waitForExistence(timeout: 5))
        element("detail.buy").tap()
        XCTAssertTrue(element("detail.tradePanel").waitForExistence(timeout: 5))
        XCTAssertTrue(element("inline.quantity").waitForExistence(timeout: 5))
        assertChartAboveTradePanel()
        capture("16-inline-buy")
        replaceText("inline.limitPrice", with: "200")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        assertChartAboveTradePanel(focusedField: "inline.limitPrice")
        capture("17-inline-keyboard")
        dismissKeyboard()
        tapRevealing("inline.amountMode")
        replaceText("inline.amount", with: "1000")
        dismissKeyboard()
        XCTAssertTrue(reveal("inline.amountShares").label.contains("5 整股"))
        XCTAssertTrue(reveal("inline.maxBuy").label.contains("23 股"))
        XCTAssertTrue(reveal("inline.maxSell").label.contains("20 股"))
        element("inline.review").tap()
        XCTAssertTrue(element("inline.review.summary").waitForExistence(timeout: 5))
        XCTAssertTrue(element("inline.review.summary").label.contains("5 股"))
        XCTAssertEqual(element("inline.confirm").label, "确认模拟下单")
        XCTAssertFalse(app.sheets.firstMatch.exists)
        assertChartAboveTradePanel()
        capture("18-inline-review")
        element("inline.confirm").tap()
        XCTAssertTrue(app.navigationBars["订单"].waitForExistence(timeout: 5))
        newestOrder().tap()
        XCTAssertTrue(element("order.detail.status").waitForExistence(timeout: 5))
        XCTAssertTrue(element("order.detail.status").label.contains("委托中"))
        XCTAssertEqual(reveal("order.detail.limitPrice").value as? String, "$200.00")
    }

    func testLimitBuyReviewSubmitAndCancelInDemo() {
        launch(tab: "trade")
        replaceText("trade.quantity", with: "3")
        replaceText("trade.limitPrice", with: "199")
        dismissKeyboard()
        tapRevealing("trade.review")
        XCTAssertTrue(element("order.review.confirm").waitForExistence(timeout: 5))
        XCTAssertEqual(element("order.review.confirm").label, "确认模拟下单")
        capture("07-limit-order-review")
        element("order.review.confirm").tap()
        XCTAssertTrue(app.navigationBars["订单"].waitForExistence(timeout: 5))
        XCTAssertTrue(element("orders.notice").waitForExistence(timeout: 5))
        newestOrder().tap()
        XCTAssertTrue(element("order.detail.status").waitForExistence(timeout: 5))
        XCTAssertTrue(element("order.detail.status").label.contains("委托中"))
        tapRevealing("order.cancel")
        let confirmation = app.sheets["确认撤销这笔订单？"].buttons["order.cancel.confirm"].firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 3))
        XCTAssertEqual(confirmation.label, "确认模拟撤单")
        confirmation.tap()
        waitForLabel("order.detail.status", containing: "已撤销")
        XCTAssertFalse(element("order.cancel").exists)
        capture("08-canceled-demo-order")
    }

    func testModifyExistingDemoLimitOrder() {
        launch(tab: "orders")
        let original = element("order.row.910001")
        XCTAssertTrue(original.waitForExistence(timeout: 5))
        original.tap()
        tapRevealing("order.modify")
        XCTAssertTrue(app.navigationBars["修改订单"].waitForExistence(timeout: 5))
        replaceText("trade.limitPrice", with: "197")
        dismissKeyboard()
        tapRevealing("trade.review")
        XCTAssertTrue(element("order.review.confirm").waitForExistence(timeout: 5))
        XCTAssertEqual(element("order.review.confirm").label, "确认模拟修改")
        capture("09-replacement-review")
        element("order.review.confirm").tap()
        XCTAssertTrue(app.navigationBars["订单"].waitForExistence(timeout: 5))
        newestOrder().tap()
        XCTAssertTrue(element("order.detail.status").waitForExistence(timeout: 5))
        XCTAssertTrue(element("order.detail.status").label.contains("委托中"))
        let limitPrice = reveal("order.detail.limitPrice")
        XCTAssertEqual(limitPrice.value as? String, "$197.00")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let replaced = element("order.row.910001")
        XCTAssertTrue(replaced.exists)
        XCTAssertTrue(replaced.label.contains("已替换"))
    }

    func testInvalidQuantityNeverOpensConfirmation() {
        launch(tab: "trade")
        replaceText("trade.quantity", with: "0")
        replaceText("trade.limitPrice", with: "199")
        dismissKeyboard()
        tapRevealing("trade.review")
        XCTAssertTrue(element("trade.error").waitForExistence(timeout: 3))
        XCTAssertTrue(element("trade.error").label.contains("整股数量"))
        XCTAssertFalse(element("order.review.confirm").exists)
        capture("10-invalid-quantity")
        selectTab("tab.orders")
        XCTAssertTrue(element("order.row.910001").waitForExistence(timeout: 5))
        XCTAssertTrue(element("order.row.910002").exists)
    }

    func testAppearanceFollowsSystemWhileAppRemainsOpen() {
        launch(tab: "watchlist")
        XCTAssertTrue(element("watchlist.symbol.AAPL").waitForExistence(timeout: 5))
        changeSystemAppearance(.light)
        changeSystemAppearance(.dark)
        XCTAssertTrue(element("watchlist.symbol.AAPL").isHittable)
        capture("19-watchlist-dark", appearance: .dark)
        element("watchlist.symbol.AAPL").tap()
        element("history.daily").tap()
        XCTAssertTrue(element("chart.movingAverages").waitForExistence(timeout: 5))
        XCTAssertTrue(waitForRenderedAppearance(.dark, in: app))
        capture("20-detail-dark", appearance: .dark)
        changeSystemAppearance(.light)
        XCTAssertTrue(element("chart.movingAverages").exists)
        XCTAssertTrue(element("detail.buy").isHittable)
        capture("21-detail-light", appearance: .light)
    }

    func testMoreMenuSelectsAllSixMinuteCandlesWithMovingAverages() {
        executionTimeAllowance = 420
        launch(tab: "watchlist")
        element("watchlist.symbol.AAPL").tap()
        XCTAssertTrue(element("history.more").waitForExistence(timeout: 5))
        for (minute, screenshot) in [(1, "23-minute-1"), (5, "24-minute-5"), (15, "25-minute-15"),
                                     (30, "26-minute-30"), (60, "27-minute-60"), (120, "28-minute-120")] {
            element("history.more").tap()
            let choice = app.buttons["history.minute\(minute)"]
            XCTAssertTrue(choice.waitForExistence(timeout: 5))
            if minute == 1 { capture("22-minute-menu") }
            choice.tap()
            XCTAssertEqual(element("history.more").value as? String, "\(minute)分钟")
            let averages = element("chart.movingAverages")
            XCTAssertTrue(averages.waitForExistence(timeout: 5))
            for period in [5, 10, 20, 30] { XCTAssertTrue(averages.label.contains("MA\(period)")) }
            XCTAssertFalse(averages.label.contains("—"))
            XCTAssertFalse(element("chart.average").exists)
            XCTAssertTrue(element("chart.window").label.contains("最近"))
            XCTAssertTrue(element("detail.chart.volume").exists)
            capture(screenshot)
        }
        element("history.intraday").tap()
        XCTAssertTrue(element("chart.average").waitForExistence(timeout: 5))
        XCTAssertEqual(element("history.more").value as? String, "未选择分钟周期")
    }

    func testInlineCancelFiltersSymbolAndConfirmsOneOrderBelowChart() {
        executionTimeAllowance = 420
        launch(tab: "watchlist")
        element("watchlist.symbol.SPY").tap()
        element("detail.cancel").tap()
        XCTAssertTrue(element("inline.cancel.empty").waitForExistence(timeout: 5))
        XCTAssertFalse(element("inline.cancel.order.910001").exists)
        element("inline.close").tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()

        element("watchlist.symbol.AAPL").tap()
        element("history.daily").tap()
        element("detail.buy").tap()
        let actions = app.segmentedControls["inline.side"]
        XCTAssertTrue(actions.waitForExistence(timeout: 5))
        XCTAssertTrue(actions.buttons["买"].exists)
        XCTAssertTrue(actions.buttons["卖"].exists)
        actions.buttons["撤"].tap()
        let pendingOrder = element("inline.cancel.order.910001")
        XCTAssertTrue(pendingOrder.waitForExistence(timeout: 5))
        XCTAssertFalse(element("inline.cancel.order.910002").exists)
        assertChartAboveTradePanel()
        capture("29-inline-cancel-orders")
        pendingOrder.tap()
        XCTAssertTrue(element("inline.cancel.review").waitForExistence(timeout: 5))
        element("inline.cancel.back").tap()
        XCTAssertTrue(pendingOrder.exists)
        pendingOrder.tap()
        XCTAssertTrue(element("inline.cancel.review").waitForExistence(timeout: 5))
        XCTAssertEqual(element("inline.cancel.confirm").label, "确认模拟撤单")
        XCTAssertFalse(app.sheets.firstMatch.exists)
        assertChartAboveTradePanel()
        capture("30-inline-cancel-review")
        element("inline.cancel.confirm").tap()
        waitForLabel("inline.cancel.notice", containing: "演示订单已撤销")
        XCTAssertFalse(pendingOrder.exists)
        XCTAssertTrue(element("inline.cancel.empty").exists)
        assertChartAboveTradePanel()
        capture("31-inline-cancel-result")
        element("inline.close").tap()
        XCTAssertTrue(element("detail.cancel").isEnabled)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        selectTab("tab.orders")
        let canceled = element("order.row.910001")
        XCTAssertTrue(canceled.waitForExistence(timeout: 5))
        XCTAssertTrue(canceled.label.contains("已撤销"))
    }

    func testDailyCandlesPinchPanAndReturnToLatestWithoutBlockingPageScroll() throws {
        executionTimeAllowance = 600
        launch(tab: "watchlist")
        element("watchlist.symbol.AAPL").tap()
        element("history.daily").tap()
        XCTAssertTrue(element("chart.movingAverages").waitForExistence(timeout: 5))
        let initial = try chartWindow()
        XCTAssertEqual(initial.count, min(120, initial.total))
        XCTAssertEqual(initial.last, initial.total)
        XCTAssertTrue(element("chart.window").label.contains("最近\(initial.count)根"))
        let plot = element("chart.interaction.price")
        XCTAssertTrue(plot.waitForExistence(timeout: 5))
        XCTAssertTrue(plot.isHittable)

        plot.pinch(withScale: 2, velocity: 1)
        let zoomed = try waitForChartWindow { $0.count < initial.count && $0.total == initial.total }
        capture("32-chart-zoomed")

        dragChart(plot, fromX: 0.25, toX: 0.75)
        // A continuous viewport may expose one additional partial candle at an edge while panning.
        let earlier = try waitForChartWindow {
            $0.first < zoomed.first && abs($0.count - zoomed.count) <= 1 && $0.total == zoomed.total
        }
        capture("33-chart-panned")

        dragChart(plot, fromX: 0.75, toX: 0.25)
        let later = try waitForChartWindow {
            $0.first > earlier.first && abs($0.count - earlier.count) <= 1 && $0.total == earlier.total
        }
        plot.pinch(withScale: 0.6, velocity: -1)
        _ = try waitForChartWindow { $0.count > later.count && $0.total == initial.total }
        let latest = app.buttons["chart.latest"]
        XCTAssertTrue(latest.isHittable)
        latest.tap()
        let reset = try waitForChartWindow { $0.last == initial.total && $0.count == min(120, initial.total) }
        XCTAssertEqual(reset, initial)

        // A vertical touch that starts inside the plot must still scroll the detail page.
        let chart = element("detail.chart")
        let originalTop = chart.frame.minY
        plot.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
            .press(forDuration: 0.05, thenDragTo: plot.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)))
        let scrolled = XCTNSPredicateExpectation(predicate: NSPredicate { object, _ in
            guard let chart = object as? XCUIElement else { return false }
            return chart.frame.minY < originalTop - 12
        }, object: chart)
        XCTAssertEqual(XCTWaiter.wait(for: [scrolled], timeout: 5), .completed)
        XCTAssertEqual(try chartWindow(), reset, "Vertical scrolling must not pan or zoom the candle window")
    }

    func testMinuteCandlesAndInlineBuySellAcceptActualChartGestures() throws {
        executionTimeAllowance = 600
        launch(tab: "watchlist")
        element("watchlist.symbol.AAPL").tap()
        element("history.more").tap()
        let fiveMinutes = app.buttons["history.minute5"]
        XCTAssertTrue(fiveMinutes.waitForExistence(timeout: 5))
        fiveMinutes.tap()
        XCTAssertEqual(element("history.more").value as? String, "5分钟")
        XCTAssertTrue(element("chart.movingAverages").waitForExistence(timeout: 5))
        let initial = try chartWindow()
        let plot = element("chart.interaction.price")
        XCTAssertTrue(plot.waitForExistence(timeout: 5))
        plot.pinch(withScale: 2, velocity: 1)
        let zoomed = try waitForChartWindow { $0.count < initial.count && $0.total == initial.total }

        // The volume plot manipulates the same visible candle window as the price plot.
        let volume = element("chart.interaction.volume")
        XCTAssertTrue(volume.waitForExistence(timeout: 5))
        XCTAssertTrue(volume.isHittable)
        dragChart(volume, fromX: 0.25, toX: 0.75)
        let earlier = try waitForChartWindow {
            $0.first < zoomed.first && abs($0.count - zoomed.count) <= 1 && $0.total == zoomed.total
        }
        let averagesLabel = element("chart.movingAverages").label
        for period in [5, 10, 20, 30] {
            XCTAssertTrue(averagesLabel.contains("MA\(period)"))
        }
        capture("34-chart-minute-panned")
        dragChart(plot, fromX: 0.75, toX: 0.25)
        let beforeOpen = try waitForChartWindow {
            $0.first > earlier.first && abs($0.count - earlier.count) <= 1 && $0.total == earlier.total
        }

        element("detail.buy").tap()
        XCTAssertTrue(element("detail.tradePanel").waitForExistence(timeout: 5))
        assertChartAboveTradePanel()
        let inlineInitial = try chartWindow()
        XCTAssertEqual(inlineInitial, beforeOpen, "Opening buy/sell must preserve the candle viewport")
        let inlinePlot = element("chart.interaction.price")
        XCTAssertTrue(inlinePlot.isHittable)
        inlinePlot.pinch(withScale: 2, velocity: 1)
        let inlineZoomed = try waitForChartWindow { $0.count < inlineInitial.count && $0.total == inlineInitial.total }
        assertChartAboveTradePanel()
        capture("35-chart-inline-zoomed")

        let actions = app.segmentedControls["inline.side"]
        XCTAssertTrue(actions.buttons["卖"].isHittable)
        actions.buttons["卖"].tap()
        dragChart(inlinePlot, fromX: 0.25, toX: 0.75)
        _ = try waitForChartWindow {
            $0.first < inlineZoomed.first && abs($0.count - inlineZoomed.count) <= 1 && $0.total == inlineZoomed.total
        }
        assertChartAboveTradePanel()
        XCTAssertFalse(element("inline.review.summary").exists)
        XCTAssertFalse(element("order.review.confirm").exists)
    }

    private func launch(tab: String? = nil) {
        app.launchArguments = ["--uitesting-demo", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        if let tab { app.launchArguments += ["--snapshot-tab", tab] }
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["账户"].waitForExistence(timeout: 10))
        XCTAssertFalse(element("reconciliation.orders").exists)
    }

    private func selectTab(_ identifier: String, file: StaticString = #filePath, line: UInt = #line) {
        let tabs = app.tabBars.buttons
        let target = tabs[identifier]
        guard target.waitForExistence(timeout: 5) else {
            XCTFail("Missing tab \(identifier)", file: file, line: line)
            return
        }
        func waitForSelection() -> Bool {
            let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: target)
            return XCTWaiter.wait(for: [selected], timeout: 5) == .completed
        }

        if !target.isSelected {
            let current = tabs.matching(NSPredicate(format: "selected == true")).firstMatch
            let previousIdentifier = current.exists ? current.identifier : nil
            target.tap()
            if !waitForSelection(), let previousIdentifier, previousIdentifier != identifier {
                let previous = tabs[previousIdentifier]
                if previous.exists && previous.isSelected && !target.isSelected {
                    // Retry navigation only when the first tap left the original tab selected.
                    print("Retrying tab navigation once: \(previousIdentifier) remains selected after tapping \(identifier).")
                    target.tap()
                    _ = waitForSelection()
                }
            }
        }
        XCTAssertTrue(target.isSelected, "Expected \(identifier) to be selected after tab navigation", file: file, line: line)
    }

    private func element(_ identifier: String) -> XCUIElement {
        if ["watchlist.search", "trade.quantity", "trade.amount", "trade.limitPrice", "trade.stopPrice", "trade.symbol",
            "inline.quantity", "inline.amount", "inline.limitPrice", "inline.stopPrice"].contains(identifier) {
            return app.textFields[identifier]
        }
        if identifier.hasPrefix("history.") || identifier.hasPrefix("order.row.") || identifier.hasPrefix("watchlist.symbol.") ||
            identifier.hasPrefix("inline.cancel.order.") ||
            ["detail.buy", "detail.sell", "detail.cancel", "watchlist.lookup", "trade.review", "order.review.confirm", "order.cancel", "order.modify"].contains(identifier) {
            return app.buttons[identifier]
        }
        return app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func newestOrder() -> XCUIElement {
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "order.row.")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        return row
    }

    private func reveal(_ identifier: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let target = element(identifier)
        let list = contentList(for: identifier)
        XCTAssertTrue(list.waitForExistence(timeout: 5), file: file, line: line)
        for _ in 0..<7 {
            let visible = visibleContent(in: list)
            let margin: CGFloat = identifier.hasPrefix("inline.") ? 0 : 8
            if target.exists && target.isHittable && visible.contains(target.frame.insetBy(dx: 0, dy: -margin)) {
                return target
            }
            if app.keyboards.firstMatch.exists {
                dismissKeyboard()
                continue
            }
            let movingDown = target.exists && target.frame.minY < visible.minY
            let upperY = visible.minY + visible.height * 0.25
            let lowerY = visible.minY + visible.height * 0.80
            let origin = list.coordinate(withNormalizedOffset: .zero)
            let start = origin.withOffset(CGVector(dx: list.frame.width / 2,
                                                   dy: (movingDown ? upperY : lowerY) - list.frame.minY))
            let end = origin.withOffset(CGVector(dx: list.frame.width / 2,
                                                 dy: (movingDown ? lowerY : upperY) - list.frame.minY))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        XCTFail("Element is not reachable: \(identifier)", file: file, line: line)
        return target
    }

    private func contentList(for identifier: String) -> XCUIElement {
        if identifier.hasPrefix("inline.") { return app.scrollViews["inline.fields"] }
        let screen: String
        if identifier.hasPrefix("trade.") { screen = "screen.trade" }
        else if identifier.hasPrefix("watchlist.") { screen = "screen.watchlist" }
        else { screen = "screen.orderDetail" }
        return app.collectionViews[screen]
    }

    private func visibleContent(in list: XCUIElement) -> CGRect {
        let frame = list.frame.intersection(app.frame)
        var top = frame.minY
        var bottom = frame.maxY
        let navigation = app.navigationBars.firstMatch
        if navigation.exists { top = max(top, navigation.frame.maxY) }
        let tabs = app.tabBars.firstMatch
        if tabs.exists { bottom = min(bottom, tabs.frame.minY) }
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists {
            bottom = min(bottom, keyboard.frame.minY)
            for toolbar in app.toolbars.allElementsBoundByIndex where toolbar.frame.minY > top {
                bottom = min(bottom, toolbar.frame.minY)
            }
        }
        // The inline scroll view already ends above its fixed action button.
        // Only the full-screen lists need extra clearance from the floating tab bar.
        let bottomClearance: CGFloat = list.identifier == "inline.fields" ? 0 : 12
        return CGRect(x: frame.minX, y: top, width: frame.width, height: max(0, bottom - top - bottomClearance))
    }

    private func tapRevealing(_ identifier: String) { reveal(identifier).tap() }

    private struct CandleWindow: Equatable {
        let first: Int
        let last: Int
        let total: Int
        var count: Int { last - first + 1 }

        init?(value: Any?) {
            guard let text = value as? String else { return nil }
            let numbers = text.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
            guard numbers.count == 3, numbers[0] > 0, numbers[1] >= numbers[0], numbers[2] >= numbers[1] else { return nil }
            first = numbers[0]
            last = numbers[1]
            total = numbers[2]
        }
    }

    private func chartWindow(file: StaticString = #filePath, line: UInt = #line) throws -> CandleWindow {
        let window = element("chart.window")
        XCTAssertTrue(window.waitForExistence(timeout: 5), file: file, line: line)
        return try XCTUnwrap(CandleWindow(value: window.value), "Expected a candle window with first, last and total counts", file: file, line: line)
    }

    private func waitForChartWindow(file: StaticString = #filePath, line: UInt = #line,
                                    matching condition: @escaping (CandleWindow) -> Bool) throws -> CandleWindow {
        let target = element("chart.window")
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate { object, _ in
            guard let element = object as? XCUIElement, let window = CandleWindow(value: element.value) else { return false }
            return condition(window)
        }, object: target)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed,
                       "The actual chart gesture must change the candle window as expected", file: file, line: line)
        return try chartWindow(file: file, line: line)
    }

    private func dragChart(_ plot: XCUIElement, fromX: CGFloat, toX: CGFloat) {
        plot.coordinate(withNormalizedOffset: CGVector(dx: fromX, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: plot.coordinate(withNormalizedOffset: CGVector(dx: toX, dy: 0.5)))
    }

    private func assertChartAboveTradePanel(focusedField: String? = nil, file: StaticString = #filePath, line: UInt = #line) {
        let chart = element("detail.chart")
        let panel = element("detail.tradePanel")
        XCTAssertTrue(chart.exists, file: file, line: line)
        XCTAssertTrue(panel.exists, file: file, line: line)
        let chartFrame = chart.frame
        let panelFrame = panel.frame
        XCTAssertGreaterThanOrEqual(chartFrame.height, 90, file: file, line: line)
        XCTAssertLessThanOrEqual(chartFrame.maxY, panelFrame.minY + 1, file: file, line: line)
        XCTAssertTrue(app.frame.contains(chartFrame), file: file, line: line)
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists {
            var keyboardTop = keyboard.frame.minY
            XCTAssertLessThanOrEqual(chartFrame.maxY, keyboardTop, file: file, line: line)
            for toolbar in app.toolbars.allElementsBoundByIndex {
                let toolbarTop = toolbar.frame.minY
                if toolbarTop > panelFrame.minY { keyboardTop = min(keyboardTop, toolbarTop) }
            }
            XCTAssertLessThanOrEqual(panelFrame.maxY, keyboardTop + 1, file: file, line: line)
            if let focusedField {
                let field = element(focusedField)
                XCTAssertTrue(field.isHittable, file: file, line: line)
                XCTAssertTrue(visibleContent(in: app.scrollViews["inline.fields"]).contains(field.frame), file: file, line: line)
            }
        }
    }

    private func replaceText(_ identifier: String, with text: String) {
        let field = reveal(identifier)
        let value = field.value as? String ?? ""
        let previousText = value == field.placeholderValue ? "" : value
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        if !previousText.isEmpty {
            let editable = reveal(identifier)
            let trailingInset: CGFloat = identifier.hasPrefix("inline.") ? 16 : 1
            editable.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5))
                .withOffset(CGVector(dx: -trailingInset, dy: 0)).tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        }
        let activeField = app.textFields[identifier]
        XCTAssertTrue(activeField.waitForExistence(timeout: 5))
        activeField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: previousText.count) + text)
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: activeField)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed)
    }

    private func dismissKeyboard() {
        let done = app.toolbars.buttons["完成"]
        if done.exists && done.isHittable {
            done.tap()
            let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
            XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 5), .completed)
        }
    }

    private func waitForLabel(_ identifier: String, containing text: String) {
        let target = element(identifier)
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", text), object: target)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed)
    }

    private func changeSystemAppearance(_ appearance: XCUIDevice.Appearance) {
        if waitForRenderedAppearance(appearance, in: app) { return }

        // Apple's Simulator exposes the actual appearance setting under Developer.
        // The XCUIDevice getter did not reliably match rendered pixels on this runtime.
        XCTContext.runActivity(named: "Change Simulator appearance through Developer settings") { _ in
            let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
            settings.launch()
            captureSettingsDiagnostics(settings, name: "settings-open", appearance: appearance)
            let darkAppearance = settings.switches.matching(NSPredicate(
                format: "label CONTAINS[c] %@ OR label CONTAINS %@", "Dark Appearance", "深色外观"
            )).firstMatch
            if !darkAppearance.exists {
                let developer = settings.buttons["com.apple.settings.developer"]
                for _ in 0..<6 {
                    if developer.exists && developer.isHittable { break }
                    settings.swipeUp()
                }
                guard developer.exists && developer.isHittable else {
                    captureSettingsDiagnostics(settings, name: "settings-developer-not-found", appearance: appearance)
                    XCTFail("Simulator Settings must expose the Developer appearance control")
                    return
                }
                developer.tap()
            }
            captureSettingsDiagnostics(settings, name: "settings-developer", appearance: appearance)
            guard darkAppearance.waitForExistence(timeout: 5) else {
                XCTFail("Developer settings must expose the Dark Appearance switch")
                return
            }
            let requestedValue = appearance == .dark ? "1" : "0"
            if darkAppearance.value as? String != requestedValue {
                // Settings exposes a full-row Switch; its center is the label, not the toggle.
                darkAppearance.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            }
            captureSettingsDiagnostics(settings, name: "settings-after-toggle", appearance: appearance)
            let valueChanged = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "value == %@", requestedValue), object: darkAppearance
            )
            XCTAssertEqual(XCTWaiter.wait(for: [valueChanged], timeout: 5), .completed)
            XCTAssertTrue(waitForRenderedAppearance(appearance, in: settings))
            captureSettingsDiagnostics(settings, name: "settings-appearance-applied", appearance: appearance)
            reactivateExistingApp()
            XCTAssertTrue(waitForRenderedAppearance(appearance, in: app), "The app must actually render the requested appearance")
        }
    }

    private func reactivateExistingApp() {
        let state = app.state
        XCTAssertTrue(state == .runningForeground || state == .runningBackground || state == .runningBackgroundSuspended,
                      "The app must still be running before activation, actual state: \(state)")
        app.activate()
    }

    private func captureSettingsDiagnostics(_ settings: XCUIApplication, name: String, appearance: XCUIDevice.Appearance) {
        let screenshot = XCTAttachment(screenshot: settings.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let details = "Requested appearance: \(appearance), device: \(XCUIDevice.shared.appearance), settings state: \(settings.state), app state: \(app.state)\n\(settings.debugDescription)"
        let hierarchy = XCTAttachment(string: details)
        hierarchy.name = name + "-accessibility"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        print(details)
    }

    private func waitForRenderedAppearance(_ appearance: XCUIDevice.Appearance, in application: XCUIApplication) -> Bool {
        let deadline = Date().addingTimeInterval(6)
        var consecutiveMatches = 0
        repeat {
            let matches = matchesAppearance(appearance, screenshot: application.screenshot())
            consecutiveMatches = matches ? consecutiveMatches + 1 : 0
            if consecutiveMatches >= 2 { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return false
    }

    private func matchesAppearance(_ appearance: XCUIDevice.Appearance, screenshot: XCUIScreenshot) -> Bool {
        guard let brightness = screenshotBrightness(screenshot) else { return false }
        return appearance == .dark ? brightness < 0.4 : brightness > 0.65
    }

    private func screenshotBrightness(_ screenshot: XCUIScreenshot) -> Double? {
        guard let image = screenshot.image.cgImage else { return nil }
        let size = 40
        var pixels = [UInt8](repeating: 0, count: size * size * 4)
        return pixels.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) -> Double? in
            guard let context = CGContext(data: buffer.baseAddress, width: size, height: size,
                                          bitsPerComponent: 8, bytesPerRow: size * 4,
                                          space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return nil }
            context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)))
            let bytes = buffer.bindMemory(to: UInt8.self)
            var sum: UInt64 = 0
            for index in stride(from: 0, to: bytes.count, by: 4) {
                sum += UInt64(bytes[index])
                sum += UInt64(bytes[index + 1])
                sum += UInt64(bytes[index + 2])
            }
            return Double(sum) / Double(size * size * 3 * 255)
        }
    }

    private func capture(_ name: String, appearance: XCUIDevice.Appearance? = nil) {
        let screenshot = app.screenshot()
        if let appearance {
            XCTAssertTrue(matchesAppearance(appearance, screenshot: screenshot), "The exported screenshot must show the requested appearance")
        }
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
