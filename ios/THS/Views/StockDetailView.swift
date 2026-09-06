import SwiftUI

struct StockDetailView: View {
    @Environment(AppStore.self) private var store
    let symbol: String
    @State private var quote: StockQuote?
    @State private var history: PriceHistory?
    @State private var range: HistoryRange = .intraday
    @State private var quoteError: String?
    @State private var historyError: String?
    @State private var isLoadingQuote = false
    @State private var isLoadingHistory = false
    @State private var quoteRequestID = UUID()
    @State private var historyRequestID = UUID()
    @State private var historyCache: [HistoryRange: PriceHistory] = [:]
    @State private var cachedSession = ""
    @State private var editorAction: InlineTradeAction?
    @State private var showsMetricNotes = false
    @State private var fundamentals: StockFundamentals?
    @State private var metricRequestID = UUID()

    private var sessionKey: String { "\(symbol)|\(store.generation)|\(store.isDemo)|\(store.isAuthenticated)" }
    private var historyKey: String { "\(sessionKey)|\(range.rawValue)" }
    private var holding: Position? { store.selectedAccount?.positions.first { $0.symbol == symbol } }
    private var canTrade: Bool { quote?.assetMainType == "EQUITY" && (store.isDemo || store.isAuthenticated) }
    private var volumeRatio: Double? {
        MarketStatistics.volumeRatio(intraday: historyCache[.intraday], daily: historyCache[.daily])
    }
    private var turnover: Double? {
        guard let shares = fundamentals?.sharesOutstanding, shares.isFinite, shares > 0,
              let volume = quote?.totalVolume, volume.isFinite, volume >= 0 else { return nil }
        let value = volume / shares * 100
        return value.isFinite ? value : nil
    }

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                if let action = editorAction {
                    quoteSummary(compact: true).frame(height: 72)
                    chartSection(height: min(320, max(180, (geometry.size.height - 72) * 0.44)))
                    Rectangle().fill(MarketTheme.separator).frame(height: 1)
                    Group {
                        if action == .cancel {
                            InlineCancelPanel(symbol: symbol, onAction: { editorAction = $0 }, onClose: { editorAction = nil })
                        } else {
                            InlineTradePanel(symbol: symbol, initialSide: action == .buy ? .buy : .sell, quote: quote,
                                             onCancel: { editorAction = .cancel }, onClose: { editorAction = nil })
                        }
                    }
                    .id("\(symbol)|\(action.rawValue)")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        VStack(spacing: 0) {
                            quoteSummary(compact: false)
                            chartSection(height: min(450, max(330, geometry.size.height * 0.56)))
                            extraStatistics
                            if let holding { holdingSection(holding) }
                        }
                    }
                    .refreshable { await refreshDetail() }
                    tradeBar
                }
            }
            .background(MarketTheme.background)
        }
        .accessibilityElement(children: .contain).accessibilityIdentifier("screen.detail")
        .navigationTitle(symbol).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 2) {
                    Text(quote?.description ?? symbol).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text("\(symbol) · USD").font(.system(size: 10)).foregroundStyle(MarketTheme.secondary)
                }.frame(maxWidth: 190)
            }
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
                .foregroundStyle(store.watchlist.contains(symbol) ? MarketTheme.average : MarketTheme.primary)
                .disabled(store.isBusy || store.isSubmittingOrder).accessibilityIdentifier("detail.watchlist")
                Button { Task { await refreshDetail() } } label: { Label("刷新", systemImage: "arrow.clockwise") }
                    .disabled(isLoadingQuote || isLoadingHistory || store.isSubmittingOrder)
                    .accessibilityIdentifier("detail.refresh")
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .toolbarBackground(MarketTheme.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .tint(MarketTheme.primary)
        .task(id: sessionKey) { await loadQuote() }
        .task(id: sessionKey) { await loadMetrics() }
        .task(id: historyKey) { await loadHistory() }
        .onChange(of: sessionKey) { _, _ in editorAction = nil }
    }

    private func quoteSummary(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: compact ? 7 : 11) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(MarketTheme.number(quote?.lastPrice))
                        .font(.system(size: compact ? 27 : 34, weight: .semibold, design: .rounded))
                        .monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
                        .foregroundStyle(MarketTheme.change(quote?.netChange))
                        .accessibilityIdentifier("detail.lastPrice")
                    HStack(spacing: 7) {
                        Text(MarketTheme.signedNumber(quote?.netChange))
                        Text(DisplayFormat.signedPercent(quote?.netPercentChange))
                    }
                    .font(.system(size: 12, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(MarketTheme.change(quote?.netChange))
                }.frame(maxWidth: .infinity, alignment: .leading)
                VStack(spacing: 5) {
                    priceMetric("高", value: quote?.highPrice)
                    priceMetric("低", value: quote?.lowPrice)
                    if !compact { priceMetric("开", value: quote?.openPrice) }
                }.frame(width: compact ? 86 : 100)
                if compact {
                    VStack(spacing: 5) {
                        priceMetric("开", value: quote?.openPrice)
                        priceMetric("昨", value: quote?.closePrice)
                    }.frame(width: 86)
                }
            }
            if !compact {
                Grid(horizontalSpacing: 14, verticalSpacing: 10) {
                    GridRow {
                        statistic("昨收", value: MarketTheme.number(quote?.closePrice))
                        statistic("成交量", value: DisplayFormat.volume(quote?.totalVolume))
                        statistic("换手估", value: turnover.map { MarketTheme.number($0) + "%" } ?? "—")
                    }
                    GridRow {
                        statistic("市值", value: DisplayFormat.volume(fundamentals?.marketCap))
                        statistic("市盈率", value: MarketTheme.number(quote?.peRatio))
                        statistic("量比估", value: MarketTheme.number(volumeRatio))
                    }
                }
                HStack(spacing: 5) {
                    Circle().fill(store.isDemo ? MarketTheme.average : (quote?.isRealtime == true ? MarketTheme.fall : MarketTheme.secondary))
                        .frame(width: 4, height: 4)
                    Text(quoteStatus).lineLimit(1)
                    Spacer(minLength: 4)
                    Button { showsMetricNotes.toggle() } label: { Image(systemName: "info.circle") }
                        .accessibilityLabel("行情指标说明").accessibilityIdentifier("detail.metricInfo")
                }
                .font(.system(size: 10)).foregroundStyle(MarketTheme.secondary)
                if showsMetricNotes {
                    Text("换手率＝成交量 / 总股本，股本和市值来自基本面数据。量比以最近分时交易日每分钟成交量对比此前五日日均量，按常规交易日390分钟估算；半日市或数据缺失时可能不适用。黄色线按分钟价格与成交量估算均价，每日重置。")
                        .font(.caption2).foregroundStyle(MarketTheme.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let error = quoteError { AppMessageView(message: error, isError: true) }
                if isLoadingQuote { ProgressView().controlSize(.mini).accessibilityLabel("正在刷新报价") }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, compact ? 7 : 14)
        .background(MarketTheme.surface)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(compact ? "detail.quote.compact" : "detail.quote.summary")
    }

    private var quoteStatus: String {
        if store.isDemo { return "演示行情 · 换手与量比为估算" }
        let status = quote?.isRealtime == true ? "实时权限" : (quote?.isRealtime == false ? "非实时标记" : "时效未确认")
        let time = quote?.quoteTime?.formatted(date: .omitted, time: .standard) ?? "时间未提供"
        return "\(status) · \(time) · 换手按总股本估算"
    }

    private func priceMetric(_ name: String, value: Double?) -> some View {
        HStack(spacing: 6) {
            Text(name).foregroundStyle(MarketTheme.secondary)
            Spacer(minLength: 0)
            Text(MarketTheme.number(value))
                .foregroundStyle(MarketTheme.change(value.flatMap { current in quote?.closePrice.map { current - $0 } }))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
        }.font(.system(size: 12))
        .accessibilityElement(children: .combine)
    }

    private func statistic(_ title: String, value: String) -> some View {
        HStack(spacing: 5) {
            Text(title).foregroundStyle(MarketTheme.secondary)
            Spacer(minLength: 0)
            Text(value).foregroundStyle(MarketTheme.primary).monospacedDigit().lineLimit(1).minimumScaleFactor(0.65)
        }
        .font(.system(size: 11)).frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    private func chartSection(height: CGFloat) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(HistoryRange.primaryCases, id: \.self) { item in
                    Button {
                        range = item
                    } label: {
                        VStack(spacing: 6) {
                            Text(item.title).font(.system(size: 14, weight: range == item ? .semibold : .regular))
                            Capsule().fill(range == item ? MarketTheme.rise : .clear).frame(width: 18, height: 3)
                        }.frame(maxWidth: .infinity).padding(.top, 9)
                    }
                    .buttonStyle(.plain).foregroundStyle(range == item ? MarketTheme.primary : MarketTheme.secondary)
                    .disabled(store.isSubmittingOrder).accessibilityIdentifier("history.\(item.rawValue)")
                    .accessibilityAddTraits(range == item ? .isSelected : [])
                }
                Menu {
                    ForEach(HistoryRange.minuteCases, id: \.self) { item in
                        Button { range = item } label: {
                            if range == item { Label(item.title, systemImage: "checkmark") }
                            else { Text(item.title) }
                        }
                        .accessibilityIdentifier("history.\(item.rawValue)")
                    }
                } label: {
                    VStack(spacing: 6) {
                        HStack(spacing: 2) {
                            Text(range.minuteInterval.map { "\($0)分" } ?? "更多")
                                .font(.system(size: 14, weight: range.minuteInterval == nil ? .regular : .semibold))
                            Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
                        }
                        Capsule().fill(range.minuteInterval != nil ? MarketTheme.rise : .clear).frame(width: 18, height: 3)
                    }.frame(maxWidth: .infinity).padding(.top, 9)
                }
                .foregroundStyle(range.minuteInterval != nil ? MarketTheme.primary : MarketTheme.secondary)
                .disabled(store.isSubmittingOrder).accessibilityIdentifier("history.more")
                .accessibilityLabel("更多K线周期")
                .accessibilityValue(range.minuteInterval.map { "\($0)分钟" } ?? "未选择分钟周期")
            }.frame(height: 38)
            Group {
                if let history, !history.candles.isEmpty {
                    MarketChartView(history: history, range: range)
                } else if isLoadingHistory {
                    VStack(spacing: 8) {
                        ProgressView().tint(MarketTheme.secondary)
                        Text("正在读取\(range.title)…").font(.caption).foregroundStyle(MarketTheme.secondary)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: "chart.xyaxis.line").font(.title2)
                        Text(historyError ?? "此区间暂无价格数据").font(.caption).multilineTextAlignment(.center)
                    }.foregroundStyle(MarketTheme.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("detail.chart")
        }
        .frame(height: height)
        .background(MarketTheme.background)
        .clipped()
    }

    private var extraStatistics: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Text("报价与统计").font(.subheadline.weight(.semibold))
                Spacer()
                Text("USD").font(.caption2).foregroundStyle(MarketTheme.secondary)
            }
            HStack(spacing: 20) {
                statistic("买价", value: MarketTheme.number(quote?.bidPrice))
                statistic("卖价", value: MarketTheme.number(quote?.askPrice))
            }
            HStack(spacing: 20) {
                statistic("52周高", value: MarketTheme.number(quote?.high52Week))
                statistic("52周低", value: MarketTheme.number(quote?.low52Week))
            }
            if let status = quote?.securityStatus, !status.isEmpty {
                statistic("证券状态", value: status)
            }
        }
        .padding(16).background(MarketTheme.surface)
        .overlay(alignment: .top) { Rectangle().fill(MarketTheme.separator).frame(height: 1) }
    }

    private func holdingSection(_ holding: Position) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("当前账户持仓").font(.subheadline.weight(.semibold))
            HStack(spacing: 20) {
                statistic("持有", value: DisplayFormat.quantity(holding.quantity) + " 股")
                statistic("成本", value: MarketTheme.number(holding.averagePrice))
            }
            HStack(spacing: 20) {
                statistic("市值", value: DisplayFormat.money(holding.marketValue))
                statistic("当日盈亏", value: DisplayFormat.signedMoney(holding.dayProfitLoss))
            }
        }
        .padding(16).background(MarketTheme.surface)
        .overlay(alignment: .top) { Rectangle().fill(MarketTheme.separator).frame(height: 1) }
        .privacySensitive()
    }

    private var tradeBar: some View {
        HStack(spacing: 12) {
            Button { editorAction = .buy } label: {
                Text("买").font(.headline).frame(maxWidth: .infinity).frame(height: 43)
                    .background(MarketTheme.rise, in: RoundedRectangle(cornerRadius: 8))
            }.buttonStyle(.plain).disabled(!canTrade)
                .accessibilityLabel("买入").accessibilityIdentifier("detail.buy")
            Button { editorAction = .sell } label: {
                Text("卖").font(.headline).frame(maxWidth: .infinity).frame(height: 43)
                    .background(MarketTheme.ma30.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain).disabled(!canTrade || (holding?.quantity ?? 0) < 1)
            .accessibilityLabel("卖出").accessibilityIdentifier("detail.sell")
            Button { editorAction = .cancel } label: {
                Text("撤").font(.headline).foregroundStyle(MarketTheme.primary)
                    .frame(maxWidth: .infinity).frame(height: 43)
                    .background(MarketTheme.elevated, in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain).disabled((!store.isDemo && !store.isAuthenticated) || store.selectedAccount == nil)
            .accessibilityLabel("撤单").accessibilityIdentifier("detail.cancel")
        }
        .foregroundStyle(.white)
        .disabled(store.isBusy || store.isSubmittingOrder)
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(MarketTheme.surface)
        .overlay(alignment: .top) { Rectangle().fill(MarketTheme.separator).frame(height: 1) }
    }

    @MainActor private func loadQuote() async {
        let key = sessionKey
        let request = UUID()
        quoteRequestID = request
        isLoadingQuote = true
        quoteError = nil
        quote = store.quotes.first { $0.symbol == symbol }
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

    @MainActor private func loadHistory(force: Bool = false) async {
        let key = historyKey
        let request = UUID()
        historyRequestID = request
        historyError = nil
        if cachedSession != sessionKey {
            historyCache.removeAll()
            cachedSession = sessionKey
        }
        history = historyCache[range]
        if history != nil, !force { isLoadingHistory = false; return }
        isLoadingHistory = true
        defer { if request == historyRequestID { isLoadingHistory = false } }
        do {
            let response = try await store.priceHistory(symbol: symbol, range: range)
            guard !Task.isCancelled, key == historyKey, request == historyRequestID else { return }
            history = response
            historyCache[range] = response
        } catch {
            guard !Task.isCancelled, key == historyKey, request == historyRequestID else { return }
            historyError = DisplayFormat.message(error)
        }
    }

    @MainActor private func refreshDetail() async {
        historyCache.removeAll()
        await loadQuote()
        await loadHistory(force: true)
        await loadMetrics()
    }

    @MainActor private func loadMetrics() async {
        let key = sessionKey
        let request = UUID()
        metricRequestID = request
        fundamentals = nil
        async let basics = try? store.fundamentals(symbol: symbol)
        async let daily = try? store.priceHistory(symbol: symbol, range: .daily)
        let (basicResult, dailyResult) = await (basics, daily)
        guard !Task.isCancelled, key == sessionKey, request == metricRequestID else { return }
        fundamentals = basicResult
        if let dailyResult { historyCache[.daily] = dailyResult }
        if historyCache[.intraday] == nil {
            let intraday = try? await store.priceHistory(symbol: symbol, range: .intraday)
            guard !Task.isCancelled, key == sessionKey, request == metricRequestID else { return }
            if let intraday { historyCache[.intraday] = intraday }
        }
    }
}
