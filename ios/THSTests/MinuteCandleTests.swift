import Foundation
import XCTest
@testable import THS

final class MinuteCandleTests: XCTestCase {
    func testPublishedEarlyClosesAndHolidaysUseTheirActualBoundaries() throws {
        for day in ["2026-11-27", "2026-12-24", "2027-11-26", "2028-11-24"] {
            XCTAssertEqual(EquityTradingSession.at(date(day + "T17:59:59Z")), .regular)
            XCTAssertEqual(EquityTradingSession.at(date(day + "T18:00:00Z")), .postmarket)
            XCTAssertEqual(EquityTradingSession.bounds(containing: date(day + "T18:00:00Z"))?.end,
                           date(day + "T22:00:00Z"))
            XCTAssertNil(EquityTradingSession.at(date(day + "T22:00:00Z")))
        }
        XCTAssertEqual(EquityTradingSession.at(date("2028-07-03T17:00:00Z")), .postmarket)
        XCTAssertNil(EquityTradingSession.at(date("2028-07-03T21:00:00Z")))
        for day in ["2026-07-03", "2026-09-07", "2026-11-26", "2027-12-24", "2028-07-04"] {
            XCTAssertTrue(EquityTradingSession.windows(on: date(day + "T14:00:00Z")).isEmpty)
        }
        XCTAssertEqual(EquityTradingSession.at(date("2027-12-31T19:00:00Z")), .regular)
        let start = date("2026-11-27T14:30:00Z")
        let source = minutes(start: start, count: 210)
        let bars = ChartAnalytics.minuteCandles(source, interval: 60,
            asOf: date("2026-11-27T22:00:00Z"), includeExtendedHours: true)
        XCTAssertEqual(bars.count, 4)
        XCTAssertEqual(bars.last?.volume, 3_000)
        XCTAssertEqual(bars.last?.close, source.last?.close)
    }

    func testTradingSessionBoundariesAreHalfOpenAndUseNewYorkTime() throws {
        XCTAssertEqual(EquityTradingSession.allCases.map(\.title), ["盘前", "盘中", "盘后"])
        let cases: [(String, EquityTradingSession?)] = [
            ("2026-09-04T07:59:59Z", nil), ("2026-09-04T08:00:00Z", .premarket),
            ("2026-09-04T13:29:59Z", .premarket), ("2026-09-04T13:30:00Z", .regular),
            ("2026-09-04T19:59:59Z", .regular), ("2026-09-04T20:00:00Z", .postmarket),
            ("2026-09-04T23:59:59Z", .postmarket), ("2026-09-05T00:00:00Z", nil),
            ("2026-09-05T14:00:00Z", nil), ("2026-09-06T14:00:00Z", nil)
        ]
        for (timestamp, expected) in cases {
            let point = date(timestamp)
            XCTAssertEqual(EquityTradingSession.at(point), expected, timestamp)
            if expected != nil {
                let bounds = try XCTUnwrap(EquityTradingSession.bounds(containing: point))
                XCTAssertTrue(point >= bounds.start && point < bounds.end)
            } else { XCTAssertNil(EquityTradingSession.bounds(containing: point)) }
        }
        for timestamp in [Double.nan, Double.infinity, -1, 32_503_680_000] {
            XCTAssertNil(EquityTradingSession.at(Date(timeIntervalSince1970: timestamp)))
            XCTAssertNil(EquityTradingSession.bounds(containing: Date(timeIntervalSince1970: timestamp)))
        }
    }

