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
    let assetMainType: String?
    let openPrice: Double?
    let highPrice: Double?
    let lowPrice: Double?
    let closePrice: Double?
    let totalVolume: Double?
    let high52Week: Double?
    let low52Week: Double?
    let securityStatus: String?

    init(symbol: String, description: String?, lastPrice: Double?, bidPrice: Double?, askPrice: Double?,
         netChange: Double?, netPercentChange: Double?, quoteTime: Date?, isRealtime: Bool?,
         assetMainType: String? = nil, openPrice: Double? = nil, highPrice: Double? = nil,
         lowPrice: Double? = nil, closePrice: Double? = nil, totalVolume: Double? = nil,
         high52Week: Double? = nil, low52Week: Double? = nil, securityStatus: String? = nil) {
        self.symbol = symbol
        self.description = description
        self.lastPrice = lastPrice
        self.bidPrice = bidPrice
        self.askPrice = askPrice
        self.netChange = netChange
        self.netPercentChange = netPercentChange
        self.quoteTime = quoteTime
        self.isRealtime = isRealtime
        self.assetMainType = assetMainType
        self.openPrice = openPrice
        self.highPrice = highPrice
        self.lowPrice = lowPrice
        self.closePrice = closePrice
        self.totalVolume = totalVolume
        self.high52Week = high52Week
        self.low52Week = low52Week
        self.securityStatus = securityStatus
    }

    var id: String { symbol }
}
