import Foundation

struct StockFundamentals: Sendable {
    let symbol: String
    let marketCap: Double?
    let sharesOutstanding: Double?
}

enum MarketStatistics {
    /// Estimated volume pace relative to the previous five daily bars.
    /// This assumes 390-minute regular sessions, so shortened days do not have a corrected baseline.
    /// Forming minute bars are excluded; missing bars or volumes never become zero observations.
    static func volumeRatio(intraday: PriceHistory?, daily: PriceHistory?, asOf: Date = Date()) -> Double? {
        guard let intraday, let daily, intraday.symbol == daily.symbol,
              OrderDraft.isValidSymbol(intraday.symbol), asOf.timeIntervalSince1970.isFinite,
              intraday.candles.allSatisfy({ $0.time.timeIntervalSince1970.isFinite }),
              daily.candles.allSatisfy({ $0.time.timeIntervalSince1970.isFinite }) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        let regularBars = intraday.candles.filter { candle in
            let parts = calendar.dateComponents([.hour, .minute], from: candle.time)
            let minute = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
            return minute >= 9 * 60 + 30 && minute < 16 * 60
        }
        guard let latest = regularBars.max(by: { $0.time < $1.time }) else { return nil }
        let sessionDay = calendar.startOfDay(for: latest.time)
        guard ![1, 7].contains(calendar.component(.weekday, from: sessionDay)),
              let sessionOpen = calendar.date(bySettingHour: 9, minute: 30, second: 0, of: sessionDay) else { return nil }
        let completedBars = regularBars.filter {
            calendar.startOfDay(for: $0.time) == sessionDay && $0.time.addingTimeInterval(60) <= asOf
        }.sorted { $0.time < $1.time }
        guard !completedBars.isEmpty, completedBars.count <= 390 else { return nil }
        var sessionVolume = 0.0
        for (index, bar) in completedBars.enumerated() {
            let expectedTime = sessionOpen.addingTimeInterval(Double(index) * 60)
            guard abs(bar.time.timeIntervalSince(expectedTime)) < 0.001,
                  let volume = bar.volume, volume.isFinite, volume >= 0 else { return nil }
            sessionVolume += volume
        }
        guard sessionVolume.isFinite else { return nil }

        let priorBars = daily.candles.filter { calendar.startOfDay(for: $0.time) < sessionDay }
        let byDate = Dictionary(grouping: priorBars) { calendar.startOfDay(for: $0.time) }
        let priorDates = byDate.keys.sorted(by: >).prefix(5)
        guard priorDates.count == 5 else { return nil }
        var priorVolume = 0.0
        for date in priorDates {
            guard let bars = byDate[date], bars.count == 1, let bar = bars.first,
                  let volume = bar.volume, volume.isFinite, volume >= 0 else { return nil }
            priorVolume += volume
        }
        guard priorVolume.isFinite, priorVolume > 0 else { return nil }
        let baselinePerMinute = priorVolume / (5 * 390)
        let ratio = (sessionVolume / Double(completedBars.count)) / baselinePerMinute
        return ratio.isFinite ? ratio : nil
    }
}
