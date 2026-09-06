import Foundation

enum AppTab: Hashable {
    case accounts, watchlist, trade, orders, connection
}

struct PreparedOrder: Identifiable, Sendable {
    let id: UUID
    let draft: OrderDraft
    let accountID: String
    let accountDisplay: String
    let accountHash: String
    let quote: StockQuote
    let estimatedValue: Double?
    let availableShares: Double
    let buyingPower: Double?
    let preparedAt: Date
    let replacementOrderID: String?
    let isDemo: Bool
}

enum TradingWorkflowError: Error, LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): return text }
    }
}
