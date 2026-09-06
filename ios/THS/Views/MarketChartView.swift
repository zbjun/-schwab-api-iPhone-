import SwiftUI
import Charts

struct MarketChartView: View {
    let history: PriceHistory
    let range: HistoryRange
    let compact: Bool
    private let candles: [PriceCandle]
    private let samples: [MarketChartSample]
    private let averageValues: [Double?]
    private let averages: [MarketAverageSeries]
    private let domain: ClosedRange<Double>
    @State private var selectedIndex: Double?

    init(history: PriceHistory, range: HistoryRange, compact: Bool = false) {
        self.history = history
        self.range = range
        self.compact = compact
        let windowStart = range.minuteInterval == nil ? 0 : max(0, history.candles.count - 120)
        let visibleCandles = Array(history.candles.dropFirst(windowStart))
        candles = visibleCandles
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .gmt
        samples = visibleCandles.enumerated().map { index, candle in
            MarketChartSample(index: index, candle: candle,
                              session: calendar.startOfDay(for: candle.time).timeIntervalSince1970)
        }
        averageValues = range.isIntraday && !compact ? ChartAnalytics.sessionAverage(history.candles) : []
        averages = range.isIntraday || compact ? [] : [5, 10, 20, 30].map {
            // Calculate on full history so the first visible minute bar keeps its preceding MA samples.
            let fullValues = ChartAnalytics.movingAverage(history.candles, period: $0)
            return MarketAverageSeries(period: $0, values: Array(fullValues.dropFirst(windowStart)))
        }
        var values = visibleCandles.flatMap { range.isIntraday || compact ? [$0.close] : [$0.low, $0.high] }.filter(\.isFinite)
        values.append(contentsOf: averageValues.compactMap { $0 }.filter(\.isFinite))
        values.append(contentsOf: averages.flatMap(\.values).compactMap { $0 }.filter(\.isFinite))
        if (range.isIntraday || compact), let close = history.previousClose, close.isFinite { values.append(close) }
        if let low = values.min(), let high = values.max() {
            let padding = max((high - low) * 0.08, max(abs(high) * 0.0005, 0.01))
            domain = (low - padding)...(high + padding)
        } else { domain = 0...1 }
    }

    private var activeIndex: Int {
        guard !candles.isEmpty else { return 0 }
        return min(candles.count - 1, max(0, Int((selectedIndex ?? Double(candles.count - 1)).rounded())))
    }
    private var xDomain: ClosedRange<Double> { -0.6...max(0.6, Double(candles.count) - 0.4) }
    private var directionColor: Color {
        MarketTheme.change((candles.last?.close ?? 0) - (history.previousClose ?? candles.first?.open ?? 0))
    }

    var body: some View {
        if compact {
            sparkline
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(history.symbol) 分时走势，\(candles.count) 个数据点")
        } else {
            GeometryReader { geometry in
                VStack(alignment: .leading, spacing: 4) {
                    legend
                    priceChart
                        .frame(maxHeight: .infinity)
                    if geometry.size.height >= 180 {
                        HStack(spacing: 8) {
                            Text("成交量")
                            if range.minuteInterval != nil {
                                Text("最近\(candles.count)根 · 美东时间")
                                    .font(.system(size: 9)).accessibilityIdentifier("chart.window")
                            }
                            Spacer()
                            if candles.indices.contains(activeIndex) {
                                Text(DisplayFormat.volume(candles[activeIndex].volume)).monospacedDigit()
                            }
                        }.font(.system(size: 10)).foregroundStyle(MarketTheme.secondary)
                        volumeChart.frame(height: min(68, max(24, geometry.size.height * 0.17)))
                        if range.isIntraday {
                            Text("黄色均价估算 · 每个交易日重新计算")
                                .font(.system(size: 9)).foregroundStyle(MarketTheme.secondary).lineLimit(1)
                        }
                    }
                }
            }
            .onChange(of: range) { _, _ in selectedIndex = nil }
        }
    }

