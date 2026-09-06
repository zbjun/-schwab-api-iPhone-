import Foundation
import XCTest
@testable import THS

final class SchwabCoreTests: XCTestCase {
    func testAccountParsingPreservesMissingMoneyAndMasksNumber() throws {
        let data = Data("""
        [{"securitiesAccount":{"accountNumber":"123456789","type":"CASH",
          "currentBalances":{"liquidationValue":345.67,"cashBalance":null},
          "positions":[{"instrument":{"symbol":"AAPL","cusip":"TEST-CUSIP","assetType":"EQUITY"},
            "longQuantity":0,"shortQuantity":2,"averagePrice":100.5,"marketValue":-220,
            "currentDayProfitLoss":-19,"currentDayProfitLossPercentage":-10.4}]}}]
        """.utf8)
        let account = try XCTUnwrap(SchwabClient.decodeAccounts(data).first)
        XCTAssertEqual(account.id, "123456789")
        XCTAssertEqual(account.displayNumber, "•••• 6789")
        XCTAssertEqual(account.accountType, "CASH")
        XCTAssertEqual(account.liquidationValue, 345.67)
        XCTAssertNil(account.cashBalance)
        XCTAssertNil(account.buyingPower)
        let position = try XCTUnwrap(account.positions.first)
        XCTAssertEqual(position.quantity, -2)
        XCTAssertEqual(position.description, "AAPL")
        XCTAssertEqual(position.averagePrice, 100.5)
        XCTAssertEqual(position.marketValue, -220)
        XCTAssertEqual(position.dayProfitLossPercent, -10.4)
        XCTAssertFalse(account.displayNumber.contains(account.id))
    }

    func testEmptyAccountsAndMissingPositionsAreValidButMissingQuantityIsNotInvented() throws {
        XCTAssertTrue(try SchwabClient.decodeAccounts(Data("[]".utf8)).isEmpty)
        let accounts = try SchwabClient.decodeAccounts(Data("""
        [{"securitiesAccount":{"accountNumber":"123","type":"MARGIN"}}]
        """.utf8))
        XCTAssertEqual(accounts.first?.displayNumber, "•••")
        XCTAssertTrue(try XCTUnwrap(accounts.first).positions.isEmpty)
        XCTAssertNil(accounts.first?.liquidationValue)
        let missingQuantity = Data("""
        [{"securitiesAccount":{"accountNumber":"12345678","positions":[
          {"instrument":{"symbol":"AAPL"},"marketValue":10}]}}]
        """.utf8)
        XCTAssertThrowsError(try SchwabClient.decodeAccounts(missingQuantity)) { error in
            XCTAssertEqual(error as? SchwabClientError, .invalidResponse)
        }
    }

    func testQuotesUseRootRealtimeAndMillisecondQuoteTimestampWithoutInventedPrices() throws {
        let data = Data("""
        {"AAPL":{"symbol":"AAPL","realtime":true,"reference":{"description":"Apple Inc"},
          "quote":{"lastPrice":234.87,"bidPrice":null,"netPercentChange":1.17165626,
                   "quoteTime":1757102400123,"tradeTime":1757100000000}},
         "MSFT":{"symbol":"MSFT","quote":{}}}
        """.utf8)
        let quotes = try SchwabClient.decodeQuotes(data, symbols: ["MSFT", "AAPL"])
        XCTAssertEqual(quotes.map(\.symbol), ["MSFT", "AAPL"])
        XCTAssertNil(quotes[0].lastPrice)
        XCTAssertNil(quotes[0].quoteTime)
        XCTAssertNil(quotes[0].isRealtime)
        XCTAssertEqual(quotes[1].isRealtime, true)
        XCTAssertEqual(quotes[1].netPercentChange, 1.17165626)
        XCTAssertNil(quotes[1].bidPrice)
        XCTAssertEqual(try XCTUnwrap(quotes[1].quoteTime).timeIntervalSince1970, 1_757_102_400.123, accuracy: 0.001)
    }

    func testMalformedProviderResponsesNeverEscapeIntoErrors() {
        let privateBody = "{\"secret\":\"private-provider-body\",\"accountNumber\":\"987654321\"}"
        for operation in [
            { _ = try SchwabClient.decodeAccounts(Data(privateBody.utf8)) },
            { _ = try SchwabClient.decodeQuotes(Data(privateBody.utf8), symbols: ["AAPL"]) }
        ] {
            XCTAssertThrowsError(try operation()) { error in
                XCTAssertEqual(error as? SchwabClientError, .invalidResponse)
                XCTAssertFalse(error.localizedDescription.contains("private-provider-body"))
                XCTAssertFalse(error.localizedDescription.contains("987654321"))
            }
        }
    }

