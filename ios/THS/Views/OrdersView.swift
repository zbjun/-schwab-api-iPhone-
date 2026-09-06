import SwiftUI

struct OrdersView: View {
    @Environment(AppStore.self) private var store
    @State private var filter: OrderFilter = .all
    @State private var path: [String] = []
    private enum OrderFilter: String, CaseIterable, Identifiable {
        case all = "全部", open = "未完成", closed = "已结束"
        var id: String { rawValue }
    }
    private var requestKey: String { "\(store.selectedAccount?.id ?? "")|\(store.isDemo)|\(store.isAuthenticated)" }
    private var visibleOrders: [BrokerageOrder] {
        store.orders.filter { order in
            switch filter {
            case .all: return true
            case .open: return order.isOpen
            case .closed: return ["FILLED", "CANCELED", "REJECTED", "EXPIRED", "REPLACED"].contains(order.status)
            }
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if store.isDemo { Section { DemoNotice() } }
                if store.isAuthenticated || store.isDemo {
                    Section {
                        AccountSelector()
                        Picker("订单状态", selection: $filter) {
                            ForEach(OrderFilter.allCases) { item in Text(item.rawValue).tag(item) }
                        }
                        .pickerStyle(.segmented).accessibilityIdentifier("orders.filter")
                    }
                    if let notice = store.tradeNotice {
                        Section { AppMessageView(message: notice).accessibilityIdentifier("orders.notice") }
                    }
                    if let error = store.ordersError {
                        Section { AppMessageView(message: error, isError: true).accessibilityIdentifier("orders.error") }
                    }
                    ordersSection
                } else {
                    Section { ConnectionRequiredView(message: "连接后查看最近 30 天的订单和券商回执。") }
                        .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("订单")
            .navigationDestination(for: String.self) { OrderDetailView(orderID: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if store.isLoadingOrders { ProgressView().accessibilityLabel("正在读取订单") }
                    else {
                        Button { Task { await store.refreshOrders() } } label: { Label("刷新", systemImage: "arrow.clockwise") }
                            .disabled((!store.isAuthenticated && !store.isDemo) || store.isSubmittingOrder || store.isBusy)
                            .accessibilityIdentifier("orders.refresh")
                    }
                }
            }
            .task(id: requestKey) {
                path = []
                await store.refreshOrders()
            }
            .refreshable { if !store.isSubmittingOrder { await store.refreshOrders() } }
            .accessibilityIdentifier("screen.orders")
        }
    }

    private var ordersSection: some View {
        Section {
            if store.isLoadingOrders, store.orders.isEmpty {
                HStack(spacing: 12) { ProgressView(); Text("正在读取订单…").foregroundStyle(.secondary) }
            } else if visibleOrders.isEmpty {
                ContentUnavailableView {
                    Label(filter == .all ? "暂无订单" : "没有\(filter.rawValue)订单", systemImage: "list.bullet.rectangle")
                } description: { Text("这里显示当前账户最近 30 天的订单。") }
                actions: {
                    Button("创建股票订单") { store.openTrade(symbol: store.tradeSymbol, side: .buy) }
                        .buttonStyle(.bordered).disabled(store.isBusy || store.isSubmittingOrder)
                }
            } else {
                ForEach(visibleOrders) { order in
                    NavigationLink(value: order.id) { OrderRow(order: order) }
                        .accessibilityIdentifier("order.row.\(order.id)")
                }
            }
        } header: { Text("最近 30 天 · \(visibleOrders.count) 笔") }
        footer: {
            VStack(alignment: .leading, spacing: 5) {
                if let time = store.ordersUpdatedAt {
                    Text("更新于 \(time.formatted(date: .abbreviated, time: .standard))")
                }
                Text("提交、撤单或修改的回执不代表最终状态。下拉刷新，以券商订单记录为准。")
            }
        }
    }
}

private struct OrderRow: View {
    let order: BrokerageOrder
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(order.symbol.isEmpty ? "多证券订单" : order.symbol).font(.headline)
                    if let side = order.side {
                        Text(side.title).font(.caption.weight(.semibold))
                            .foregroundStyle(side == .buy ? .red : .green)
                    }
                }
                Text("\(order.kind?.title ?? "其他订单") · \(order.quantity.map(DisplayFormat.quantity) ?? "—") 股")
                    .font(.caption).foregroundStyle(.secondary)
                if let time = order.enteredAt {
                    Text(time.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(.tertiary)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: typeSize.isAccessibilitySize ? .leading : .trailing, spacing: 6) {
                OrderStatusBadge(order: order)
                if let price = order.limitPrice { Text(DisplayFormat.price(price)).font(.subheadline.weight(.medium)) }
                else if let price = order.stopPrice { Text("触发 \(DisplayFormat.price(price))").font(.caption) }
                if let filled = order.filledQuantity {
                    Text("已成 \(DisplayFormat.quantity(filled)) 股").font(.caption).foregroundStyle(.secondary)
                }
            }.monospacedDigit()
        }
        .padding(.vertical, 6).accessibilityElement(children: .combine)
    }
}

struct OrderStatusBadge: View {
    let order: BrokerageOrder
    private var color: Color {
        if order.status == "REJECTED" { return .red }
        if order.status == "FILLED" { return .blue }
        return order.isOpen ? .orange : .secondary
    }

    var body: some View {
        Text(order.statusTitle).font(.caption.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 6))
    }
}

