import SwiftUI

struct WatchlistView: View {
    @Environment(AppStore.self) private var store
    @State private var isAddingSymbol = false
    @State private var isEditing = false
    @State private var searchSymbol = ""
    @State private var searchError: String?
    @State private var path: [String] = []
    @State private var mode: WatchlistMode = .quotes
    @State private var histories: [String: PriceHistory] = [:]
    @State private var failedHistories: Set<String> = []
    @State private var visibleSymbols: Set<String> = []
    @State private var historyTasks: [String: Task<Void, Never>] = [:]
    @State private var historyEpoch = UUID()
    @FocusState private var isSearching: Bool

    private var connected: Bool { store.isAuthenticated || store.isDemo }
    private var sessionKey: String { "\(store.generation)|\(store.isDemo)|\(store.isAuthenticated)" }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                searchRow
                modeRow
                if store.isDemo {
                    DemoNotice().padding(.vertical, 3)
                        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16))
                        .listRowSeparator(.hidden).listRowBackground(MarketTheme.background)
                }
                if let error = searchError ?? store.errorMessage {
                    AppMessageView(message: error, isError: true).listRowBackground(MarketTheme.surface)
                }
                if !connected {
                    ConnectionRequiredView(message: "连接后即可查价、查看图表和创建股票订单。")
                        .listRowBackground(MarketTheme.background)
                }
                if store.watchlist.isEmpty {
                    ContentUnavailableView {
                        Label("添加你的第一只自选", systemImage: "star")
                    } description: { Text("关注股票和 ETF，在这里对比价格与走势。") }
                    actions: {
                        Button("添加自选") { isAddingSymbol = true }.buttonStyle(.borderedProminent)
                    }.listRowBackground(MarketTheme.background)
                } else {
                    tableHeader
                    ForEach(store.watchlist, id: \.self) { symbol in symbolRow(symbol) }
                    VStack(alignment: .leading, spacing: 5) {
                        Text(mode == .quotes ? "左滑查看多股同列走势" : "右滑返回行情列表 · 分时走势")
                        UpdateStatusView(lastUpdated: store.quotesUpdatedAt,
                                         latencyMilliseconds: store.quotesLatencyMilliseconds, isDemo: store.isDemo)
                    }
                    .font(.caption2).foregroundStyle(MarketTheme.secondary).padding(.vertical, 10)
                    .listRowSeparator(.hidden).listRowBackground(MarketTheme.background)
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden).background(MarketTheme.background)
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(DragGesture(minimumDistance: 25).onEnded { gesture in
                guard abs(gesture.translation.width) > 55,
                      abs(gesture.translation.width) > abs(gesture.translation.height) * 1.6 else { return }
                changeMode(gesture.translation.width < 0 ? .charts : .quotes)
            })
            .navigationTitle("自选").navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { StockDetailView(symbol: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(isEditing ? "完成" : "编辑") { isEditing.toggle() }
                        .disabled(store.watchlist.isEmpty || store.isBusy || store.isSubmittingOrder)
                        .accessibilityIdentifier("watchlist.edit")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    RefreshToolbarButton()
                    Button { isAddingSymbol = true } label: { Label("添加自选", systemImage: "plus") }
                        .disabled(store.isBusy || store.isSubmittingOrder)
                        .accessibilityIdentifier("watchlist.add")
                }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("完成") { isSearching = false } }
            }
            .toolbarBackground(MarketTheme.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .sheet(isPresented: $isAddingSymbol) { AddSymbolView() }
            .refreshable { if !store.isSubmittingOrder { await store.refresh(); resetHistories() } }
            .onChange(of: sessionKey) { _, _ in resetHistories() }
            .onChange(of: store.watchlist) { _, symbols in
                let retained = Set(symbols)
                histories = histories.filter { retained.contains($0.key) }
                failedHistories.formIntersection(retained)
                visibleSymbols.formIntersection(retained)
                scheduleHistories()
            }
            .onChange(of: store.quotesUpdatedAt) { _, _ in resetHistories() }
            .onDisappear(perform: cancelHistoryTasks)
            .accessibilityIdentifier("screen.watchlist")
        }
        .preferredColorScheme(.dark).tint(.white)
    }

    private var searchRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(MarketTheme.secondary)
            TextField("输入股票 / ETF 代码", text: $searchSymbol)
                .font(.subheadline).textInputAutocapitalization(.characters).autocorrectionDisabled()
                .keyboardType(.asciiCapable).submitLabel(.search)
                .focused($isSearching).onSubmit(openSearch).accessibilityIdentifier("watchlist.search")
            Button("查价", action: openSearch)
                .font(.subheadline.weight(.semibold)).foregroundStyle(MarketTheme.rise)
                .disabled(searchSymbol.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !connected)
                .accessibilityIdentifier("watchlist.lookup")
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(MarketTheme.elevated, in: RoundedRectangle(cornerRadius: 10))
        .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 10, trailing: 16))
        .listRowSeparator(.hidden).listRowBackground(MarketTheme.background)
    }

    private var modeRow: some View {
        HStack {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("自选股").font(.title3.weight(.semibold))
                Text("\(store.watchlist.count)").font(.subheadline.monospacedDigit()).foregroundStyle(MarketTheme.secondary)
            }
            Spacer()
            HStack(spacing: 3) {
                ForEach(WatchlistMode.allCases) { item in
                    Button { changeMode(item) } label: {
                        Image(systemName: item == .quotes ? "list.bullet" : "chart.xyaxis.line")
                            .font(.system(size: 15, weight: .medium)).frame(width: 40, height: 30)
                            .background(mode == item ? MarketTheme.elevated : .clear, in: RoundedRectangle(cornerRadius: 7))
                    }
                    .buttonStyle(.plain).foregroundStyle(mode == item ? .white : MarketTheme.secondary)
                    .accessibilityLabel(item == .quotes ? "行情列表" : "多股同列")
                    .accessibilityIdentifier("watchlist.mode.\(item.rawValue)")
                    .accessibilityAddTraits(mode == item ? .isSelected : [])
                }
            }
        }
        .padding(.vertical, 6)
        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 7, trailing: 16))
        .listRowSeparator(.hidden).listRowBackground(MarketTheme.background)
    }

    private var tableHeader: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            HStack(spacing: 0) {
                Text("名称 / 代码").frame(width: width * 0.30, alignment: .leading)
                if mode == .quotes {
                    Text("最新").frame(width: width * 0.25, alignment: .trailing)
                    Text("涨幅").frame(width: width * 0.24, alignment: .trailing)
                    Text("涨跌").frame(width: width * 0.21, alignment: .trailing)
                } else {
                    Text("多股同列").frame(width: width * 0.43, alignment: .center)
                    Text("涨幅 / 最新").frame(width: width * 0.27, alignment: .trailing)
                }
            }.font(.system(size: 11)).foregroundStyle(MarketTheme.secondary)
        }
        .frame(height: 20)
        .listRowInsets(EdgeInsets(top: 7, leading: 16, bottom: 6, trailing: 16))
        .listRowSeparatorTint(MarketTheme.separator).listRowBackground(MarketTheme.surface)
    }

    private func symbolRow(_ symbol: String) -> some View {
        let quote = store.quotes.first { $0.symbol == symbol }
        return HStack(spacing: 8) {
            if isEditing {
                Button(role: .destructive) { removeSymbol(symbol) } label: {
                    Image(systemName: "minus.circle.fill").font(.title3)
                }
                .buttonStyle(.plain).accessibilityLabel("移除 \(symbol)")
                .accessibilityIdentifier("watchlist.remove.\(symbol)")
                .disabled(store.isBusy || store.isSubmittingOrder)
            }
            Button { isSearching = false; path.append(symbol) } label: {
                WatchlistQuoteRow(symbol: symbol, quote: quote, mode: mode,
                                  history: histories[symbol], failedHistory: failedHistories.contains(symbol))
            }
            .buttonStyle(.plain).disabled(!connected).accessibilityIdentifier("watchlist.symbol.\(symbol)")
            .accessibilityValue(mode == .charts ? (histories[symbol].map { "分时走势，\($0.candles.count) 个数据点" } ?? "分时读取中") : "行情列表")
            .contextMenu {
                Button("移除自选", role: .destructive) { removeSymbol(symbol) }
                    .disabled(store.isBusy || store.isSubmittingOrder)
            }
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
        .listRowSeparatorTint(MarketTheme.separator).listRowBackground(MarketTheme.surface)
        .onAppear { visibleSymbols.insert(symbol); scheduleHistories() }
        .onDisappear { visibleSymbols.remove(symbol) }
    }

    private func openSearch() {
        let value = searchSymbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard connected else { return }
        guard value.range(of: "^[A-Z0-9][A-Z0-9.\\-/]{0,14}$", options: .regularExpression) != nil else {
            searchError = "请输入有效的股票或 ETF 代码，例如 AAPL。"
            return
        }
        isSearching = false
        searchError = nil
        path.append(value)
    }

    private func removeSymbol(_ symbol: String) { Task { await store.removeSymbol(symbol) } }

    private func changeMode(_ value: WatchlistMode) {
        isSearching = false
        mode = value
        if value == .charts { scheduleHistories() }
        else { cancelHistoryTasks() }
    }

    private func cancelHistoryTasks() {
        historyEpoch = UUID()
        historyTasks.values.forEach { $0.cancel() }
        historyTasks.removeAll()
    }

    private func resetHistories() {
        cancelHistoryTasks()
        histories.removeAll()
        failedHistories.removeAll()
        scheduleHistories()
    }

    private func scheduleHistories() {
        guard mode == .charts, connected, !store.isSubmittingOrder else { return }
        let candidates = store.watchlist.filter {
            visibleSymbols.contains($0) && histories[$0] == nil && historyTasks[$0] == nil && !failedHistories.contains($0)
        }
        for symbol in candidates.prefix(max(0, 2 - historyTasks.count)) {
            let epoch = historyEpoch
            let key = sessionKey
            historyTasks[symbol] = Task { @MainActor in
                defer {
                    if epoch == historyEpoch {
                        historyTasks.removeValue(forKey: symbol)
                        scheduleHistories()
                    }
                }
                do {
                    let result = try await store.priceHistory(symbol: symbol, range: .intraday)
                    guard !Task.isCancelled, epoch == historyEpoch, key == sessionKey, store.watchlist.contains(symbol) else { return }
                    histories[symbol] = result
                } catch {
                    guard !Task.isCancelled, epoch == historyEpoch, key == sessionKey else { return }
                    failedHistories.insert(symbol)
                }
            }
        }
    }
}

