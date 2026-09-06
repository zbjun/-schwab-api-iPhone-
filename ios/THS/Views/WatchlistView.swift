import SwiftUI

struct WatchlistView: View {
    @Environment(AppStore.self) private var store
    @State private var isAddingSymbol = false
    @State private var searchSymbol = ""
    @State private var searchError: String?
    @State private var path: [String] = []
    @FocusState private var isSearching: Bool

    private var connected: Bool { store.isAuthenticated || store.isDemo }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField("输入股票 / ETF 代码", text: $searchSymbol)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled()
                            .keyboardType(.asciiCapable).submitLabel(.search)
                            .focused($isSearching).onSubmit(openSearch)
                            .accessibilityIdentifier("watchlist.search")
                        Button("查价", action: openSearch)
                            .font(.subheadline.weight(.semibold))
                            .disabled(searchSymbol.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !connected)
                            .accessibilityIdentifier("watchlist.lookup")
                    }
                }
                if store.isDemo { Section { DemoNotice() } }
                if let error = searchError ?? store.errorMessage {
                    Section { AppMessageView(message: error, isError: true) }
                }
                if !connected {
                    Section { ConnectionRequiredView(message: "连接后即可查价、查看图表和创建股票订单。") }
                        .listRowBackground(Color.clear)
                }
                if store.watchlist.isEmpty {
                    Section {
                        ContentUnavailableView {
                            Label("你的自选，从这里开始", systemImage: "star")
                        } description: { Text("添加关注的股票或 ETF，集中查看报价。") }
                        actions: {
                            Button("添加自选") { isAddingSymbol = true }
                                .buttonStyle(.borderedProminent)
                        }
                    }.listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(store.watchlist, id: \.self) { symbol in
                            NavigationLink(value: symbol) {
                                WatchlistQuoteRow(symbol: symbol, quote: store.quotes.first { $0.symbol == symbol }, isLoading: store.isBusy)
                            }
                            .disabled(!connected)
                            .accessibilityIdentifier("watchlist.symbol.\(symbol)")
                        }
                        .onDelete(perform: removeSymbols)
                        .deleteDisabled(store.isBusy || store.isSubmittingOrder)
                    } header: {
                        HStack { Text("自选 · \(store.watchlist.count)"); Spacer(); Text("最新价 / 涨跌幅") }
                    } footer: {
                        VStack(alignment: .leading, spacing: 6) {
                            UpdateStatusView(lastUpdated: store.quotesUpdatedAt,
                                             latencyMilliseconds: store.quotesLatencyMilliseconds, isDemo: store.isDemo)
                            Text("向左滑动可移除自选。报价时间与权限标记见证券详情。")
                        }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("自选")
            .navigationDestination(for: String.self) { StockDetailView(symbol: $0) }
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    RefreshToolbarButton()
                    Button { isAddingSymbol = true } label: { Label("添加自选", systemImage: "plus") }
                        .disabled(store.isBusy || store.isSubmittingOrder)
                        .accessibilityIdentifier("watchlist.add")
                }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("完成") { isSearching = false } }
            }
            .sheet(isPresented: $isAddingSymbol) { AddSymbolView() }
            .refreshable { if !store.isSubmittingOrder { await store.refresh() } }
            .accessibilityIdentifier("screen.watchlist")
        }
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

    private func removeSymbols(at offsets: IndexSet) {
        let symbols = offsets.compactMap { store.watchlist.indices.contains($0) ? store.watchlist[$0] : nil }
        Task { for symbol in symbols { await store.removeSymbol(symbol) } }
    }
}

private struct WatchlistQuoteRow: View {
    let symbol: String
    let quote: StockQuote?
    let isLoading: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
        layout {
            VStack(alignment: .leading, spacing: 6) {
                Text(symbol).font(.headline)
                Text(quote?.description ?? (isLoading ? "正在读取行情…" : "暂无报价"))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: typeSize.isAccessibilitySize ? .leading : .trailing, spacing: 6) {
                Text(DisplayFormat.price(quote?.lastPrice))
                    .font(.headline).foregroundStyle(.primary)
                Text(DisplayFormat.signedPercent(quote?.netPercentChange))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(DisplayFormat.changeColor(quote?.netPercentChange))
                    .padding(.horizontal, 9).padding(.vertical, 5)
                    .background(DisplayFormat.changeColor(quote?.netPercentChange).opacity(0.10), in: RoundedRectangle(cornerRadius: 6))
            }.monospacedDigit()
        }
        .padding(.vertical, 6).accessibilityElement(children: .combine)
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
                if let error = store.errorMessage {
                    Section { AppMessageView(message: error, isError: true) }
                }
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
            .onAppear { isFocused = true }
            .interactiveDismissDisabled(isSaving)
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
