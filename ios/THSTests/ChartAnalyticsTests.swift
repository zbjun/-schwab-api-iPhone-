import Foundation
import XCTest
@testable import THS

final class ChartAnalyticsTests: XCTestCase {
    func testMovingAverageRequiresAFullWindowAndUsesClosingPrices() throws {
        let candles = (1...6).map { candle(close: Double($0), at: date("2026-09-01T14:00:00Z").addingTimeInterval(Double($0) * 60)) }
        let values = ChartAnalytics.movingAverage(candles, period: 3)
        XCTAssertEqual(values.count, candles.count)
        XCTAssertNil(values[0])
        XCTAssertNil(values[1])
        XCTAssertEqual(try XCTUnwrap(values[2]), 2, accuracy: 0.000001)
        XCTAssertEqual(try XCTUnwrap(values[5]), 5, accuracy: 0.000001)
        XCTAssertEqual(ChartAnalytics.movingAverage(candles, period: 1), candles.map { Optional($0.close) })
    }

    func testMovingAverageRejectsInvalidPeriodsAndRecoversAfterInvalidBarLeavesWindow() {
        let start = date("2026-09-01T14:00:00Z")
        let candles = [10.0, .nan, 12.0, 14.0].enumerated().map {
            candle(close: $0.element, at: start.addingTimeInterval(Double($0.offset) * 60))
        }
        for period in [-1, 0, 5] {
            XCTAssertTrue(ChartAnalytics.movingAverage(candles, period: period).allSatisfy { $0 == nil })
        }
        XCTAssertEqual(ChartAnalytics.movingAverage(candles, period: 2), [nil, nil, nil, 13])
        XCTAssertTrue(ChartAnalytics.movingAverage([], period: 5).isEmpty)
    }

    func testSessionAverageUsesWeightedTypicalPriceRatherThanClosingPrice() throws {
        let candles = [
            PriceCandle(time: date("2026-09-01T13:30:00Z"), open: 10, high: 14, low: 8, close: 11, volume: 100),
            PriceCandle(time: date("2026-09-01T13:31:00Z"), open: 11, high: 20, low: 10, close: 15, volume: 300)
        ]
        let values = ChartAnalytics.sessionAverage(candles)
        XCTAssertEqual(try XCTUnwrap(values[0]), 11, accuracy: 0.000001)
        XCTAssertEqual(try XCTUnwrap(values[1]), 14, accuracy: 0.000001)
    }

    func testSessionAverageResetsByNewYorkDateRatherThanUTCMidnight() throws {
        let candles = [
            candle(close: 10, at: date("2026-09-01T23:59:00Z"), volume: 100),
            candle(close: 20, at: date("2026-09-02T00:01:00Z"), volume: 100),
            candle(close: 30, at: date("2026-09-02T13:30:00Z"), volume: 100)
        ]
        let values = ChartAnalytics.sessionAverage(candles)
        XCTAssertEqual(try XCTUnwrap(values[0]), 10, accuracy: 0.000001)
        XCTAssertEqual(try XCTUnwrap(values[1]), 15, accuracy: 0.000001)
        XCTAssertEqual(try XCTUnwrap(values[2]), 30, accuracy: 0.000001)
    }

    func testZeroVolumeCarriesOnlyAnExistingAverage() {
        let candles = [
            candle(close: 9, at: date("2026-09-01T13:30:00Z"), volume: 0),
            candle(close: 10, at: date("2026-09-01T13:31:00Z"), volume: 100),
            candle(close: 20, at: date("2026-09-01T13:32:00Z"), volume: 0)
        ]
        XCTAssertEqual(ChartAnalytics.sessionAverage(candles), [nil, 10, 10])
    }

    func testUnknownOrInvalidVolumeSuppressesTheRemainingSessionUntilNextDate() {
        let invalidVolumes: [Double?] = [nil, -1, Double.nan, Double.infinity]
        for badVolume in invalidVolumes {
            let candles = [
                candle(close: 10, at: date("2026-09-01T13:30:00Z"), volume: 100),
                candle(close: 20, at: date("2026-09-01T13:31:00Z"), volume: badVolume),
                candle(close: 30, at: date("2026-09-01T13:32:00Z"), volume: 100),
                candle(close: 40, at: date("2026-09-02T13:30:00Z"), volume: 100)
            ]
            XCTAssertEqual(ChartAnalytics.sessionAverage(candles), [10, nil, nil, 40])
        }
    }

