import XCTest
@testable import THS

final class CandleViewportTests: XCTestCase {
    func testEmptyAndNegativeHistoryHaveSafeDomainsAndIgnoreGestures() {
        for total in [Int.min, -1, 0] {
            let viewport = CandleViewport(totalCount: total)
            XCTAssertEqual(viewport.totalCount, 0)
            XCTAssertEqual(viewport.start, 0)
            XCTAssertEqual(viewport.count, 0)
            XCTAssertEqual(viewport.visibleRange, 0..<0)
            XCTAssertEqual(viewport.xDomain, -0.5...0.5)
            XCTAssertEqual(viewport.panned(translation: 80, plotWidth: 300), viewport)
            XCTAssertEqual(viewport.zoomed(scale: 2, anchor: 0.25), viewport)
        }
    }

    func testOneCandleAndShortHistoriesRemainFullyVisible() {
        for total in [1, 2, 7, 11, 12] {
            let viewport = CandleViewport(totalCount: total)
            XCTAssertEqual(viewport.start, 0)
            XCTAssertEqual(viewport.count, Double(total))
            XCTAssertEqual(viewport.visibleRange, 0..<total)
            XCTAssertEqual(viewport.xDomain, -0.5...(Double(total) - 0.5))
            XCTAssertEqual(viewport.zoomed(scale: 100, anchor: 0.9), viewport)
            XCTAssertEqual(viewport.panned(translation: -500, plotWidth: 300), viewport)
        }
    }

    func testDefaultWindowContainsTheLatest120Candles() {
        let viewport = CandleViewport(totalCount: 1_000)
        XCTAssertEqual(viewport.totalCount, 1_000)
        XCTAssertEqual(viewport.start, 880)
        XCTAssertEqual(viewport.count, 120)
        XCTAssertEqual(viewport.visibleRange, 880..<1_000)
        XCTAssertEqual(viewport.xDomain, 879.5...999.5)
        XCTAssertEqual(CandleViewport(totalCount: 80).visibleRange, 0..<80)
    }

    func testPreferredCountIsLimitedTo12Through600AvailableCandles() {
        for preferred in [Int.min, -1, 0, 1, 11] {
            XCTAssertEqual(CandleViewport(totalCount: 1_000, preferredCount: preferred).visibleRange, 988..<1_000)
        }
        for preferred in [600, 601, Int.max] {
            XCTAssertEqual(CandleViewport(totalCount: 1_000, preferredCount: preferred).visibleRange, 400..<1_000)
        }
        XCTAssertEqual(CandleViewport(totalCount: 250, preferredCount: 600).visibleRange, 0..<250)
        XCTAssertEqual(CandleViewport(totalCount: 1_000, preferredCount: 240).visibleRange, 760..<1_000)
    }

    func testFractionalPanIncludesThePartiallyVisibleEdgeCandles() {
        let viewport = CandleViewport(totalCount: 1_000).panned(translation: 5, plotWidth: 400)
        XCTAssertEqual(viewport.start, 878.5)
        XCTAssertEqual(viewport.count, 120)
        XCTAssertEqual(viewport.visibleRange, 878..<999)
        XCTAssertEqual(viewport.xDomain, 878...998)
    }

    func testRightDragShowsEarlierCandlesAndUsesTheGestureStartViewport() {
        let initial = CandleViewport(totalCount: 1_000)
        XCTAssertEqual(initial.panned(translation: 150, plotWidth: 300).start, 820)
        XCTAssertEqual(initial.panned(translation: 300, plotWidth: 300).start, 760)
        XCTAssertEqual(initial.start, 880)
        XCTAssertEqual(initial.panned(translation: 0, plotWidth: 300), initial)
    }

    func testLeftDragReturnsToLatestAndBothHistoryEdgesClamp() {
        let initial = CandleViewport(totalCount: 1_000)
        let earlier = initial.panned(translation: 300, plotWidth: 300)
        XCTAssertEqual(earlier.panned(translation: -300, plotWidth: 300), initial)
        XCTAssertEqual(earlier.panned(translation: -30_000, plotWidth: 300).visibleRange, 880..<1_000)
        XCTAssertEqual(initial.panned(translation: 30_000, plotWidth: 300).visibleRange, 0..<120)
        XCTAssertEqual(initial.panned(translation: .greatestFiniteMagnitude, plotWidth: .leastNonzeroMagnitude).start, 0)
        XCTAssertEqual(earlier.panned(translation: -.greatestFiniteMagnitude, plotWidth: .leastNonzeroMagnitude), initial)
    }

