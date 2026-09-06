import Foundation
import Observation

@MainActor
@Observable
final class AppStore {
    var accounts: [BrokerageAccount] = []
    var quotes: [StockQuote] = []
    var selectedAccountID: String?
    var isAuthenticated = false
    var isConfigured = false
    var isBusy = false
    var errorMessage: String?
    var statusMessage: String?
    var accountsUpdatedAt: Date?
    var quotesUpdatedAt: Date?
    var accountsLatencyMilliseconds: Double?
    var quotesLatencyMilliseconds: Double?
    var watchlist: [String]
    var isDemo = false

    @ObservationIgnored private let client: SchwabClient
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var hasLoaded = false
    private static let watchlistKey = "ths.watchlist.v1"

    init(client: SchwabClient = SchwabClient(), defaults: UserDefaults = .standard) {
        self.client = client
        self.defaults = defaults
        let saved = defaults.stringArray(forKey: Self.watchlistKey) ?? ["AAPL", "MSFT", "SPY"]
        var unique: [String] = []
        for symbol in saved where Self.validSymbol(symbol) && !unique.contains(symbol) {
            if unique.count < 12 { unique.append(symbol) }
        }
        watchlist = unique
    }

    var selectedAccount: BrokerageAccount? {
        accounts.first { $0.id == selectedAccountID } ?? accounts.first
    }

    func load() async {
        guard !hasLoaded else { return }
        hasLoaded = true
        do {
            let status = try await client.sessionStatus()
            isConfigured = status.configured
            isAuthenticated = status.authenticated
            if isAuthenticated { await refresh() }
        } catch { errorMessage = Self.message(for: error) }
    }

    func saveCredentials(clientID: String, clientSecret: String) async -> Bool {
        guard !isBusy else { return false }
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        do {
            try await client.saveCredentials(clientID: clientID, clientSecret: clientSecret)
            generation += 1
            let status = try await client.sessionStatus()
            isConfigured = status.configured
            isAuthenticated = status.authenticated
            isDemo = false
            clearFinancialData()
            statusMessage = "凭据已保存在这台 iPhone，接下来登录 Schwab。"
            if isAuthenticated {
                statusMessage = "已保存的凭据仍有有效账户授权。"
                isBusy = false
                await refresh()
            }
            return true
        } catch {
            errorMessage = Self.message(for: error)
            return false
        }
    }

    func beginAuthorization() async -> URL? {
        guard !isBusy else { return nil }
        isBusy = true
        defer { isBusy = false }
        errorMessage = nil
        do {
            let url = try await client.beginAuthorization()
            statusMessage = "完成 Safari 授权后，把最终回调链接粘贴回来。"
            return url
        } catch {
            errorMessage = Self.message(for: error)
            return nil
        }
    }

