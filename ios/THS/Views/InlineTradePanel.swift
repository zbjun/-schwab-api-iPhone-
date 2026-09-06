import SwiftUI

struct InlineTradePanel: View {
    @Environment(AppStore.self) private var store
    let symbol: String
    let initialSide: OrderSide
    let quote: StockQuote?
    let onClose: () -> Void
    @State private var side: OrderSide = .buy
    @State private var kind: OrderKind = .limit
    @State private var duration: OrderDuration = .day
    @State private var quantity = ""
    @State private var amount = ""
    @State private var limitPrice = ""
    @State private var stopPrice = ""
    @State private var amountMode = false
    @State private var initialized = false
    @State private var isVisible = false
    @State private var localError: String?
    @State private var review: PreparedOrder?
    @FocusState private var input: Field?
    private enum Field: Hashable { case price, stop, quantity, amount }

    private var locked: Bool { store.isBusy || store.isSubmittingOrder }
    private var color: Color { side == .buy ? .red : .green }
    private var needsLimit: Bool { kind == .limit || kind == .stopLimit }
    private var needsStop: Bool { kind == .stop || kind == .stopLimit }
    private var chosenPrice: Decimal? {
        needsLimit ? OrderSizing.price(limitPrice) : OrderSizing.decimal(quote?.askPrice ?? quote?.lastPrice)
    }
    private var maxBuy: Int? { OrderSizing.maximumBuy(account: store.selectedAccount, price: chosenPrice) }
    private var maxSell: Int? {
        OrderSizing.maximumSell(account: store.selectedAccount, symbol: symbol, orders: store.orders,
                                ordersLoaded: store.ordersUpdatedAt != nil && store.ordersError == nil)
    }
    private var enteredShares: Int? {
        OrderSizing.quantity(text: quantity, budget: amount, amountMode: amountMode && side == .buy, limitPrice: limitPrice)
    }
    private var context: String { "\(symbol)|\(store.selectedAccount?.id ?? "")|\(store.isDemo)|\(store.isAuthenticated)" }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if review != nil {
                    Button("返回修改") { review = nil; store.clearTradePreparation() }
                        .accessibilityIdentifier("inline.review.back")
                } else {
                    Text(store.selectedAccount?.displayNumber ?? "尚未连接").lineLimit(1).privacySensitive()
                    if store.accounts.count > 1 { AccountSelector().labelsHidden() }
                }
                Spacer(minLength: 4)
                Text(store.isDemo ? "模拟交易" : "股票 / ETF").foregroundStyle(store.isDemo ? Color.orange : Color.secondary)
                Button {
                    input = nil
                    store.clearTradePreparation()
                    onClose()
                } label: { Image(systemName: "xmark").frame(width: 30, height: 30) }
                    .accessibilityLabel("关闭买卖区").accessibilityIdentifier("inline.close")
            }
            .font(.caption.weight(.medium)).padding(.horizontal, 12).padding(.top, 6)
            .disabled(store.isSubmittingOrder)

            ScrollView {
                VStack(alignment: .leading, spacing: 9) {
                    if let review { reviewContent(review) }
                    else { editor }
                    if let error = localError ?? store.tradeError {
                        Text(error).font(.caption).foregroundStyle(.orange)
                            .accessibilityIdentifier("inline.error")
                    }
                }.padding(.horizontal, 12).padding(.vertical, 7)
            }
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("inline.fields")

            Button(action: review == nil ? prepare : submit) {
                HStack(spacing: 8) {
                    if store.isSubmittingOrder { ProgressView().tint(.white) }
                    Text(actionTitle).font(.subheadline.weight(.semibold))
                }.frame(maxWidth: .infinity).frame(minHeight: 34)
            }
            .buttonStyle(.borderedProminent).tint(color)
            .disabled(locked || (!store.isDemo && store.unresolvedOrderOperation) || (review != nil && store.preparedOrder?.id != review?.id))
            .accessibilityIdentifier(review == nil ? "inline.review" : "inline.confirm")
            .padding(.horizontal, 12).padding(.bottom, 6)
        }
        .background(Color(red: 0.075, green: 0.08, blue: 0.095))
        .accessibilityElement(children: .contain).accessibilityIdentifier("detail.tradePanel")
        .task(id: context) {
            if !initialized {
                initialized = true
                side = initialSide
                limitPrice = DisplayFormat.inputPrice(quote?.askPrice ?? quote?.lastPrice)
                store.beginInlineTrade(symbol: symbol, side: side)
            }
            review = nil
            store.clearTradePreparation()
            await store.refresh()
            await store.refreshOrders()
        }
        .onChange(of: quantity) { _, _ in invalidate() }
        .onChange(of: amount) { _, _ in invalidate() }
        .onChange(of: limitPrice) { _, _ in invalidate() }
        .onChange(of: stopPrice) { _, _ in invalidate() }
        .onChange(of: duration) { _, _ in invalidate() }
        .onChange(of: side) { _, newSide in
            if newSide == .sell { amountMode = false }
            invalidate()
        }
        .onChange(of: initialSide) { _, value in side = value }
        .onChange(of: kind) { _, value in
            if value == .market { duration = .day }
            if value != .limit { amountMode = false }
            invalidate()
        }
        .onChange(of: amountMode) { _, enabled in
            if enabled { kind = .limit }
            invalidate()
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("完成") { input = nil }.accessibilityIdentifier("inline.keyboard.done")
            }
        }
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false; store.clearTradePreparation() }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 10) {
                Picker("方向", selection: $side) {
                    Text("买入").tag(OrderSide.buy)
                    Text("卖出").tag(OrderSide.sell)
                }.pickerStyle(.segmented).accessibilityIdentifier("inline.side")
                Picker("类型", selection: $kind) {
                    ForEach([OrderKind.market, .limit, .stop, .stopLimit], id: \.self) { Text($0.title).tag($0) }
                }.labelsHidden().tint(color).accessibilityIdentifier("inline.kind")
            }
            HStack(alignment: .top, spacing: 12) {
                if needsLimit {
                    priceInput("限价 · USD", text: $limitPrice, field: .price, id: "inline.limitPrice")
                } else {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("参考价 · USD").font(.caption).foregroundStyle(.secondary)
                        Text(DisplayFormat.price(quote?.lastPrice)).font(.headline).monospacedDigit()
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(amountMode ? "买入金额 · USD" : "数量 · 股").font(.caption).foregroundStyle(.secondary)
                    TextField(amountMode ? "输入金额" : "整股数量", text: amountMode ? $amount : $quantity)
                        .keyboardType(amountMode ? .decimalPad : .numberPad).focused($input, equals: amountMode ? .amount : .quantity)
                        .font(.headline).monospacedDigit().padding(.horizontal, 10).frame(height: 34)
                        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 5))
                        .accessibilityIdentifier(amountMode ? "inline.amount" : "inline.quantity")
                }.frame(maxWidth: .infinity)
            }
            if needsStop { priceInput("触发价 · USD", text: $stopPrice, field: .stop, id: "inline.stopPrice") }
            HStack(spacing: 8) {
                Text("可买预估 \(count(maxBuy))").accessibilityIdentifier("inline.maxBuy")
                Text("可卖预估 \(count(maxSell))").accessibilityIdentifier("inline.maxSell")
                Spacer(minLength: 0)
                Button("最大") { fillMaximum() }.tint(color).disabled((side == .buy ? maxBuy : maxSell) == nil)
                    .accessibilityIdentifier("inline.maximum")
            }.font(.caption).monospacedDigit()
            HStack {
                if side == .buy {
                    Button(amountMode ? "改为按股数" : "按金额买入") { amountMode.toggle() }
                        .font(.caption.weight(.semibold)).tint(color).accessibilityIdentifier("inline.amountMode")
                }
                Spacer()
                Picker("有效期", selection: $duration) {
                    Text("当日有效").tag(OrderDuration.day)
                    if kind != .market { Text("撤销前有效").tag(OrderDuration.goodTillCancel) }
                }.labelsHidden().font(.caption).tint(.secondary).accessibilityIdentifier("inline.duration")
            }
            if amountMode {
                Text("按限价换算 \(enteredShares.map(String.init) ?? "—") 整股，预算不含费用。")
                    .font(.caption2).foregroundStyle(.secondary).accessibilityIdentifier("inline.amountShares")
            }
            Text("按当前购买力、持仓与已读取委托估算，实际可交易数量以券商为准。")
                .font(.caption2).foregroundStyle(.secondary)
        }.disabled(locked)
    }

    private func priceInput(_ title: String, text: Binding<String>, field: Field, id: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextField("输入价格", text: text).keyboardType(.decimalPad).focused($input, equals: field)
                .font(.headline).monospacedDigit().padding(.horizontal, 10).frame(height: 34)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 5))
                .accessibilityIdentifier(id)
        }.frame(maxWidth: .infinity)
    }

    private func reviewContent(_ order: PreparedOrder) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(order.draft.side.title) \(symbol) · \(order.draft.quantity) 股").font(.headline).foregroundStyle(color)
                .accessibilityIdentifier("inline.review.summary")
            LabeledContent("账户", value: order.accountDisplay)
            LabeledContent("类型", value: order.draft.kind.title)
            if let price = order.draft.limitPrice { LabeledContent("限价", value: DisplayFormat.decimal(price)) }
            if let price = order.draft.stopPrice { LabeledContent("触发价", value: DisplayFormat.decimal(price)) }
            LabeledContent("有效期", value: order.draft.duration.title)
            LabeledContent("预估金额", value: DisplayFormat.money(order.estimatedValue))
            Text(order.isDemo ? "模拟订单，不会发送到券商。" : "确认后发送真实订单；这是本机核对，回执不代表成交。")
                .font(.caption).foregroundStyle(.secondary)
            if store.preparedOrder?.id != order.id { Text("核对已失效，请返回修改。").foregroundStyle(.orange) }
        }.font(.caption).monospacedDigit()
    }

    private var actionTitle: String {
        if store.isSubmittingOrder { return "正在处理…" }
        if review == nil { return "核对\(side.title)" }
        return store.isDemo ? "确认模拟下单" : "确认提交真实订单"
    }
    private func count(_ value: Int?) -> String { value.map { "\($0) 股" } ?? "—" }
    private func invalidate() { localError = nil; review = nil; store.clearTradePreparation() }
    private func fillMaximum() {
        input = nil
        if amountMode { amount = store.selectedAccount?.buyingPower.map { String($0) } ?? "" }
        else { quantity = (side == .buy ? maxBuy : maxSell).map(String.init) ?? "" }
    }
    private func prepare() {
        guard !locked else { return }
        input = nil
        localError = nil
        guard let shares = enteredShares, shares > 0 else { localError = amountMode ? "金额不足一股或价格无效。" : "请输入大于 0 的整股数量。"; return }
        let limit = needsLimit ? OrderSizing.price(limitPrice) : nil
        let stop = needsStop ? OrderSizing.price(stopPrice) : nil
        guard !needsLimit || limit != nil, !needsStop || stop != nil else { localError = "请输入有效价格，最多 4 位小数。"; return }
        let draft = OrderDraft(symbol: symbol, side: side, kind: kind, quantity: shares,
                               limitPrice: limit, stopPrice: stop, duration: duration)
        Task {
            let prepared = await store.prepareOrder(draft)
            guard isVisible else { store.clearTradePreparation(); return }
            if prepared { review = store.preparedOrder }
        }
    }
    private func submit() {
        guard !locked, let review, review.id == store.preparedOrder?.id else { return }
        Task { if await store.submitPreparedOrder() { onClose() } }
    }
}
