import XCTest

@MainActor
final class TradingFlowTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        app = XCUIApplication()
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

    func testWatchlistLookupAndFourChartRanges() {
        launch(tab: "watchlist")
        let apple = element("watchlist.symbol.AAPL")
        XCTAssertTrue(apple.waitForExistence(timeout: 5))
        apple.tap()
        XCTAssertTrue(element("detail.lastPrice").waitForExistence(timeout: 5))
        XCTAssertTrue(element("detail.chart").waitForExistence(timeout: 5))
        for range in ["week", "month", "year", "day"] {
            element("history.\(range)").tap()
            XCTAssertTrue(element("detail.chart").waitForExistence(timeout: 5))
        }
        XCTAssertTrue(element("detail.buy").isEnabled)
        XCTAssertTrue(element("detail.sell").isEnabled)
        capture("06-stock-detail-chart")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        replaceText("watchlist.search", with: "QQQ")
        element("watchlist.lookup").tap()
        XCTAssertTrue(app.navigationBars["QQQ"].waitForExistence(timeout: 5))
        XCTAssertTrue(element("detail.lastPrice").waitForExistence(timeout: 5))
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
        let confirmation = app.buttons["确认模拟撤单"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 3))
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
        XCTAssertTrue(app.staticTexts["$197.00"].exists)
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
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func newestOrder() -> XCUIElement {
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "order.row.")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        return row
    }

    private func reveal(_ identifier: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let target = element(identifier)
        for _ in 0..<7 {
            if target.exists && target.isHittable { return target }
            app.swipeUp()
        }
        XCTFail("Element is not reachable: \(identifier)", file: file, line: line)
        return target
    }

    private func tapRevealing(_ identifier: String) { reveal(identifier).tap() }

    private func replaceText(_ identifier: String, with text: String) {
        let field = reveal(identifier)
        field.tap()
        // Tapping the end of the input keeps replacement independent of the localized edit menu.
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        let count = (field.value as? String)?.count ?? 0
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: count) + text)
    }

    private func dismissKeyboard() {
        let done = app.toolbars.buttons["完成"]
        if done.exists { done.tap() }
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