    func testAllThreeTradingSessionWindowsFollowBothDSTChanges() throws {
        let rows = [
            ["2026-03-06T09:00:00Z", "2026-03-06T14:30:00Z", "2026-03-06T21:00:00Z", "2026-03-07T01:00:00Z"],
            ["2026-03-09T08:00:00Z", "2026-03-09T13:30:00Z", "2026-03-09T20:00:00Z", "2026-03-10T00:00:00Z"],
            ["2026-10-30T08:00:00Z", "2026-10-30T13:30:00Z", "2026-10-30T20:00:00Z", "2026-10-31T00:00:00Z"],
            ["2026-11-02T09:00:00Z", "2026-11-02T14:30:00Z", "2026-11-02T21:00:00Z", "2026-11-03T01:00:00Z"]
        ]
        for row in rows {
            let times = row.map(date)
            for (index, session) in EquityTradingSession.allCases.enumerated() {
                XCTAssertEqual(EquityTradingSession.at(times[index]), session)
                let bounds = try XCTUnwrap(EquityTradingSession.bounds(containing: times[index]))
                XCTAssertEqual(bounds.start, times[index])
                XCTAssertEqual(bounds.end, times[index + 1])
            }
            XCTAssertNil(EquityTradingSession.at(times[3]))
        }
    }

    func testHistoryRangeExtendedHoursMatchesTheMinuteBasedChartsOnly() {
        XCTAssertEqual(HistoryRange.allCases.filter(\.includesExtendedHours),
                       [.intraday, .fiveDay, .minute1, .minute5, .minute15, .minute30, .minute60, .minute120])
        for range in [HistoryRange.daily, .weekly, .monthly] { XCTAssertFalse(range.includesExtendedHours) }
    }

    func testExtendedAggregationNeverCrossesTheOpenCloseOrTradingDate() throws {
        let premarket = date("2026-09-04T08:00:00Z")
        let regular = date("2026-09-04T13:30:00Z")
        let postmarket = date("2026-09-04T20:00:00Z")
        let source = minutes(start: premarket, count: 330) + minutes(start: regular, count: 390)
            + minutes(start: postmarket, count: 240)
        for interval in [60, 120] {
            let bars = ChartAnalytics.minuteCandles(source, interval: interval,
                asOf: date("2026-09-05T00:00:00Z"), includeExtendedHours: true)
            let pre = bars.filter { EquityTradingSession.at($0.time) == .premarket }
            let main = bars.filter { EquityTradingSession.at($0.time) == .regular }
            let post = bars.filter { EquityTradingSession.at($0.time) == .postmarket }
            XCTAssertEqual(pre.count, interval == 60 ? 6 : 3)
            XCTAssertEqual(main.count, interval == 60 ? 7 : 4)
            XCTAssertEqual(post.count, interval == 60 ? 4 : 2)
            XCTAssertEqual(pre.last?.close, 429.5)
            XCTAssertEqual(pre.last?.volume, interval == 60 ? 3_000 : 9_000)
            XCTAssertEqual(main.first?.time, regular)
            XCTAssertEqual(main.first?.open, 100)
            XCTAssertEqual(main.last?.volume, 3_000)
            XCTAssertEqual(post.first?.time, postmarket)
            XCTAssertEqual(post.first?.open, 100)
            XCTAssertEqual(bars.compactMap(\.volume).reduce(0, +), 96_000)
        }
    }

    func testSparseExtendedMinutesProduceOnlyObservedOHLCAndVolume() throws {
        let times = ["2026-09-04T08:05:00Z", "2026-09-04T08:37:00Z", "2026-09-04T09:04:00Z",
                     "2026-09-04T13:29:00Z", "2026-09-04T20:01:00Z", "2026-09-04T20:43:00Z",
                     "2026-09-04T22:31:00Z"].map(date)
        let source = times.enumerated().map { index, time in
            PriceCandle(time: time, open: Double(100 + index), high: Double(102 + index),
                        low: Double(99 + index), close: Double(101 + index), volume: Double(10 + index))
        }
        let asOf = date("2026-09-05T00:00:00Z")
        let hourly = ChartAnalytics.minuteCandles(Array(source.reversed()), interval: 60,
                                                  asOf: asOf, includeExtendedHours: true)
        XCTAssertEqual(hourly.map(\.time), [times[0], times[2], times[3], times[4], times[6]])
        let first = try XCTUnwrap(hourly.first)
        XCTAssertEqual(first.open, 100)
        XCTAssertEqual(first.high, 103)
        XCTAssertEqual(first.low, 99)
        XCTAssertEqual(first.close, 102)
        XCTAssertEqual(hourly.map(\.volume), [21, 12, 13, 29, 16])
        let twoHourly = ChartAnalytics.minuteCandles(source, interval: 120,
                                                     asOf: asOf, includeExtendedHours: true)
        XCTAssertEqual(twoHourly.map(\.time), [times[0], times[3], times[4], times[6]])
        XCTAssertEqual(twoHourly.map(\.volume), [33, 13, 29, 16])
        XCTAssertTrue(ChartAnalytics.minuteCandles(source, interval: 60, asOf: asOf).isEmpty)
    }

