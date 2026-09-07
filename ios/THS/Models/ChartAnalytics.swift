import Foundation

enum ChartAnalytics {
    private struct MinuteSession {
        let bounds: DateInterval
        var minutes: [Int: PriceCandle] = [:]
    }

    /// Anchors buckets to each New York session, never across the open, close, or date.
    /// Regular-session buckets require every completed source minute. Extended sessions
    /// may be sparse: aggregate only actual observations, never fabricate prices or volume.
    /// A forming source minute is excluded in every session. The output starts at the
    /// first observed minute of each bucket.
    static func minuteCandles(_ candles: [PriceCandle], interval: Int, asOf: Date,
                              includeExtendedHours: Bool = false) -> [PriceCandle] {
        guard [1, 5, 15, 30, 60, 120].contains(interval),
              asOf.timeIntervalSince1970.isFinite, asOf.timeIntervalSince1970 >= 0,
              asOf.timeIntervalSince1970 < 32_503_680_000 else { return [] }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        var dayWindows: [Date: [(session: EquityTradingSession, bounds: DateInterval)]] = [:]
        var sessions: [Date: MinuteSession] = [:]
        for candle in candles {
            let timestamp = candle.time.timeIntervalSince1970
            guard timestamp.isFinite, timestamp >= 0, timestamp < 32_503_680_000,
                  candle.time.addingTimeInterval(60) <= asOf,
                  [candle.open, candle.high, candle.low, candle.close].allSatisfy({ $0.isFinite && $0 >= 0 }),
                  candle.high >= max(candle.open, candle.close),
                  candle.low <= min(candle.open, candle.close) else { continue }
            let day = calendar.startOfDay(for: candle.time)
            let windows: [(session: EquityTradingSession, bounds: DateInterval)]
            if let cached = dayWindows[day] { windows = cached }
            else {
                windows = EquityTradingSession.windows(on: day)
                dayWindows[day] = windows
            }
            guard let window = windows.first(where: { candle.time >= $0.bounds.start && candle.time < $0.bounds.end }),
                  includeExtendedHours || window.session == .regular else { continue }
            let bounds = window.bounds
            let offset = candle.time.timeIntervalSince(bounds.start)
            guard offset >= 0, offset < bounds.duration,
                  offset.truncatingRemainder(dividingBy: 60) == 0 else { continue }
            // Match the history decoder: the last valid observation at a timestamp wins.
            // Repeated observations never count as additional minutes or volume.
            sessions[bounds.start, default: MinuteSession(bounds: bounds)].minutes[Int(offset / 60)] = candle
        }

        var result: [PriceCandle] = []
        for (_, session) in sessions.sorted(by: { $0.key < $1.key }) {
            let availableMinutes = min(Int(session.bounds.duration / 60),
                                       Int(floor(asOf.timeIntervalSince(session.bounds.start) / 60)))
            guard availableMinutes > 0 else { continue }
            for offset in stride(from: 0, to: availableMinutes, by: interval) {
                let expectedCount = min(interval, availableMinutes - offset)
                let bars = (offset..<(offset + expectedCount)).compactMap { session.minutes[$0] }
                guard session.kind != .regular || bars.count == expectedCount,
                      let first = bars.first, let last = bars.last else { continue }
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
