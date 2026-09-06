import SwiftUI
import Charts

struct StockDetailView: View {
    @Environment(AppStore.self) private var store
    let symbol: String
    @State private var quote: StockQuote?
    @State private var history: PriceHistory?
    @State private var range: HistoryRange = .day
    @State private var quoteError: String?
    @State private var historyError: String?
    @State private var isLoadingQuote = false
    @State private var isLoadingHistory = false
    @State private var quoteRequestID = UUID()
    @State private var historyRequestID = UUID()
    @State private var selectedTime: Date?

    private var sessionKey: String { "\(symbol)|\(store.isDemo)|\(store.isAuthenticated)" }
    private var historyKey: String { "\(sessionKey)|\(rangeName(range))" }
    private var holding: Position? { store.selectedAccount?.positions.first { $0.symbol == symbol } }
    private var canTrade: Bool { quote?.assetMainType == "EQUITY" && (store.isDemo || store.isAuthenticated) }
    private var selectedCandle: PriceCandle? {
        guard let selectedTime else { return nil }
        return history?.candles.min { abs($0.time.timeIntervalSince(selectedTime)) < abs($1.time.timeIntervalSince(selectedTime)) }
    }
    private var priceDomain: ClosedRange<Double> {
        let values = history?.candles.map(\.close).filter(\.isFinite) ?? []
        guard let low = values.min(), let high = values.max() else { return 0...1 }
        let padding = max((high - low) * 0.12, max(abs(high) * 0.001, 0.01))
        return (low - padding)...(high + padding)
    }
    private var chartColor: Color {
        guard let first = history?.candles.first?.close, let last = history?.candles.last?.close else { return .blue }
        return DisplayFormat.changeColor(last - first)
    }