    func testPartialQuotesSkipInvalidEntriesAndPreserveRequestedOrder() throws {
        let data = Data("""
        {"AAPL":{"symbol":"AAPL","quote":{"lastPrice":234.87}},
         "MSFT":{"symbol":"MSFT","quote":{"lastPrice":450.12}},
         "BROKEN":{"symbol":"BROKEN","quote":{"lastPrice":"invalid-price"}},
         "WRONG":{"symbol":"UNREQUESTED","quote":{"lastPrice":10}},
         "errors":{"invalidSymbols":["INVALID","MISSING"]}}
        """.utf8)
        let quotes = try SchwabClient.decodeQuotes(data,
                                                  symbols: ["MSFT", "INVALID", "BROKEN", "WRONG", "MISSING", "AAPL"])
        XCTAssertEqual(quotes.map(\.symbol), ["MSFT", "AAPL"])
        XCTAssertEqual(quotes[0].lastPrice, 450.12)
        XCTAssertEqual(quotes[1].lastPrice, 234.87)
    }

    func testAllInvalidAndMalformedQuotesReturnOnlyRedactedErrors() {
        let bodies = [
            "{\"errors\":{\"invalidSymbols\":[\"AAPL\"],\"message\":\"private-provider-body\"}}",
            "{\"MSFT\":{\"symbol\":\"MSFT\",\"quote\":{\"lastPrice\":450.12}}}",
            "{\"AAPL\":{\"symbol\":\"MSFT\",\"quote\":{\"lastPrice\":450.12}}}",
            "{\"AAPL\":{\"symbol\":\"AAPL\",\"quote\":{\"lastPrice\":\"private-provider-body\"}}}",
            "{\"AAPL\":{\"symbol\":\"AAPL\"}}",
            "{\"AAPL\":null}", "{}", "[]", "null", "42", "private-provider-body"
        ]
        for body in bodies {
            XCTAssertThrowsError(try SchwabClient.decodeQuotes(Data(body.utf8), symbols: ["AAPL"])) { error in
                XCTAssertEqual(error as? SchwabClientError, .invalidResponse)
                XCTAssertFalse(error.localizedDescription.contains("private-provider-body"))
            }
        }
    }

