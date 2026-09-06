import SwiftUI

struct TradeView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        NavigationStack {
            Group {
                if store.isAuthenticated || store.isDemo {
                    TradeTicketView().id(store.tradeFormID)
                } else {
                    ConnectionRequiredView(message: "连接 Schwab 后创建股票 / ETF 订单，或先在连接页体验演示交易。")
                }
            }
            .navigationTitle(store.tradeReplacement == nil ? "交易" : "修改订单")
            .navigationBarTitleDisplayMode(.inline)
            .accessibilityIdentifier("screen.trade")
        }
    }
}

private struct TradeTicketView: View {
    @Environment(AppStore.self) private var store
    @State private var symbol = ""
    @State private var side: OrderSide = .buy
    @State private var kind: OrderKind = .limit
    @State private var quantity = ""
    @State private var limitPrice = ""
    @State private var stopPrice = ""
    @State private var duration: OrderDuration = .day
    @State private var localError: String?
    @State private var quote: StockQuote?
    @State private var quoteError: String?
    @State private var isLoadingQuote = false
    @State private var quoteRequestID = UUID()
    @State private var review: PreparedOrder?
    @State private var initialized = false
    @FocusState private var focusedField: Field?
    private enum Field: Hashable { case symbol, quantity, limit, stop }

    private var locked: Bool { store.isBusy || store.isSubmittingOrder }
    private var normalizedSymbol: String { symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }
    private var isReplacement: Bool { store.tradeReplacement != nil }
    private var needsLimit: Bool { kind == .limit || kind == .stopLimit }
    private var needsStop: Bool { kind == .stop || kind == .stopLimit }
    private var holding: Position? { store.selectedAccount?.positions.first { $0.symbol == normalizedSymbol } }
    private var estimate: Double? {
        guard let shares = Int(quantity), shares > 0 else { return nil }
        let price: Double?
        switch kind {
        case .limit, .stopLimit: price = parsedPrice(limitPrice).map { NSDecimalNumber(decimal: $0).doubleValue }
        case .market, .stop: price = quote?.lastPrice
        }
        guard let price, price.isFinite, price > 0 else { return nil }
        return Double(shares) * price
    }