    func testInvalidTypicalPriceCannotCreateAnAverage() {
        let start = date("2026-09-01T13:30:00Z")
        let candles = [
            PriceCandle(time: start, open: 10, high: 9, low: 8, close: 10, volume: 100),
            candle(close: 10, at: start.addingTimeInterval(60), volume: 100)
        ]
        XCTAssertEqual(ChartAnalytics.sessionAverage(candles), [nil, nil])
    }

    func testTotalShareTurnoverDoesNotSubstituteForMissingSharesOrFloat() throws {
        let quote = metricQuote(volume: 250, shares: 10_000)
        XCTAssertEqual(try XCTUnwrap(quote.turnoverRate), 2.5, accuracy: 0.000001)
        XCTAssertEqual(metricQuote(volume: 0, shares: 10_000).turnoverRate, 0)
        let invalidShares: [Double?] = [nil, 0, -1, Double.nan, Double.infinity]
        for shares in invalidShares {
            XCTAssertNil(metricQuote(volume: 250, shares: shares).turnoverRate)
        }
        let invalidVolumes: [Double?] = [nil, -1, Double.nan, Double.infinity]
        for volume in invalidVolumes {
            XCTAssertNil(metricQuote(volume: volume, shares: 10_000).turnoverRate)
        }
    }

    func testDemoRangesHaveEnoughBarsAndDistinctSessionDates() throws {
        let end = date("2026-09-06T12:00:00Z")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        XCTAssertEqual(HistoryRange.primaryCases.map(\.title), ["分时", "日K", "周K", "月K", "五日"])
        XCTAssertEqual(HistoryRange.minuteCases.compactMap(\.minuteInterval), [1, 5, 15, 30, 60, 120])
        XCTAssertEqual(HistoryRange.allCases, HistoryRange.primaryCases + HistoryRange.minuteCases)
        XCTAssertTrue(HistoryRange.primaryCases.allSatisfy { $0.minuteInterval == nil })
        XCTAssertEqual(HistoryRange.allCases.filter(\.isIntraday), [.intraday, .fiveDay])
        XCTAssertEqual(Set(DemoData.quotes.map(\.symbol)), ["AAPL", "MSFT", "SPY", "QQQ", "NVDA", "AMD", "TSLA", "IWM"])
        for range in HistoryRange.allCases {
            let history = try DemoData.history(symbol: "AAPL", range: range, endingAt: end)
            XCTAssertEqual(history.candles.last?.close, DemoData.quote(symbol: "AAPL")?.lastPrice)
            XCTAssertEqual(history.candles.map(\.time), history.candles.map(\.time).sorted())
            XCTAssertEqual(Set(history.candles.map(\.time)).count, history.candles.count)
            XCTAssertTrue(history.candles.allSatisfy { $0.time <= end && $0.high >= max($0.open, $0.close) && $0.low <= min($0.open, $0.close) })
            if range.isIntraday {
                XCTAssertEqual(history.candles.count, 390)
                let dates = Set(history.candles.map { calendar.startOfDay(for: $0.time) })
                XCTAssertEqual(dates.count, range == .fiveDay ? 5 : 1)
                XCTAssertTrue(ChartAnalytics.sessionAverage(history.candles).allSatisfy { $0 != nil })
            } else {
                XCTAssertGreaterThanOrEqual(history.candles.count, range.minuteInterval == nil ? 60 : 30)
                XCTAssertNotNil(ChartAnalytics.movingAverage(history.candles, period: 30).last!)
                if let interval = range.minuteInterval {
                    XCTAssertEqual(history.candles.count, 10 * Int(ceil(390.0 / Double(interval))))
                }
            }
        }
    }

    private func date(_ text: String) -> Date {
        ISO8601DateFormatter().date(from: text)!
    }

    private func candle(close: Double, at time: Date, volume: Double? = 100) -> PriceCandle {
        PriceCandle(time: time, open: close, high: close, low: close, close: close, volume: volume)
    }

    private func metricQuote(volume: Double?, shares: Double?) -> StockQuote {
        StockQuote(symbol: "AAPL", description: nil, lastPrice: nil, bidPrice: nil, askPrice: nil,
                   netChange: nil, netPercentChange: nil, quoteTime: nil, isRealtime: nil,
                   totalVolume: volume, sharesOutstanding: shares)
    }
}
