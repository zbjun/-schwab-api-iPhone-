import XCTest

@MainActor
final class TradingFlowTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        executionTimeAllowance = 240
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
        super.tearDown()
    }

    func testFiveMainScreensHaveDemoContextAndScreenshots() {
        launch()
        for (tab, name) in [("账户", "01-accounts"), ("自选", "02-watchlist"), ("交易", "03-trade"), ("订单", "04-orders"), ("连接", "05-connection")] {
            app.tabBars.buttons[tab].tap()
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
        for symbol in ["AAPL", "MSFT", "SPY", "QQQ"] {
            let row = element("watchlist.symbol.\(symbol)")
            let loaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "分时走势，390"), object: row)
            XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 5), .completed)
        }
        capture("15-watchlist-charts")
        element("watchlist.symbol.AAPL").swipeRight()
        XCTAssertEqual(element("watchlist.symbol.AAPL").value as? String, "行情列表")
        XCTAssertTrue(element("watchlist.symbol.AAPL").exists)
    }

    func testInlineAmountBuyKeepsChartVisibleWithKeyboardAndReview() {
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
        assertChartAboveTradePanel()
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
        app.tabBars.buttons["订单"].tap()
        XCTAssertTrue(element("order.row.910001").waitForExistence(timeout: 5))
        XCTAssertTrue(element("order.row.910002").exists)
    }

    private func launch(tab: String? = nil) {
        app.launchArguments = ["--uitesting-demo", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        if let tab { app.launchArguments += ["--snapshot-tab", tab] }
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["账户"].waitForExistence(timeout: 10))
        XCTAssertFalse(element("reconciliation.orders").exists)
    }

    private func element(_ identifier: String) -> XCUIElement {
        if ["watchlist.search", "trade.quantity", "trade.amount", "trade.limitPrice", "trade.stopPrice", "trade.symbol",
            "inline.quantity", "inline.amount", "inline.limitPrice", "inline.stopPrice"].contains(identifier) {
            return app.textFields[identifier]
        }
        if identifier.hasPrefix("history.") || identifier.hasPrefix("order.row.") || identifier.hasPrefix("watchlist.symbol.") ||
            ["detail.buy", "detail.sell", "watchlist.lookup", "trade.review", "order.review.confirm", "order.cancel", "order.modify"].contains(identifier) {
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
            if target.exists && target.isHittable && visible.contains(target.frame.insetBy(dx: 0, dy: -8)) {
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
        return CGRect(x: frame.minX, y: top, width: frame.width, height: max(0, bottom - top - 12))
    }

    private func tapRevealing(_ identifier: String) { reveal(identifier).tap() }

    private func assertChartAboveTradePanel(file: StaticString = #filePath, line: UInt = #line) {
        let chart = element("detail.chart")
        let panel = element("detail.tradePanel")
        XCTAssertTrue(chart.exists, file: file, line: line)
        XCTAssertTrue(panel.exists, file: file, line: line)
        XCTAssertGreaterThanOrEqual(chart.frame.height, 90, file: file, line: line)
        XCTAssertLessThanOrEqual(chart.frame.maxY, panel.frame.minY + 1, file: file, line: line)
        XCTAssertTrue(app.frame.contains(chart.frame), file: file, line: line)
        if app.keyboards.firstMatch.exists {
            XCTAssertLessThanOrEqual(chart.frame.maxY, app.keyboards.firstMatch.frame.minY, file: file, line: line)
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
            // These inputs align values to the trailing edge. Reposition only after the keyboard has settled.
            editable.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5))
                .withOffset(CGVector(dx: -1, dy: 0)).tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        }
        let activeField = app.textFields[identifier]
        XCTAssertTrue(activeField.waitForExistence(timeout: 5))
        activeField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: previousText.count) + text)
        XCTAssertEqual(activeField.value as? String, text)
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

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