    func testExtendedOptInDoesNotWeakenRegularMinuteCompleteness() {
        let regular = date("2026-09-04T13:30:00Z")
        let source = minutes(start: date("2026-09-04T08:10:00Z"), count: 1)
            + minutes(start: regular, count: 60).enumerated().compactMap { $0.offset == 20 ? nil : $0.element }
            + minutes(start: date("2026-09-04T20:10:00Z"), count: 1)
        let bars = ChartAnalytics.minuteCandles(source, interval: 60,
            asOf: date("2026-09-05T00:00:00Z"), includeExtendedHours: true)
        XCTAssertEqual(bars.count, 2)
        XCTAssertEqual(bars.compactMap { EquityTradingSession.at($0.time) }, [.premarket, .postmarket])
        XCTAssertEqual(bars.map(\.volume), [100, 100])
    }

    func testSparseExtendedCurrentBucketsExcludeFormingAndFutureMinutes() throws {
        for start in [date("2026-09-04T08:00:00Z"), date("2026-09-04T20:00:00Z")] {
            let source = [0, 7, 30].flatMap { minutes(start: start.addingTimeInterval(Double($0) * 60), count: 1) }
            let forming = ChartAnalytics.minuteCandles(source, interval: 60,
                asOf: start.addingTimeInterval(7 * 60 + 30), includeExtendedHours: true)
            XCTAssertEqual(forming.count, 1)
            XCTAssertEqual(forming.first?.volume, 100)
            let completed = ChartAnalytics.minuteCandles(source, interval: 60,
                asOf: start.addingTimeInterval(8 * 60), includeExtendedHours: true)
            XCTAssertEqual(completed.count, 1)
            XCTAssertEqual(completed.first?.volume, 200)
            XCTAssertTrue(ChartAnalytics.minuteCandles(source, interval: 60,
                asOf: start.addingTimeInterval(59), includeExtendedHours: true).isEmpty)
        }
    }

    func testSparseExtendedUnknownVolumeAndDuplicateMinutesAreNotInvented() {
        let first = date("2026-09-04T08:10:00Z")
        let nextDay = date("2026-09-08T08:10:00Z")
        var source = minutes(start: first, count: 1) + minutes(start: first.addingTimeInterval(30 * 60), count: 1)
            + minutes(start: nextDay, count: 1)
        source.append(changingVolume(source[0], to: nil))
        let bars = ChartAnalytics.minuteCandles(source, interval: 60,
            asOf: date("2026-09-09T00:00:00Z"), includeExtendedHours: true)
        XCTAssertEqual(bars.map(\.time), [first, nextDay])
        XCTAssertNil(bars[0].volume)
        XCTAssertEqual(bars[1].volume, 100)
        XCTAssertEqual(bars[0].close, 100.5)
        XCTAssertEqual(bars[1].close, 100.5)
    }