    func testAuthorizationSurvivesProcessRestartAndConsumesCallbackOnce() async throws {
        let store = MemoryVault()
        let transport = FixtureTransport([.response(200, tokenJSON())])
        let first = SchwabClient(store: store, transport: transport)
        try await first.saveCredentials(clientID: "fixture-client", clientSecret: "fixture-secret")
        let authorizationURL = try await first.beginAuthorization()
        let components = try XCTUnwrap(URLComponents(url: authorizationURL, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.host, "api.schwabapi.com")
        XCTAssertEqual(components.path, "/v1/oauth/authorize")
        XCTAssertEqual(components.queryItems?.first { $0.name == "redirect_uri" }?.value, "https://127.0.0.1")
        let state = try state(from: authorizationURL)
        XCTAssertEqual(state.count, 64)

        let restored = SchwabClient(store: store, transport: transport)
        let callback = "https://127.0.0.1/?code=once%252Bencoded%2Bcode&state=\(state)"
        try await restored.completeAuthorization(callbackURL: callback)
        let status = try await restored.sessionStatus()
        XCTAssertTrue(status.configured)
        XCTAssertTrue(status.authenticated)
        let requests = await transport.recordedRequests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].httpMethod, "POST")
        XCTAssertEqual(requests[0].url?.absoluteString, "https://api.schwabapi.com/v1/oauth/token")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"),
                       "Basic \(Data("fixture-client:fixture-secret".utf8).base64EncodedString())")
        let body = String(data: try XCTUnwrap(requests[0].httpBody), encoding: .utf8)
        XCTAssertTrue(body?.contains("code=once%252Bencoded%2Bcode") == true)
        try await assertError(.authorizationExpired) { try await restored.completeAuthorization(callbackURL: callback) }
        let finalCount = await transport.recordedRequests().count
        XCTAssertEqual(finalCount, 1)
    }

    func testCallbackRejectsWrongOriginDuplicateFieldsAndFragments() async throws {
        let transport = FixtureTransport([])
        let client = SchwabClient(store: MemoryVault(), transport: transport)
        try await client.saveCredentials(clientID: "fixture-client", clientSecret: "fixture-secret")
        let state = try state(from: await client.beginAuthorization())
        let callbacks = [
            "http://127.0.0.1/?code=c&state=\(state)",
            "https://localhost/?code=c&state=\(state)",
            "https://127.0.0.1.attacker.example/?code=c&state=\(state)",
            "https://127.0.0.1:443/?code=c&state=\(state)",
            "https://127.0.0.1:8766/?code=c&state=\(state)",
            "https://name@127.0.0.1/?code=c&state=\(state)",
            "https://127.0.0.1/other?code=c&state=\(state)",
            "https://127.0.0.1/?code=c&state=\(state)#fragment",
            "https://127.0.0.1/?code=c&state=wrong",
            "https://127.0.0.1/?code=c&state=\(state)&state=\(state)",
            "https://127.0.0.1/?code=c&state=\(state)&%73tate=\(state)",
            "https://127.0.0.1/?code=c&code=c&state=\(state)",
            "https://127.0.0.1/?code=&state=\(state)",
            "https://127.0.0.1/?state=\(state)"
        ]
        for callback in callbacks {
            try await assertError(.invalidCallback) { try await client.completeAuthorization(callbackURL: callback) }
        }
        let count = await transport.recordedRequests().count
        XCTAssertEqual(count, 0)
    }

    func testExpiredAndReplacedAuthorizationStatesCannotBeUsed() async throws {
        let clock = FixtureClock()
        let client = SchwabClient(store: MemoryVault(), transport: FixtureTransport([]), now: { clock.now() })
        try await client.saveCredentials(clientID: "fixture-client", clientSecret: "fixture-secret")
        let firstState = try state(from: await client.beginAuthorization())
        let secondState = try state(from: await client.beginAuthorization())
        XCTAssertNotEqual(firstState, secondState)
        try await assertError(.invalidCallback) {
            try await client.completeAuthorization(callbackURL: "https://127.0.0.1/?code=c&state=\(firstState)")
        }
        clock.advance(601)
        try await assertError(.authorizationExpired) {
            try await client.completeAuthorization(callbackURL: "https://127.0.0.1/?code=c&state=\(secondState)")
        }
    }

    func testFailedExchangeConsumesStateAndRedactsProviderAndNetworkErrors() async throws {
        for reply in [FixtureTransport.Reply.response(400, "fixture-secret private-provider-body"),
                      .failure("fixture-secret https://127.0.0.1/?code=private-code")] {
            let transport = FixtureTransport([reply])
            let client = SchwabClient(store: MemoryVault(), transport: transport)
            try await client.saveCredentials(clientID: "fixture-client", clientSecret: "fixture-secret")
            let state = try state(from: await client.beginAuthorization())
            let callback = "https://127.0.0.1/?code=c&state=\(state)"
            do {
                try await client.completeAuthorization(callbackURL: callback)
                XCTFail("Exchange should fail")
            } catch {
                XCTAssertTrue(error is SchwabClientError)
                XCTAssertFalse(error.localizedDescription.contains("fixture-secret"))
                XCTAssertFalse(error.localizedDescription.contains("private-code"))
                XCTAssertFalse(error.localizedDescription.contains("private-provider-body"))
            }
            try await assertError(.authorizationExpired) { try await client.completeAuthorization(callbackURL: callback) }
            let count = await transport.recordedRequests().count
            XCTAssertEqual(count, 1)
        }
    }

    func testRefreshRetainsOmittedRefreshTokenAndReadTimingsExcludeOAuth() async throws {
        let clock = FixtureClock()
        let transport = FixtureTransport([
            .response(200, tokenJSON(access: "access-one", refresh: "refresh-original", expires: 120)),
            .response(200, tokenJSON(access: "access-two", refresh: nil, expires: 120)),
            .response(200, "[]"),
            .response(200, tokenJSON(access: "access-three", refresh: nil, expires: 120)),
            .response(200, "[]")
        ])
        let client = try await authorizedClient(transport: transport, clock: clock)
        clock.advance(61)
        let first = try await client.fetchAccounts()
        clock.advance(61)
        let second = try await client.fetchAccounts()
        XCTAssertTrue(first.value.isEmpty)
        XCTAssertEqual(first.elapsedMilliseconds, 123.4)
        XCTAssertEqual(second.elapsedMilliseconds, 123.4)
        let requests = await transport.recordedRequests()
        let refreshes = requests.filter { request in
            String(data: request.httpBody ?? Data(), encoding: .utf8)?.contains("grant_type=refresh_token") == true
        }
        XCTAssertEqual(refreshes.count, 2)
        for request in refreshes {
            XCTAssertTrue(String(data: request.httpBody ?? Data(), encoding: .utf8)?.contains("refresh_token=refresh-original") == true)
        }
        XCTAssertEqual(requests[2].value(forHTTPHeaderField: "Authorization"), "Bearer access-two")
        XCTAssertEqual(requests[4].value(forHTTPHeaderField: "Authorization"), "Bearer access-three")
    }

    func testConcurrentReadsShareOneRefresh() async throws {
        let clock = FixtureClock()
        let transport = FixtureTransport([
            .response(200, tokenJSON(expires: 120)),
            .response(200, tokenJSON(access: "new-access", expires: 120)),
            .response(200, "[]"), .response(200, "[]")
        ])
        let client = try await authorizedClient(transport: transport, clock: clock)
        clock.advance(61)
        await transport.blockNextTokenRequest()
        let first = Task { try await client.fetchAccounts() }
        try await waitForSuspension(transport)
        let second = Task { try await client.fetchAccounts() }
        try await Task.sleep(nanoseconds: 20_000_000)
        let requestsWhileRefreshing = await transport.recordedRequests()
        XCTAssertEqual(requestsWhileRefreshing.count, 2)
        await transport.releaseTokenRequest()
        _ = try await first.value
        _ = try await second.value
        let tokenRequests = await transport.recordedRequests().filter { $0.url?.path == "/v1/oauth/token" }
        XCTAssertEqual(tokenRequests.count, 2, "One initial exchange and one shared refresh")
    }

    func testLogoutCannotBeUndoneByAnInflightRefresh() async throws {
        let clock = FixtureClock()
        let store = MemoryVault()
        let transport = FixtureTransport([
            .response(200, tokenJSON(expires: 120)),
            .response(200, tokenJSON(access: "late-access", expires: 120))
        ])
        let client = try await authorizedClient(store: store, transport: transport, clock: clock)
        clock.advance(61)
        await transport.blockNextTokenRequest()
        let read = Task { try await client.fetchAccounts() }
        try await waitForSuspension(transport)
        try await client.disconnect()
        await transport.releaseTokenRequest()
        do { _ = try await read.value; XCTFail("Old operation must be discarded") }
        catch { XCTAssertEqual(error as? SchwabClientError, .sessionChanged) }
        let status = try await client.sessionStatus()
        XCTAssertTrue(status.configured)
        XCTAssertFalse(status.authenticated)
        let restored = SchwabClient(store: store, transport: FixtureTransport([]))
        let restoredStatus = try await restored.sessionStatus()
        XCTAssertFalse(restoredStatus.authenticated)
        XCTAssertNil(restoredStatus.expiresAt)
    }

    func testUnauthorizedReadClearsTokensAndForgetAlsoClearsCredentials() async throws {
        let store = MemoryVault()
        let transport = FixtureTransport([.response(200, tokenJSON()), .response(401, "private-account-body")])
        let client = try await authorizedClient(store: store, transport: transport)
        try await assertError(.httpStatus(401)) { _ = try await client.fetchAccounts() }
        let status = try await client.sessionStatus()
        XCTAssertFalse(status.authenticated)
        XCTAssertTrue(status.configured)
        try await client.clearCredentials()
        let cleared = try await client.sessionStatus()
        XCTAssertFalse(cleared.configured)
        try assertOnlyPersonalConfigurationOptOut(store)
    }

    func testInvalidTokensAndSymbolInjectionAreRejected() async throws {
        let transport = FixtureTransport([.response(200, """
        {"access_token":"fixture-access\\nInjected: value","refresh_token":"fixture-refresh", "expires_in":1800}
        """)])
        let client = SchwabClient(store: MemoryVault(), transport: transport)
        try await client.saveCredentials(clientID: "fixture-client", clientSecret: "fixture-secret")
        let state = try state(from: await client.beginAuthorization())
        try await assertError(.invalidResponse) {
            try await client.completeAuthorization(callbackURL: "https://127.0.0.1/?code=c&state=\(state)")
        }
        try await assertError(.invalidSymbols) { _ = try await client.fetchQuotes(symbols: ["AAPL&fields=secret"]) }
        try await assertError(.invalidSymbols) { _ = try await client.fetchQuotes(symbols: []) }
        let count = await transport.recordedRequests().count
        XCTAssertEqual(count, 1)
    }

    func testFailedDisconnectKeepsMemoryAndPersistedSessionConsistent() async throws {
        let store = MemoryVault()
        let client = try await authorizedClient(store: store, transport: FixtureTransport([.response(200, tokenJSON())]))
        let before = try XCTUnwrap(store.read())
        store.failNextWrite()
        try await assertError(.secureStorage) { try await client.disconnect() }
        XCTAssertEqual(try store.read(), before)
        let status = try await client.sessionStatus()
        let restoredStatus = try await SchwabClient(store: store, transport: FixtureTransport([])).sessionStatus()
        XCTAssertTrue(status.authenticated)
        XCTAssertEqual(status.authenticated, restoredStatus.authenticated)
        XCTAssertEqual(status.expiresAt, restoredStatus.expiresAt)
        try await client.disconnect()
        let disconnected = try await client.sessionStatus()
        XCTAssertFalse(disconnected.authenticated)
        XCTAssertTrue(disconnected.configured)
    }

    func testFailedCredentialDeletionKeepsMemoryAndPersistedSessionConsistent() async throws {
        let store = MemoryVault()
        let client = try await authorizedClient(store: store, transport: FixtureTransport([.response(200, tokenJSON())]))
        let before = try XCTUnwrap(store.read())
        store.failNextWrite()
        try await assertError(.secureStorage) { try await client.clearCredentials() }
        XCTAssertEqual(try store.read(), before)
        let status = try await client.sessionStatus()
        let restoredStatus = try await SchwabClient(store: store, transport: FixtureTransport([])).sessionStatus()
        XCTAssertTrue(status.configured)
        XCTAssertTrue(status.authenticated)
        XCTAssertEqual(status.configured, restoredStatus.configured)
        XCTAssertEqual(status.expiresAt, restoredStatus.expiresAt)
        try await client.clearCredentials()
        let cleared = try await client.sessionStatus()
        XCTAssertFalse(cleared.configured)
        XCTAssertFalse(cleared.authenticated)
        try assertOnlyPersonalConfigurationOptOut(store)
    }

    func testFailedTokenInvalidationAfter401DoesNotChangeOnlyTheMemoryCopy() async throws {
        let store = MemoryVault()
        let transport = FixtureTransport([.response(200, tokenJSON()), .response(401, "private-response")])
        let client = try await authorizedClient(store: store, transport: transport)
        let before = try XCTUnwrap(store.read())
        store.failNextWrite()
        try await assertError(.secureStorage) { _ = try await client.fetchAccounts() }
        XCTAssertEqual(try store.read(), before)
        let status = try await client.sessionStatus()
        let restoredStatus = try await SchwabClient(store: store, transport: FixtureTransport([])).sessionStatus()
        XCTAssertTrue(status.authenticated)
        XCTAssertEqual(status.authenticated, restoredStatus.authenticated)
        XCTAssertEqual(status.expiresAt, restoredStatus.expiresAt)
    }

    func testFailedRefreshInvalidationKeepsStoredExpiryInMemory() async throws {
        let store = MemoryVault()
        let clock = FixtureClock()
        let transport = FixtureTransport([.response(200, tokenJSON(expires: 120)), .response(400, "private-response")])
        let client = try await authorizedClient(store: store, transport: transport, clock: clock)
        let before = try XCTUnwrap(store.read())
        clock.advance(61)
        store.failNextWrite()
        try await assertError(.secureStorage) { _ = try await client.fetchAccounts() }
        XCTAssertEqual(try store.read(), before)
        let status = try await client.sessionStatus()
        let restoredStatus = try await SchwabClient(store: store, transport: FixtureTransport([]), now: { clock.now() }).sessionStatus()
        XCTAssertEqual(status.authenticated, restoredStatus.authenticated)
        XCTAssertEqual(status.expiresAt, restoredStatus.expiresAt)
    }

    func testTransportDeniesUnconfiguredWritesAndForeignHostsBeforeAnyNetwork() async throws {
        let transport = DirectSchwabTransport()
        let urls = ["https://api.schwabapi.com/trader/v1/accounts/fixture/orders", "https://other.example/trader/v1/accounts?fields=positions"]
        for url in urls {
            var request = URLRequest(url: try XCTUnwrap(URL(string: url)))
            request.httpMethod = "POST"
            try await assertError(.invalidResponse) { _ = try await transport.send(request) }
        }
    }

    private func assertOnlyPersonalConfigurationOptOut(_ store: MemoryVault,
                                                       file: StaticString = #filePath, line: UInt = #line) throws {
        let data = try XCTUnwrap(store.read(), file: file, line: line)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], file: file, line: line)
        XCTAssertEqual(Set(object.keys), ["personalConfigurationDisabled"], file: file, line: line)
        XCTAssertEqual(object["personalConfigurationDisabled"] as? Bool, true, file: file, line: line)
    }

    private func state(from authorizationURL: URL) throws -> String {
        let components = try XCTUnwrap(URLComponents(url: authorizationURL, resolvingAgainstBaseURL: false))
        return try XCTUnwrap(components.queryItems?.first { $0.name == "state" }?.value)
    }

    private func authorizedClient(store: MemoryVault = MemoryVault(), transport: FixtureTransport,
                                  clock: FixtureClock = FixtureClock()) async throws -> SchwabClient {
        let client = SchwabClient(store: store, transport: transport, now: { clock.now() })
        try await client.saveCredentials(clientID: "fixture-client", clientSecret: "fixture-secret")
        let state = try state(from: await client.beginAuthorization())
        try await client.completeAuthorization(callbackURL: "https://127.0.0.1/?code=fixture-code&state=\(state)")
        return client
    }

    private func assertError(_ expected: SchwabClientError,
                             file: StaticString = #filePath, line: UInt = #line,
                             operation: () async throws -> Void) async throws {
        do {
            try await operation()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? SchwabClientError, expected, file: file, line: line)
        }
    }

    private func waitForSuspension(_ transport: FixtureTransport) async throws {
        for _ in 0..<200 {
            if await transport.isTokenRequestSuspended() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        throw FixtureFailure(message: "Timed out waiting for the test transport")
    }
}

