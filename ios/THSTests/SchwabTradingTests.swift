import Foundation
import XCTest
@testable import THS

final class SchwabTradingTests: XCTestCase {
    private let accountHash = "fixture_Account-HashA1"

    func testAllOrderTypesEncodeOnlyTheirRequiredPricesAndFixedEquityContract() throws {
        for kind in OrderKind.allCases {
            let draft = draft(kind: kind)
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: draft.encoded()) as? [String: Any])
            XCTAssertEqual(payload["orderType"] as? String, kind.rawValue)
            XCTAssertEqual(payload["session"] as? String, "NORMAL")
            XCTAssertEqual(payload["duration"] as? String, "DAY")
            XCTAssertEqual(payload["orderStrategyType"] as? String, "SINGLE")
            let legs = try XCTUnwrap(payload["orderLegCollection"] as? [[String: Any]])
            XCTAssertEqual(legs.count, 1)
            XCTAssertEqual(legs[0]["instruction"] as? String, "BUY")
            XCTAssertEqual(legs[0]["quantity"] as? Int, 3)
            let instrument = try XCTUnwrap(legs[0]["instrument"] as? [String: String])
            XCTAssertEqual(instrument, ["symbol": "AAPL", "assetType": "EQUITY"])
            if kind == .limit || kind == .stopLimit {
                XCTAssertEqual(payload["price"] as? String, "123.4567")
            } else { XCTAssertNil(payload["price"]) }
            if kind == .stop || kind == .stopLimit {
                XCTAssertEqual(payload["stopPrice"] as? String, "124.0001")
            } else { XCTAssertNil(payload["stopPrice"]) }
            XCTAssertNil(payload["childOrderStrategies"])
        }
    }

    func testSellAndGoodTillCancelRemainExplicitInPayload() throws {
        let order = OrderDraft(symbol: "BRK/B", side: .sell, kind: .limit, quantity: 2,
                               limitPrice: Decimal(string: "0.0123"), stopPrice: nil, duration: .goodTillCancel)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: order.encoded()) as? [String: Any])
        XCTAssertEqual(payload["duration"] as? String, "GOOD_TILL_CANCEL")
        XCTAssertEqual(payload["price"] as? String, "0.0123")
        XCTAssertEqual((payload["orderLegCollection"] as? [[String: Any]])?.first?["instruction"] as? String, "SELL")
    }

    func testOrderValidationRejectsOptionsInjectionAndNonpositiveShares() {
        for symbol in ["", "aapl", " AAPL", "AAPL ", "AAPL&quantity=1", "AAPL_260918C250", "../AAPL", "AAPL//A", "1234", "A\nAPL", "AAPL\n"] {
            let order = OrderDraft(symbol: symbol, side: .buy, kind: .market, quantity: 1,
                                   limitPrice: nil, stopPrice: nil, duration: .day)
            XCTAssertThrowsError(try order.encoded()) { XCTAssertEqual($0 as? OrderValidationError, .symbol) }
        }
        for quantity in [0, -1] {
            let order = OrderDraft(symbol: "SPY", side: .buy, kind: .market, quantity: quantity,
                                   limitPrice: nil, stopPrice: nil, duration: .day)
            XCTAssertThrowsError(try order.validate()) { XCTAssertEqual($0 as? OrderValidationError, .quantity) }
        }
        for symbol in ["AAPL", "SPY", "BRK.B", "BRK/B", "BF-B"] {
            XCTAssertTrue(OrderDraft.isValidSymbol(symbol))
        }
    }

    func testDecimalValidationNeverRoundsAnInvalidPriceIntoAnOrder() throws {
        for price in [Decimal.zero, Decimal(-1), Decimal.nan, Decimal(string: "1.00001")!, Decimal(string: "0.00001")!] {
            let order = OrderDraft(symbol: "AAPL", side: .buy, kind: .limit, quantity: 1,
                                   limitPrice: price, stopPrice: nil, duration: .day)
            XCTAssertThrowsError(try order.encoded()) { XCTAssertEqual($0 as? OrderValidationError, .limitPrice) }
        }
        for raw in ["0.0001", "1.2300", "999999.9999"] {
            let price = try XCTUnwrap(Decimal(string: raw))
            let order = OrderDraft(symbol: "AAPL", side: .buy, kind: .limit, quantity: 1,
                                   limitPrice: price, stopPrice: nil, duration: .day)
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: order.encoded()) as? [String: Any])
            let encoded = try XCTUnwrap(payload["price"] as? String)
            XCTAssertEqual(Decimal(string: encoded), price)
            XCTAssertFalse(encoded.contains(","))
        }
    }

    func testMissingUnexpectedPricesAndMarketGTCFailBeforeEncoding() {
        let cases: [(OrderKind, Decimal?, Decimal?, OrderDuration, OrderValidationError)] = [
            (.limit, nil, nil, .day, .limitPrice), (.stop, nil, nil, .day, .stopPrice),
            (.stopLimit, 1, nil, .day, .stopPrice), (.stopLimit, nil, 1, .day, .limitPrice),
            (.market, 1, nil, .day, .unexpectedPrice), (.limit, 1, 1, .day, .unexpectedPrice),
            (.stop, 1, 1, .day, .unexpectedPrice), (.market, nil, nil, .goodTillCancel, .marketDuration)
        ]
        for (kind, limit, stop, duration, expected) in cases {
            let order = OrderDraft(symbol: "AAPL", side: .buy, kind: kind, quantity: 1,
                                   limitPrice: limit, stopPrice: stop, duration: duration)
            XCTAssertThrowsError(try order.encoded()) { XCTAssertEqual($0 as? OrderValidationError, expected) }
        }
    }

    func testIdentifierMappingRejectsNumericAccountNumbersAsHashesAndDuplicateMappings() throws {
        let valid = Data("[{\"accountNumber\":\"12345678\",\"hashValue\":\"fixture_Account-HashA1\"}]".utf8)
        let mapping = try XCTUnwrap(SchwabClient.decodeAccountIdentifiers(valid).first)
        XCTAssertEqual(mapping.accountNumber, "12345678")
        XCTAssertEqual(mapping.hashValue, accountHash)
        for body in [
            "[{\"accountNumber\":\"12345678\",\"hashValue\":\"12345678\"}]",
            "[{\"accountNumber\":\"12345678\",\"hashValue\":\"hash/other\"}]",
            "[{\"accountNumber\":\"12345678\",\"hashValue\":\"hash\"},{\"accountNumber\":\"12345678\",\"hashValue\":\"other\"}]"
        ] {
            XCTAssertThrowsError(try SchwabClient.decodeAccountIdentifiers(Data(body.utf8))) {
                XCTAssertEqual($0 as? SchwabClientError, .invalidResponse)
            }
        }
    }

    func testOrderParsingSupportsInt64IDsPreservesMissingFieldsAndReadsDates() throws {
        let data = try orderJSON(overrides: ["orderId": Int64(9_007_199_254_740_993), "price": NSNull(),
                                             "quantity": NSNull(), "remainingQuantity": NSNull()])
        let order = try SchwabClient.decodeOrder(data)
        XCTAssertEqual(order.id, "9007199254740993")
        XCTAssertNil(order.limitPrice)
        XCTAssertNil(order.quantity)
        XCTAssertNil(order.remainingQuantity)
        XCTAssertNil(order.closedAt)
        XCTAssertEqual(order.side, .buy)
        XCTAssertEqual(order.kind, .limit)
        XCTAssertEqual(order.duration, .day)
        XCTAssertEqual(order.statusTitle, "委托中")
        XCTAssertTrue(order.isOpen)
        XCTAssertFalse(order.editable)
        let entered = try XCTUnwrap(order.enteredAt)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        XCTAssertEqual(calendar.component(.year, from: entered), 2026)
        XCTAssertEqual(calendar.component(.month, from: entered), 9)
        XCTAssertEqual(calendar.component(.hour, from: entered), 2)
    }

    func testOnlyExplicitFlagsEnableSimpleEquityActions() throws {
        let eligible = try SchwabClient.decodeOrder(orderJSON())
        XCTAssertTrue(eligible.isSimpleEquity)
        XCTAssertTrue(eligible.cancelable)
        XCTAssertTrue(eligible.editable)
        let absent = try SchwabClient.decodeOrder(orderJSON(removing: ["editable", "cancelable", "filledQuantity"]))
        XCTAssertFalse(absent.cancelable)
        XCTAssertFalse(absent.editable)
        XCTAssertNil(absent.filledQuantity)
        let partial = try SchwabClient.decodeOrder(orderJSON(overrides: ["filledQuantity": 1, "remainingQuantity": 9]))
        XCTAssertTrue(partial.cancelable)
        XCTAssertFalse(partial.editable)
        let canceled = try SchwabClient.decodeOrder(orderJSON(overrides: ["status": "CANCELED"]))
        XCTAssertFalse(canceled.isOpen)
        XCTAssertFalse(canceled.cancelable)
        XCTAssertFalse(canceled.editable)
    }

    func testComplexOptionsUnknownKindsAndExtendedSessionOrdersRemainReadOnly() throws {
        let legs: [[String: Any]] = [
            ["instruction": "BUY", "instrument": ["symbol": "AAPL", "assetType": "EQUITY"]],
            ["instruction": "SELL", "instrument": ["symbol": "MSFT", "assetType": "EQUITY"]]
        ]
        let variants: [[String: Any]] = [
            ["orderStrategyType": "OCO", "childOrderStrategies": [["orderType": "LIMIT"]]],
            ["orderLegCollection": legs], ["orderType": "NET_DEBIT"], ["session": "SEAMLESS"],
            ["orderLegCollection": [["instruction": "BUY_TO_OPEN", "instrument": ["symbol": "AAPL_260918C250", "assetType": "OPTION"]]]]
        ]
        for variant in variants {
            let order = try SchwabClient.decodeOrder(orderJSON(overrides: variant))
            XCTAssertFalse(order.isSimpleEquity)
            XCTAssertFalse(order.cancelable)
            XCTAssertFalse(order.editable)
        }
        let unknown = try SchwabClient.decodeOrder(orderJSON(overrides: ["status": "FUTURE_BROKER_STATUS"]))
        XCTAssertEqual(unknown.statusTitle, "FUTURE_BROKER_STATUS")
        XCTAssertFalse(unknown.isOpen)
        XCTAssertFalse(unknown.cancelable)
        XCTAssertFalse(unknown.editable)
    }

    func testSpecialInstructionsDisableReplacementWithoutDisablingCancellation() throws {
        for instruction in ["ALL_OR_NONE", "DO_NOT_REDUCE", "ALL_OR_NONE_DO_NOT_REDUCE", "NONE", "FUTURE_INSTRUCTION"] {
            let order = try SchwabClient.decodeOrder(orderJSON(overrides: ["specialInstruction": instruction]))
            XCTAssertTrue(order.isSimpleEquity)
            XCTAssertTrue(order.cancelable)
            XCTAssertFalse(order.editable, "The replacement payload cannot preserve \(instruction)")
        }
        let absent = try SchwabClient.decodeOrder(orderJSON(overrides: ["specialInstruction": NSNull()]))
        XCTAssertTrue(absent.editable)
    }

    func testExplicitTaxLotMethodsCannotBeLostByReplacingASellOrder() throws {
        let sellLeg: [[String: Any]] = [["instruction": "SELL", "instrument": ["symbol": "AAPL", "assetType": "EQUITY"]]]
        for method in ["FIFO", "LIFO", "HIGH_COST", "LOW_COST", "AVERAGE_COST", "SPECIFIC_LOT", "LOSS_HARVESTER"] {
            let order = try SchwabClient.decodeOrder(orderJSON(overrides: ["taxLotMethod": method, "orderLegCollection": sellLeg]))
            XCTAssertEqual(order.side, .sell)
            XCTAssertTrue(order.isSimpleEquity)
            XCTAssertTrue(order.cancelable)
            XCTAssertFalse(order.editable, "No account-specific tax-lot default is assumed for \(method)")
        }
    }

    func testRequestedRouteOnlyAllowsAutomaticDestinationForReplacement() throws {
        let automatic = try SchwabClient.decodeOrder(orderJSON(overrides: ["requestedDestination": "AUTO"]))
        XCTAssertTrue(automatic.editable)
        for route in ["INET", "NYSE", "NASDAQ", "FUTURE_ROUTE"] {
            let order = try SchwabClient.decodeOrder(orderJSON(overrides: ["requestedDestination": route]))
            XCTAssertTrue(order.cancelable)
            XCTAssertFalse(order.editable)
        }
        let unrelatedMetadata = try SchwabClient.decodeOrder(orderJSON(overrides: ["futureResponseMetadata": ["received": true]]))
        XCTAssertTrue(unrelatedMetadata.editable, "Unknown response fields alone do not change supported order instructions")
    }

    func testPricesBeyondDraftPrecisionDisableReplacementWithoutChangingTheReportedPrices() throws {
        let variants: [[String: Any]] = [
            ["price": 0.12345],
            ["orderType": "STOP", "price": NSNull(), "stopPrice": 0.54321],
            ["orderType": "STOP_LIMIT", "price": 123.4567, "stopPrice": 124.00001]
        ]
        for variant in variants {
            let order = try SchwabClient.decodeOrder(orderJSON(overrides: variant))
            XCTAssertTrue(order.isSimpleEquity)
            XCTAssertTrue(order.cancelable)
            XCTAssertFalse(order.editable)
            if let price = variant["price"] as? Double { XCTAssertEqual(order.limitPrice, price) }
            if let stop = variant["stopPrice"] as? Double { XCTAssertEqual(order.stopPrice, stop) }
        }
        for price in [0.1, 0.29, 10.1234, 123.4567] {
            let order = try SchwabClient.decodeOrder(orderJSON(overrides: ["price": price]))
            XCTAssertTrue(order.editable, "Ordinary decimal prices must not fail because of binary floating-point expansion")
        }
    }

    func testExplicitGTCExpiryCannotBeDroppedByReplacement() throws {
        let order = try SchwabClient.decodeOrder(orderJSON(overrides: [
            "duration": "GOOD_TILL_CANCEL", "cancelTime": "2026-10-01T20:00:00.000Z"
        ]))
        XCTAssertEqual(order.duration, .goodTillCancel)
        XCTAssertTrue(order.isSimpleEquity)
        XCTAssertTrue(order.cancelable)
        XCTAssertFalse(order.editable)
        let noExplicitExpiry = try SchwabClient.decodeOrder(orderJSON(overrides: [
            "duration": "GOOD_TILL_CANCEL", "cancelTime": NSNull()
        ]))
        XCTAssertTrue(noExplicitExpiry.editable)
    }

    func testMalformedOrdersReturnOnlyRedactedErrors() throws {
        for data in [try orderJSON(overrides: ["enteredTime": "private-provider-detail"]),
                     try orderJSON(overrides: ["price": "private-provider-detail"]),
                     try orderJSON(overrides: ["orderId": "bad/private-provider-detail"]),
                     try orderJSON(overrides: ["quantity": -1]), Data("private-provider-detail".utf8)] {
            XCTAssertThrowsError(try SchwabClient.decodeOrder(data)) {
                XCTAssertEqual($0 as? SchwabClientError, .invalidResponse)
                XCTAssertFalse($0.localizedDescription.contains("private-provider-detail"))
            }
        }
    }

    func testTransportWhitelistAcceptsOnlyTheImplementedOrderRoutesWithoutNetwork() throws {
        let base = "https://api.schwabapi.com"
        let list = "/trader/v1/accounts/\(accountHash)/orders?maxResults=200&fromEnteredTime=2026-09-01T00:00:00.000Z&toEnteredTime=2026-09-06T00:00:00.000Z"
        let allowed = [("GET", "/trader/v1/accounts/accountNumbers"), ("GET", list),
                       ("GET", "/trader/v1/accounts/\(accountHash)/orders/123"),
                       ("POST", "/trader/v1/accounts/\(accountHash)/orders"),
                       ("PUT", "/trader/v1/accounts/\(accountHash)/orders/123"),
                       ("DELETE", "/trader/v1/accounts/\(accountHash)/orders/123")]
        for (method, path) in allowed {
            XCTAssertNoThrow(try DirectSchwabTransport.validateRequest(request(base + path, method: method)))
        }
        let denied = [("POST", "/trader/v1/accounts"), ("POST", "/trader/v1/accounts/accountNumbers"),
                      ("POST", "/trader/v1/accounts/\(accountHash)/orders/123"),
                      ("PUT", "/trader/v1/accounts/\(accountHash)/orders"),
                      ("DELETE", "/trader/v1/accounts/\(accountHash)/orders"),
                      ("PATCH", "/trader/v1/accounts/\(accountHash)/orders/123"),
                      ("GET", "/trader/v1/accounts/12345678/orders/123"),
                      ("GET", "/trader/v1/accounts/\(accountHash)/orders/123?extra=1"),
                      ("GET", "/trader/v1/accounts/\(accountHash)/orders/123/extra"),
                      ("GET", "/trader/v1/accounts/\(accountHash)/orders/%31%32%33"),
                      ("GET", list + "&maxResults=200"), ("GET", list.replacingOccurrences(of: "maxResults=200", with: "maxResults=201"))]
        for (method, path) in denied {
            XCTAssertThrowsError(try DirectSchwabTransport.validateRequest(request(base + path, method: method))) {
                XCTAssertEqual($0 as? SchwabClientError, .invalidResponse)
            }
        }
        for url in ["http://api.schwabapi.com", "https://api.schwabapi.com:443", "https://api.schwabapi.com.attacker.example", "https://user@api.schwabapi.com"] {
            XCTAssertThrowsError(try DirectSchwabTransport.validateRequest(request(url + "/trader/v1/accounts/accountNumbers")))
        }
    }

    func testInvalidPathsDraftsAndDatesFailBeforeAnyNetworkOrOAuth() async throws {
        let transport = TradingTransport([])
        let client = SchwabClient(store: TradingVault(), transport: transport)
        for hash in ["", "12345678", "hash/../other", "hash?other", "%68ash", "hash\n"] {
            try await assertError(.invalidTradingAccount) { _ = try await client.placeOrder(accountHash: hash, draft: self.draft()) }
        }
        for identifier in ["12/3", "123\n"] {
            try await assertError(.invalidOrderIdentifier) { _ = try await client.cancelOrder(accountHash: self.accountHash, orderID: identifier) }
        }
        for interval in [-1.0, 61.0 * 86_400] {
            try await assertError(.invalidDateRange) {
                _ = try await client.fetchOrders(accountHash: self.accountHash, from: tradingNow,
                                                 to: tradingNow.addingTimeInterval(interval))
            }
        }
        let invalid = OrderDraft(symbol: "AAPL", side: .buy, kind: .market, quantity: 0,
                                 limitPrice: nil, stopPrice: nil, duration: .day)
        do { _ = try await client.placeOrder(accountHash: accountHash, draft: invalid); XCTFail("Invalid draft must fail") }
        catch { XCTAssertEqual(error as? OrderValidationError, .quantity) }
        let count = await transport.recorded().count
        XCTAssertEqual(count, 0)
    }

    func testIdentifierAndOrderReadsUseHashWithBoundedUTCDateParameters() async throws {
        let oneOrder = try orderJSON()
        let array = Data("[\(String(decoding: oneOrder, as: UTF8.self))]".utf8)
        let transport = TradingTransport([.response(200, tradingToken),
                                          .response(200, "[{\"accountNumber\":\"12345678\",\"hashValue\":\"fixture_Account-HashA1\"}]"),
                                          .response(200, String(decoding: array, as: UTF8.self)),
                                          .response(200, String(decoding: oneOrder, as: UTF8.self))])
        let client = try await authorizedClient(transport)
        let identifiers = try await client.fetchAccountIdentifiers()
        XCTAssertEqual(identifiers.value.first?.hashValue, accountHash)
        let response = try await client.fetchOrders(accountHash: accountHash, from: tradingNow.addingTimeInterval(-30 * 86_400), to: tradingNow)
        XCTAssertEqual(response.value.count, 1)
        XCTAssertEqual(response.elapsedMilliseconds, 42)
        let single = try await client.fetchOrder(accountHash: accountHash, orderID: "1234")
        XCTAssertEqual(single.value.id, "1234")
        let requests = await transport.recorded()
        XCTAssertEqual(requests.count, 4)
        XCTAssertEqual(requests[1].url?.path, "/trader/v1/accounts/accountNumbers")
        XCTAssertEqual(requests[2].url?.path, "/trader/v1/accounts/\(accountHash)/orders")
        let items = try XCTUnwrap(URLComponents(url: XCTUnwrap(requests[2].url), resolvingAgainstBaseURL: false)?.queryItems)
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(Set(values.keys), ["maxResults", "fromEnteredTime", "toEnteredTime"])
        XCTAssertEqual(values["maxResults"], "200")
        XCTAssertTrue(try XCTUnwrap(values["fromEnteredTime"]).hasSuffix(".000Z"))
        XCTAssertTrue(try XCTUnwrap(values["toEnteredTime"]).hasSuffix(".000Z"))
        XCTAssertEqual(requests[3].url?.path, "/trader/v1/accounts/\(accountHash)/orders/1234")
        for request in requests.dropFirst() {
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-access")
            XCTAssertNoThrow(try DirectSchwabTransport.validateRequest(request))
        }
    }

    func testSingleOrderResponseCannotSubstituteAnotherOrderID() async throws {
        let transport = TradingTransport([.response(200, tradingToken), .response(200, String(decoding: try orderJSON(), as: UTF8.self))])
        let client = try await authorizedClient(transport)
        try await assertError(.invalidResponse) { _ = try await client.fetchOrder(accountHash: self.accountHash, orderID: "9876") }
    }

    func testPlaceReplaceAndCancelUseOneWriteEachAndReturnAcceptedReceipts() async throws {
        let transport = TradingTransport([.response(200, tradingToken),
                                          .response(201, "", headers: ["Location": "https://api.schwabapi.com/trader/v1/accounts/\(accountHash)/orders/1234"]),
                                          .response(201, "", headers: ["location": "/trader/v1/accounts/\(accountHash)/orders/5678"]),
                                          .response(200, "")])
        let client = try await authorizedClient(transport)
        let placed = try await client.placeOrder(accountHash: accountHash, draft: draft())
        XCTAssertEqual(placed.orderID, "1234")
        XCTAssertEqual(placed.elapsedMilliseconds, 42)
        let replaced = try await client.replaceOrder(accountHash: accountHash, orderID: "1234", draft: draft(kind: .stopLimit))
        XCTAssertEqual(replaced.orderID, "5678")
        let canceled = try await client.cancelOrder(accountHash: accountHash, orderID: "5678")
        XCTAssertEqual(canceled.orderID, "5678")
        let requests = await transport.recorded()
        XCTAssertEqual(requests.map(\.httpMethod), ["POST", "POST", "PUT", "DELETE"])
        XCTAssertEqual(requests[1].httpBody, try draft().encoded())
        XCTAssertEqual(requests[2].httpBody, try draft(kind: .stopLimit).encoded())
        XCTAssertNil(requests[3].httpBody)
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(requests[2].url?.path, "/trader/v1/accounts/\(accountHash)/orders/1234")
    }

    func testMissingOrInvalidLocationDoesNotRetryAnAcceptedOrder() async throws {
        for headers in [[:], ["Location": "https://other.example/orders/1234"],
                        ["Location": "/trader/v1/accounts/differentHash/orders/1234"]] {
            let transport = TradingTransport([.response(200, tradingToken), .response(201, "", headers: headers)])
            let client = try await authorizedClient(transport)
            let receipt = try await client.placeOrder(accountHash: accountHash, draft: draft())
            XCTAssertNil(receipt.orderID)
            let count = await transport.recorded().count
            XCTAssertEqual(count, 2)
        }
    }

    func testLocationParserRejectsHostPathQueryAndEncodingTricks() {
        let path = "/trader/v1/accounts/\(accountHash)/orders/1234"
        XCTAssertEqual(SchwabClient.orderIdentifier(from: ["LOCATION": path], accountHash: accountHash), "1234")
        for value in ["http://api.schwabapi.com" + path, "https://api.schwabapi.com:443" + path,
                      "https://user@api.schwabapi.com" + path, "//api.schwabapi.com" + path,
                      "https://api.schwabapi.com.attacker.example" + path, path + "?extra=1", path + "#fragment",
                      path + "/", path + ",5678", path.replacingOccurrences(of: "1234", with: "%31%32%33%34"),
                      path.replacingOccurrences(of: accountHash, with: "otherHash"), " " + path] {
            XCTAssertNil(SchwabClient.orderIdentifier(from: ["Location": value], accountHash: accountHash))
        }
        XCTAssertNil(SchwabClient.orderIdentifier(from: ["Location": path, "location": path], accountHash: accountHash))
    }

    func testRejectedWritesRedactBodiesDoNotRetryAnd401InvalidatesTheToken() async throws {
        for status in [400, 401, 403, 404, 409, 422, 429] {
            let transport = TradingTransport([.response(200, tradingToken), .response(status, "private-provider-detail fixture-secret")])
            let client = try await authorizedClient(transport)
            try await assertError(.httpStatus(status)) { _ = try await client.placeOrder(accountHash: self.accountHash, draft: self.draft()) }
            let count = await transport.recorded().count
            XCTAssertEqual(count, 2)
            let session = try await client.sessionStatus()
            XCTAssertEqual(session.authenticated, status != 401)
            XCTAssertFalse(SchwabClientError.httpStatus(status).localizedDescription.contains("private-provider-detail"))
        }
    }

    func testServerFailureTimeoutCancellationAndUnexpectedSuccessRemainUnknownWithoutRetry() async throws {
        let replies: [TradingTransport.Reply] = [
            .response(500, "private-provider-detail"), .response(502, ""), .response(503, ""), .response(504, ""),
            .response(408, ""), .response(200, ""), .response(202, ""), .response(204, ""), .failure, .canceled
        ]
        for reply in replies {
            let transport = TradingTransport([.response(200, tradingToken), reply])
            let client = try await authorizedClient(transport)
            try await assertError(.orderOutcomeUnknown) { _ = try await client.placeOrder(accountHash: self.accountHash, draft: self.draft()) }
            let count = await transport.recorded().count
            XCTAssertEqual(count, 2)
        }
    }

    func testReplaceAndCancelFailuresCannotAutomaticallySendAnotherWrite() async throws {
        for method in ["PUT", "DELETE"] {
            let transport = TradingTransport([.response(200, tradingToken), .failure])
            let client = try await authorizedClient(transport)
            try await assertError(.orderOutcomeUnknown) {
                if method == "PUT" {
                    _ = try await client.replaceOrder(accountHash: self.accountHash, orderID: "1234", draft: self.draft())
                } else { _ = try await client.cancelOrder(accountHash: self.accountHash, orderID: "1234") }
            }
            let requests = await transport.recorded()
            XCTAssertEqual(requests.count, 2)
            XCTAssertEqual(requests.last?.httpMethod, method)
        }
    }

    func testSessionChangeAfterDispatchPreservesUnknownOutcomeAndLogout() async throws {
        let transport = TradingTransport([.response(200, tradingToken), .response(201, "")])
        let client = try await authorizedClient(transport)
        await transport.blockNextWrite()
        let operation = Task { try await client.placeOrder(accountHash: self.accountHash, draft: self.draft()) }
        try await waitForSuspension(transport)
        try await client.disconnect()
        await transport.releaseWrite()
        do { _ = try await operation.value; XCTFail("Changed session must retain unknown outcome") }
        catch { XCTAssertEqual(error as? SchwabClientError, .orderOutcomeUnknown) }
        let status = try await client.sessionStatus()
        XCTAssertFalse(status.authenticated)
        let count = await transport.recorded().count
        XCTAssertEqual(count, 2)
    }

    func testHistorySortsAndDeduplicatesMillisecondsWithoutInventingVolume() throws {
        let data = Data("""
        {"symbol":"AAPL","empty":false,"previousClose":10.5,"candles":[
          {"datetime":1800000060000,"open":11,"high":13,"low":10,"close":12,"volume":200},
          {"datetime":1800000000000,"open":10,"high":11,"low":9,"close":10.5},
          {"datetime":1800000060000,"open":11,"high":13,"low":10,"close":12.5,"volume":250}]}
        """.utf8)
        let history = try SchwabClient.decodePriceHistory(data, symbol: "AAPL")
        XCTAssertEqual(history.symbol, "AAPL")
        XCTAssertEqual(history.previousClose, 10.5)
        XCTAssertEqual(history.candles.count, 2)
        XCTAssertEqual(history.candles[0].time.timeIntervalSince1970, 1_800_000_000, accuracy: 0.001)
        XCTAssertNil(history.candles[0].volume)
        XCTAssertEqual(history.candles[1].close, 12.5)
        XCTAssertEqual(history.candles[1].volume, 250)
    }

    func testEmptyHistoryIsValidButMissingOrMalformedCandleFieldsAreRedacted() throws {
        let empty = try SchwabClient.decodePriceHistory(Data("{\"symbol\":\"AAPL\",\"empty\":true,\"candles\":[]}".utf8), symbol: "AAPL")
        XCTAssertTrue(empty.candles.isEmpty)
        XCTAssertNil(empty.previousClose)
        let bodies = [
            "{\"symbol\":\"MSFT\",\"candles\":[]}", "{\"symbol\":\"AAPL\",\"empty\":true}",
            "{\"symbol\":\"AAPL\",\"candles\":[{\"datetime\":1800000000000,\"open\":10,\"high\":11,\"low\":9}]}",
            "{\"symbol\":\"AAPL\",\"candles\":[{\"datetime\":1800000000000,\"open\":10,\"high\":9,\"low\":11,\"close\":10}]}",
            "{\"symbol\":\"AAPL\",\"candles\":[{\"datetime\":1800000000000,\"open\":10,\"high\":11,\"low\":9,\"close\":10,\"volume\":-1}]}",
            "private-provider-detail"
        ]
        for body in bodies {
            XCTAssertThrowsError(try SchwabClient.decodePriceHistory(Data(body.utf8), symbol: "AAPL")) {
                XCTAssertEqual($0 as? SchwabClientError, .invalidResponse)
                XCTAssertFalse($0.localizedDescription.contains("private-provider-detail"))
            }
        }
    }

    func testEveryHistoryRangeSetsAnExplicitCurrentEndAndSupportedFrequency() async throws {
        let body = "{\"symbol\":\"AAPL\",\"empty\":true,\"candles\":[]}"
        let transport = TradingTransport([.response(200, tradingToken)] + HistoryRange.allCases.map { _ in .response(200, body) })
        let client = try await authorizedClient(transport)
        for range in HistoryRange.allCases {
            let history = try await client.fetchPriceHistory(symbol: " aapl ", range: range)
            XCTAssertTrue(history.value.candles.isEmpty)
            XCTAssertEqual(history.elapsedMilliseconds, 42)
        }
        let requests = await transport.recorded()
        let expected = [["day", "1", "minute", "1"], ["day", "5", "minute", "30"],
                        ["month", "1", "daily", "1"], ["year", "1", "daily", "1"]]
        for (index, request) in requests.dropFirst().enumerated() {
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/marketdata/v1/pricehistory")
            let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            let values = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(["periodType", "period", "frequencyType", "frequency"].map { values[$0] ?? "" }, expected[index])
            XCTAssertEqual(values["endDate"], "1800000000000")
            XCTAssertEqual(values["symbol"], "AAPL")
            XCTAssertEqual(values["needExtendedHoursData"], "false")
            XCTAssertEqual(values["needPreviousClose"], "true")
            XCTAssertNil(values["startDate"])
            XCTAssertNoThrow(try DirectSchwabTransport.validateRequest(request))
            var invalid = request
            var badComponents = components
            badComponents.queryItems?.append(URLQueryItem(name: "symbol", value: "MSFT"))
            invalid.url = badComponents.url
            XCTAssertThrowsError(try DirectSchwabTransport.validateRequest(invalid))
        }
    }

    func testQuoteDetailFieldsPreserveOptionalValuesAndBrokerSecurityStatus() throws {
        let data = Data("""
        {"AAPL":{"symbol":"AAPL","assetMainType":"EQUITY","realtime":true,"quote":{
          "openPrice":100,"highPrice":110,"lowPrice":99,"closePrice":101,"totalVolume":12345,
          "52WeekHigh":200,"52WeekLow":80,"securityStatus":"Normal"}},
         "MSFT":{"symbol":"MSFT","quote":{}}}
        """.utf8)
        let quotes = try SchwabClient.decodeQuotes(data, symbols: ["AAPL", "MSFT"])
        XCTAssertEqual(quotes[0].assetMainType, "EQUITY")
        XCTAssertEqual(quotes[0].openPrice, 100)
        XCTAssertEqual(quotes[0].highPrice, 110)
        XCTAssertEqual(quotes[0].lowPrice, 99)
        XCTAssertEqual(quotes[0].closePrice, 101)
        XCTAssertEqual(quotes[0].totalVolume, 12345)
        XCTAssertEqual(quotes[0].high52Week, 200)
        XCTAssertEqual(quotes[0].low52Week, 80)
        XCTAssertEqual(quotes[0].securityStatus, "Normal")
        XCTAssertNil(quotes[1].assetMainType)
        XCTAssertNil(quotes[1].openPrice)
        XCTAssertNil(quotes[1].securityStatus)
    }

    private func draft(kind: OrderKind = .limit) -> OrderDraft {
        OrderDraft(symbol: "AAPL", side: .buy, kind: kind, quantity: 3,
                   limitPrice: kind == .limit || kind == .stopLimit ? Decimal(string: "123.4567") : nil,
                   stopPrice: kind == .stop || kind == .stopLimit ? Decimal(string: "124.0001") : nil,
                   duration: .day)
    }

    private func orderJSON(overrides: [String: Any] = [:], removing: [String] = []) throws -> Data {
        var payload: [String: Any] = [
            "orderId": 1234, "status": "WORKING", "orderType": "LIMIT", "session": "NORMAL", "duration": "DAY",
            "orderStrategyType": "SINGLE", "quantity": 10, "filledQuantity": 0, "remainingQuantity": 10, "price": 123.4567,
            "enteredTime": "2026-09-06T02:03:04.123Z", "cancelable": true, "editable": true,
            "orderLegCollection": [["instruction": "BUY", "instrument": ["symbol": "AAPL", "assetType": "EQUITY"]]]
        ]
        for (key, value) in overrides { payload[key] = value }
        for key in removing { payload.removeValue(forKey: key) }
        return try JSONSerialization.data(withJSONObject: payload)
    }

    private func request(_ url: String, method: String = "GET") throws -> URLRequest {
        var request = URLRequest(url: try XCTUnwrap(URL(string: url)))
        request.httpMethod = method
        if method == "POST" || method == "PUT" {
            request.httpBody = try draft().encoded()
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func authorizedClient(_ transport: TradingTransport) async throws -> SchwabClient {
        let client = SchwabClient(store: TradingVault(), transport: transport, now: { tradingNow })
        try await client.saveCredentials(clientID: "fixture-client", clientSecret: "fixture-secret")
        let authorization = try await client.beginAuthorization()
        let state = try XCTUnwrap(URLComponents(url: authorization, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "state" }?.value)
        try await client.completeAuthorization(callbackURL: "https://127.0.0.1/?code=fixture-code&state=\(state)")
        return client
    }

    private func assertError(_ expected: SchwabClientError, file: StaticString = #filePath, line: UInt = #line,
                             operation: () async throws -> Void) async throws {
        do { try await operation(); XCTFail("Expected \(expected)", file: file, line: line) }
        catch { XCTAssertEqual(error as? SchwabClientError, expected, file: file, line: line) }
    }

    private func waitForSuspension(_ transport: TradingTransport) async throws {
        for _ in 0..<200 {
            if await transport.isSuspended() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        await transport.releaseWrite()
        XCTFail("Fixture write did not suspend")
        throw URLError(.timedOut)
    }
}

private let tradingNow = Date(timeIntervalSince1970: 1_800_000_000)
private let tradingToken = "{\"access_token\":\"fixture-access\",\"refresh_token\":\"fixture-refresh\",\"expires_in\":1800,\"token_type\":\"Bearer\"}"

private final class TradingVault: SchwabSecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?

    func read() throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        return data
    }
    func write(_ data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        self.data = data
    }
    func clear() throws {
        lock.lock(); defer { lock.unlock() }
        data = nil
    }
}

