import Foundation
import XCTest
@testable import THS

@MainActor
final class AppStoreTradingTests: XCTestCase {
    func testUITestLaunchIsIsolatedFromDeviceSessionAndPendingOperation() async throws {
        let app = THSApp.makeStore(arguments: ["--uitesting-demo"])
        XCTAssertFalse(app.unresolvedOrderOperation)
        XCTAssertNil(app.tradeError)
        let session = try await app.client.sessionStatus()
        XCTAssertFalse(session.configured)
        XCTAssertFalse(session.authenticated)
        await app.loadUITestDemo(tab: "trade")
        XCTAssertTrue(app.isDemo)
        XCTAssertEqual(app.activeTab, .trade)
        let prepared = await app.prepareOrder(draft())
        XCTAssertTrue(prepared)
        let sent = await app.submitPreparedOrder()
        XCTAssertTrue(sent)
        XCTAssertFalse(app.unresolvedOrderOperation)
    }

    func testDemoCreateReplaceCancelUsesNoNetworkOrLiveMarker() async throws {
        let transport = StoreFixtureTransport()
        let marker = OperationFixtureVault()
        let app = makeStore(transport: transport, marker: marker)
        await app.setDemoMode(true)
        let startingCount = app.orders.count
        let ready = await app.prepareOrder(draft())
        XCTAssertTrue(ready)
        let sent = await app.submitPreparedOrder()
        XCTAssertTrue(sent)
        XCTAssertEqual(app.orders.count, startingCount + 1)
        let duplicate = await app.submitPreparedOrder()
        XCTAssertFalse(duplicate)
        let first = try XCTUnwrap(app.orders.first)
        app.beginReplacement(first)
        let replacementReady = await app.prepareOrder(draft(price: 197))
        XCTAssertTrue(replacementReady)
        let replaced = await app.submitPreparedOrder()
        XCTAssertTrue(replaced)
        XCTAssertEqual(app.orders.first(where: { $0.id == first.id })?.status, "REPLACED")
        let second = try XCTUnwrap(app.orders.first)
        let canceled = await app.cancelOrder(second)
        XCTAssertTrue(canceled)
        XCTAssertEqual(app.orders.first(where: { $0.id == second.id })?.status, "CANCELED")
        let calls = await transport.callCount()
        XCTAssertEqual(calls, 0)
        XCTAssertNil(try marker.read())
    }

    func testSellCannotExceedHoldingsAndReplacementCannotChangeSide() async throws {
        let app = makeStore()
        await app.setDemoMode(true)
        let oversized = await app.prepareOrder(draft(side: .sell, quantity: 21))
        XCTAssertFalse(oversized)
        XCTAssertNil(app.preparedOrder)
        app.beginReplacement(try XCTUnwrap(app.orders.first))
        let changedSide = await app.prepareOrder(draft(side: .sell))
        XCTAssertFalse(changedSide)
        XCTAssertNil(app.preparedOrder)
    }

    func testExpiredReviewAndModeChangeConsumeNoWrite() async throws {
        let clock = StoreFixtureClock()
        let transport = StoreFixtureTransport()
        let app = makeStore(transport: transport, clock: clock)
        await app.setDemoMode(true)
        let ready = await app.prepareOrder(draft())
        XCTAssertTrue(ready)
        clock.advance(121)
        let expired = await app.submitPreparedOrder()
        XCTAssertFalse(expired)
        let fresh = await app.prepareOrder(draft())
        XCTAssertTrue(fresh)
        await app.setDemoMode(false)
        XCTAssertNil(app.preparedOrder)
        let changedMode = await app.submitPreparedOrder()
        XCTAssertFalse(changedMode)
        let calls = await transport.callCount()
        XCTAssertEqual(calls, 0)
    }

    func testReopeningSameTradeResetsReplacementAndReview() async throws {
        let app = makeStore()
        await app.setDemoMode(true)
        app.beginReplacement(try XCTUnwrap(app.orders.first))
        let oldForm = app.tradeFormID
        let ready = await app.prepareOrder(draft())
        XCTAssertTrue(ready)
        app.openTrade(symbol: "AAPL", side: .buy)
        XCTAssertNotEqual(oldForm, app.tradeFormID)
        XCTAssertNil(app.tradeReplacement)
        XCTAssertNil(app.preparedOrder)
    }

