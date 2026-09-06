import Foundation

enum HistoryRange: String, CaseIterable, Sendable {
    case intraday
    case daily
    case weekly
    case monthly
    case fiveDay
    case minute1
    case minute5
    case minute15
    case minute30
    case minute60
    case minute120

    static let primaryCases: [HistoryRange] = [.intraday, .daily, .weekly, .monthly, .fiveDay]
    static let minuteCases: [HistoryRange] = [.minute1, .minute5, .minute15, .minute30, .minute60, .minute120]

    var title: String {
        switch self {
        case .intraday: return "分时"
        case .daily: return "日K"
        case .weekly: return "周K"
        case .monthly: return "月K"
        case .fiveDay: return "五日"
        case .minute1: return "1分钟"
        case .minute5: return "5分钟"
        case .minute15: return "15分钟"
        case .minute30: return "30分钟"
        case .minute60: return "60分钟"
        case .minute120: return "120分钟"
        }
    }

    var isIntraday: Bool { self == .intraday || self == .fiveDay }

    var minuteInterval: Int? {
        switch self {
        case .minute1: return 1
        case .minute5: return 5
        case .minute15: return 15
        case .minute30: return 30
        case .minute60: return 60
        case .minute120: return 120
        default: return nil
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