    func testHourlyAndTwoHourlyBarsStartAt0930AndKeepTheFinalThirtyMinutes() throws {
        let start = date("2026-09-04T13:30:00Z")
        let source = minutes(start: start, count: 390)
        for interval in [60, 120] {
            let bars = ChartAnalytics.minuteCandles(source, interval: interval, asOf: start.addingTimeInterval(390 * 60))
            XCTAssertEqual(bars.count, interval == 60 ? 7 : 4)
            XCTAssertEqual(bars.map(\.time), stride(from: 0, to: 390, by: interval).map { start.addingTimeInterval(Double($0) * 60) })
            let first = try XCTUnwrap(bars.first)
            XCTAssertEqual(first.open, 100)
            XCTAssertEqual(first.high, Double(100 + interval))
            XCTAssertEqual(first.low, 99)
            XCTAssertEqual(first.close, Double(100 + interval) - 0.5)
            XCTAssertEqual(first.volume, Double(interval * 100))
            let last = try XCTUnwrap(bars.last)
            XCTAssertEqual(last.time, start.addingTimeInterval(360 * 60))
            XCTAssertEqual(last.open, 460)
            XCTAssertEqual(last.close, 489.5)
            XCTAssertEqual(last.volume, 3_000)
            XCTAssertEqual(bars.compactMap(\.volume).reduce(0, +), 39_000)
        }
    }

    func testSupportedSmallIntervalsPreserveWholeSourceCoverage() {
        let start = date("2026-09-04T13:30:00Z")
        let source = minutes(start: start, count: 390)
        for interval in [1, 5, 15, 30] {
            let bars = ChartAnalytics.minuteCandles(source, interval: interval, asOf: start.addingTimeInterval(390 * 60))
            XCTAssertEqual(bars.count, 390 / interval)
            XCTAssertEqual(bars.last?.close, source.last?.close)
            XCTAssertEqual(bars.compactMap(\.volume).reduce(0, +), 39_000)
        }
        for interval in [-1, 0, 2, 10, 45, 240, Int.max] {
            XCTAssertTrue(ChartAnalytics.minuteCandles(source, interval: interval, asOf: start.addingTimeInterval(390 * 60)).isEmpty)
        }
    }

    func testNewYorkAnchorsFollowBothDSTChangesWithoutCombiningSessions() {
        let starts = ["2026-03-06T14:30:00Z", "2026-03-09T13:30:00Z",
                      "2026-10-30T13:30:00Z", "2026-11-02T14:30:00Z"].map(date)
        let source = starts.flatMap { minutes(start: $0, count: 390) }
        let bars = ChartAnalytics.minuteCandles(Array(source.reversed()), interval: 120, asOf: date("2026-11-02T21:00:00Z"))
        XCTAssertEqual(bars.count, 16)
        for (index, start) in starts.enumerated() {
            XCTAssertEqual(bars[index * 4].time, start)
            XCTAssertEqual(bars[index * 4].open, 100)
            XCTAssertEqual(bars[index * 4 + 3].time, start.addingTimeInterval(360 * 60))
            XCTAssertEqual(bars[index * 4 + 3].volume, 3_000)
        }
        XCTAssertEqual(Set(bars.map(\.time)).count, bars.count)
    }

    func testMissingMinutesDropOnlyTheirBucketWithoutFillingPricesOrVolume() {
        let start = date("2026-09-04T13:30:00Z")
        let source = minutes(start: start, count: 390)
        for interval in [60, 120] {
            for missing in [0, 23, 59, 120, 389] {
                let incomplete = source.enumerated().compactMap { $0.offset == missing ? nil : $0.element }
                let bars = ChartAnalytics.minuteCandles(incomplete, interval: interval, asOf: start.addingTimeInterval(390 * 60))
                let missingBucket = missing / interval * interval
                let expected = stride(from: 0, to: 390, by: interval).filter { $0 != missingBucket }
                XCTAssertEqual(bars.map(\.time), expected.map { start.addingTimeInterval(Double($0) * 60) })
                XCTAssertTrue(bars.allSatisfy { $0.volume == Double(min(interval, 390 - Int($0.time.timeIntervalSince(start) / 60)) * 100) })
            }
        }
    }