    func testInvalidPanInputsLeaveTheViewportUnchanged() {
        let viewport = CandleViewport(totalCount: 1_000)
        for translation in [Double.nan, .infinity, -.infinity] {
            XCTAssertEqual(viewport.panned(translation: translation, plotWidth: 300), viewport)
        }
        for width in [Double.nan, .infinity, -.infinity, 0, -1] {
            XCTAssertEqual(viewport.panned(translation: 50, plotWidth: width), viewport)
        }
    }

    func testZoomPreservesTheCenterIndexAwayFromHistoryEdges() {
        let initial = CandleViewport(totalCount: 1_000).panned(translation: 950, plotWidth: 300)
        let zoomed = initial.zoomed(scale: 2, anchor: 0.5)
        XCTAssertEqual(initial.start, 500)
        XCTAssertEqual(zoomed.count, 60)
        XCTAssertEqual(zoomed.start, 530)
        XCTAssertEqual(index(at: 0.5, in: zoomed), index(at: 0.5, in: initial), accuracy: 0.000_001)
        XCTAssertEqual(zoomed.zoomed(scale: 0.5, anchor: 0.5), initial)
        XCTAssertEqual(initial.zoomed(scale: 1, anchor: 0.5), initial)
    }

    func testZoomPreservesOffCenterAnchorsForBothDirections() {
        let initial = CandleViewport(totalCount: 1_000).panned(translation: 950, plotWidth: 300)
        for anchor in [0.0, 0.25, 0.8, 1.0] {
            for scale in [0.5, 2.0] {
                let zoomed = initial.zoomed(scale: scale, anchor: anchor)
                XCTAssertEqual(index(at: anchor, in: zoomed), index(at: anchor, in: initial), accuracy: 0.000_001)
            }
        }
        XCTAssertEqual(initial.zoomed(scale: 2, anchor: 0.25).start, 515)
        XCTAssertEqual(initial.zoomed(scale: 0.5, anchor: 0.25).start, 470)
    }

    func testZoomAnchorYieldsToTheHistoryEdgesWhenNecessary() {
        let latest = CandleViewport(totalCount: 1_000)
        let expandedAtEnd = latest.zoomed(scale: 0.5, anchor: 0.25)
        XCTAssertEqual(expandedAtEnd.count, 240)
        XCTAssertEqual(expandedAtEnd.visibleRange, 760..<1_000)
        XCTAssertEqual(expandedAtEnd.xDomain.upperBound, latest.xDomain.upperBound)
        XCTAssertNotEqual(index(at: 0.25, in: expandedAtEnd), index(at: 0.25, in: latest))

        let earliest = latest.panned(translation: 30_000, plotWidth: 300)
        let expandedAtStart = earliest.zoomed(scale: 0.5, anchor: 0.75)
        XCTAssertEqual(expandedAtStart.count, 240)
        XCTAssertEqual(expandedAtStart.visibleRange, 0..<240)
        XCTAssertEqual(expandedAtStart.xDomain.lowerBound, earliest.xDomain.lowerBound)
        XCTAssertNotEqual(index(at: 0.75, in: expandedAtStart), index(at: 0.75, in: earliest))
    }

    func testZoomLimitsKeepAtLeast12AndAtMost600Candles() {
        let viewport = CandleViewport(totalCount: 1_000)
        XCTAssertEqual(viewport.zoomed(scale: 1_000, anchor: 0.5).count, 12)
        XCTAssertEqual(viewport.zoomed(scale: .greatestFiniteMagnitude, anchor: 0.5).count, 12)
        XCTAssertEqual(viewport.zoomed(scale: .leastNonzeroMagnitude, anchor: 0.5).count, 600)
        XCTAssertEqual(viewport.zoomed(scale: 0.1, anchor: 1).visibleRange, 400..<1_000)
        XCTAssertEqual(CandleViewport(totalCount: 300).zoomed(scale: 0.1, anchor: 1).visibleRange, 0..<300)
        let smallest = viewport.zoomed(scale: 100, anchor: 0.5)
        XCTAssertEqual(smallest.zoomed(scale: 2, anchor: 0), smallest)
        let largest = viewport.zoomed(scale: 0.1, anchor: 1)
        XCTAssertEqual(largest.zoomed(scale: 0.5, anchor: 0), largest)
    }

