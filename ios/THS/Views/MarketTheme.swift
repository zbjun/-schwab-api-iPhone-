import SwiftUI

enum MarketTheme {
    static let background = Color(red: 0.063, green: 0.067, blue: 0.075)
    static let surface = Color(red: 0.102, green: 0.110, blue: 0.122)
    static let elevated = Color(red: 0.145, green: 0.153, blue: 0.169)
    static let separator = Color.white.opacity(0.08)
    static let secondary = Color(red: 0.61, green: 0.63, blue: 0.67)
    static let rise = Color(red: 1.0, green: 0.29, blue: 0.25)
    static let fall = Color(red: 0.16, green: 0.73, blue: 0.35)
    static let average = Color(red: 1.0, green: 0.76, blue: 0.20)
    static let ma10 = Color(red: 0.94, green: 0.36, blue: 0.72)
    static let ma30 = Color(red: 0.24, green: 0.68, blue: 0.93)

    static func change(_ value: Double?) -> Color {
        guard let value, value.isFinite, value != 0 else { return secondary }
        return value > 0 ? rise : fall
    }

    static func number(_ value: Double?, digits: Int = 2) -> String {
        guard let value, value.isFinite else { return "—" }
        return value.formatted(.number.grouping(.never).precision(.fractionLength(digits)).locale(DisplayFormat.locale))
    }

    static func signedNumber(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return (value > 0 ? "+" : "") + number(value)
    }

    static func averageColor(_ period: Int) -> Color {
        switch period {
        case 5: return .white
        case 10: return ma10
        case 20: return average
        default: return ma30
        }
    }
}