    func testCurrentBucketUsesOnlyCompletedMinutesAndRequiresEveryOne() throws {
        let start = date("2026-09-04T13:30:00Z")
        let source = minutes(start: start, count: 390)
        let asOf = start.addingTimeInterval(63 * 60 + 30)
        let bars = ChartAnalytics.minuteCandles(source, interval: 60, asOf: asOf)
        XCTAssertEqual(bars.count, 2)
        let forming = try XCTUnwrap(bars.last)
        XCTAssertEqual(forming.time, start.addingTimeInterval(60 * 60))
        XCTAssertEqual(forming.open, 160)
        XCTAssertEqual(forming.close, 162.5)
        XCTAssertEqual(forming.volume, 300)
        XCTAssertEqual(ChartAnalytics.minuteCandles(source, interval: 60, asOf: start.addingTimeInterval(60 * 60)).count, 1)
        XCTAssertTrue(ChartAnalytics.minuteCandles(source, interval: 60, asOf: start.addingTimeInterval(59)).isEmpty)
        let missing = source.filter { $0.time != start.addingTimeInterval(61 * 60) }
        XCTAssertEqual(ChartAnalytics.minuteCandles(missing, interval: 60, asOf: asOf).count, 1)
    }

    func testHistoricalTruncatedBucketIsNotMistakenForATodaysFormingBar() {
        let start = date("2026-09-04T13:30:00Z")
        let source = minutes(start: start, count: 210)
        // A 13:00 close cannot be inferred from history alone; the 12:30 bucket stays absent.
        let bars = ChartAnalytics.minuteCandles(source, interval: 60, asOf: date("2026-09-08T20:00:00Z"))
        XCTAssertEqual(bars.count, 3)
        XCTAssertEqual(bars.last?.time, start.addingTimeInterval(120 * 60))
        XCTAssertEqual(bars.last?.volume, 6_000)
    }

    func testUnsortedDuplicatesUseTheLastValidObservationExactlyOnce() throws {
        let start = date("2026-09-04T13:30:00Z")
        var source = Array(minutes(start: start, count: 60).reversed())
        source.append(PriceCandle(time: start.addingTimeInterval(59 * 60), open: 159,
                                 high: 1_000, low: 1, close: 80, volume: 7))
        let bars = ChartAnalytics.minuteCandles(source, interval: 60, asOf: start.addingTimeInterval(60 * 60))
        XCTAssertEqual(bars.count, 1)
        let bar = try XCTUnwrap(bars.first)
        XCTAssertEqual(bar.open, 100)
        XCTAssertEqual(bar.high, 1_000)
        XCTAssertEqual(bar.low, 1)
        XCTAssertEqual(bar.close, 80)
        XCTAssertEqual(bar.volume, 5_907)
    }

    func testMissingOrInvalidVolumeRemainsNilWhileTheOHLCAndNextBucketSurvive() {
        let start = date("2026-09-04T13:30:00Z")
        let invalid: [Double?] = [nil, -1, Double.nan, Double.infinity]
        for volume in invalid {
            var source = minutes(start: start, count: 120)
            source[20] = changingVolume(source[20], to: volume)
            let bars = ChartAnalytics.minuteCandles(source, interval: 60, asOf: start.addingTimeInterval(120 * 60))
            XCTAssertEqual(bars.count, 2)
            XCTAssertNil(bars[0].volume)
            XCTAssertEqual(bars[0].close, 159.5)
            XCTAssertEqual(bars[1].volume, 6_000)
        }
    }

