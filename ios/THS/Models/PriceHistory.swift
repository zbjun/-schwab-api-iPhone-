import Foundation

enum HistoryRange: String, CaseIterable, Sendable {
    case day
    case week
    case month
    case year

    var title: String {
        switch self {
        case .day: return "1 日"
        case .week: return "5 日"
        case .month: return "1 月"
        case .year: return "1 年"
        }
    }
}

struct PriceCandle: Identifiable, Sendable {
    let time: Date
    let open: Double
    let high: Double
    let low: Double
    let close: Double
    let volume: Double?

    var id: Date { time }
}

struct PriceHistory: Sendable {
    let symbol: String
    let candles: [PriceCandle]
    let previousClose: Double?
}