    func testSuccessfulLiveReceiptClearsMarkerAndCannotSubmitTwice() async throws {
        let transport = StoreFixtureTransport(reply: .accepted)
        let marker = OperationFixtureVault()
        let app = try await liveStore(transport: transport, marker: marker)
        let ready = await app.prepareOrder(draft())
        XCTAssertTrue(ready)
        async let first = app.submitPreparedOrder()
        async let second = app.submitPreparedOrder()
        let (firstResult, secondResult) = await (first, second)
        XCTAssertEqual([firstResult, secondResult].filter { $0 }.count, 1)
        let writes = await transport.writeCount()
        XCTAssertEqual(writes, 1)
        XCTAssertFalse(app.unresolvedOrderOperation)
        XCTAssertNil(try marker.read())
        XCTAssertEqual(app.activeTab, .orders)
    }

    func testUnknownWriteSurvivesRefreshRestartAndDemoUntilExplicitReconciliation() async throws {
        let transport = StoreFixtureTransport(reply: .network)
        let marker = OperationFixtureVault()
        let app = try await liveStore(transport: transport, marker: marker)
        let ready = await app.prepareOrder(draft())
        XCTAssertTrue(ready)
        let sent = await app.submitPreparedOrder()
        XCTAssertFalse(sent)
        XCTAssertTrue(app.unresolvedOrderOperation)
        XCTAssertNotNil(try marker.read())
        await app.refreshOrders()
        XCTAssertTrue(app.unresolvedOrderOperation)
        let retry = await app.prepareOrder(draft())
        XCTAssertFalse(retry)
        let restored = makeStore(marker: marker)
        XCTAssertTrue(restored.unresolvedOrderOperation)
        await restored.setDemoMode(true)
        let demoReady = await restored.prepareOrder(draft())
        XCTAssertTrue(demoReady)
        let demoSent = await restored.submitPreparedOrder()
        XCTAssertTrue(demoSent)
        restored.acknowledgeOrderReconciliation()
        XCTAssertNotNil(try marker.read(), "Demo must never clear a real pending-operation marker")
        await restored.setDemoMode(false)
        restored.acknowledgeOrderReconciliation()
        XCTAssertNil(try marker.read())
        let writes = await transport.writeCount()
        XCTAssertEqual(writes, 1)
    }

    func testMissingReceiptIdentifierKeepsReconciliationMarker() async throws {
        let marker = OperationFixtureVault()
        let transport = StoreFixtureTransport(reply: .missingIdentifier)
        let app = try await liveStore(transport: transport, marker: marker)
        let ready = await app.prepareOrder(draft())
        XCTAssertTrue(ready)
        let accepted = await app.submitPreparedOrder()
        XCTAssertTrue(accepted)
        XCTAssertTrue(app.unresolvedOrderOperation)
        XCTAssertNotNil(try marker.read())
        let retry = await app.prepareOrder(draft())
        XCTAssertFalse(retry)
        let writes = await transport.writeCount()
        XCTAssertEqual(writes, 1)
    }

    func testDefinitiveRejectionClearsMarkerWithoutAutomaticRetry() async throws {
        let marker = OperationFixtureVault()
        let transport = StoreFixtureTransport(reply: .rejected)
        let app = try await liveStore(transport: transport, marker: marker)
        let ready = await app.prepareOrder(draft())
        XCTAssertTrue(ready)
        let accepted = await app.submitPreparedOrder()
        XCTAssertFalse(accepted)
        XCTAssertFalse(app.unresolvedOrderOperation)
        XCTAssertNil(try marker.read())
        XCTAssertFalse(app.tradeError?.contains("private-provider-detail") ?? true)
        let writes = await transport.writeCount()
        XCTAssertEqual(writes, 1)
    }

