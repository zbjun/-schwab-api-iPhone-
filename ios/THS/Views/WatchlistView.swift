import SwiftUI

struct WatchlistView: View {
    @Environment(AppStore.self) private var store
    @State private var isAddingSymbol = false
    let onConnect: () -> Void

    var body: some View {
        NavigationStack {
            List {
                if store.isDemo {
                    Section { DemoNotice() }
                }

                if let error = store.errorMessage {
                    Section { AppMessageView(message: error, isError: true) }
                }

                if !store.isAuthenticated && !store.isDemo {
                    Section {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("连接账户后查看自选行情。")
                                .foregroundStyle(.secondary)
                            Button("前往连接", action: onConnect)
                                .buttonStyle(.bordered)
                        }
                    }
                }

                if store.watchlist.isEmpty {
                    Section {
                        ContentUnavailableView {
                            Label("添加关注的股票", systemImage: "star")
                        } description: {
                            Text("用股票代码创建你的自选列表。")
                        } actions: {
                            Button("添加自选") { isAddingSymbol = true }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                    .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(store.watchlist, id: \.self) { symbol in
                            if let quote = store.quotes.first(where: { $0.symbol == symbol }) {
                                QuoteRow(quote: quote)
                            } else {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(symbol).font(.headline)
                                    Text(store.isBusy ? "正在读取行情…" : "暂无报价")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 6)
                            }
                        }
                        .onDelete(perform: removeSymbols)
                        .deleteDisabled(store.isBusy)
                    } footer: {
                        UpdateStatusView(
                            lastUpdated: store.quotesUpdatedAt,
                            latencyMilliseconds: store.quotesLatencyMilliseconds,
                            isDemo: store.isDemo
                        )
                    }
                }
            }
            .navigationTitle("自选")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    RefreshToolbarButton()
                    Button {
                        isAddingSymbol = true
                    } label: {
                        Label("添加自选", systemImage: "plus")
                    }
                    .disabled(store.isBusy)
                }
            }
            .sheet(isPresented: $isAddingSymbol) { AddSymbolView() }
            .refreshable {
                if store.isAuthenticated || store.isDemo { await store.refresh() }
            }
        }
    }

    private func removeSymbols(at offsets: IndexSet) {
        let symbols = offsets.compactMap { index in
            store.watchlist.indices.contains(index) ? store.watchlist[index] : nil
        }
        Task {
            for symbol in symbols { await store.removeSymbol(symbol) }
        }
    }
}

private struct QuoteRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let quote: StockQuote

    private var freshness: String {
        switch quote.isRealtime {
        case .some(true): return "实时报价权限"
        case .some(false): return "非实时报价标记"
        case .none: return "报价时效未确认"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 6) {
                    Text(quote.symbol).font(.headline)
                    priceLabel
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(quote.symbol).font(.headline)
                    Spacer(minLength: 8)
                    priceLabel
                }
            }

            if let description = quote.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            LabeledContent("涨跌") {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(DisplayFormat.signedMoney(quote.netChange))
                        .foregroundStyle(DisplayFormat.changeColor(quote.netChange))
                    Text(DisplayFormat.signedPercent(quote.netPercentChange))
                        .foregroundStyle(DisplayFormat.changeColor(quote.netPercentChange))
                }
                .monospacedDigit()
            }
            .font(.subheadline)

            LabeledContent("买价", value: DisplayFormat.money(quote.bidPrice))
                .font(.subheadline)
                .monospacedDigit()
            LabeledContent("卖价", value: DisplayFormat.money(quote.askPrice))
                .font(.subheadline)
                .monospacedDigit()

            VStack(alignment: .leading, spacing: 4) {
                Text(freshness)
                if let quoteTime = quote.quoteTime {
                    Text("报价时间 \(quoteTime.formatted(date: .abbreviated, time: .standard))")
                } else {
                    Text("报价时间未提供")
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private var priceLabel: some View {
        Text(DisplayFormat.money(quote.lastPrice))
            .font(.title3.weight(.semibold))
            .monospacedDigit()
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct AddSymbolView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var symbol = ""
    @FocusState private var isSymbolFocused: Bool

    private var normalizedSymbol: String {
        symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("股票代码，例如 AAPL", text: $symbol)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .keyboardType(.asciiCapable)
                        .submitLabel(.done)
                        .focused($isSymbolFocused)
                        .onSubmit(addSymbol)
                } header: {
                    Text("股票代码")
                }

                if let error = store.errorMessage {
                    Section { AppMessageView(message: error, isError: true) }
                }
            }
            .navigationTitle("添加自选")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("添加", action: addSymbol)
                        .disabled(normalizedSymbol.isEmpty || store.isBusy)
                }
            }
            .onAppear { isSymbolFocused = true }
        }
    }

    private func addSymbol() {
        let value = normalizedSymbol
        guard !value.isEmpty, !store.isBusy else { return }
        Task {
            await store.addSymbol(value)
            if store.watchlist.contains(value) { dismiss() }
        }
    }
}
