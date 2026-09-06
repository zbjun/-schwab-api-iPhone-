import Foundation

enum ChartAnalytics {
    /// Combines one-minute bars using New York regular-session boundaries, not UTC hours.
    /// Every completed source minute in a bucket must be present. Today's forming bucket
    /// can contain fewer minutes; the currently forming source minute is excluded.
    /// A normal session ends at 16:00, so 60/120-minute series both end with a 30-minute bar.
    /// Without an exchange calendar, a half-day's incomplete final bucket is not synthesized.
    static func minuteCandles(_ candles: [PriceCandle], interval: Int, asOf: Date) -> [PriceCandle] {
        guard [1, 5, 15, 30, 60, 120].contains(interval),
              asOf.timeIntervalSince1970.isFinite, asOf.timeIntervalSince1970 >= 0,
              asOf.timeIntervalSince1970 < 32_503_680_000 else { return [] }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        var sessions: [Date: [Int: PriceCandle]] = [:]
        for candle in candles {
            let timestamp = candle.time.timeIntervalSince1970
            guard timestamp.isFinite, timestamp >= 0, timestamp < 32_503_680_000,
                  candle.time.addingTimeInterval(60) <= asOf,
                  [candle.open, candle.high, candle.low, candle.close].allSatisfy({ $0.isFinite && $0 >= 0 }),
                  candle.high >= max(candle.open, candle.close),
                  candle.low <= min(candle.open, candle.close) else { continue }
            let day = calendar.startOfDay(for: candle.time)
            guard ![1, 7].contains(calendar.component(.weekday, from: day)),
                  let open = calendar.date(bySettingHour: 9, minute: 30, second: 0, of: day) else { continue }
            let offset = candle.time.timeIntervalSince(open)
            guard offset >= 0, offset < 390 * 60, offset.truncatingRemainder(dividingBy: 60) == 0 else { continue }
            // Match the history decoder: the last valid observation at a timestamp wins.
            // Repeated observations never count as additional minutes or volume.
            sessions[day, default: [:]][Int(offset / 60)] = candle
        }

        var result: [PriceCandle] = []
        for (day, minutes) in sessions.sorted(by: { $0.key < $1.key }) {
            guard let open = calendar.date(bySettingHour: 9, minute: 30, second: 0, of: day) else { continue }
            let availableMinutes = min(390, Int(floor(asOf.timeIntervalSince(open) / 60)))
            guard availableMinutes > 0 else { continue }
            for offset in stride(from: 0, to: availableMinutes, by: interval) {
                let expectedCount = min(interval, availableMinutes - offset)
                let bars = (offset..<(offset + expectedCount)).compactMap { minutes[$0] }
                guard bars.count == expectedCount, let first = bars.first, let last = bars.last else { continue }
                var volume: Double? = 0
                for bar in bars {
                    guard let value = bar.volume, value.isFinite, value >= 0,
                          let accumulated = volume, (accumulated + value).isFinite else {
                        volume = nil
                        break
                    }
                    volume = accumulated + value
                }
                result.append(PriceCandle(time: first.time, open: first.open,
                    high: bars.map(\.high).max()!, low: bars.map(\.low).min()!,
                    close: last.close, volume: volume))
            }
        }
        return result
    }

    /// A complete window is required; missing or invalid closes never become zero-price observations.
    static func movingAverage(_ candles: [PriceCandle], period: Int) -> [Double?] {
        var result = [Double?](repeating: nil, count: candles.count)
        guard period > 0, period <= candles.count else { return result }
        for index in (period - 1)..<candles.count {
            let window = candles[(index - period + 1)...index]
            guard window.allSatisfy({ $0.close.isFinite && $0.close >= 0 }) else { continue }
            let average = window.reduce(0) { $0 + $1.close / Double(period) }
            if average.isFinite { result[index] = average }
        }
        return result
    }

    /// Estimated session average from bar typical prices, not a tick-by-tick broker VWAP.
    /// Each New York date starts fresh. A missing volume invalidates the remaining session
    /// because a cumulative weighted average cannot silently omit unknown trades.
    static func sessionAverage(_ candles: [PriceCandle]) -> [Double?] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        var session: Date?
        var volume = 0.0
        var average: Double?
        var incomplete = false

        return candles.map { candle -> Double? in
            guard candle.time.timeIntervalSince1970.isFinite else {
                incomplete = true
                return nil
            }
            let day = calendar.startOfDay(for: candle.time)
            if day != session {
                session = day
                volume = 0
                average = nil
                incomplete = false
            }
            guard !incomplete else { return nil }
            guard let barVolume = candle.volume, barVolume.isFinite, barVolume >= 0,
                  [candle.high, candle.low, candle.close].allSatisfy({ $0.isFinite && $0 >= 0 }),
                  candle.high >= candle.close, candle.low <= candle.close else {
                incomplete = true
                return nil
            }
            if barVolume == 0 { return average }
            let newVolume = volume + barVolume
            let typicalPrice = candle.high / 3 + candle.low / 3 + candle.close / 3
            guard newVolume.isFinite, typicalPrice.isFinite else {
                incomplete = true
                return nil
            }
            let updated = average.map { $0 + (typicalPrice - $0) * (barVolume / newVolume) } ?? typicalPrice
            guard updated.isFinite else {
                incomplete = true
                return nil
            }
            volume = newVolume
            average = updated
            return updated
        }
    }
}