    func testMarkerWriteFailurePreventsSendingAndRedactsStorageDetail() async throws {
        let marker = OperationFixtureVault()
        let transport = StoreFixtureTransport()
        let app = try await liveStore(transport: transport, marker: marker)
        let ready = await app.prepareOrder(draft())
        XCTAssertTrue(ready)
        marker.failWrite = true
        let accepted = await app.submitPreparedOrder()
        XCTAssertFalse(accepted)
        XCTAssertFalse(app.tradeError?.contains("private-storage-detail") ?? true)
        let writes = await transport.writeCount()
        XCTAssertEqual(writes, 0)
    }

    func testMarkerClearFailureAfterReceiptKeepsBlockOnFurtherWrites() async throws {
        let marker = OperationFixtureVault()
        let transport = StoreFixtureTransport()
        let app = try await liveStore(transport: transport, marker: marker)
        let ready = await app.prepareOrder(draft())
        XCTAssertTrue(ready)
        marker.failClear = true
        let result = await app.submitPreparedOrder()
        XCTAssertFalse(result)
        XCTAssertTrue(app.unresolvedOrderOperation)
        let retry = await app.prepareOrder(draft())
        XCTAssertFalse(retry)
        let writes = await transport.writeCount()
        XCTAssertEqual(writes, 1)
    }

    func testChangedAccountAndNonEquityQuoteCannotReachOrderWrite() async throws {
        let transport = StoreFixtureTransport()
        let app = try await liveStore(transport: transport)
        let ready = await app.prepareOrder(draft())
        XCTAssertTrue(ready)
        app.selectedAccountID = "different-account"
        // No matching account must be accepted merely because selectedAccount has a display fallback.
        let result = await app.submitPreparedOrder()
        XCTAssertFalse(result)
        let writes = await transport.writeCount()
        XCTAssertEqual(writes, 0)
        let otherTransport = StoreFixtureTransport(assetType: "OPTION")
        let other = try await liveStore(transport: otherTransport)
        let nonEquity = await other.prepareOrder(draft())
        XCTAssertFalse(nonEquity)
    }

    func testLatestFilledOrderCannotBeCanceled() async throws {
        let transport = StoreFixtureTransport(latestStatus: "FILLED")
        let app = try await liveStore(transport: transport)
        let stale = try XCTUnwrap(DemoData.orders.first)
        let result = await app.cancelOrder(stale)
        XCTAssertFalse(result)
        let writes = await transport.writeCount()
        XCTAssertEqual(writes, 0)
    }

    private func draft(side: OrderSide = .buy, quantity: Int = 2, price: Decimal = 195) -> OrderDraft {
        OrderDraft(symbol: "AAPL", side: side, kind: .limit, quantity: quantity,
                   limitPrice: price, stopPrice: nil, duration: .day)
    }

    private func makeStore(transport: StoreFixtureTransport = StoreFixtureTransport(),
                           marker: OperationFixtureVault = OperationFixtureVault(),
                           clock: StoreFixtureClock = StoreFixtureClock()) -> AppStore {
        AppStore(client: SchwabClient(store: OperationFixtureVault(), transport: transport),
                 defaults: UserDefaults(suiteName: "ths.store-tests.\(UUID().uuidString)")!,
                 operationStore: marker, now: { clock.now() })
    }

    private func liveStore(transport: StoreFixtureTransport = StoreFixtureTransport(),
                           marker: OperationFixtureVault = OperationFixtureVault()) async throws -> AppStore {
        let client = SchwabClient(store: OperationFixtureVault(), transport: transport)
        try await client.saveCredentials(clientID: "fixture-client", clientSecret: "fixture-secret")
        let url = try await client.beginAuthorization()
        let state = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value)
        try await client.completeAuthorization(callbackURL: "https://127.0.0.1/?code=fixture-code&state=\(state)")
        let app = AppStore(client: client,
            defaults: UserDefaults(suiteName: "ths.store-tests.\(UUID().uuidString)")!, operationStore: marker)
        await app.load()
        XCTAssertTrue(app.isAuthenticated)
        return app
    }
}

private final class OperationFixtureVault: SchwabSecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    var failWrite = false
    var failClear = false
    func read() throws -> Data? { lock.lock(); defer { lock.unlock() }; return data }
    func write(_ value: Data) throws {
        lock.lock(); defer { lock.unlock() }
        if failWrite { throw StoreFixtureError.privateStorage }
        data = value
    }
    func clear() throws {
        lock.lock(); defer { lock.unlock() }
        if failClear { throw StoreFixtureError.privateStorage }
        data = nil
    }
}

