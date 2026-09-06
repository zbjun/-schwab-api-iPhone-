import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            if store.unresolvedOrderOperation { OrderReconciliationBanner() }
            TabView(selection: $store.activeTab) {
                AccountsView()
                    .tabItem { Label("账户", systemImage: "chart.pie.fill").accessibilityIdentifier("tab.accounts") }
                    .tag(AppTab.accounts)
                WatchlistView()
                    .tabItem { Label("自选", systemImage: "star.fill").accessibilityIdentifier("tab.watchlist") }
                    .tag(AppTab.watchlist)
                TradeView()
                    .tabItem { Label("交易", systemImage: "arrow.left.arrow.right").accessibilityIdentifier("tab.trade") }
                    .tag(AppTab.trade)
                OrdersView()
                    .tabItem { Label("订单", systemImage: "list.bullet.rectangle").accessibilityIdentifier("tab.orders") }
                    .tag(AppTab.orders)
                ConnectionView()
                    .tabItem { Label("连接", systemImage: "link").accessibilityIdentifier("tab.connection") }
                    .tag(AppTab.connection)
            }
        }
        .tint(.blue)
    }
}

private struct OrderReconciliationBanner: View {
    @Environment(AppStore.self) private var store
    @State private var isConfirming = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("有一笔真实订单操作需要核对", systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
            Text(store.isDemo ? "退出演示后核对真实券商订单。" : "先检查券商订单，避免重复发送。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button(store.isDemo ? "前往连接" : "查看订单") { store.activeTab = store.isDemo ? .connection : .orders }
                    .accessibilityIdentifier("reconciliation.orders")
                Spacer()
                if !store.isDemo {
                    Button("我已核对") { isConfirming = true }
                        .accessibilityIdentifier("reconciliation.acknowledge")
                }
            }
            .font(.subheadline.weight(.medium))
            .disabled(store.isSubmittingOrder)
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(Color.orange.opacity(0.13))
        .alert("确认已核对券商订单", isPresented: $isConfirming) {
            Button("我已核对券商订单") { store.acknowledgeOrderReconciliation() }
            Button("继续核对", role: .cancel) {}
        } message: {
            Text("确认你已在 Schwab 查清上一笔操作的结果。此操作只解除本机提示，不会撤销、重试或提交任何订单。")
        }
    }
}

enum DisplayFormat {
    static let locale = Locale(identifier: "en_US")

    static func money(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return value.formatted(.currency(code: "USD").precision(.fractionLength(2)).locale(locale))
    }

    static func price(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return value.formatted(.currency(code: "USD").precision(.fractionLength(2...4)).locale(locale))
    }

    static func decimal(_ value: Decimal?) -> String {
        guard let value else { return "—" }
        return price(NSDecimalNumber(decimal: value).doubleValue)
    }

    static func inputPrice(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "" }
        return value.formatted(.number.grouping(.never).precision(.fractionLength(0...4)).locale(locale))
    }

    static func signedMoney(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return (value > 0 ? "+" : "") + money(value)
    }

    static func signedPercent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return (value > 0 ? "+" : "") + value.formatted(.number.precision(.fractionLength(2)).locale(locale)) + "%"
    }

    static func quantity(_ value: Double) -> String {
        guard value.isFinite else { return "—" }
        return value.formatted(.number.precision(.fractionLength(0...6)).locale(locale))
    }

    static func volume(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        if abs(value) >= 100_000_000 { return "\(quantity((value / 100_000_000 * 100).rounded() / 100)) 亿" }
        if abs(value) >= 10_000 { return "\(quantity((value / 10_000 * 100).rounded() / 100)) 万" }
        return quantity(value)
    }

    static func changeColor(_ value: Double?) -> Color {
        guard let value, value.isFinite, value != 0 else { return .secondary }
        return value > 0 ? .red : .green
    }

    static func accountType(_ value: String) -> String {
        switch value.uppercased() {
        case "CASH": return "现金账户"
        case "MARGIN": return "保证金账户"
        default: return value.isEmpty ? "交易账户" : value
        }
    }

    static func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "暂时无法读取，请稍后刷新。"
    }
}

struct DemoNotice: View {
    var body: some View {
        Label("演示模式 · 所有交易均为模拟", systemImage: "sparkles")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.orange)
            .accessibilityIdentifier("demo.notice")
    }
}

struct AppMessageView: View {
    let message: String
    var isError = false

    var body: some View {
        Label {
            Text(message).font(.subheadline).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: isError ? "exclamationmark.circle" : "info.circle")
                .foregroundStyle(isError ? Color.orange : Color.blue)
        }
        .accessibilityElement(children: .combine)
    }
}

struct UpdateStatusView: View {
    let lastUpdated: Date?
    let latencyMilliseconds: Double?
    let isDemo: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let lastUpdated {
                Text("更新于 \(lastUpdated.formatted(date: .abbreviated, time: .standard))")
            }
            if !isDemo, let latencyMilliseconds, latencyMilliseconds.isFinite {
                Text("直连响应 \(latencyMilliseconds.formatted(.number.precision(.fractionLength(0)))) 毫秒")
            }
        }
        .font(.caption).foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }
}

struct RefreshToolbarButton: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if store.isBusy { ProgressView().accessibilityLabel("正在更新") }
        else {
            Button { Task { await store.refresh() } } label: {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            .disabled((!store.isAuthenticated && !store.isDemo) || store.isSubmittingOrder)
            .accessibilityIdentifier("market.refresh")
        }
    }
}

struct AccountSelector: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if store.accounts.count > 1 {
            Picker("账户", selection: Binding(
                get: { store.selectedAccount?.id ?? "" },
                set: { id in Task { await store.selectAccount(id) } }
            )) {
                ForEach(store.accounts) { account in
                    Text(account.displayNumber).tag(account.id)
                }
            }
            .disabled(store.isBusy || store.isSubmittingOrder)
            .accessibilityIdentifier("account.selector")
            .privacySensitive()
        } else if let account = store.selectedAccount {
            LabeledContent("账户", value: account.displayNumber)
                .font(.subheadline).privacySensitive()
        }
    }
}

struct MetricCell: View {
    let title: String
    let value: String
    var color: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.subheadline.weight(.semibold)).monospacedDigit()
                .foregroundStyle(color).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct ConnectionRequiredView: View {
    @Environment(AppStore.self) private var store
    var message = "连接 Schwab 后，查看你的账户、行情和订单。"

    var body: some View {
        ContentUnavailableView {
            Label("连接你的账户", systemImage: "person.crop.circle.badge.checkmark")
        } description: {
            Text(message)
        } actions: {
            Button("前往连接") { store.activeTab = .connection }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("connection.open")
        }
    }
}

struct QuoteTimeLabel: View {
    let quote: StockQuote
    let isDemo: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if isDemo { Text("演示报价") }
            else {
                Text(quote.isRealtime == true ? "实时报价权限" : (quote.isRealtime == false ? "非实时报价标记" : "报价时效未确认"))
                if let time = quote.quoteTime {
                    Text("报价时间 \(time.formatted(date: .abbreviated, time: .standard))")
                } else { Text("报价时间未提供") }
            }
        }
        .font(.caption).foregroundStyle(.secondary)
    }
}
