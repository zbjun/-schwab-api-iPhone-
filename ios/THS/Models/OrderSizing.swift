import Foundation

enum OrderSizing {
    static func price(_ text: String) -> Decimal? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: "^[0-9]+(?:\\.[0-9]{1,4})?$", options: .regularExpression) != nil,
              let number = Decimal(string: value, locale: Locale(identifier: "en_US_POSIX")),
              !number.isNaN, number > 0 else { return nil }
        return number
    }

    static func shares(budget: Decimal?, price: Decimal?) -> Int? {
        guard let budget, let price, !budget.isNaN, !price.isNaN,
              budget >= 0, price > 0 else { return nil }
        var quotient = budget / price
        guard !quotient.isNaN else { return nil }
        var rounded = Decimal()
        NSDecimalRound(&rounded, &quotient, 0, .down)
        guard rounded <= Decimal(Int.max), rounded >= 0 else { return nil }
        return NSDecimalNumber(decimal: rounded).intValue
    }

    static func decimal(_ value: Double?) -> Decimal? {
        guard let value, value.isFinite, value >= 0 else { return nil }
        return Decimal(string: String(value), locale: Locale(identifier: "en_US_POSIX"))
    }

    static func maximumBuy(account: BrokerageAccount?, price: Decimal?) -> Int? {
        shares(budget: decimal(account?.buyingPower), price: price)
    }

    static func maximumSell(account: BrokerageAccount?, symbol: String,
                            orders: [BrokerageOrder], ordersLoaded: Bool,
                            excludingOrderID: String? = nil) -> Int? {
        guard let account, ordersLoaded else { return nil }
        let positions = account.positions.filter { $0.symbol == symbol && $0.assetType == "EQUITY" }
        guard positions.allSatisfy({ $0.quantity.isFinite && $0.quantity >= 0 }) else { return nil }
        let held = positions.reduce(0) { $0 + $1.quantity }
        let finalStates = ["FILLED", "CANCELED", "REJECTED", "EXPIRED", "REPLACED"]
        var reserved = 0.0
        for order in orders where order.id != excludingOrderID && !finalStates.contains(order.status) {
            let symbols = order.symbol.components(separatedBy: " / ")
            guard symbols.contains(symbol) || order.symbol.isEmpty || order.symbol == "未知标的" else { continue }
            if order.side == .buy { continue }
            guard order.side == .sell, let remaining = order.remainingQuantity,
                  remaining.isFinite, remaining >= 0 else { return nil }
            reserved += remaining
            guard reserved.isFinite else { return nil }
        }
        return shares(budget: decimal(max(0, held - reserved)), price: 1)
    }

    static func quantity(text: String, budget: String, amountMode: Bool, limitPrice: String) -> Int? {
        if amountMode { return shares(budget: price(budget), price: price(limitPrice)) }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: "^[0-9]+$", options: .regularExpression) != nil else { return nil }
        return Int(value)
    }
}
