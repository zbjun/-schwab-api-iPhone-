import SwiftUI
import UIKit

enum MarketTheme {
    static let background = adaptive(light: 0xF4F6F9, dark: 0x101113)
    static let surface = adaptive(light: 0xFFFFFF, dark: 0x1A1C1F)
    static let elevated = adaptive(light: 0xE9EDF3, dark: 0x25272B)
    static let separator = adaptive(light: 0xDDE3EA, dark: 0x2C2F36)
    static let primary = adaptive(light: 0x202833, dark: 0xF5F7FA)
    static let secondary = adaptive(light: 0x626B77, dark: 0xA0A4AD)
    static let rise = adaptive(light: 0xCF332D, dark: 0xFF4A40)
    static let fall = adaptive(light: 0x12813F, dark: 0x29BA59)
    static let average = adaptive(light: 0x966300, dark: 0xFFC233)
    static let ma10 = adaptive(light: 0xB42A86, dark: 0xEF5CB8)
    static let ma30 = adaptive(light: 0x1175AD, dark: 0x3DADEB)
    static let premarket = adaptive(light: 0xB87815, dark: 0xE3B84E)
    static let postmarket = adaptive(light: 0x3475C7, dark: 0x7299E8)

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let rgb = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((rgb >> 16) & 0xFF) / 255,
                           green: CGFloat((rgb >> 8) & 0xFF) / 255,
                           blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
        })
    }

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
        case 5: return primary
        case 10: return ma10
        case 20: return average
        default: return ma30
        }
    }

    static func sessionColor(_ session: EquityTradingSession) -> Color {
        switch session {
        case .premarket: return premarket
        case .regular: return secondary
        case .postmarket: return postmarket
        }
    }
}
