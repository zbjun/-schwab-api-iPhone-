import Foundation

struct SessionStatus: Sendable {
    let configured: Bool
    let authenticated: Bool
    let expiresAt: Date?
}

struct APIResponse<Value: Sendable>: Sendable {
    let value: Value
    let elapsedMilliseconds: Double
}

struct BrokerageAccount: Identifiable, Sendable {
    let id: String
    let displayNumber: String
    let accountType: String
    let liquidationValue: Double?
    let cashBalance: Double?
    let buyingPower: Double?
    let positions: [Position]
}

struct Position: Identifiable, Sendable {
    let id: String
    let symbol: String
    let description: String
    let assetType: String
    let quantity: Double
    let averagePrice: Double?
    let marketValue: Double?
    let dayProfitLoss: Double?
    let dayProfitLossPercent: Double?
}

struct StockQuote: Identifiable, Sendable {
    let symbol: String
    let description: String?
    let lastPrice: Double?
    let bidPrice: Double?
    let askPrice: Double?
    let netChange: Double?
    let netPercentChange: Double?
    let quoteTime: Date?
    let isRealtime: Bool?

    var id: String { symbol }
}