    var body: some View {
        List {
            if store.isDemo { Section { DemoNotice() } }
            quoteSection
            chartSection
            if let quote { statisticsSection(quote) }
            if let holding { holdingSection(holding) }
        }
        .navigationTitle(symbol).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    Task {
                        if store.watchlist.contains(symbol) { await store.removeSymbol(symbol) }
                        else { await store.addSymbol(symbol) }
                    }
                } label: {
                    Label(store.watchlist.contains(symbol) ? "移除自选" : "加入自选",
                          systemImage: store.watchlist.contains(symbol) ? "star.fill" : "star")
                }
                .disabled(store.isBusy || store.isSubmittingOrder)
                .accessibilityIdentifier("detail.watchlist")
                Button { Task { await refreshDetail() } } label: { Label("刷新", systemImage: "arrow.clockwise") }
                    .disabled(isLoadingQuote || isLoadingHistory || store.isSubmittingOrder)
                    .accessibilityIdentifier("detail.refresh")
            }
        }
        .safeAreaInset(edge: .bottom) { tradeBar }
        .task(id: sessionKey) { await loadQuote() }
        .task(id: historyKey) { await loadHistory() }
        .refreshable { await refreshDetail() }
        .accessibilityIdentifier("screen.detail")
    }

    private var quoteSection: some View {
        Section {
            if let quote {
                VStack(alignment: .leading, spacing: 12) {
                    Text(quote.description ?? symbol).font(.subheadline).foregroundStyle(.secondary)
                    Text(DisplayFormat.price(quote.lastPrice))
                        .font(.system(.largeTitle, design: .rounded, weight: .semibold))
                        .monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
                        .accessibilityIdentifier("detail.lastPrice")
                    HStack(spacing: 12) {
                        Text(DisplayFormat.signedMoney(quote.netChange))
                        Text(DisplayFormat.signedPercent(quote.netPercentChange))
                    }
                    .font(.subheadline.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(DisplayFormat.changeColor(quote.netChange))
                    QuoteTimeLabel(quote: quote, isDemo: store.isDemo)
                }.padding(.vertical, 6)
            } else if isLoadingQuote {
                HStack(spacing: 12) { ProgressView(); Text("正在读取 \(symbol) 报价…").foregroundStyle(.secondary) }
            } else {
                ContentUnavailableView("暂无报价", systemImage: "chart.line.uptrend.xyaxis", description: Text("检查证券代码，或稍后刷新。"))
            }
            if let error = quoteError { AppMessageView(message: error, isError: true) }
        }
    }

    private var chartSection: some View {
        Section {
            HStack(spacing: 4) {
                ForEach([HistoryRange.day, .week, .month, .year], id: \.self) { item in
                    Button {
                        selectedTime = nil
                        range = item
                    } label: {
                        Text(rangeTitle(item)).font(.subheadline.weight(range == item ? .semibold : .regular))
                            .frame(maxWidth: .infinity).padding(.vertical, 8)
                            .background(range == item ? Color.blue.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain).foregroundStyle(range == item ? .blue : .secondary)
                    .accessibilityIdentifier("history.\(rangeName(item))")
                    .accessibilityAddTraits(range == item ? .isSelected : [])
                }
            }
            .listRowSeparator(.hidden)
            if isLoadingHistory {
                VStack(spacing: 12) { ProgressView(); Text("正在加载图表…").font(.caption).foregroundStyle(.secondary) }
                    .frame(maxWidth: .infinity).frame(height: 220)
            } else if let history, !history.candles.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    if let candle = selectedCandle {
                        HStack {
                            Text(candle.time.formatted(date: range == .day ? .omitted : .abbreviated, time: range == .day ? .shortened : .omitted))
                            Spacer()
                            Text(DisplayFormat.price(candle.close)).monospacedDigit()
                        }.font(.caption.weight(.medium))
                    } else {
                        Text("\(range.title) · 收盘价格 · 长按查看")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Chart {
                        ForEach(history.candles) { candle in
                            LineMark(x: .value("时间", candle.time), y: .value("价格", candle.close))
                                .foregroundStyle(chartColor).lineStyle(StrokeStyle(lineWidth: 2))
                        }
                        if let candle = selectedCandle {
                            RuleMark(x: .value("选中时间", candle.time))
                                .foregroundStyle(.secondary.opacity(0.5)).lineStyle(StrokeStyle(dash: [3, 3]))
                            PointMark(x: .value("时间", candle.time), y: .value("价格", candle.close))
                                .foregroundStyle(chartColor).symbolSize(45)
                        }
                    }
                    .chartYScale(domain: priceDomain)
                    .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
                    .chartYAxis { AxisMarks(position: .trailing, values: .automatic(desiredCount: 4)) }
                    .chartXSelection(value: $selectedTime)
                    .frame(height: 205)
                    .accessibilityLabel("\(symbol) \(range.title) 价格图表，\(history.candles.count) 个数据点")
                    .accessibilityIdentifier("detail.chart")
                }.padding(.vertical, 4)
            } else {
                ContentUnavailableView("此区间暂无价格数据", systemImage: "chart.xyaxis.line", description: Text("可以切换区间，或下拉重新加载。"))
                    .frame(minHeight: 190)
            }
            if let error = historyError { AppMessageView(message: error, isError: true) }
        }
    }

    private func statisticsSection(_ quote: StockQuote) -> some View {
        Section("报价与统计 · USD") {
            MetricRow {
                MetricCell(title: "买价 Bid", value: DisplayFormat.price(quote.bidPrice))
                MetricCell(title: "卖价 Ask", value: DisplayFormat.price(quote.askPrice))
            }.padding(.vertical, 3)
            MetricRow {
                MetricCell(title: "开盘", value: DisplayFormat.price(quote.openPrice))
                MetricCell(title: "昨收", value: DisplayFormat.price(quote.closePrice))
            }.padding(.vertical, 3)
            MetricRow {
                MetricCell(title: "最高", value: DisplayFormat.price(quote.highPrice))
                MetricCell(title: "最低", value: DisplayFormat.price(quote.lowPrice))
            }.padding(.vertical, 3)
            MetricRow {
                MetricCell(title: "52 周最高", value: DisplayFormat.price(quote.high52Week))
                MetricCell(title: "52 周最低", value: DisplayFormat.price(quote.low52Week))
            }.padding(.vertical, 3)
            LabeledContent("成交量", value: DisplayFormat.volume(quote.totalVolume)).font(.subheadline).monospacedDigit()
            if let status = quote.securityStatus, !status.isEmpty {
                LabeledContent("证券状态", value: status).font(.subheadline)
            }
        }
    }

    private func holdingSection(_ holding: Position) -> some View {
        Section("当前账户持仓") {
            MetricRow {
                MetricCell(title: "持有股数", value: DisplayFormat.quantity(holding.quantity))
                MetricCell(title: "平均成本", value: DisplayFormat.price(holding.averagePrice))
            }
            MetricRow {
                MetricCell(title: "持仓市值", value: DisplayFormat.money(holding.marketValue))
                MetricCell(title: "当日盈亏", value: DisplayFormat.signedMoney(holding.dayProfitLoss), color: DisplayFormat.changeColor(holding.dayProfitLoss))
            }
        }.privacySensitive()
    }

    private var tradeBar: some View {
        VStack(spacing: 6) {
            if !canTrade, quote != nil {
                Text("此页仅支持明确识别为股票 / ETF 的证券交易。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Button { store.openTrade(symbol: symbol, side: .buy) } label: {
                    Text("买入").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 5)
                }
                .buttonStyle(.borderedProminent).tint(.red).accessibilityIdentifier("detail.buy")
                Button { store.openTrade(symbol: symbol, side: .sell) } label: {
                    Text("卖出").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 5)
                }
                .buttonStyle(.borderedProminent).tint(.green)
                .disabled((holding?.quantity ?? 0) < 1).accessibilityIdentifier("detail.sell")
            }
            .disabled(!canTrade || store.isBusy || store.isSubmittingOrder)
        }
        .padding(.horizontal, 20).padding(.vertical, 12).background(.regularMaterial)
    }

    @MainActor private func loadQuote() async {
        let key = sessionKey
        let request = UUID()
        quoteRequestID = request
        isLoadingQuote = true
        quoteError = nil
        quote = nil
        defer { if request == quoteRequestID { isLoadingQuote = false } }
        do {
            let response = try await store.lookupQuote(symbol)
            guard !Task.isCancelled, key == sessionKey, request == quoteRequestID else { return }
            quote = response
        } catch {
            guard !Task.isCancelled, key == sessionKey, request == quoteRequestID else { return }
            quoteError = DisplayFormat.message(error)
        }
    }

    @MainActor private func loadHistory() async {
        let key = historyKey
        let request = UUID()
        historyRequestID = request
        isLoadingHistory = true
        historyError = nil
        history = nil
        defer { if request == historyRequestID { isLoadingHistory = false } }
        do {
            let response = try await store.priceHistory(symbol: symbol, range: range)
            guard !Task.isCancelled, key == historyKey, request == historyRequestID else { return }
            history = response
        } catch {
            guard !Task.isCancelled, key == historyKey, request == historyRequestID else { return }
            historyError = DisplayFormat.message(error)
        }
    }

    @MainActor private func refreshDetail() async {
        await loadQuote()
        await loadHistory()
    }

    private func rangeName(_ item: HistoryRange) -> String {
        switch item { case .day: return "day"; case .week: return "week"; case .month: return "month"; case .year: return "year" }
    }

    private func rangeTitle(_ item: HistoryRange) -> String {
        switch item { case .day: return "1D"; case .week: return "1W"; case .month: return "1M"; case .year: return "1Y" }
    }
}
