import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store
    @State private var selectedTab: AppTab = .accounts

    private enum AppTab: Hashable {
        case accounts
        case watchlist
        case connection
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            AccountsView(onConnect: { selectedTab = .connection })
                .tabItem { Label("账户", systemImage: "chart.pie") }
                .tag(AppTab.accounts)

            WatchlistView(onConnect: { selectedTab = .connection })
                .tabItem { Label("自选", systemImage: "star") }
                .tag(AppTab.watchlist)

            ConnectionView()
                .tabItem { Label("连接", systemImage: "link") }
                .tag(AppTab.connection)
        }
    }
}

enum DisplayFormat {
    static func money(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return value.formatted(
            .currency(code: "USD")
                .precision(.fractionLength(2))
                .locale(Locale(identifier: "en_US"))
        )
    }

    static func signedMoney(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return (value > 0 ? "+" : "") + money(value)
    }

    static func signedPercent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        let number = value.formatted(
            .number.precision(.fractionLength(2)).locale(Locale(identifier: "en_US"))
        )
        return (value > 0 ? "+" : "") + number + "%"
    }

    static func quantity(_ value: Double) -> String {
        guard value.isFinite else { return "—" }
        return value.formatted(
            .number.precision(.fractionLength(0...6)).locale(Locale(identifier: "en_US"))
        )
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
}

struct DemoNotice: View {
    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text("演示数据").font(.headline)
                Text("这里显示的是示例账户和行情。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: "sparkles").foregroundStyle(.orange)
        }
        .accessibilityElement(children: .combine)
    }
}

struct AppMessageView: View {
    let message: String
    var isError = false

    var body: some View {
        Label {
            Text(message).font(.subheadline)
        } icon: {
            Image(systemName: isError ? "exclamationmark.circle" : "info.circle")
                .foregroundStyle(isError ? Color.orange : Color.secondary)
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
                Text("最近更新 \(lastUpdated.formatted(date: .abbreviated, time: .standard))")
            }
            if !isDemo, let latencyMilliseconds, latencyMilliseconds.isFinite {
                Text("响应耗时 \(latencyMilliseconds.formatted(.number.precision(.fractionLength(0)))) 毫秒")
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }
}

struct RefreshToolbarButton: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if store.isBusy {
            ProgressView().accessibilityLabel("正在更新")
        } else {
            Button {
                Task { await store.refresh() }
            } label: {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            .disabled(!store.isAuthenticated && !store.isDemo)
        }
    }
}