private actor TradingTransport: SchwabHTTPTransport {
    enum Reply: Sendable {
        case response(Int, String, headers: [String: String] = [:])
        case failure
        case canceled
    }
    private var replies: [Reply]
    private var requests: [URLRequest] = []
    private var shouldBlockWrite = false
    private var continuation: CheckedContinuation<Void, Never>?

    init(_ replies: [Reply]) { self.replies = replies }
    func recorded() -> [URLRequest] { requests }
    func blockNextWrite() { shouldBlockWrite = true }
    func isSuspended() -> Bool { continuation != nil }
    func releaseWrite() {
        let pending = continuation
        continuation = nil
        pending?.resume()
    }
    func send(_ request: URLRequest) async throws -> SchwabHTTPResponse {
        requests.append(request)
        guard !replies.isEmpty else { throw URLError(.badServerResponse) }
        let reply = replies.removeFirst()
        if shouldBlockWrite, request.url?.path.contains("/orders") == true, request.httpMethod != "GET" {
            shouldBlockWrite = false
            await withCheckedContinuation { continuation = $0 }
        }
        switch reply {
        case .response(let status, let body, let headers):
            return SchwabHTTPResponse(statusCode: status, data: Data(body.utf8), elapsedMilliseconds: 42, headers: headers)
        case .failure: throw URLError(.timedOut)
        case .canceled: throw CancellationError()
        }
    }
}