    func testInvalidZoomInputsAreIgnoredAndFiniteAnchorsClamp() {
        let viewport = CandleViewport(totalCount: 1_000)
        for scale in [Double.nan, .infinity, -.infinity, 0, -1] {
            XCTAssertEqual(viewport.zoomed(scale: scale, anchor: 0.5), viewport)
        }
        for anchor in [Double.nan, .infinity, -.infinity] {
            XCTAssertEqual(viewport.zoomed(scale: 2, anchor: anchor), viewport)
        }
        XCTAssertEqual(viewport.zoomed(scale: 2, anchor: -0.5), viewport.zoomed(scale: 2, anchor: 0))
        XCTAssertEqual(viewport.zoomed(scale: 2, anchor: 1.5), viewport.zoomed(scale: 2, anchor: 1))
    }

    func testReconcileFollowsAppendedCandlesOnlyWhenAlreadyAtLatest() {
        let latest = CandleViewport(totalCount: 1_000)
        XCTAssertEqual(latest.reconciled(totalCount: 1_030).visibleRange, 910..<1_030)
        XCTAssertEqual(latest.reconciled(totalCount: 1_000), latest)
        let historical = latest.panned(translation: 450, plotWidth: 300)
        let refreshed = historical.reconciled(totalCount: 1_030)
        XCTAssertEqual(historical.start, 700)
        XCTAssertEqual(refreshed.start, historical.start)
        XCTAssertEqual(refreshed.count, historical.count)
        XCTAssertEqual(refreshed.visibleRange, historical.visibleRange)
    }

    func testReconcileHandlesTruncatedAndNewlyAvailableHistory() {
        let historical = CandleViewport(totalCount: 1_000).panned(translation: 450, plotWidth: 300)
        XCTAssertEqual(historical.reconciled(totalCount: 750).visibleRange, 630..<750)
        XCTAssertEqual(historical.reconciled(totalCount: 80).visibleRange, 0..<80)
        XCTAssertEqual(historical.reconciled(totalCount: 0), CandleViewport(totalCount: 0))
        XCTAssertEqual(historical.reconciled(totalCount: -1), CandleViewport(totalCount: 0))
        XCTAssertEqual(CandleViewport(totalCount: 0).reconciled(totalCount: 1_000), CandleViewport(totalCount: 1_000))
    }

    func testContinuousPanAndZoomOperationsStayWithinBounds() {
        for total in [0, 1, 7, 12, 50, 1_000] {
            var viewport = CandleViewport(totalCount: total)
            for step in 0..<400 {
                viewport = viewport.panned(translation: Double(step % 17 - 8) * 17, plotWidth: 280)
                    .zoomed(scale: step % 3 == 0 ? 1.08 : 0.96, anchor: Double(step * 7 % 11) / 10)
                XCTAssertTrue(viewport.start.isFinite)
                XCTAssertTrue(viewport.count.isFinite)
                XCTAssertGreaterThanOrEqual(viewport.start, 0)
                XCTAssertGreaterThanOrEqual(viewport.count, Double(min(12, total)))
                XCTAssertLessThanOrEqual(viewport.count, Double(min(600, total)))
                XCTAssertLessThanOrEqual(viewport.start + viewport.count, Double(total) + 0.000_001)
                XCTAssertGreaterThanOrEqual(viewport.visibleRange.lowerBound, 0)
                XCTAssertLessThanOrEqual(viewport.visibleRange.upperBound, total)
                XCTAssertTrue(viewport.xDomain.lowerBound.isFinite)
                XCTAssertTrue(viewport.xDomain.upperBound.isFinite)
                XCTAssertLessThan(viewport.xDomain.lowerBound, viewport.xDomain.upperBound)
            }
        }
    }

    private func index(at anchor: Double, in viewport: CandleViewport) -> Double {
        viewport.xDomain.lowerBound + anchor * (viewport.xDomain.upperBound - viewport.xDomain.lowerBound)
    }
}