private func tokenJSON(access: String = "fixture-access", refresh: String? = "fixture-refresh", expires: Int = 1_800) -> String {
    let refreshPart = refresh.map { ",\"refresh_token\":\"\($0)\"" } ?? ""
    return "{\"access_token\":\"\(access)\"\(refreshPart),\"expires_in\":\(expires),\"token_type\":\"Bearer\"}"
}

private final class MemoryVault: SchwabSecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    private var shouldFailWrite = false
    func read() throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        return data
    }
    func write(_ data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        if shouldFailWrite {
            shouldFailWrite = false
            throw FixtureFailure(message: "Private storage detail must be redacted")
        }
        self.data = data
    }
    func clear() throws {
        lock.lock(); defer { lock.unlock() }
        data = nil
    }
    func failNextWrite() {
        lock.lock(); defer { lock.unlock() }
        shouldFailWrite = true
    }
}

private final class FixtureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 1_800_000_000)
    func now() -> Date {
        lock.lock(); defer { lock.unlock() }
        return date
    }
    func advance(_ seconds: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        date.addTimeInterval(seconds)
    }
}

private struct FixtureFailure: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private actor FixtureTransport: SchwabHTTPTransport {
    enum Reply: Sendable {
        case response(Int, String)
        case failure(String)
    }
    private var replies: [Reply]
    private var requests: [URLRequest] = []
    private var blockToken = false
    private var continuation: CheckedContinuation<Void, Never>?

    init(_ replies: [Reply]) { self.replies = replies }
    func recordedRequests() -> [URLRequest] { requests }
    func blockNextTokenRequest() { blockToken = true }
    func isTokenRequestSuspended() -> Bool { continuation != nil }
    func releaseTokenRequest() {
        let pending = continuation
        continuation = nil
        pending?.resume()
    }

    func send(_ request: URLRequest) async throws -> SchwabHTTPResponse {
        requests.append(request)
        guard !replies.isEmpty else { throw FixtureFailure(message: "Unexpected test request") }
        let reply = replies.removeFirst()
        if blockToken && request.url?.path == "/v1/oauth/token" {
            blockToken = false
            await withCheckedContinuation { continuation = $0 }
        }
        switch reply {
        case .response(let status, let body):
            return SchwabHTTPResponse(statusCode: status, data: Data(body.utf8), elapsedMilliseconds: 123.4)
        case .failure(let message): throw FixtureFailure(message: message)
        }
    }
}
