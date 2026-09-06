import Foundation

enum ChartAnalytics {
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