private enum WatchlistMode: String, CaseIterable, Identifiable {
    case quotes, charts
    var id: String { rawValue }
}

private struct WatchlistQuoteRow: View {
    let symbol: String
    let quote: StockQuote?
    let mode: WatchlistMode
    let history: PriceHistory?
    let failedHistory: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(quote?.description ?? symbol)
                        .font(.system(size: 15, weight: .medium)).foregroundStyle(.white)
                        .lineLimit(1).minimumScaleFactor(0.8)
                    HStack(spacing: 4) {
                        Text("US").font(.system(size: 9, weight: .medium))
                            .padding(.horizontal, 3).padding(.vertical, 1)
                            .background(MarketTheme.ma10.opacity(0.25), in: RoundedRectangle(cornerRadius: 2))
                        Text(symbol).font(.system(size: 11)).foregroundStyle(MarketTheme.secondary).lineLimit(1)
                    }
                }
                .frame(width: width * 0.30, alignment: .leading)
                if mode == .quotes {
                    number(MarketTheme.number(quote?.lastPrice), width: width * 0.25)
                    number(DisplayFormat.signedPercent(quote?.netPercentChange), width: width * 0.24)
                    number(MarketTheme.signedNumber(quote?.netChange), width: width * 0.21)
                } else {
                    Group {
                        if let history, !history.candles.isEmpty {
                            MarketChartView(history: history, range: .intraday, compact: true)
                                .allowsHitTesting(false).accessibilityIdentifier("watchlist.chart.\(symbol)")
                        } else if failedHistory || history != nil {
                            Text("暂无分时").font(.caption2).foregroundStyle(MarketTheme.secondary)
                        } else {
                            ProgressView().controlSize(.mini).tint(MarketTheme.secondary)
                        }
                    }
                    .padding(.horizontal, 8).padding(.vertical, 7)
                    .frame(width: width * 0.43, height: 59)
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(DisplayFormat.signedPercent(quote?.netPercentChange))
                            .font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                            .lineLimit(1).minimumScaleFactor(0.7)
                            .frame(maxWidth: .infinity).padding(.vertical, 4)
                            .background(MarketTheme.change(quote?.netPercentChange), in: RoundedRectangle(cornerRadius: 3))
                        Text(MarketTheme.number(quote?.lastPrice))
                            .font(.system(size: 11, weight: .medium)).foregroundStyle(MarketTheme.secondary)
                    }
                    .padding(.leading, 5).frame(width: width * 0.27)
                }
            }
            .monospacedDigit().frame(height: geometry.size.height)
        }
        .frame(height: typeSize.isAccessibilitySize ? 78 : 65)
        .contentShape(Rectangle()).accessibilityElement(children: .combine)
    }

    private func number(_ value: String, width: CGFloat) -> some View {
        Text(value).font(.system(size: 16, weight: .semibold))
            .foregroundStyle(MarketTheme.change(quote?.netChange))
            .lineLimit(1).minimumScaleFactor(0.65).frame(width: width, alignment: .trailing)
    }
}

private struct AddSymbolView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var symbol = ""
    @State private var isSaving = false
    @FocusState private var isFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section("股票 / ETF 代码") {
                    TextField("例如 AAPL 或 SPY", text: $symbol)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .keyboardType(.asciiCapable).submitLabel(.done).focused($isFocused)
                        .onSubmit(add).accessibilityIdentifier("watchlist.add.symbol")
                }
                if let error = store.errorMessage { Section { AppMessageView(message: error, isError: true) } }
                Section { Text("最多保存 50 个自选。也可以在自选页直接输入代码查价。")
                    .font(.subheadline).foregroundStyle(.secondary) }
            }
            .navigationTitle("添加自选").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(isSaving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("添加", action: add)
                        .disabled(symbol.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isBusy || isSaving)
                        .accessibilityIdentifier("watchlist.add.confirm")
                }
            }
            .onAppear { isFocused = true }.interactiveDismissDisabled(isSaving)
        }
    }

    private func add() {
        guard !store.isBusy, !isSaving else { return }
        let value = symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        isSaving = true
        Task {
            await store.addSymbol(value)
            isSaving = false
            if store.watchlist.contains(value) { dismiss() }
        }
    }
}