private struct OrderDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let orderID: String
    @State private var order: BrokerageOrder?
    @State private var error: String?
    @State private var isLoading = false
    @State private var isConfirmingCancel = false
    @State private var requestID = UUID()

    private var sessionKey: String { "\(orderID)|\(store.selectedAccount?.id ?? "")|\(store.isDemo)|\(store.isAuthenticated)" }
    private var blocked: Bool { isLoading || store.isSubmittingOrder || store.isBusy || (!store.isDemo && store.unresolvedOrderOperation) }

    var body: some View {
        List {
            if store.isDemo { Section { DemoNotice() } }
            if let error { Section { AppMessageView(message: error, isError: true) } }
            if let notice = store.tradeNotice {
                Section { AppMessageView(message: notice).accessibilityIdentifier("order.detail.notice") }
            }
            if let order { orderSections(order) }
            else if isLoading {
                Section { HStack(spacing: 12) { ProgressView(); Text("正在读取订单详情…").foregroundStyle(.secondary) } }
            } else {
                Section {
                    ContentUnavailableView("暂无订单详情", systemImage: "doc.text.magnifyingglass", description: Text("下拉重新读取券商记录。"))
                }.listRowBackground(Color.clear)
            }
            if let tradeError = store.tradeError {
                Section { AppMessageView(message: tradeError, isError: true) }
            }
        }
        .navigationTitle("订单详情").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if isLoading { ProgressView() }
                else {
                    Button { Task { await load() } } label: { Label("刷新", systemImage: "arrow.clockwise") }
                        .disabled(store.isSubmittingOrder || store.isBusy).accessibilityIdentifier("order.detail.refresh")
                }
            }
        }
        .task(id: sessionKey) { await load() }
        .refreshable { if !store.isSubmittingOrder { await load() } }
        .confirmationDialog("确认撤销这笔订单？", isPresented: $isConfirmingCancel, titleVisibility: .visible) {
            Button(store.isDemo ? "确认模拟撤单" : "确认撤销真实订单", role: .destructive) {
                guard let order else { return }
                Task { if await store.cancelOrder(order) { await load() } }
            }
            .accessibilityIdentifier("order.cancel.confirm")
            Button("保留订单", role: .cancel) {}
        } message: {
            Text("\(order?.symbol ?? "") · 订单 #\(orderID)。撤单请求可能与成交同时发生，发送后请刷新确认最终状态。")
        }
        .accessibilityIdentifier("screen.orderDetail")
    }

    @ViewBuilder private func orderSections(_ order: BrokerageOrder) -> some View {
        Section {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text(order.symbol.isEmpty ? "多证券订单" : order.symbol).font(.title2.bold())
                    Text("\(order.side?.title ?? "其他方向") · \(order.kind?.title ?? "其他订单")")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                OrderStatusBadge(order: order).accessibilityIdentifier("order.detail.status")
            }.padding(.vertical, 6)
            LabeledContent("订单编号", value: order.id).font(.caption).textSelection(.enabled)
            LabeledContent("状态代码", value: order.status).font(.caption).foregroundStyle(.secondary)
        }
        Section("订单内容") {
            LabeledContent("委托数量", value: shareText(order.quantity))
            LabeledContent("已成交", value: shareText(order.filledQuantity))
            LabeledContent("剩余数量", value: shareText(order.remainingQuantity))
            if order.limitPrice != nil {
                LabeledContent("限价", value: DisplayFormat.price(order.limitPrice))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("限价")
                    .accessibilityValue(DisplayFormat.price(order.limitPrice))
                    .accessibilityIdentifier("order.detail.limitPrice")
            }
            if order.stopPrice != nil { LabeledContent("触发价", value: DisplayFormat.price(order.stopPrice)) }
            LabeledContent("有效期", value: order.duration?.title ?? "—")
            if let time = order.enteredAt {
                LabeledContent("提交时间", value: time.formatted(date: .abbreviated, time: .standard))
            }
            if let time = order.closedAt {
                LabeledContent("结束时间", value: time.formatted(date: .abbreviated, time: .standard))
            }
        }.font(.subheadline).monospacedDigit()
        Section {
            if order.isSimpleEquity, order.isOpen, order.editable, order.filledQuantity == 0 {
                Button {
                    store.beginReplacement(order)
                    dismiss()
                } label: { Label("修改订单", systemImage: "pencil") }
                .disabled(blocked).accessibilityIdentifier("order.modify")
            }
            if order.isSimpleEquity, order.isOpen, order.cancelable {
                Button(role: .destructive) { isConfirmingCancel = true } label: {
                    Label(store.isSubmittingOrder ? "正在发送…" : "撤销订单", systemImage: "xmark.circle")
                }
                .disabled(blocked).accessibilityIdentifier("order.cancel")
            }
            if !order.isSimpleEquity {
                AppMessageView(message: "这不是可在本机修改的简单股票订单。请前往 Schwab 管理此订单。")
            } else if !order.isOpen || (!order.cancelable && !order.editable) {
                Text("当前券商状态未允许撤单或修改。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
        } footer: {
            Text("可撤改操作以本次读取的券商标记为准。已部分成交的订单不提供本机修改。")
        }
    }

    private func shareText(_ value: Double?) -> String { value.map { "\(DisplayFormat.quantity($0)) 股" } ?? "—" }

    @MainActor private func load() async {
        let key = sessionKey
        let request = UUID()
        requestID = request
        isLoading = true
        error = nil
        defer { if request == requestID { isLoading = false } }
        do {
            let result = try await store.orderDetail(orderID)
            guard !Task.isCancelled, key == sessionKey, request == requestID else { return }
            order = result
        } catch {
            guard !Task.isCancelled, key == sessionKey, request == requestID else { return }
            order = nil
            self.error = DisplayFormat.message(error)
        }
    }
}
