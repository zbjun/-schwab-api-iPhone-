import SwiftUI

struct InlineCancelPanel: View {
    @Environment(AppStore.self) private var store
    let symbol: String
    let onAction: (InlineTradeAction) -> Void
    let onClose: () -> Void
    @State private var review: CancelReview?
    @State private var notice: String?
    @State private var localError: String?
    @State private var isVisible = false
    @State private var isSending = false

    private struct CancelReview {
        let order: BrokerageOrder
        let context: String
        let accountDisplay: String
        let preparedAt: Date
    }

    private var context: String {
        "\(symbol)|\(store.selectedAccount?.id ?? "")|\(store.generation)|\(store.isDemo)|\(store.isAuthenticated)"
    }
    private var blocked: Bool {
        isSending || store.isBusy || store.isSubmittingOrder || store.isLoadingOrders ||
        (!store.isDemo && store.unresolvedOrderOperation)
    }
    private var candidates: [BrokerageOrder] {
        store.orders.filter {
            $0.symbol == symbol && $0.isSimpleEquity && $0.isOpen && $0.cancelable && $0.status != "PENDING_CANCEL"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(store.selectedAccount?.displayNumber ?? "尚未连接").lineLimit(1).privacySensitive()
                if store.accounts.count > 1 { AccountSelector().labelsHidden() }
                Spacer(minLength: 4)
                Text(store.isDemo ? "模拟交易" : "股票 / ETF")
                    .foregroundStyle(store.isDemo ? Color.orange : Color.secondary)
                Button(action: onClose) { Image(systemName: "xmark").frame(width: 30, height: 30) }
                    .accessibilityLabel("关闭撤单区").accessibilityIdentifier("inline.close")
            }
            .font(.caption.weight(.medium)).padding(.horizontal, 12).padding(.top, 6)
            .disabled(isSending || store.isSubmittingOrder)

            HStack(spacing: 10) {
                Picker("买卖撤", selection: Binding(get: { InlineTradeAction.cancel }, set: { action in
                    guard !blocked, action != .cancel else { return }
                    review = nil
                    onAction(action)
                })) {
                    ForEach(InlineTradeAction.allCases, id: \.self) { Text($0.title).tag($0) }
                }.pickerStyle(.segmented).accessibilityIdentifier("inline.side")
                Button {
                    review = nil
                    notice = nil
                    Task { await store.refreshOrders() }
                } label: { Label("刷新", systemImage: "arrow.clockwise") }
                    .font(.caption).accessibilityIdentifier("inline.cancel.refresh")
            }
            .padding(.horizontal, 12).padding(.vertical, 7).disabled(blocked)

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if let review {
                        cancelReview(review)
                    } else {
                        orderList
                    }
                    if let notice {
                        Text(notice).font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("inline.cancel.notice")
                    }
                    if let error = localError ?? store.tradeError ?? store.ordersError {
                        Text(error).font(.caption).foregroundStyle(.orange)
                            .accessibilityIdentifier("inline.cancel.error")
                    }
                }.padding(.horizontal, 12).padding(.vertical, 6)
            }
            .accessibilityIdentifier("inline.cancel.fields")

            if review != nil {
                Button(action: confirmCancellation) {
                    HStack(spacing: 8) {
                        if store.isSubmittingOrder { ProgressView().tint(.white) }
                        Text(store.isDemo ? "确认模拟撤单" : "确认撤销真实订单")
                            .font(.subheadline.weight(.semibold))
                    }.frame(maxWidth: .infinity).frame(minHeight: 34)
                }
                .buttonStyle(.borderedProminent).tint(MarketTheme.rise).disabled(blocked)
                .accessibilityIdentifier("inline.cancel.confirm")
                .padding(.horizontal, 12).padding(.bottom, 6)
            }
        }
        .background(MarketTheme.surface)
        .accessibilityElement(children: .contain).accessibilityIdentifier("detail.tradePanel")
        .task(id: context) {
            review = nil
            notice = nil
            localError = nil
            store.clearTradePreparation()
            await store.refreshOrders()
        }
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false; review = nil }
    }

    @ViewBuilder private var orderList: some View {
        HStack {
            Text("\(symbol) · 可撤订单").font(.subheadline.weight(.semibold))
            Spacer()
            if store.isLoadingOrders || isSending { ProgressView().controlSize(.small).accessibilityLabel(isSending ? "正在撤单" : "正在读取订单") }
            else { Text("\(candidates.count) 笔").font(.caption).foregroundStyle(.secondary) }
        }
        if candidates.isEmpty && !store.isLoadingOrders {
            Text(store.ordersError == nil ? "当前没有可撤订单" : "暂时无法确认可撤订单，请刷新。")
                .font(.subheadline).foregroundStyle(.secondary).padding(.vertical, 8)
                .accessibilityIdentifier("inline.cancel.empty")
        }
        ForEach(candidates) { order in
            Button {
                guard !blocked, store.ordersError == nil, let account = store.selectedAccount else { return }
                notice = nil
                localError = nil
                review = CancelReview(order: order, context: context, accountDisplay: account.displayNumber, preparedAt: store.now())
            } label: {
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text("\(order.side?.title ?? "委托") · \(order.kind?.title ?? "股票订单")")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        OrderStatusBadge(order: order)
                    }
                    HStack {
                        Text("待成交 \(shares(order.remainingQuantity))")
                        Spacer()
                        if let price = order.limitPrice { Text(DisplayFormat.price(price)) }
                        else if let price = order.stopPrice { Text("触发 \(DisplayFormat.price(price))") }
                    }.font(.caption).monospacedDigit()
                    HStack {
                        Text("#\(order.id)").lineLimit(1)
                        Spacer()
                        Text("撤单核对 ›").foregroundStyle(MarketTheme.rise)
                    }.font(.caption2).foregroundStyle(.secondary)
                }
                .padding(10).background(MarketTheme.elevated, in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain).disabled(blocked || store.ordersError != nil)
            .accessibilityIdentifier("inline.cancel.order.\(order.id)")
        }
        Text("当前账户最近 30 天、最多 200 笔订单中的可撤股票委托。更早的委托请在 Schwab 查看。")
            .font(.caption2).foregroundStyle(.secondary)
    }

    private func cancelReview(_ selection: CancelReview) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("撤单核对 · \(symbol)").font(.headline)
                    .accessibilityIdentifier("inline.cancel.review")
                Spacer()
                Button("保留订单") { review = nil; localError = nil }
                    .accessibilityIdentifier("inline.cancel.back").disabled(blocked)
            }
            LabeledContent("账户", value: selection.accountDisplay)
            LabeledContent("订单", value: "#\(selection.order.id)")
            LabeledContent("方向 / 类型", value: "\(selection.order.side?.title ?? "—") · \(selection.order.kind?.title ?? "—")")
            LabeledContent("待成交", value: shares(selection.order.remainingQuantity))
            if let price = selection.order.limitPrice { LabeledContent("限价", value: DisplayFormat.price(price)) }
            Text(store.isDemo ? "仅撤销这笔模拟委托，不会发送到券商。" : "撤单可能与成交同时发生，已成交部分无法撤销；最终状态以券商记录为准。")
                .foregroundStyle(.secondary)
        }.font(.caption).monospacedDigit().privacySensitive()
    }

    private func shares(_ value: Double?) -> String { value.map { DisplayFormat.quantity($0) + " 股" } ?? "—" }

    @MainActor private func confirmCancellation() {
        guard !blocked, let selection = review else { return }
        guard selection.context == context, (0...120).contains(store.now().timeIntervalSince(selection.preparedAt)) else {
            review = nil
            localError = "账户或核对已变化，请重新选择订单。"
            return
        }
        // Consume this confirmation before awaiting; the store re-reads the broker's latest state.
        isSending = true
        review = nil
        Task {
            defer { isSending = false }
            guard isVisible else { return }
            guard selection.context == context, (0...120).contains(store.now().timeIntervalSince(selection.preparedAt)) else {
                localError = "账户或核对已变化，请重新选择订单。"
                return
            }
            let canceled = await store.cancelOrder(selection.order)
            guard isVisible, selection.context == context else { return }
            if canceled { notice = store.tradeNotice }
        }
    }
}
