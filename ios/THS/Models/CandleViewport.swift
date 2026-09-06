import Foundation

struct CandleViewport: Equatable, Sendable {
    let start: Double
    let count: Double
    let totalCount: Int

    init(totalCount: Int, preferredCount: Int = 120) {
        let total = max(0, totalCount)
        let count = Double(min(max(preferredCount, min(12, total)), min(600, total)))
        self.init(totalCount: total, start: Double(total) - count, count: count)
    }

    private init(totalCount: Int, start: Double, count: Double) {
        self.totalCount = max(0, totalCount)
        guard self.totalCount > 0 else {
            self.start = 0
            self.count = 0
            return
        }
        self.count = min(max(count, Double(min(12, self.totalCount))), Double(min(600, self.totalCount)))
        self.start = min(max(start, 0), max(0, Double(self.totalCount) - self.count))
    }

    // Include partially visible candle cells at either edge; callers keep their global indices.
    var visibleRange: Range<Int> {
        boundedIndex(start.rounded(.down))..<boundedIndex((start + count).rounded(.up))
    }

    var xDomain: ClosedRange<Double> {
        guard totalCount > 0 else { return -0.5...0.5 }
        let lower = start - 0.5
        let upper = start + count - 0.5
        return lower...max(upper, lower.nextUp)
    }

    // Translation is measured from the start of a gesture, using that gesture's initial viewport.
    func panned(translation: Double, plotWidth: Double) -> Self {
        guard totalCount > 0, translation.isFinite, plotWidth.isFinite, plotWidth > 0 else { return self }
        return Self(totalCount: totalCount, start: start - translation / plotWidth * count, count: count)
    }

    func zoomed(scale: Double, anchor: Double) -> Self {
        guard totalCount > 0, scale.isFinite, scale > 0, anchor.isFinite else { return self }
        let nextCount = min(max(count / scale, Double(min(12, totalCount))), Double(min(600, totalCount)))
        guard nextCount != count else { return self }
        let anchor = min(max(anchor, 0), 1)
        let anchoredIndex = start + count * anchor
        return Self(totalCount: totalCount, start: anchoredIndex - nextCount * anchor, count: nextCount)
    }

    // Follow appended candles only when the user was already at the latest data.
    func reconciled(totalCount: Int) -> Self {
        let total = max(0, totalCount)
        guard total != self.totalCount else { return self }
        guard self.totalCount > 0, total > 0 else { return Self(totalCount: total) }
        let nextCount = min(max(count, Double(min(12, total))), Double(min(600, total)))
        let wasAtLatest = start == max(0, Double(self.totalCount) - count)
        let nextStart = wasAtLatest ? Double(total) - nextCount : start
        return Self(totalCount: total, start: nextStart, count: nextCount)
    }

    private func boundedIndex(_ value: Double) -> Int {
        if value <= 0 { return 0 }
        // Check before conversion, including when Double rounds a very large Int upward.
        if value >= Double(totalCount) { return totalCount }
        return Int(value)
    }
}