private final class StoreFixtureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 1_800_000_000)
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return date }
    func advance(_ interval: TimeInterval) { lock.lock(); defer { lock.unlock() }; date.addTimeInterval(interval) }
}

private enum StoreFixtureError: Error, LocalizedError, Equatable {
    case privateStorage, network
    var errorDescription: String? { self == .privateStorage ? "private-storage-detail" : "private-network-detail" }
}

private actor StoreFixtureTransport: SchwabHTTPTransport {
    enum Reply: Sendable { case accepted, missingIdentifier, rejected, network }
    private let reply: Reply
    private let assetType: String
    private let latestStatus: String
    private var calls = 0
    private var writes = 0
    init(reply: Reply = .accepted, assetType: String = "EQUITY", latestStatus: String = "WORKING") {
        self.reply = reply; self.assetType = assetType; self.latestStatus = latestStatus
    }
    func callCount() -> Int { calls }
    func writeCount() -> Int { writes }
    func send(_ request: URLRequest) async throws -> SchwabHTTPResponse {
        calls += 1
        let path = request.url?.path ?? ""
        if path == "/v1/oauth/token" {
            return response(200, "{\"access_token\":\"fixture-access\",\"refresh_token\":\"fixture-refresh\",\"expires_in\":1800}")
        }
        if path == "/trader/v1/accounts" {
            return response(200, """
            [{"securitiesAccount":{"accountNumber":"11111111","type":"CASH","currentBalances":{"cashBalance":4000,"buyingPower":4000,"liquidationValue":6000},"positions":[{"instrument":{"symbol":"AAPL","assetType":"EQUITY"},"longQuantity":10,"shortQuantity":0,"marketValue":2000}]}}]
            """)
        }
        if path == "/trader/v1/accounts/accountNumbers" {
            return response(200, "[{\"accountNumber\":\"11111111\",\"hashValue\":\"fixtureHashA\"}]")
        }
        if path == "/marketdata/v1/quotes" {
            let symbols = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "symbols" }?.value ?? "AAPL"
            var body: [String: Any] = [:]
            for symbol in symbols.split(separator: ",").map(String.init) {
                body[symbol] = ["symbol": symbol, "assetMainType": assetType, "realtime": true,
                                "quote": ["lastPrice": 200, "bidPrice": 199.9, "askPrice": 200.1]]
            }
            return SchwabHTTPResponse(statusCode: 200, data: try JSONSerialization.data(withJSONObject: body), elapsedMilliseconds: 10)
        }
        if ["POST", "PUT", "DELETE"].contains(request.httpMethod ?? "") {
            writes += 1
            switch reply {
            case .accepted:
                return SchwabHTTPResponse(statusCode: request.httpMethod == "DELETE" ? 200 : 201, data: Data(),
                    elapsedMilliseconds: 10, headers: ["Location": "https://api.schwabapi.com/trader/v1/accounts/fixtureHashA/orders/7001"])
            case .missingIdentifier: return response(201, "")
            case .rejected: return response(400, "private-provider-detail")
            case .network: throw StoreFixtureError.network
            }
        }
        if path.hasSuffix("/orders") { return response(200, "[]") }
        if path.contains("/orders/") {
            let completed = latestStatus == "FILLED"
            return response(200, """
            {"orderId":910001,"status":"\(latestStatus)","orderType":"LIMIT","session":"NORMAL","duration":"DAY","orderStrategyType":"SINGLE","quantity":2,"filledQuantity":\(completed ? 2 : 0),"remainingQuantity":\(completed ? 0 : 2),"price":195,"cancelable":\(!completed),"editable":\(!completed),"orderLegCollection":[{"instruction":"BUY","quantity":2,"instrument":{"symbol":"AAPL","assetType":"EQUITY"}}]}
            """)
        }
        throw StoreFixtureError.network
    }
    private func response(_ status: Int, _ text: String) -> SchwabHTTPResponse {
        SchwabHTTPResponse(statusCode: status, data: Data(text.utf8), elapsedMilliseconds: 10)
    }
}