    func testZeroVolumeIsKnownAndCumulativeVolumeOverflowIsUnknown() {
        let start = date("2026-09-04T13:30:00Z")
        var source = minutes(start: start, count: 60).map { changingVolume($0, to: 0) }
        XCTAssertEqual(ChartAnalytics.minuteCandles(source, interval: 60, asOf: start.addingTimeInterval(60 * 60)).first?.volume, 0)
        source[0] = changingVolume(source[0], to: Double.greatestFiniteMagnitude)
        source[1] = changingVolume(source[1], to: Double.greatestFiniteMagnitude)
        let bars = ChartAnalytics.minuteCandles(source, interval: 60, asOf: start.addingTimeInterval(60 * 60))
        XCTAssertEqual(bars.count, 1)
        XCTAssertNil(bars.first?.volume)
        XCTAssertEqual(bars.first?.close, 159.5)
    }

    func testOutsideSessionOffMinuteAndInvalidPricesCannotBecomeConstituents() {
        let start = date("2026-09-04T13:30:00Z")
        var source = minutes(start: start, count: 60)
        for time in [start.addingTimeInterval(-60), start.addingTimeInterval(390 * 60),
                     start.addingTimeInterval(0.5), date("2026-09-05T13:30:00Z"),
                     Date(timeIntervalSince1970: .nan), Date(timeIntervalSince1970: .infinity)] {
            source.append(PriceCandle(time: time, open: 1, high: 2, low: 0, close: 1, volume: 1))
        }
        let asOf = date("2026-09-08T20:00:00Z")
        XCTAssertEqual(ChartAnalytics.minuteCandles(source, interval: 60, asOf: asOf).first?.volume, 6_000)
        let invalid: [(Double, Double, Double, Double)] = [
            (.nan, 200, 0, 120), (120, .infinity, 0, 120), (120, 200, -1, 120),
            (120, 119, 0, 120), (120, 200, 121, 120), (120, 200, 0, .nan)
        ]
        for (open, high, low, close) in invalid {
            var broken = minutes(start: start, count: 60)
            broken[20] = PriceCandle(time: start.addingTimeInterval(20 * 60), open: open,
                                     high: high, low: low, close: close, volume: 100)
            XCTAssertTrue(ChartAnalytics.minuteCandles(broken, interval: 60, asOf: asOf).isEmpty)
        }
        XCTAssertTrue(ChartAnalytics.minuteCandles(source, interval: 60, asOf: Date(timeIntervalSince1970: .nan)).isEmpty)
    }

    func testMovingAveragesUseAggregatedClosesAndRequireTheFullPeriod() throws {
        let starts = ["2026-08-31T13:30:00Z", "2026-09-01T13:30:00Z", "2026-09-02T13:30:00Z",
                      "2026-09-03T13:30:00Z", "2026-09-04T13:30:00Z"].map(date)
        let source = starts.flatMap { minutes(start: $0, count: 390) }
        let bars = ChartAnalytics.minuteCandles(source, interval: 60, asOf: date("2026-09-04T20:00:00Z"))
        XCTAssertEqual(bars.count, 35)
        for period in [5, 10, 20, 30] {
            let values = ChartAnalytics.movingAverage(bars, period: period)
            XCTAssertTrue(values.prefix(period - 1).allSatisfy { $0 == nil })
            XCTAssertEqual(try XCTUnwrap(values[period - 1]), bars.prefix(period).map(\.close).reduce(0, +) / Double(period), accuracy: 0.000001)
            XCTAssertEqual(try XCTUnwrap(values.last!), bars.suffix(period).map(\.close).reduce(0, +) / Double(period), accuracy: 0.000001)
        }
    }

    private func minutes(start: Date, count: Int) -> [PriceCandle] {
        (0..<count).map { minute in
            let price = 100 + Double(minute)
            return PriceCandle(time: start.addingTimeInterval(Double(minute) * 60), open: price,
                               high: price + 1, low: price - 1, close: price + 0.5, volume: 100)
        }
    }

    private func changingVolume(_ candle: PriceCandle, to volume: Double?) -> PriceCandle {
        PriceCandle(time: candle.time, open: candle.open, high: candle.high,
                    low: candle.low, close: candle.close, volume: volume)
    }

    private func date(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }
}
