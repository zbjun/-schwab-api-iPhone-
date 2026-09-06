import SwiftUI

struct AccountsView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        NavigationStack {
            List {
                if store.isDemo { Section { DemoNotice() } }
                if let error = store.errorMessage {
                    Section { AppMessageView(message: error, isError: true) }
                }
                if store.isAuthenticated || store.isDemo { accountContent }
                else {
                    Section { ConnectionRequiredView() }.listRowBackground(Color.clear)
                }
            }
            .navigationTitle("账户")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { RefreshToolbarButton() } }
            .refreshable {
                if !store.isSubmittingOrder { await store.refresh() }
            }
            .navigationDestination(for: String.self) { StockDetailView(symbol: $0) }
            .accessibilityIdentifier("screen.accounts")
        }
    }

    @ViewBuilder private var accountContent: some View {
        if let account = store.selectedAccount {
            Section {
                AccountSelector()
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("账户净值").font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                        Text("USD").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    Text(DisplayFormat.money(account.liquidationValue))
                        .font(.system(.largeTitle, design: .rounded, weight: .semibold))
                        .monospacedDigit().lineLimit(1).minimumScaleFactor(0.55)
                        .accessibilityIdentifier("account.netValue")
                    HStack(spacing: 16) {
                        MetricCell(title: "现金余额", value: DisplayFormat.money(account.cashBalance))
                        MetricCell(title: "购买力", value: DisplayFormat.money(account.buyingPower))
                    }
                    HStack {
                        Label(DisplayFormat.accountType(account.accountType), systemImage: "building.columns")
                        Spacer()
                        Text("\(account.positions.count) 项持仓")
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 8).privacySensitive()
            } footer: {
                UpdateStatusView(lastUpdated: store.accountsUpdatedAt,
                                 latencyMilliseconds: store.accountsLatencyMilliseconds, isDemo: store.isDemo)
            }

            Section {
                if account.positions.isEmpty {
                    ContentUnavailableView("暂无持仓", systemImage: "tray", description: Text("成交后的持仓会显示在这里。"))
                } else {
                    ForEach(account.positions) { position in
                        if position.assetType.uppercased() == "EQUITY" {
                            NavigationLink(value: position.symbol) { PositionRow(position: position) }
                                .accessibilityIdentifier("position.\(position.symbol)")
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    if position.quantity >= 1 {
                                        Button("卖出") { store.openTrade(symbol: position.symbol, side: .sell) }
                                            .tint(.green).disabled(store.isBusy || store.isSubmittingOrder)
                                    }
                                }
                        } else { PositionRow(position: position) }
                    }
                }
            } header: {
                HStack { Text("持仓"); Spacer(); Text("市值 / 当日盈亏") }
            }
            Section {
                Button {
                    store.openTrade(symbol: store.tradeSymbol, side: .buy)
                } label: { Label("股票 / ETF 交易", systemImage: "arrow.left.arrow.right") }
                .disabled(store.isBusy || store.isSubmittingOrder)
                .accessibilityIdentifier("account.trade")
            }
        } else if store.isBusy {
            Section { HStack(spacing: 12) { ProgressView(); Text("正在读取账户…").foregroundStyle(.secondary) } }
        } else {
            Section {
                ContentUnavailableView("暂无账户数据", systemImage: "tray", description: Text("下拉刷新以读取已授权的账户。"))
            }.listRowBackground(Color.clear)
        }
    }
}

private struct PositionRow: View {
    let position: Position
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            VStack(alignment: .leading, spacing: 5) {
                Text(position.symbol).font(.headline)
                Text("\(DisplayFormat.quantity(position.quantity)) 股 · 成本 \(DisplayFormat.price(position.averagePrice))")
                    .font(.caption).foregroundStyle(.secondary)
                if !position.description.isEmpty {
                    Text(position.description).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: typeSize.isAccessibilitySize ? .leading : .trailing, spacing: 5) {
                Text(DisplayFormat.money(position.marketValue)).font(.subheadline.weight(.semibold))
                Text(DisplayFormat.signedMoney(position.dayProfitLoss))
                    .font(.subheadline).foregroundStyle(DisplayFormat.changeColor(position.dayProfitLoss))
                if position.dayProfitLossPercent != nil {
                    Text(DisplayFormat.signedPercent(position.dayProfitLossPercent))
                        .font(.caption).foregroundStyle(DisplayFormat.changeColor(position.dayProfitLossPercent))
                }
            }
        }
        .monospacedDigit().padding(.vertical, 6).privacySensitive()
        .accessibilityElement(children: .combine)
    }
}