    private var legend: some View {
        Group {
            if range.isIntraday {
                HStack(spacing: 12) {
                    Text("均价估算 \(MarketTheme.number(averageValues.indices.contains(activeIndex) ? averageValues[activeIndex] : nil))")
                        .foregroundStyle(MarketTheme.average)
                    if candles.indices.contains(activeIndex) {
                        Text("价格 \(MarketTheme.number(candles[activeIndex].close))").foregroundStyle(MarketTheme.primary)
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("chart.average")
            } else {
                HStack(spacing: 6) {
                    ForEach(averages) { series in
                        Text("MA\(series.period) \(MarketTheme.number(series.values.indices.contains(activeIndex) ? series.values[activeIndex] : nil))")
                            .foregroundStyle(MarketTheme.averageColor(series.period))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("chart.movingAverages")
            }
        }
        .font(.system(size: 10, weight: .medium, design: .monospaced))
        .lineLimit(1).minimumScaleFactor(0.7)
        .frame(height: 17)
    }

    private var priceChart: some View {
        Chart {
            if range.isIntraday {
                intradayMarks
            } else {
                candleMarks
                movingAverageMarks
            }
            if range.isIntraday, let previousClose = history.previousClose, previousClose.isFinite {
                RuleMark(y: .value("昨收", previousClose))
                    .foregroundStyle(MarketTheme.secondary.opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 0.7, dash: [4, 4]))
            }
            if selectedIndex != nil, candles.indices.contains(activeIndex) {
                RuleMark(x: .value("所选时间", Double(activeIndex)))
                    .foregroundStyle(MarketTheme.primary.opacity(0.55)).lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                PointMark(x: .value("序号", Double(activeIndex)), y: .value("价格", candles[activeIndex].close))
                    .foregroundStyle(MarketTheme.primary).symbolSize(20)
            }
        }
        .chartXScale(domain: xDomain)
        .chartYScale(domain: domain)
        .chartLegend(.hidden)
        .chartXAxis {
            AxisMarks(values: axisIndices) { value in
                AxisGridLine().foregroundStyle(MarketTheme.separator)
                AxisValueLabel(centered: false, anchor: axisLabelAnchor(value.as(Double.self))) {
                    if let index = value.as(Double.self) {
                        Text(axisLabel(index)).font(.system(size: 9)).foregroundStyle(MarketTheme.secondary)
                            .lineLimit(1).fixedSize(horizontal: true, vertical: false)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine().foregroundStyle(MarketTheme.separator)
                AxisValueLabel {
                    if let price = value.as(Double.self) {
                        priceAxisLabel(price)
                    }
                }
            }
        }
        .chartXSelection(value: $selectedIndex)
        .accessibilityLabel("\(history.symbol) \(range.title)，\(candles.count) 个价格点")
    }

    @ChartContentBuilder private var intradayMarks: some ChartContent {
        ForEach(samples) { sample in
            LineMark(x: .value("序号", Double(sample.index)), y: .value("价格", sample.candle.close), series: .value("线", "价格"))
                .foregroundStyle(MarketTheme.primary.opacity(0.95)).lineStyle(StrokeStyle(lineWidth: 1.5))
            if averageValues.indices.contains(sample.index), let average = averageValues[sample.index] {
                LineMark(x: .value("序号", Double(sample.index)), y: .value("均价估算", average),
                         series: .value("均价交易日", "均价\(sample.session)"))
                    .foregroundStyle(MarketTheme.average).lineStyle(StrokeStyle(lineWidth: 1.4))
            }
        }
    }

    @ChartContentBuilder private var candleMarks: some ChartContent {
        ForEach(samples) { sample in
            RuleMark(x: .value("序号", Double(sample.index)), yStart: .value("最低", sample.candle.low), yEnd: .value("最高", sample.candle.high))
                .foregroundStyle(MarketTheme.change(sample.candle.close - sample.candle.open)).lineStyle(StrokeStyle(lineWidth: 1))
            if sample.candle.open == sample.candle.close {
                RuleMark(xStart: .value("开始", Double(sample.index) - 0.32), xEnd: .value("结束", Double(sample.index) + 0.32), y: .value("价格", sample.candle.close))
                    .foregroundStyle(MarketTheme.secondary)
            } else {
                RectangleMark(xStart: .value("开始", Double(sample.index) - 0.32), xEnd: .value("结束", Double(sample.index) + 0.32),
                              yStart: .value("实体低", min(sample.candle.open, sample.candle.close)), yEnd: .value("实体高", max(sample.candle.open, sample.candle.close)))
                    .foregroundStyle(MarketTheme.change(sample.candle.close - sample.candle.open))
            }
        }
    }

    @ChartContentBuilder private var movingAverageMarks: some ChartContent {
        ForEach(averages) { series in
            ForEach(samples) { sample in
                if series.values.indices.contains(sample.index), let average = series.values[sample.index] {
                    LineMark(x: .value("序号", Double(sample.index)), y: .value("均线", average), series: .value("均线周期", "MA\(series.period)"))
                        .foregroundStyle(MarketTheme.averageColor(series.period)).lineStyle(StrokeStyle(lineWidth: 1.15))
                }
            }
        }
    }

    private var volumeChart: some View {
        Chart(samples) { sample in
            if let volume = sample.candle.volume, volume.isFinite, volume >= 0 {
                RectangleMark(xStart: .value("开始", Double(sample.index) - 0.35), xEnd: .value("结束", Double(sample.index) + 0.35),
                              yStart: .value("零", 0.0), yEnd: .value("成交量", volume))
                    .foregroundStyle(MarketTheme.change(sample.candle.close - sample.candle.open).opacity(0.85))
            }
        }
        .chartXScale(domain: xDomain).chartXAxis(.hidden)
        .chartYAxis {
            AxisMarks(position: .trailing, values: [0.0]) {
                AxisValueLabel {
                    priceAxisLabel(nil).accessibilityHidden(true)
                }
            }
        }
        .accessibilityLabel("\(range.title) 成交量柱图")
        .accessibilityIdentifier("detail.chart.volume")
    }

    private func priceAxisLabel(_ price: Double?) -> some View {
        // Both plots reserve the same label width, including prices crossing digit or sign boundaries.
        ZStack(alignment: .leading) {
            Text(MarketTheme.number(domain.lowerBound)).hidden()
            Text(MarketTheme.number(domain.upperBound)).hidden()
            if let price { Text(MarketTheme.number(price)) }
        }
        .font(.system(size: 9, design: .monospaced)).foregroundStyle(MarketTheme.secondary)
        .lineLimit(1).fixedSize(horizontal: true, vertical: false)
    }

    private var sparkline: some View {
        Chart(samples) { sample in
            AreaMark(x: .value("序号", Double(sample.index)), yStart: .value("基线", domain.lowerBound), yEnd: .value("价格", sample.candle.close))
                .foregroundStyle(LinearGradient(colors: [directionColor.opacity(0.22), directionColor.opacity(0.01)], startPoint: .top, endPoint: .bottom))
            LineMark(x: .value("序号", Double(sample.index)), y: .value("价格", sample.candle.close))
                .foregroundStyle(directionColor).lineStyle(StrokeStyle(lineWidth: 1.25))
            if sample.index == 0, let previousClose = history.previousClose, previousClose.isFinite {
                RuleMark(y: .value("昨收", previousClose)).foregroundStyle(MarketTheme.secondary.opacity(0.5))
                    .lineStyle(StrokeStyle(lineWidth: 0.7, dash: [3, 3]))
            }
        }
        .chartXScale(domain: xDomain).chartYScale(domain: domain)
        .chartXAxis(.hidden).chartYAxis(.hidden).chartLegend(.hidden)
    }

    private var axisIndices: [Double] {
        guard candles.count > 1 else { return [0] }
        let intervals = range.minuteInterval == nil ? 4 : 2
        return (0...intervals).map { Double(Int(Double(candles.count - 1) * Double($0) / Double(intervals))) }
    }

    private func axisLabelAnchor(_ index: Double?) -> UnitPoint {
        guard let index, candles.count > 1 else { return .top }
        if index == 0 { return .topLeading }
        if index == Double(candles.count - 1) { return .topTrailing }
        return .top
    }

    private func axisLabel(_ index: Double) -> String {
        let position = Int(index.rounded())
        guard candles.indices.contains(position) else { return "" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "America/New_York")
        switch range {
        case .intraday: formatter.dateFormat = "HH:mm"
        case .minute1, .minute5, .minute15, .minute30, .minute60, .minute120:
            let spansSessions = samples.first?.session != samples.last?.session
            let isEndpoint = position == 0 || position == candles.count - 1
            formatter.dateFormat = spansSessions && isEndpoint ? "MM/dd HH:mm" : "HH:mm"
        case .fiveDay, .daily: formatter.dateFormat = "MM/dd"
        case .weekly, .monthly: formatter.dateFormat = "yy/MM"
        }
        return formatter.string(from: candles[position].time)
    }
}

private struct MarketChartSample: Identifiable {
    let index: Int
    let candle: PriceCandle
    let session: TimeInterval
    var id: Int { index }
}

private struct MarketAverageSeries: Identifiable {
    let period: Int
    let values: [Double?]
    var id: Int { period }
}
