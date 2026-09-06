import SwiftUI

struct AccountsView: View {
    @Environment(AppStore.self) private var store
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

                if store.isAuthenticated || store.isDemo {
                    accountContent
                } else {
                    Section {
                        ContentUnavailableView {
                            Label("连接你的账户", systemImage: "person.crop.circle.badge.checkmark")
                        } description: {
                            Text("连接 Schwab 后，在这里查看余额和持仓。")
                        } actions: {
                            Button("前往连接", action: onConnect)
                                .buttonStyle(.borderedProminent)
                        }
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("账户")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { RefreshToolbarButton() }
            }
            .refreshable {
                if store.isAuthenticated || store.isDemo { await store.refresh() }
            }
        }
    }

    @ViewBuilder
    private var accountContent: some View {
        if let account = store.selectedAccount {
            Section {
                if store.accounts.count > 1 {
                    Picker("当前账户", selection: Binding(
                        get: { store.selectedAccountID },
                        set: { store.selectedAccountID = $0 }
                    )) {
                        ForEach(store.accounts) { option in
                            Text(option.displayNumber).tag(Optional(option.id))
                        }
                    }
                    .privacySensitive()
                } else {
                    LabeledContent("当前账户", value: account.displayNumber)
                        .privacySensitive()
                }
                LabeledContent("账户类型", value: DisplayFormat.accountType(account.accountType))
            }

            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("账户净值 · USD")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(DisplayFormat.money(account.liquidationValue))
                        .font(.largeTitle.weight(.semibold))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                .padding(.vertical, 6)
                .privacySensitive()

                LabeledContent("现金余额", value: DisplayFormat.money(account.cashBalance))
                    .monospacedDigit()
                    .privacySensitive()
                LabeledContent("购买力", value: DisplayFormat.money(account.buyingPower))
                    .monospacedDigit()
                    .privacySensitive()
            } footer: {
                UpdateStatusView(
                    lastUpdated: store.accountsUpdatedAt,
                    latencyMilliseconds: store.accountsLatencyMilliseconds,
                    isDemo: store.isDemo
                )
            }

            Section("持仓") {
                if account.positions.isEmpty {
                    ContentUnavailableView(
                        "暂无持仓",
                        systemImage: "tray",
                        description: Text("当前账户没有可显示的持仓。")
                    )
                } else {
                    ForEach(account.positions) { position in
                        PositionRow(position: position)
                    }
                }
            }
        } else if store.isBusy {
            Section {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("正在读取账户…").foregroundStyle(.secondary)
                }
            }
        } else {
            Section {
                ContentUnavailableView(
                    "暂无账户数据",
                    systemImage: "tray",
                    description: Text("下拉刷新以重新读取已授权的账户。")
                )
            }
            .listRowBackground(Color.clear)
        }
    }
}

private struct PositionRow: View {
    let position: Position

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(position.symbol).font(.headline)
                if !position.description.isEmpty {
                    Text(position.description)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            LabeledContent("数量", value: DisplayFormat.quantity(position.quantity))
            LabeledContent("市值", value: DisplayFormat.money(position.marketValue))
            LabeledContent("当日盈亏") {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(DisplayFormat.signedMoney(position.dayProfitLoss))
                        .foregroundStyle(DisplayFormat.changeColor(position.dayProfitLoss))
                    if position.dayProfitLossPercent != nil {
                        Text(DisplayFormat.signedPercent(position.dayProfitLossPercent))
                            .foregroundStyle(DisplayFormat.changeColor(position.dayProfitLossPercent))
                    }
                }
            }
        }
        .font(.subheadline)
        .monospacedDigit()
        .padding(.vertical, 6)
        .privacySensitive()
        .accessibilityElement(children: .combine)
    }
}