    func completeAuthorization(callbackURL: String) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        do {
            try await client.completeAuthorization(callbackURL: callbackURL)
            generation += 1
            isAuthenticated = true
            isConfigured = true
            isDemo = false
            clearFinancialData()
            statusMessage = "已连接 Schwab。"
            isBusy = false
            await refresh()
        } catch {
            if let status = try? await client.sessionStatus() {
                isConfigured = status.configured
                isAuthenticated = status.authenticated
                if !status.authenticated {
                    clearFinancialData()
                    statusMessage = nil
                }
            }
            isBusy = false
            errorMessage = Self.message(for: error)
        }
    }

    func refresh() async {
        guard !isBusy else { return }
        if isDemo {
            loadDemo()
            return
        }
        guard isAuthenticated else { return }
        isBusy = true
        errorMessage = nil
        let currentGeneration = generation
        let service = client
        let symbols = watchlist
        async let accountResult = Self.capture { try await service.fetchAccounts() }
        async let quoteResult = Self.capture {
            if symbols.isEmpty { return APIResponse<[StockQuote]>(value: [], elapsedMilliseconds: 0) }
            return try await service.fetchQuotes(symbols: symbols)
        }
        let (accountResponse, quoteResponse) = await (accountResult, quoteResult)
        guard generation == currentGeneration, !isDemo else { return }
        defer { if generation == currentGeneration { isBusy = false } }
        var messages: [String] = []

        switch accountResponse {
        case .success(let response):
            accounts = response.value
            if !accounts.contains(where: { $0.id == selectedAccountID }) {
                selectedAccountID = accounts.first?.id
            }
            accountsUpdatedAt = Date()
            accountsLatencyMilliseconds = response.elapsedMilliseconds
        case .failure(let error):
            messages.append("账户：\(Self.message(for: error))")
        }
        switch quoteResponse {
        case .success(let response):
            quotes = symbols.compactMap { symbol in response.value.first { $0.symbol == symbol } }
            quotesUpdatedAt = symbols.isEmpty ? nil : Date()
            quotesLatencyMilliseconds = symbols.isEmpty ? nil : response.elapsedMilliseconds
            let missing = symbols.filter { symbol in !quotes.contains { $0.symbol == symbol } }
            if !missing.isEmpty { messages.append("暂无报价：\(missing.joined(separator: "、"))。") }
        case .failure(let error):
            messages.append("行情：\(Self.message(for: error))")
        }
        let status = try? await client.sessionStatus()
        guard generation == currentGeneration, !isDemo else { return }
        if let status, !status.authenticated {
            isAuthenticated = false
            clearFinancialData()
        }
        errorMessage = messages.isEmpty ? nil : messages.joined(separator: "\n")
    }

    func setDemoMode(_ flag: Bool) async {
        guard !isBusy else { return }
        generation += 1
        isDemo = flag
        errorMessage = nil
        statusMessage = flag ? "正在查看演示数据，不连接真实账户。" : nil
        clearFinancialData()
        if flag { loadDemo() }
        else { await refresh() }
    }

    func disconnect() async {
        generation += 1
        let currentGeneration = generation
        isBusy = true
        defer { if generation == currentGeneration { isBusy = false } }
        do {
            try await client.disconnect()
            guard generation == currentGeneration else { return }
            isAuthenticated = false
            isDemo = false
            clearFinancialData()
            errorMessage = nil
            statusMessage = "已清除这台 iPhone 的账户授权。"
        } catch { errorMessage = Self.message(for: error) }
    }

    func removeCredentials() async {
        generation += 1
        let currentGeneration = generation
        isBusy = true
        defer { if generation == currentGeneration { isBusy = false } }
        do {
            try await client.clearCredentials()
            guard generation == currentGeneration else { return }
            isConfigured = false
            isAuthenticated = false
            isDemo = false
            clearFinancialData()
            errorMessage = nil
            statusMessage = "已删除这台 iPhone 保存的凭据和授权。"
        } catch { errorMessage = Self.message(for: error) }
    }

    func addSymbol(_ value: String) async {
        let symbol = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard Self.validSymbol(symbol) else {
            errorMessage = "请输入有效的股票或 ETF 代码，例如 AAPL。"
            return
        }
        guard !watchlist.contains(symbol) else { return }
        guard watchlist.count < 12 else {
            errorMessage = "第一版最多保存 12 个自选代码。"
            return
        }
        watchlist.append(symbol)
        defaults.set(watchlist, forKey: Self.watchlistKey)
        await refresh()
    }

    func removeSymbol(_ symbol: String) async {
        watchlist.removeAll { $0 == symbol }
        quotes.removeAll { $0.symbol == symbol }
        defaults.set(watchlist, forKey: Self.watchlistKey)
    }

    private func clearFinancialData() {
        accounts = []
        quotes = []
        selectedAccountID = nil
        accountsUpdatedAt = nil
        quotesUpdatedAt = nil
        accountsLatencyMilliseconds = nil
        quotesLatencyMilliseconds = nil
    }

    private func loadDemo() {
        accounts = DemoData.accounts
        selectedAccountID = accounts.first?.id
        quotes = DemoData.quotes.filter { watchlist.contains($0.symbol) }
        accountsUpdatedAt = nil
        quotesUpdatedAt = nil
        accountsLatencyMilliseconds = nil
        quotesLatencyMilliseconds = nil
    }

    private static func validSymbol(_ symbol: String) -> Bool {
        symbol.range(of: "^[A-Z0-9][A-Z0-9.\\-/]{0,14}$", options: .regularExpression) != nil
    }

    private static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "暂时无法完成请求，请稍后重试。"
    }

    private nonisolated static func capture<Value: Sendable>(
        _ operation: @Sendable () async throws -> Value
    ) async -> Result<Value, Error> {
        do { return .success(try await operation()) }
        catch { return .failure(error) }
    }
}
