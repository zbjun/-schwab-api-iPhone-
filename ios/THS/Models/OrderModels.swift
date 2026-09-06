import Foundation

enum OrderSide: String, CaseIterable, Sendable {
    case buy = "BUY"
    case sell = "SELL"

    var title: String { self == .buy ? "买入" : "卖出" }
}

enum OrderKind: String, CaseIterable, Sendable {
    case market = "MARKET"
    case limit = "LIMIT"
    case stop = "STOP"
    case stopLimit = "STOP_LIMIT"

    var title: String {
        switch self {
        case .market: return "市价单"
        case .limit: return "限价单"
        case .stop: return "止损市价单"
        case .stopLimit: return "止损限价单"
        }
    }
}

enum OrderDuration: String, CaseIterable, Sendable {
    case day = "DAY"
    case goodTillCancel = "GOOD_TILL_CANCEL"

    var title: String { self == .day ? "当日有效" : "撤销前有效" }
}

enum OrderValidationError: Error, LocalizedError, Equatable, Sendable {
    case symbol
    case quantity
    case limitPrice
    case stopPrice
    case unexpectedPrice
    case marketDuration

    var errorDescription: String? {
        switch self {
        case .symbol: return "请输入有效的股票或 ETF 代码。"
        case .quantity: return "股数必须是大于 0 的整数。"
        case .limitPrice: return "限价必须大于 0，最多保留 4 位小数。"
        case .stopPrice: return "触发价必须大于 0，最多保留 4 位小数。"
        case .unexpectedPrice: return "当前订单类型不需要这些价格，请重新检查。"
        case .marketDuration: return "市价单仅支持当日有效。"
        }
    }
}

struct OrderDraft: Sendable, Equatable {
    let symbol: String
    let side: OrderSide
    let kind: OrderKind
    let quantity: Int
    let limitPrice: Decimal?
    let stopPrice: Decimal?
    let duration: OrderDuration

    func validate() throws {
        guard Self.isValidSymbol(symbol) else { throw OrderValidationError.symbol }
        guard quantity > 0 else { throw OrderValidationError.quantity }
        switch kind {
        case .market:
            guard limitPrice == nil, stopPrice == nil else { throw OrderValidationError.unexpectedPrice }
            guard duration == .day else { throw OrderValidationError.marketDuration }
        case .limit:
            guard Self.validPrice(limitPrice) else { throw OrderValidationError.limitPrice }
            guard stopPrice == nil else { throw OrderValidationError.unexpectedPrice }
        case .stop:
            guard Self.validPrice(stopPrice) else { throw OrderValidationError.stopPrice }
            guard limitPrice == nil else { throw OrderValidationError.unexpectedPrice }
        case .stopLimit:
            guard Self.validPrice(limitPrice) else { throw OrderValidationError.limitPrice }
            guard Self.validPrice(stopPrice) else { throw OrderValidationError.stopPrice }
        }
    }

    func encoded() throws -> Data {
        try validate()
        var payload: [String: Any] = [
            "orderType": kind.rawValue,
            "session": "NORMAL",
            "duration": duration.rawValue,
            "orderStrategyType": "SINGLE",
            "orderLegCollection": [[
                "instruction": side.rawValue,
                "quantity": quantity,
                "instrument": ["symbol": symbol, "assetType": "EQUITY"]
            ]]
        ]
        if let limitPrice { payload["price"] = Self.priceString(limitPrice) }
        if let stopPrice { payload["stopPrice"] = Self.priceString(stopPrice) }
        return try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    }

    static func isValidSymbol(_ symbol: String) -> Bool {
        symbol.utf8.count <= 15 && symbol.range(of: "\\A[A-Z][A-Z0-9]*([./-][A-Z0-9]+)?\\z",
                                               options: .regularExpression) != nil
    }

    private static func validPrice(_ price: Decimal?) -> Bool {
        guard var price, !price.isNaN, price > 0 else { return false }
        var rounded = Decimal()
        NSDecimalRound(&rounded, &price, 4, .plain)
        return rounded == price
    }

    private static func priceString(_ price: Decimal) -> String {
        var value = price
        return NSDecimalString(&value, Locale(identifier: "en_US_POSIX"))
    }
}

struct TradingAccountIdentifier: Sendable {
    let accountNumber: String
    let hashValue: String
}

struct BrokerageOrder: Identifiable, Sendable {
    let id: String
    let status: String
    let symbol: String
    let side: OrderSide?
    let kind: OrderKind?
    let quantity: Double?
    let filledQuantity: Double?
    let remainingQuantity: Double?
    let limitPrice: Double?
    let stopPrice: Double?
    let duration: OrderDuration?
    let enteredAt: Date?
    let closedAt: Date?
    let cancelable: Bool
    let editable: Bool
    let assetType: String?
    let isSimpleEquity: Bool

    var statusTitle: String {
        switch status {
        case "NEW": return "新建"
        case "ACCEPTED": return "已接受"
        case "WORKING": return "委托中"
        case "QUEUED": return "排队中"
        case "FILLED": return "已成交"
        case "CANCELED": return "已撤销"
        case "REJECTED": return "已拒绝"
        case "EXPIRED": return "已过期"
        case "REPLACED": return "已替换"
        case "PENDING_CANCEL": return "撤单处理中"
        case "PENDING_REPLACE", "AWAITING_REPLACEMENT": return "改单处理中"
        case "PENDING_ACTIVATION": return "等待激活"
        case "AWAITING_STOP_CONDITION", "AWAITING_CONDITION": return "等待触发"
        case "AWAITING_MANUAL_REVIEW": return "等待人工审核"
        case "AWAITING_PARENT_ORDER": return "等待前置订单"
        case "PENDING_ACKNOWLEDGEMENT": return "等待确认"
        case "AWAITING_RELEASE_TIME": return "等待委托时间"
        case "AWAITING_UR_OUT": return "等待交易所回应"
        case "UNKNOWN": return "状态未知"
        default: return status
        }
    }

    var isOpen: Bool {
        Self.openStatuses.contains(status)
    }

    static let openStatuses: Set<String> = [
        "NEW", "ACCEPTED", "WORKING", "QUEUED", "PENDING_CANCEL", "PENDING_REPLACE",
        "AWAITING_REPLACEMENT", "PENDING_ACTIVATION", "AWAITING_STOP_CONDITION",
        "AWAITING_CONDITION", "AWAITING_MANUAL_REVIEW", "AWAITING_PARENT_ORDER",
        "PENDING_ACKNOWLEDGEMENT", "AWAITING_RELEASE_TIME", "AWAITING_UR_OUT"
    ]
}

struct OrderReceipt: Sendable {
    let orderID: String?
    let elapsedMilliseconds: Double
}
