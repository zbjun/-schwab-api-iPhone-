import XCTest
@testable import THS

final class OrderSizingTests: XCTestCase {
    func testBudgetConversionNeverRoundsUpOrExceedsLimitBudget() {
        XCTAssertEqual(OrderSizing.shares(budget: 1000, price: Decimal(string: "199.99")), 5)
        XCTAssertEqual(OrderSizing.shares(budget: Decimal(string: "0.3"), price: Decimal(string: "0.1")), 3)
        XCTAssertEqual(OrderSizing.shares(budget: 10, price: 11), 0)
        XCTAssertNil(OrderSizing.shares(budget: 100, price: 0))
        XCTAssertNil(OrderSizing.shares(budget: -1, price: 10))
        XCTAssertNil(OrderSizing.shares(budget: Decimal.greatestFiniteMagnitude, price: Decimal(string: "0.0001")))
    }

    func testInputsRejectPrecisionExponentsAndFractionalShares() {
        XCTAssertNil(OrderSizing.price("1.00001"))
        XCTAssertNil(OrderSizing.price("1e3"))
        XCTAssertNil(OrderSizing.quantity(text: "1.5", budget: "", amountMode: false, limitPrice: ""))
        XCTAssertEqual(OrderSizing.quantity(text: "99", budget: "1000", amountMode: true, limitPrice: "200"), 5)
    }

    func testSellCapacityReservesWorkingSharesAndReleasesReplacement() {
        let account = DemoData.accounts[0]
        let draft = OrderDraft(symbol: "AAPL", side: .sell, kind: .limit, quantity: 3,
                               limitPrice: 200, stopPrice: nil, duration: .day)
        let order = DemoData.makeOrder(draft: draft, at: Date())
        XCTAssertEqual(OrderSizing.maximumSell(account: account, symbol: "AAPL", orders: [order], ordersLoaded: true), 17)
        XCTAssertEqual(OrderSizing.maximumSell(account: account, symbol: "AAPL", orders: [order], ordersLoaded: true, excludingOrderID: order.id), 20)
        XCTAssertNil(OrderSizing.maximumSell(account: account, symbol: "AAPL", orders: [], ordersLoaded: false))
        XCTAssertEqual(OrderSizing.maximumBuy(account: account, price: 200), 23)
        XCTAssertNil(OrderSizing.maximumBuy(account: nil, price: 200))
    }

    func testUnknownOrComplexWorkingOrdersDoNotReportAllSharesAvailable() throws {
        let unknown = try SchwabClient.decodeOrders(Data("""
        [{"orderId":9001,"status":"WORKING","remainingQuantity":3}]
        """.utf8))
        XCTAssertNil(OrderSizing.maximumSell(account: DemoData.accounts[0], symbol: "AAPL", orders: unknown, ordersLoaded: true))
        let complex = try SchwabClient.decodeOrders(Data("""
        [{"orderId":9002,"status":"WORKING","remainingQuantity":3,"orderLegCollection":[
            {"instruction":"SELL","instrument":{"symbol":"AAPL","assetType":"EQUITY"}},
            {"instruction":"BUY","instrument":{"symbol":"MSFT","assetType":"EQUITY"}}]}]
        """.utf8))
        XCTAssertNil(OrderSizing.maximumSell(account: DemoData.accounts[0], symbol: "AAPL", orders: complex, ordersLoaded: true))
        let completed = try SchwabClient.decodeOrders(Data("""
        [{"orderId":9001,"status":"CANCELED","remainingQuantity":3}]
        """.utf8))
        XCTAssertEqual(OrderSizing.maximumSell(account: DemoData.accounts[0], symbol: "AAPL", orders: completed, ordersLoaded: true), 20)
    }
}
