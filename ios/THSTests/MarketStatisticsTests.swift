import Foundation
import XCTest
@testable import THS

final class MarketStatisticsTests: XCTestCase {
    private let sessionStart = ISO8601DateFormatter().date(from: "2026-09-01T13:30:00Z")!

    func testVolumeRatioUsesFivePriorDailyBarsAndExcludesTheCurrentDay() throws {
        let minuteHistory = intraday(volumes: [200, 200, 200])
        let currentDaily = candle(at: sessionStart, volume: 1_000_000_000)
        let dailyHistory = daily(extra: [currentDaily])
        let ratio = MarketStatistics.volumeRatio(intraday: minuteHistory, daily: dailyHistory, asOf: completedTime)
        XCTAssertEqual(try XCTUnwrap(ratio), 2, accuracy: 0.000001)
    }

    func testFormingFinalMinuteIsExcludedFromBothVolumeAndElapsedMinutes() throws {
        let minuteHistory = intraday(volumes: [100, 300, 900])
        let ratio = MarketStatistics.volumeRatio(intraday: minuteHistory, daily: daily(),
                                                asOf: sessionStart.addingTimeInterval(150))
        XCTAssertEqual(try XCTUnwrap(ratio), 2, accuracy: 0.000001)
        XCTAssertNil(MarketStatistics.volumeRatio(intraday: minuteHistory, daily: daily(),
                                                  asOf: sessionStart.addingTimeInterval(30)))
    }

    func testMissingOpeningMinuteGapsDuplicatesAndNonMinuteTimestampsAreUnavailable() {
        let bars = intraday(volumes: [100, 100, 100]).candles
        let variants = [
            Array(bars.dropFirst()),
            [bars[0], bars[2]],
            [bars[0], bars[1], bars[1], bars[2]],
            [bars[0], candle(at: sessionStart.addingTimeInterval(90), volume: 100), bars[2]]
        ]
        for variant in variants {
            XCTAssertNil(MarketStatistics.volumeRatio(intraday: history(variant), daily: daily(), asOf: completedTime))
        }
    }

    func testInvalidMinuteVolumesCannotBeCountedAsZero() {
        let invalidVolumes: [Double?] = [nil, -1, Double.nan, Double.infinity]
        for volume in invalidVolumes {
            XCTAssertNil(MarketStatistics.volumeRatio(intraday: intraday(volumes: [100, volume, 100]),
                                                      daily: daily(), asOf: completedTime))
        }
        XCTAssertEqual(MarketStatistics.volumeRatio(intraday: intraday(volumes: [0, 0, 0]),
                                                    daily: daily(), asOf: completedTime), 0)
    }

    func testPriorWindowRequiresFiveUniqueDatesWithKnownVolumeAndANonzeroBaseline() {
        let minutes = intraday(volumes: [100, 100, 100])
        let allDaily = daily().candles
        let missingDay = history(Array(allDaily.dropFirst()))
        let duplicateDay = history(allDaily + [allDaily.last!])
        let missingVolume = history(Array(allDaily.dropLast()) + [candle(at: allDaily.last!.time, volume: nil)])
        let zeroBaseline = history(allDaily.map { candle(at: $0.time, volume: 0) })
        let negativeVolume = history(Array(allDaily.dropLast()) + [candle(at: allDaily.last!.time, volume: -1)])
        for invalid in [missingDay, duplicateDay, missingVolume, zeroBaseline, negativeVolume] {
            XCTAssertNil(MarketStatistics.volumeRatio(intraday: minutes, daily: invalid, asOf: completedTime))
        }
    }

    func testLatestRegularSessionExcludesOlderSessionsAndExtendedHours() throws {
        let priorOpen = date("2026-08-31T13:30:00Z")
        let older = (0..<3).map { candle(at: priorOpen.addingTimeInterval(Double($0) * 60), volume: 50_000) }
        let extended = [candle(at: date("2026-09-01T13:00:00Z"), volume: nil),
                        candle(at: date("2026-09-01T20:01:00Z"), volume: nil)]
        let mixed = history(older + intraday(volumes: [200, 200, 200]).candles + extended)
        let ratio = MarketStatistics.volumeRatio(intraday: mixed, daily: daily(), asOf: date("2026-09-01T21:00:00Z"))
        XCTAssertEqual(try XCTUnwrap(ratio), 2, accuracy: 0.000001)
    }

    func testPriorDailyDatesUseNewYorkRatherThanUTCDate() throws {
        let regularDaily = daily().candles
        // 00:30 UTC on September 1 is still August 31 in New York.
        let lastPrior = candle(at: date("2026-09-01T00:30:00Z"), volume: 39_000)
        let historyWithUTCDateBoundary = history(Array(regularDaily.dropLast()) + [lastPrior])
        let ratio = MarketStatistics.volumeRatio(intraday: intraday(volumes: [200, 200, 200]),
                                                daily: historyWithUTCDateBoundary, asOf: completedTime)
        XCTAssertEqual(try XCTUnwrap(ratio), 2, accuracy: 0.000001)
    }

    func testOlderIncompleteDailyDataDoesNotReplaceOneOfTheLatestFiveDates() throws {
        let oldMissing = candle(at: date("2026-08-24T20:00:00Z"), volume: nil)
        let ratio = MarketStatistics.volumeRatio(intraday: intraday(volumes: [200, 200, 200]),
                                                daily: daily(extra: [oldMissing]), asOf: completedTime)
        XCTAssertEqual(try XCTUnwrap(ratio), 2, accuracy: 0.000001)
    }

    func testUnavailableOrMismatchedHistoriesDoNotProduceARatio() {
        let minutes = intraday(volumes: [100])
        let other = PriceHistory(symbol: "MSFT", candles: daily().candles, previousClose: nil)
        XCTAssertNil(MarketStatistics.volumeRatio(intraday: nil, daily: daily(), asOf: completedTime))
        XCTAssertNil(MarketStatistics.volumeRatio(intraday: minutes, daily: nil, asOf: completedTime))
        XCTAssertNil(MarketStatistics.volumeRatio(intraday: minutes, daily: other, asOf: completedTime))
        XCTAssertNil(MarketStatistics.volumeRatio(intraday: history([]), daily: daily(), asOf: completedTime))
        XCTAssertNil(MarketStatistics.volumeRatio(intraday: minutes, daily: history([]), asOf: completedTime))
    }

    func testNewSessionWithNoCompletedMinuteDoesNotFallBackToYesterdaysRatio() {
        let older = candle(at: date("2026-08-31T13:30:00Z"), volume: 100)
        let newer = candle(at: sessionStart, volume: 100)
        XCTAssertNil(MarketStatistics.volumeRatio(intraday: history([older, newer]), daily: daily(),
                                                  asOf: sessionStart.addingTimeInterval(30)))
    }

    private var completedTime: Date { sessionStart.addingTimeInterval(600) }

    private func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }

    private func candle(at time: Date, volume: Double?) -> PriceCandle {
        PriceCandle(time: time, open: 100, high: 101, low: 99, close: 100, volume: volume)
    }

    private func history(_ candles: [PriceCandle]) -> PriceHistory {
        PriceHistory(symbol: "AAPL", candles: candles, previousClose: 100)
    }

    private func intraday(volumes: [Double?]) -> PriceHistory {
        history(volumes.enumerated().map { candle(at: sessionStart.addingTimeInterval(Double($0.offset) * 60), volume: $0.element) })
    }

    private func daily(extra: [PriceCandle] = []) -> PriceHistory {
        let dates = ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-31"]
        return history(dates.map { candle(at: date($0 + "T20:00:00Z"), volume: 39_000) } + extra)
    }
}
