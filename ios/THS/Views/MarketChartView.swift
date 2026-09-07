import SwiftUI
import Charts

struct MarketChartView: View {
    let history: PriceHistory
    let range: HistoryRange
    let compact: Bool
    private let candles: [PriceCandle]
    private let averageValues: [Double?]
    private let averages: [MarketAverageSeries]
    @Binding private var viewport: CandleViewport?
    @State private var selectedIndex: Double?

    init(history: PriceHistory, range: HistoryRange, compact: Bool = false,
         viewport: Binding<CandleViewport?> = .constant(nil)) {
        self.history = history
        self.range = range
        self.compact = compact
        self._viewport = viewport
        candles = history.candles
        averageValues = range.isIntraday && !compact ? ChartAnalytics.sessionAverage(history.candles) : []
        averages = range.isIntraday || compact ? [] : [5, 10, 20, 30].map {
            // Moving a window must not restart its moving averages at the first visible candle.
            MarketAverageSeries(period: $0, values: ChartAnalytics.movingAverage(history.candles, period: $0))
        }
    }

    private var currentViewport: CandleViewport {
        viewport?.reconciled(totalCount: candles.count) ?? CandleViewport(totalCount: candles.count)
    }
    private var visibleIndices: Range<Int> {
        range.isIntraday || compact ? candles.indices : currentViewport.visibleRange
    }
    private var samples: [MarketChartSample] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .gmt
        return visibleIndices.map { index in
            MarketChartSample(index: index, candle: candles[index],
                              sessionDay: calendar.startOfDay(for: candles[index].time).timeIntervalSince1970)
        }
    }
    private var domain: ClosedRange<Double> {
        let visibleCandles = visibleIndices.map { candles[$0] }
        var values = visibleCandles.flatMap { range.isIntraday || compact ? [$0.close] : [$0.low, $0.high] }.filter(\.isFinite)
        values.append(contentsOf: averageValues.compactMap { $0 }.filter(\.isFinite))
        for series in averages {
            values.append(contentsOf: visibleIndices.compactMap { series.values[$0] }.filter(\.isFinite))
        }
        if (range.isIntraday || compact), let close = history.previousClose, close.isFinite { values.append(close) }
        if let low = values.min(), let high = values.max() {
            let padding = max((high - low) * 0.08, max(abs(high) * 0.0005, 0.01))
            return (low - padding)...(high + padding)
        } else { return 0...1 }
    }

    private var activeIndex: Int {
        guard !visibleIndices.isEmpty else { return 0 }
        return min(visibleIndices.upperBound - 1, max(visibleIndices.lowerBound,
            Int((selectedIndex ?? Double(visibleIndices.upperBound - 1)).rounded())))
    }
    private var xDomain: ClosedRange<Double> {
        range.isIntraday || compact ? -0.6...max(0.6, Double(candles.count) - 0.4) : currentViewport.xDomain
    }
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
                    if range.includesExtendedHours { sessionLegend }
                    if !range.isIntraday { viewportControls }
                    priceChart
                        .frame(maxHeight: .infinity)
                    if geometry.size.height >= 180 {
                        HStack(spacing: 8) {
                            Text("成交量")
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

    private var viewportControls: some View {
        HStack(spacing: 8) {
            Text(visibleIndices.upperBound == candles.count
                 ? "最近\(visibleIndices.count)根 · 美东时间"
                 : "第\(visibleIndices.lowerBound + 1)–\(visibleIndices.upperBound)根 · 美东时间")
                .accessibilityIdentifier("chart.window")
                .accessibilityValue("第\(visibleIndices.lowerBound + 1)至\(visibleIndices.upperBound)根，共\(candles.count)根")
            Spacer(minLength: 2)
            Button {
                viewport = CandleViewport(totalCount: candles.count)
                selectedIndex = nil
            } label: {
                Label("最新", systemImage: "arrow.right.to.line")
                    .padding(.vertical, 5).padding(.leading, 8)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(MarketTheme.ma30)
            .accessibilityLabel("回到最新K线").accessibilityIdentifier("chart.latest")
        }
        .font(.system(size: 10)).foregroundStyle(MarketTheme.secondary)
    }

    private var sessionSegments: [MarketSessionSegment] {
        guard range.includesExtendedHours else { return [] }
        var result: [MarketSessionSegment] = []
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        var dayWindows: [Date: [(session: EquityTradingSession, bounds: DateInterval)]] = [:]
        for index in visibleIndices {
            let time = candles[index].time
            let day = calendar.startOfDay(for: time)
            if dayWindows[day] == nil { dayWindows[day] = EquityTradingSession.windows(on: day) }
            guard let window = dayWindows[day]?.first(where: { time >= $0.bounds.start && time < $0.bounds.end }) else { continue }
            let session = window.session
            let bounds = window.bounds
            if let last = result.last, last.session == session, last.start == bounds.start,
               last.lastIndex + 1 == index {
                result[result.count - 1].lastIndex = index
            } else {
                result.append(MarketSessionSegment(session: session, start: bounds.start,
                                                   firstIndex: index, lastIndex: index))
            }
        }
        return result
    }

    private func sessionColor(_ session: EquityTradingSession) -> Color {
        MarketTheme.sessionColor(session)
    }

    private var sessionLegend: some View {
        let segments = sessionSegments
        let visible = EquityTradingSession.allCases.filter { session in
            segments.contains { $0.session == session }
        }.map(\.title).joined(separator: "、")
        return HStack(spacing: 6) {
            HStack(spacing: 6) {
                ForEach(EquityTradingSession.allCases, id: \.self) { session in
                    HStack(spacing: 2) {
                        Circle().fill(sessionColor(session)).frame(width: 5, height: 5)
                        Text(session.title)
                    }
                }
                Text("美东时间")
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("chart.sessionLegend")
            Spacer(minLength: 0)
            Text(visible.isEmpty ? "暂无时段数据" : "可见：\(visible)")
                .accessibilityIdentifier("chart.sessionPeriods")
        }
        .font(.system(size: 9)).foregroundStyle(MarketTheme.secondary)
        .lineLimit(1).minimumScaleFactor(0.8)
    }

    private func sessionBackground(proxy: ChartProxy, showLabels: Bool) -> some View {
        GeometryReader { geometry in
            if range.includesExtendedHours, let anchor = proxy.plotFrame {
                let frame = geometry[anchor]
                ZStack(alignment: .topLeading) {
                    ForEach(sessionSegments) { segment in
                        let left = max(xDomain.lowerBound, Double(segment.firstIndex) - 0.5)
                        let right = min(xDomain.upperBound, Double(segment.lastIndex) + 0.5)
                        if right > left, let x1 = proxy.position(forX: left), let x2 = proxy.position(forX: right) {
                            let width = max(0, min(frame.width, x2) - max(0, x1))
                            ZStack(alignment: .top) {
                                if segment.session != .regular {
                                    Rectangle().fill(sessionColor(segment.session).opacity(0.13))
                                }
                                if showLabels, width >= 28 {
                                    Text(segment.session.title)
                                        .font(.system(size: 9, weight: .medium))
                                        .foregroundStyle(MarketTheme.primary.opacity(0.8))
                                        .padding(.horizontal, 3).padding(.vertical, 1)
                                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 3))
                                        .padding(.top, 3)
                                }
                            }
                            .frame(width: width, height: max(0, frame.height), alignment: .top)
                            .offset(x: max(0, x1), y: 0)
                        }
                    }
                }
                .frame(width: max(0, frame.width), height: max(0, frame.height), alignment: .topLeading)
                .clipped().position(x: frame.midX, y: frame.midY)
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
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

    @ViewBuilder private var priceChart: some View {
        if range.isIntraday {
            configuredPriceChart.chartXSelection(value: $selectedIndex)
        } else {
            configuredPriceChart.chartOverlay { proxy in
                gestureOverlay(proxy: proxy, identifier: "chart.interaction.price")
            }
        }
    }

    private var configuredPriceChart: some View {
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
        .chartBackground { proxy in sessionBackground(proxy: proxy, showLabels: true) }
        .chartPlotStyle { plot in plot.clipped() }
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
        .accessibilityLabel("\(history.symbol) \(range.title)，\(visibleIndices.count) 个价格点")
    }

    @ChartContentBuilder private var intradayMarks: some ChartContent {
        ForEach(samples) { sample in
            LineMark(x: .value("序号", Double(sample.index)), y: .value("价格", sample.candle.close), series: .value("线", "价格"))
                .foregroundStyle(MarketTheme.primary.opacity(0.95)).lineStyle(StrokeStyle(lineWidth: 1.5))
            if averageValues.indices.contains(sample.index), let average = averageValues[sample.index] {
                LineMark(x: .value("序号", Double(sample.index)), y: .value("均价估算", average),
                         series: .value("均价交易日", "均价\(sample.sessionDay)"))
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
        .chartBackground { proxy in sessionBackground(proxy: proxy, showLabels: false) }
        .chartPlotStyle { plot in plot.clipped() }
        .chartYAxis {
            AxisMarks(position: .trailing, values: [0.0]) {
                AxisValueLabel {
                    priceAxisLabel(nil).accessibilityHidden(true)
                }
            }
        }
        .accessibilityLabel("\(range.title) 成交量柱图")
        .accessibilityIdentifier("detail.chart.volume")
        .chartOverlay { proxy in
            if !range.isIntraday { gestureOverlay(proxy: proxy, identifier: "chart.interaction.volume") }
        }
    }

    private func gestureOverlay(proxy: ChartProxy, identifier: String) -> some View {
        GeometryReader { geometry in
            if let anchor = proxy.plotFrame {
                let frame = geometry[anchor]
                CandleGestureSurface(viewport: currentViewport, identifier: identifier,
                    onChange: { value in
                        viewport = value
                        selectedIndex = nil
                    }, onSelect: { fraction in
                        selectedIndex = xDomain.lowerBound + fraction * (xDomain.upperBound - xDomain.lowerBound)
                    })
                .frame(width: max(0, frame.width), height: max(0, frame.height))
                .position(x: frame.midX, y: frame.midY)
            }
        }
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
        guard !visibleIndices.isEmpty else { return [0] }
        let first = max(visibleIndices.lowerBound, Int(ceil(xDomain.lowerBound)))
        let last = min(visibleIndices.upperBound - 1, Int(floor(xDomain.upperBound)))
        guard last > first else { return [Double(first)] }
        let intervals = range.minuteInterval == nil ? 4 : 2
        return (0...intervals).map { Double(first + Int(Double(last - first) * Double($0) / Double(intervals))) }
    }

    private func axisLabelAnchor(_ index: Double?) -> UnitPoint {
        guard let index, visibleIndices.count > 1 else { return .top }
        if index == axisIndices.first { return .topLeading }
        if index == axisIndices.last { return .topTrailing }
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
            let spansSessions = samples.first?.sessionDay != samples.last?.sessionDay
            let isEndpoint = index == axisIndices.first || index == axisIndices.last
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
    let sessionDay: TimeInterval
    var id: Int { index }
}


private struct MarketAverageSeries: Identifiable {
    let period: Int
    let values: [Double?]
    var id: Int { period }
}

private struct MarketSessionSegment: Identifiable {
    let session: EquityTradingSession
    let start: Date
    let firstIndex: Int
    var lastIndex: Int
    var id: Int { firstIndex }
}