    var body: some View {
        Form {
            contextSection
            securitySection
            instructionSection
            estimateSection
            if let error = localError ?? store.tradeError {
                Section { AppMessageView(message: error, isError: true).accessibilityIdentifier("trade.error") }
            }
            if let notice = store.tradeNotice {
                Section { AppMessageView(message: notice).accessibilityIdentifier("trade.notice") }
            }
            Section {
                Button(action: prepare) {
                    HStack {
                        Spacer()
                        if store.isSubmittingOrder { ProgressView().tint(.white) }
                        Text(store.isSubmittingOrder ? "正在核对账户与报价…" : (isReplacement ? "核对修改" : "核对订单"))
                            .font(.headline)
                        Spacer()
                    }.padding(.vertical, 7)
                }
                .buttonStyle(.borderedProminent)
                .disabled(locked || (!store.isDemo && store.unresolvedOrderOperation))
                .accessibilityIdentifier("trade.review")
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                .listRowBackground(Color.clear)
            } footer: {
                Text("仅常规交易时段、整股及已有持仓卖出。下一步会重新读取账户与报价，由你核对后才发送订单。")
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            if isReplacement {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("新建订单") { store.openTrade(symbol: normalizedSymbol, side: side) }
                        .disabled(locked).accessibilityIdentifier("trade.newOrder")
                }
            }
            ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("完成") { focusedField = nil } }
        }
        .onAppear(perform: initialize)
        .onChange(of: symbol) { _, _ in
            quote = nil
            quoteError = nil
            clearPreparation()
        }
        .onChange(of: side) { _, _ in clearPreparation() }
        .onChange(of: kind) { _, value in
            if value == .market { duration = .day }
            clearPreparation()
        }
        .onChange(of: quantity) { _, _ in clearPreparation() }
        .onChange(of: limitPrice) { _, _ in clearPreparation() }
        .onChange(of: stopPrice) { _, _ in clearPreparation() }
        .onChange(of: duration) { _, _ in clearPreparation() }
        .sheet(item: $review, onDismiss: { store.clearTradePreparation() }) { order in
            OrderReviewView(order: order)
        }
    }

    private var contextSection: some View {
        Section {
            if store.isDemo { DemoNotice() }
            else {
                Label("真实账户 · 股票 / ETF", systemImage: "building.columns")
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            AccountSelector()
            if let replacement = store.tradeReplacement {
                Label("替换订单 #\(replacement.id)", systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
    }

    private var securitySection: some View {
        Section("证券") {
            HStack(spacing: 12) {
                TextField("股票 / ETF 代码", text: $symbol)
                    .font(.headline).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .keyboardType(.asciiCapable).submitLabel(.search).focused($focusedField, equals: .symbol)
                    .onSubmit { focusedField = nil; Task { await refreshQuote() } }
                    .disabled(locked || isReplacement).accessibilityIdentifier("trade.symbol")
                if isLoadingQuote { ProgressView().controlSize(.small) }
                else {
                    Button("查价") { focusedField = nil; Task { await refreshQuote() } }
                        .font(.subheadline.weight(.semibold)).disabled(locked || normalizedSymbol.isEmpty)
                        .accessibilityIdentifier("trade.lookup")
                }
            }
            if let quote {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(quote.description ?? quote.symbol).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        Spacer()
                        Text(DisplayFormat.price(quote.lastPrice)).font(.headline).monospacedDigit()
                    }
                    MetricRow {
                        MetricCell(title: "买价 Bid", value: DisplayFormat.price(quote.bidPrice))
                        MetricCell(title: "卖价 Ask", value: DisplayFormat.price(quote.askPrice))
                    }
                    LabeledContent("涨跌幅") {
                        Text(DisplayFormat.signedPercent(quote.netPercentChange))
                            .font(.subheadline.weight(.semibold)).monospacedDigit()
                            .foregroundStyle(DisplayFormat.changeColor(quote.netPercentChange))
                    }
                    .font(.caption).foregroundStyle(.secondary)
                    QuoteTimeLabel(quote: quote, isDemo: store.isDemo)
                }.padding(.vertical, 3)
            }
            if let error = quoteError { AppMessageView(message: error, isError: true) }
        }
    }

    private var instructionSection: some View {
        Section {
            Picker("方向", selection: $side) {
                Text(OrderSide.buy.title).tag(OrderSide.buy)
                Text(OrderSide.sell.title).tag(OrderSide.sell)
            }
            .pickerStyle(.segmented).tint(side == .buy ? .red : .green)
            .disabled(locked || isReplacement).accessibilityIdentifier("trade.side")
            Picker("订单类型", selection: $kind) {
                ForEach([OrderKind.market, .limit, .stop, .stopLimit], id: \.self) { item in Text(item.title).tag(item) }
            }
            .disabled(locked).accessibilityIdentifier("trade.kind")
            LabeledContent("数量 · 股") {
                TextField("输入整股数量", text: $quantity)
                    .keyboardType(.numberPad).multilineTextAlignment(.trailing).monospacedDigit()
                    .focused($focusedField, equals: .quantity).disabled(locked)
                    .accessibilityIdentifier("trade.quantity")
            }
            if needsLimit {
                LabeledContent("限价 · USD") {
                    TextField("输入限价", text: $limitPrice)
                        .keyboardType(.decimalPad).multilineTextAlignment(.trailing).monospacedDigit()
                        .focused($focusedField, equals: .limit).disabled(locked)
                        .accessibilityIdentifier("trade.limitPrice")
                }
            }
            if needsStop {
                LabeledContent("触发价 · USD") {
                    TextField("输入止损触发价", text: $stopPrice)
                        .keyboardType(.decimalPad).multilineTextAlignment(.trailing).monospacedDigit()
                        .focused($focusedField, equals: .stop).disabled(locked)
                        .accessibilityIdentifier("trade.stopPrice")
                }
            }
            if kind == .market { LabeledContent("有效期", value: OrderDuration.day.title).font(.subheadline) }
            else {
                Picker("有效期", selection: $duration) {
                    Text(OrderDuration.day.title).tag(OrderDuration.day)
                    Text(OrderDuration.goodTillCancel.title).tag(OrderDuration.goodTillCancel)
                }
                .disabled(locked).accessibilityIdentifier("trade.duration")
            }
            LabeledContent("交易时段", value: "常规时段").font(.subheadline).foregroundStyle(.secondary)
        } header: { Text("订单指令") }
        footer: {
            Text(kindDescription).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var estimateSection: some View {
        Section("订单概览") {
            LabeledContent(side == .buy ? "预估买入金额" : "预估卖出金额") {
                Text(DisplayFormat.money(estimate)).font(.headline).monospacedDigit()
            }
            LabeledContent("账户购买力", value: DisplayFormat.money(store.selectedAccount?.buyingPower)).monospacedDigit()
            LabeledContent("当前持有", value: store.selectedAccount == nil ? "—" : "\(DisplayFormat.quantity(holding?.quantity ?? 0)) 股").monospacedDigit()
            if side == .sell, let count = holding?.quantity, count >= 1 {
                Button("填入全部整股持仓（\(DisplayFormat.quantity(floor(count))) 股）") {
                    quantity = String(format: "%.0f", floor(count))
                }
                .font(.subheadline).disabled(locked || isReplacement).accessibilityIdentifier("trade.sellAll")
            }
        }
        .font(.subheadline).privacySensitive()
    }

    private var kindDescription: String {
        switch kind {
        case .market: return "市价单以可获得的价格成交，最终金额可能与预估不同。"
        case .limit: return "限价单只按你的限价或更优价格成交，可能无法成交。"
        case .stop: return "达到触发价后转为市价单；触发价不等于保证成交价。"
        case .stopLimit: return "达到触发价后转为限价单；触发后仍可能无法成交。"
        }
    }

    private func initialize() {
        guard !initialized else { return }
        initialized = true
        symbol = store.tradeSymbol
        side = store.tradeSide
        if let order = store.tradeReplacement {
            symbol = order.symbol
            side = order.side ?? .buy
            kind = order.kind ?? .limit
            quantity = order.quantity.map { DisplayFormat.quantity($0).replacingOccurrences(of: ",", with: "") } ?? ""
            limitPrice = DisplayFormat.inputPrice(order.limitPrice)
            stopPrice = DisplayFormat.inputPrice(order.stopPrice)
            duration = order.duration ?? .day
        }
        Task { await refreshQuote() }
    }

    private func clearPreparation() {
        localError = nil
        store.clearTradePreparation()
    }

    private func parsedPrice(_ text: String) -> Decimal? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: "^[0-9]+(?:\\.[0-9]{1,4})?$", options: .regularExpression) != nil else { return nil }
        return Decimal(string: value, locale: DisplayFormat.locale)
    }

    private func prepare() {
        guard !locked else { return }
        focusedField = nil
        localError = nil
        store.clearTradePreparation()
        let shares = quantity.trimmingCharacters(in: .whitespacesAndNewlines)
        guard shares.range(of: "^[0-9]+$", options: .regularExpression) != nil,
              let quantityValue = Int(shares), quantityValue > 0 else {
            localError = "请输入大于 0 的整股数量。"
            return
        }
        let limit = needsLimit ? parsedPrice(limitPrice) : nil
        let stop = needsStop ? parsedPrice(stopPrice) : nil
        guard !needsLimit || (limit != nil && limit! > 0) else {
            localError = "请输入有效限价，最多 4 位小数。"
            return
        }
        guard !needsStop || (stop != nil && stop! > 0) else {
            localError = "请输入有效触发价，最多 4 位小数。"
            return
        }
        let draft = OrderDraft(symbol: normalizedSymbol, side: side, kind: kind, quantity: quantityValue,
                               limitPrice: limit, stopPrice: stop, duration: duration)
        Task {
            if await store.prepareOrder(draft), let prepared = store.preparedOrder {
                quote = prepared.quote
                review = prepared
            }
        }
    }

    @MainActor private func refreshQuote() async {
        let requestedSymbol = normalizedSymbol
        let demo = store.isDemo
        let request = UUID()
        quoteRequestID = request
        isLoadingQuote = true
        quoteError = nil
        defer { if request == quoteRequestID { isLoadingQuote = false } }
        do {
            let result = try await store.lookupQuote(requestedSymbol)
            guard request == quoteRequestID, requestedSymbol == normalizedSymbol, demo == store.isDemo, !Task.isCancelled else { return }
            quote = result
        } catch {
            guard request == quoteRequestID, requestedSymbol == normalizedSymbol, demo == store.isDemo, !Task.isCancelled else { return }
            quoteError = DisplayFormat.message(error)
        }
    }
}

private struct OrderReviewView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let order: PreparedOrder

    private var isCurrent: Bool { store.preparedOrder?.id == order.id }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(order.isDemo ? "演示订单 · 不会发送到券商" : "真实订单 · 确认后发送到 Schwab",
                          systemImage: order.isDemo ? "sparkles" : "building.columns")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(order.isDemo ? Color.orange : Color.primary)
                    HStack(alignment: .firstTextBaseline) {
                        Text(order.draft.symbol).font(.title.bold())
                        Spacer()
                        Text(order.draft.side.title).font(.headline)
                            .foregroundStyle(order.draft.side == .buy ? .red : .green)
                    }
                    LabeledContent("账户", value: order.accountDisplay).privacySensitive()
                    LabeledContent("订单类型", value: order.draft.kind.title)
                    LabeledContent("数量", value: "\(order.draft.quantity) 股").monospacedDigit()
                    if let price = order.draft.limitPrice { LabeledContent("限价", value: DisplayFormat.decimal(price)).monospacedDigit() }
                    if let price = order.draft.stopPrice { LabeledContent("触发价", value: DisplayFormat.decimal(price)).monospacedDigit() }
                    LabeledContent("有效期", value: order.draft.duration.title)
                    LabeledContent("交易时段", value: "常规时段")
                    if let id = order.replacementOrderID {
                        LabeledContent("替换原订单", value: "#\(id)").font(.caption).textSelection(.enabled)
                    }
                }
                Section("核对时的账户与报价") {
                    LabeledContent("最新价", value: DisplayFormat.price(order.quote.lastPrice)).monospacedDigit()
                    LabeledContent("预估金额") {
                        Text(DisplayFormat.money(order.estimatedValue)).font(.headline).monospacedDigit()
                    }
                    LabeledContent("购买力", value: DisplayFormat.money(order.buyingPower)).monospacedDigit()
                    LabeledContent("持仓数量", value: "\(DisplayFormat.quantity(order.availableShares)) 股").monospacedDigit()
                    QuoteTimeLabel(quote: order.quote, isDemo: order.isDemo)
                    Text("核对时间 \(order.preparedAt.formatted(date: .omitted, time: .standard))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    Text("这是本机核对信息。预估金额不含可能的费用，实际成交价格和数量以券商记录为准。收到提交回执不代表已成交。")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if let error = store.tradeError {
                    Section { AppMessageView(message: error, isError: true).accessibilityIdentifier("order.review.error") }
                }
                if !isCurrent, !store.isSubmittingOrder {
                    Section { AppMessageView(message: "核对信息已失效，请返回重新核对账户和报价。", isError: true) }
                }
            }
            .accessibilityIdentifier("screen.orderReview")
            .navigationTitle(order.replacementOrderID == nil ? "确认订单" : "确认修改")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("返回修改") { dismiss() }
                        .disabled(store.isSubmittingOrder).accessibilityIdentifier("order.review.back")
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    Task {
                        if await store.submitPreparedOrder() {
                            dismiss()
                            store.activeTab = .orders
                        }
                    }
                } label: {
                    HStack {
                        if store.isSubmittingOrder { ProgressView().tint(.white) }
                        Text(store.isSubmittingOrder ? "正在发送，请勿重复操作…" : confirmationTitle)
                            .font(.headline)
                    }.frame(maxWidth: .infinity).padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.isSubmittingOrder || !isCurrent || (!order.isDemo && store.unresolvedOrderOperation))
                .accessibilityIdentifier("order.review.confirm")
                .padding(20).background(.regularMaterial)
            }
            .interactiveDismissDisabled(store.isSubmittingOrder)
        }
    }

    private var confirmationTitle: String {
        if order.isDemo { return order.replacementOrderID == nil ? "确认模拟下单" : "确认模拟修改" }
        return order.replacementOrderID == nil ? "确认提交真实订单" : "确认修改真实订单"
    }
}
