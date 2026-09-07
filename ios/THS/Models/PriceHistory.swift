import Foundation

enum EquityTradingSession: String, CaseIterable, Sendable {
    case premarket
    case regular
    case postmarket

    var title: String {
        switch self {
        case .premarket: return "盘前"
        case .regular: return "盘中"
        case .postmarket: return "盘后"
        }
    }

    static func at(_ date: Date) -> EquityTradingSession? { window(containing: date)?.session }

    static func bounds(containing date: Date) -> DateInterval? { window(containing: date)?.bounds }

    private static let calendar: Calendar = {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(identifier: "America/New_York")!
        return value
    }()

    // NYSE's announced 2026–2028 calendar, including its late-session 17:00 close
    // on early-close days. Emergency closures are not predicted. Outside these
    // published years the ordinary weekday schedule is only a fallback.
    // https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/
    private static let earlyClosingDates: Set<Int> = [20261127, 20261224, 20271126, 20280703, 20281124]
    private static let closedDates: Set<Int> = [
        20260101, 20260119, 20260216, 20260403, 20260525, 20260619, 20260703, 20260907, 20261126, 20261225,
        20270101, 20270118, 20270215, 20270326, 20270531, 20270618, 20270705, 20270906, 20271125, 20271224,
        20280117, 20280221, 20280414, 20280529, 20280619, 20280704, 20280904, 20281123, 20281225
    ]

    private static func window(containing date: Date) -> (session: EquityTradingSession, bounds: DateInterval)? {
        windows(on: date).first { date >= $0.bounds.start && date < $0.bounds.end }
    }

    /// One date's windows can be reused while grouping a large minute-history response.
    static func windows(on date: Date) -> [(session: EquityTradingSession, bounds: DateInterval)] {
        let timestamp = date.timeIntervalSince1970
        guard timestamp.isFinite, timestamp >= 0, timestamp < 32_503_680_000 else { return [] }
        let day = calendar.startOfDay(for: date)
        let components = calendar.dateComponents([.year, .month, .day, .weekday], from: day)
        guard let year = components.year, let month = components.month, let dayOfMonth = components.day,
              let weekday = components.weekday, ![1, 7].contains(weekday) else { return [] }
        let dateKey = year * 10_000 + month * 100 + dayOfMonth
        guard !closedDates.contains(dateKey) else { return [] }
        let isEarlyClose = earlyClosingDates.contains(dateKey)
        guard
              let premarketStart = calendar.date(bySettingHour: 4, minute: 0, second: 0, of: day),
              let regularStart = calendar.date(bySettingHour: 9, minute: 30, second: 0, of: day),
              let regularEnd = calendar.date(bySettingHour: isEarlyClose ? 13 : 16, minute: 0, second: 0, of: day),
              let postmarketEnd = calendar.date(bySettingHour: isEarlyClose ? 17 : 20, minute: 0, second: 0, of: day) else { return [] }
        let windows: [(EquityTradingSession, Date, Date)] = [
            (.premarket, premarketStart, regularStart), (.regular, regularStart, regularEnd),
            (.postmarket, regularEnd, postmarketEnd)
        ]
        return windows.map { (session: $0.0, bounds: DateInterval(start: $0.1, end: $0.2)) }
    }
}

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

    var includesExtendedHours: Bool { isIntraday || minuteInterval != nil }

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
