import Foundation

enum HistoryRange: String, CaseIterable, Sendable {
    case intraday
    case daily
    case weekly
    case monthly
    case fiveDay

    var title: String {
        switch self {
        case .intraday: return "分时"
        case .daily: return "日K"
        case .weekly: return "周K"
        case .monthly: return "月K"
        case .fiveDay: return "五日"
        }
    }

    var isIntraday: Bool { self == .intraday || self == .fiveDay }
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
