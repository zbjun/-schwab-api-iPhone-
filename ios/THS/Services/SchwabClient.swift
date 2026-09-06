import Foundation
import Security

enum SchwabClientError: Error, LocalizedError, Equatable, Sendable {
    case credentialsRequired
    case invalidCredentials
    case authorizationRequired
    case authorizationExpired
    case invalidCallback
    case authorizationDeclined
    case sessionChanged
    case secureStorage
    case network
    case invalidResponse
    case invalidSymbols
    case invalidTradingAccount
    case invalidOrderIdentifier
    case invalidDateRange
    case orderOutcomeUnknown
    case redirectRejected
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case .credentialsRequired: return "请先填写并保存 Schwab Client ID 和 Client Secret。"
        case .invalidCredentials: return "Client ID 或 Client Secret 格式无效，请检查后重新填写。"
        case .authorizationRequired: return "请先完成 Schwab 登录授权。"
        case .authorizationExpired: return "本次授权已过期或已使用，请重新打开 Schwab 登录。"
        case .invalidCallback: return "回调链接与本次授权不匹配，请粘贴浏览器中的完整链接。"
        case .authorizationDeclined: return "Schwab 未完成授权，请重新登录并确认账户授权。"
        case .sessionChanged: return "登录状态已改变，请重新操作。"
        case .secureStorage: return "无法读取或更新本机钥匙串，请解锁设备后重试。"
        case .network: return "无法完成到 Schwab 的连接，请检查网络后重试。"
        case .invalidResponse: return "Schwab 返回的数据不完整或格式不受支持，请稍后重试。"
        case .invalidSymbols: return "请输入 1–50 个有效证券代码，每个代码最多 64 个字符。"
        case .invalidTradingAccount: return "交易账户标识无效，请刷新账户后重试。"
        case .invalidOrderIdentifier: return "订单编号无效，请刷新订单后重试。"
        case .invalidDateRange: return "请选择有效的订单查询时间，本版每次最多查询 60 天。"
        case .orderOutcomeUnknown: return "无法确认本次委托操作结果。请先刷新订单并到 Schwab 核实，避免重复提交。"
        case .redirectRejected: return "Schwab API 返回了非预期跳转，请稍后重试。"
        case .httpStatus(let status):
            switch status {
            case 400: return "Schwab 未接受请求，请检查填写内容或应用配置（HTTP 400）。"
            case 401: return "Schwab 授权已失效，请重新登录（HTTP 401）。"
            case 403: return "当前应用或账户没有此接口的访问权限（HTTP 403）。"
            case 429: return "请求过于频繁，请稍后重试（HTTP 429）。"
            default: return "Schwab 请求未成功（HTTP \(status)），请稍后重试。"
            }
        }
    }
}

struct SchwabHTTPResponse: Sendable {
    let statusCode: Int
    let data: Data
    let elapsedMilliseconds: Double
    let headers: [String: String]

    init(statusCode: Int, data: Data, elapsedMilliseconds: Double, headers: [String: String] = [:]) {
        self.statusCode = statusCode
        self.data = data
        self.elapsedMilliseconds = elapsedMilliseconds
        self.headers = headers
    }
}

protocol SchwabHTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> SchwabHTTPResponse
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct DirectSchwabTransport: SchwabHTTPTransport {
    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        configuration.waitsForConnectivity = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.connectionProxyDictionary = [:]
        session = URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
    }

    func send(_ request: URLRequest) async throws -> SchwabHTTPResponse {
        try Self.validateRequest(request)
        let started = ProcessInfo.processInfo.systemUptime
        do {
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse, data.count <= 8 * 1_024 * 1_024 else {
                throw SchwabClientError.invalidResponse
            }
            guard !(300..<400).contains(response.statusCode) else {
                throw SchwabClientError.redirectRejected
            }
            var headers: [String: String] = [:]
            for (key, value) in response.allHeaderFields {
                guard let key = key as? String else { continue }
                headers[key.lowercased()] = String(describing: value)
            }
            return SchwabHTTPResponse(statusCode: response.statusCode, data: data,
                                      elapsedMilliseconds: (ProcessInfo.processInfo.systemUptime - started) * 1_000,
                                      headers: headers)
        } catch let error as SchwabClientError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw SchwabClientError.network
        }
    }

    static func validateRequest(_ request: URLRequest) throws {
        guard let url = request.url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "https", components.host == "api.schwabapi.com",
              components.port == nil, components.user == nil, components.password == nil,
              components.fragment == nil, components.percentEncodedPath == components.path else {
            throw SchwabClientError.invalidResponse
        }
        let items = components.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count else { throw SchwabClientError.invalidResponse }
        let allowed: Bool
        switch (request.httpMethod ?? "GET", components.path) {
        case ("POST", "/v1/oauth/token"):
            allowed = items.isEmpty
        case ("GET", "/trader/v1/accounts"):
            allowed = items.count == 1 && items[0].name == "fields" && items[0].value == "positions"
        case ("GET", "/marketdata/v1/quotes"):
            allowed = items.count == 1 && items[0].name == "symbols" && !(items[0].value ?? "").isEmpty
        case ("GET", "/trader/v1/accounts/accountNumbers"):
            allowed = items.isEmpty
        case ("GET", "/marketdata/v1/pricehistory"):
            allowed = SchwabRequestPolicy.validHistoryQuery(items)
        case ("GET", "/marketdata/v1/instruments"):
            allowed = (request.httpBody ?? Data()).isEmpty && SchwabRequestPolicy.validFundamentalQuery(items)
        default:
            let path = components.path.split(separator: "/", omittingEmptySubsequences: false)
            if (path.count == 6 || path.count == 7), path[0].isEmpty,
               path[1] == "trader", path[2] == "v1", path[3] == "accounts", path[5] == "orders",
               SchwabRequestPolicy.validHash(String(path[4])) {
                switch (request.httpMethod ?? "GET", path.count) {
                case ("GET", 6):
                    allowed = SchwabRequestPolicy.validOrderQuery(items)
                case ("POST", 6), ("PUT", 7):
                    allowed = items.isEmpty && (path.count == 6 || SchwabRequestPolicy.validOrderID(String(path[6])))
                        && request.value(forHTTPHeaderField: "Content-Type") == "application/json"
                        && !(request.httpBody ?? Data()).isEmpty
                case ("GET", 7), ("DELETE", 7):
                    allowed = items.isEmpty && SchwabRequestPolicy.validOrderID(String(path[6]))
                default: allowed = false
                }
            } else { allowed = false }
        }
        guard allowed else { throw SchwabClientError.invalidResponse }
    }
}

private enum SchwabRequestPolicy {
    static func validFundamentalQuery(_ items: [URLQueryItem]) -> Bool {
        guard items.count == 2, Set(items.map(\.name)) == ["symbol", "projection"] else { return false }
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard values["projection"] == "fundamental", let symbol = values["symbol"] else { return false }
        return OrderDraft.isValidSymbol(symbol)
    }

    static func validHash(_ hash: String) -> Bool {
        !hash.isEmpty && hash.utf8.count <= 128
            && hash.range(of: "\\A[A-Za-z0-9_-]+\\z", options: .regularExpression) != nil
            && hash.range(of: "[A-Za-z]", options: .regularExpression) != nil
    }

    static func validOrderID(_ identifier: String) -> Bool {
        !identifier.isEmpty && identifier.utf8.count <= 32
            && identifier.range(of: "\\A[0-9]+\\z", options: .regularExpression) != nil
    }

    static func validDateRange(from: Date, to: Date) -> Bool {
        let interval = to.timeIntervalSince(from)
        return from.timeIntervalSince1970.isFinite && to.timeIntervalSince1970.isFinite
            && from.timeIntervalSince1970 >= 0 && to.timeIntervalSince1970 < 32_503_680_000
            && interval >= 0 && interval <= 60 * 86_400
    }

    static func dateString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func validOrderQuery(_ items: [URLQueryItem]) -> Bool {
        guard items.count == 3, Set(items.map(\.name)) == ["maxResults", "fromEnteredTime", "toEnteredTime"] else {
            return false
        }
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard values["maxResults"] == "200", let fromRaw = values["fromEnteredTime"],
              let toRaw = values["toEnteredTime"], fromRaw.hasSuffix("Z"), toRaw.hasSuffix("Z"),
              let from = parseDate(fromRaw), let to = parseDate(toRaw) else { return false }
        return validDateRange(from: from, to: to)
    }

    static func historyQuery(symbol: String, range: HistoryRange, end: Date) throws -> [URLQueryItem] {
        guard OrderDraft.isValidSymbol(symbol) else { throw SchwabClientError.invalidSymbols }
        let milliseconds = end.timeIntervalSince1970 * 1_000
        guard milliseconds.isFinite, milliseconds >= 0, milliseconds < 32_503_680_000_000 else {
            throw SchwabClientError.invalidDateRange
        }
        let periodType: String
        let period: String
        let frequencyType: String
        let frequency: String
        switch range {
        case .intraday: (periodType, period, frequencyType, frequency) = ("day", "1", "minute", "1")
        case .daily: (periodType, period, frequencyType, frequency) = ("year", "1", "daily", "1")
        case .weekly: (periodType, period, frequencyType, frequency) = ("year", "2", "weekly", "1")
        case .monthly: (periodType, period, frequencyType, frequency) = ("year", "5", "monthly", "1")
        case .fiveDay: (periodType, period, frequencyType, frequency) = ("day", "5", "minute", "5")
        }
        return [URLQueryItem(name: "symbol", value: symbol),
                URLQueryItem(name: "periodType", value: periodType), URLQueryItem(name: "period", value: period),
                URLQueryItem(name: "frequencyType", value: frequencyType), URLQueryItem(name: "frequency", value: frequency),
                URLQueryItem(name: "endDate", value: String(Int64(milliseconds))),
                URLQueryItem(name: "needExtendedHoursData", value: "false"),
                URLQueryItem(name: "needPreviousClose", value: "true")]
    }

    static func validHistoryQuery(_ items: [URLQueryItem]) -> Bool {
        let names: Set<String> = ["symbol", "periodType", "period", "frequencyType", "frequency", "endDate",
                                  "needExtendedHoursData", "needPreviousClose"]
        guard items.count == names.count, Set(items.map(\.name)) == names else { return false }
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard let symbol = values["symbol"], OrderDraft.isValidSymbol(symbol),
              values["needExtendedHoursData"] == "false", values["needPreviousClose"] == "true",
              let endRaw = values["endDate"], endRaw.range(of: "\\A[0-9]+\\z", options: .regularExpression) != nil,
              let end = Int64(endRaw), end >= 0, end < 32_503_680_000_000 else { return false }
        let combination = [values["periodType"], values["period"], values["frequencyType"], values["frequency"]]
        return combination == ["day", "1", "minute", "1"] || combination == ["day", "5", "minute", "5"]
            || combination == ["year", "1", "daily", "1"] || combination == ["year", "2", "weekly", "1"]
            || combination == ["year", "5", "monthly", "1"]
    }
}

actor SchwabClient {
    static let callbackURL = "https://127.0.0.1"

    private struct Credentials: Codable, Sendable {
        let clientID: String
        let clientSecret: String
    }

    private struct Token: Codable, Sendable {
        let accessToken: String
        let refreshToken: String?
        let expiresAt: Date
    }

    private struct PendingAuthorization: Codable, Sendable {
        let state: String
        let createdAt: Date
    }

    private struct StoredSession: Codable, Sendable {
        var credentials: Credentials?
        var token: Token?
        var pending: PendingAuthorization?
    }

    private let store: any SchwabSecureStore
    private let transport: any SchwabHTTPTransport
    private let now: @Sendable () -> Date
    private var stored = StoredSession()
    private var hasLoaded = false
    private var generation: UInt64 = 0
    private var refreshTask: Task<Token, Error>?
    private var refreshOperationID: UUID?

    init(store: any SchwabSecureStore = KeychainVault(),
         transport: any SchwabHTTPTransport = DirectSchwabTransport(),
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.transport = transport
        self.now = now
    }

    func sessionStatus() async throws -> SessionStatus {
        try load()
        let usable = stored.token.map { $0.expiresAt > now() || $0.refreshToken != nil } ?? false
        return SessionStatus(configured: stored.credentials != nil,
                             authenticated: stored.credentials != nil && usable,
                             expiresAt: stored.token?.expiresAt)
    }

    func saveCredentials(clientID: String, clientSecret: String) async throws {
        try load()
        let clientID = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        let clientSecret = clientSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.validCredential(clientID), !clientID.contains(":"), Self.validCredential(clientSecret) else {
            throw SchwabClientError.invalidCredentials
        }
        if stored.credentials?.clientID == clientID && stored.credentials?.clientSecret == clientSecret { return }
        invalidateOperations()
        try persist(StoredSession(credentials: Credentials(clientID: clientID, clientSecret: clientSecret)))
    }

    func beginAuthorization() async throws -> URL {
        try load()
        guard let credentials = stored.credentials else { throw SchwabClientError.credentialsRequired }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw SchwabClientError.secureStorage
        }
        let state = bytes.map { String(format: "%02x", $0) }.joined()
        var components = URLComponents()
        components.scheme = "https"
        components.host = "api.schwabapi.com"
        components.path = "/v1/oauth/authorize"
        components.queryItems = [URLQueryItem(name: "response_type", value: "code"),
                                 URLQueryItem(name: "client_id", value: credentials.clientID),
                                 URLQueryItem(name: "redirect_uri", value: Self.callbackURL),
                                 URLQueryItem(name: "state", value: state)]
        guard let url = components.url else { throw SchwabClientError.invalidResponse }
        invalidateOperations()
        var next = stored
        next.pending = PendingAuthorization(state: state, createdAt: now())
        try persist(next)
        return url
    }

    func completeAuthorization(callbackURL: String) async throws {
        try load()
        guard let credentials = stored.credentials else { throw SchwabClientError.credentialsRequired }
        guard let pending = stored.pending,
              (0...600).contains(now().timeIntervalSince(pending.createdAt)) else {
            var next = stored
            next.pending = nil
            try persist(next)
            throw SchwabClientError.authorizationExpired
        }
        let rawURL = callbackURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard rawURL.utf8.count <= 16_384,
              rawURL.rangeOfCharacter(from: .controlCharacters) == nil,
              let components = URLComponents(string: rawURL), components.url != nil,
              components.scheme?.lowercased() == "https", components.host == "127.0.0.1",
              components.port == nil, components.user == nil, components.password == nil,
              components.path.isEmpty || components.path == "/", components.fragment == nil else {
            throw SchwabClientError.invalidCallback
        }
        let items = components.queryItems ?? []
        let states = items.filter { $0.name == "state" }
        guard states.count == 1, let receivedState = states[0].value,
              Self.constantTimeEqual(receivedState, pending.state) else {
            throw SchwabClientError.invalidCallback
        }
        if items.contains(where: { $0.name == "error" }) {
            var next = stored
            next.pending = nil
            try persist(next)
            throw SchwabClientError.authorizationDeclined
        }
        let codes = items.filter { $0.name == "code" }
        guard codes.count == 1, let code = codes[0].value, !code.isEmpty, code.utf8.count <= 8_192,
              code.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw SchwabClientError.invalidCallback
        }
        // Persist consumption before sending: even after process death this code cannot be replayed.
        invalidateOperations()
        var next = stored
        next.pending = nil
        next.token = nil
        try persist(next)
        let currentGeneration = generation
        let response = try await exchange(credentials: credentials,
                                          form: [("grant_type", "authorization_code"), ("code", code),
                                                 ("redirect_uri", Self.callbackURL)])
        guard currentGeneration == generation else { throw SchwabClientError.sessionChanged }
        let token = try decodeToken(response, previousRefreshToken: nil)
        next = stored
        next.token = token
        try persist(next)
    }

    func fetchAccounts() async throws -> APIResponse<[BrokerageAccount]> {
        let response = try await read(path: "/trader/v1/accounts",
                                      query: [URLQueryItem(name: "fields", value: "positions")])
        return APIResponse(value: try Self.decodeAccounts(response.data),
                           elapsedMilliseconds: response.elapsedMilliseconds)
    }

    func fetchQuotes(symbols: [String]) async throws -> APIResponse<[StockQuote]> {
        let symbols = try Self.normalizedSymbols(symbols)
        let response = try await read(path: "/marketdata/v1/quotes",
                                      query: [URLQueryItem(name: "symbols", value: symbols.joined(separator: ","))])
        return APIResponse(value: try Self.decodeQuotes(response.data, symbols: symbols),
                           elapsedMilliseconds: response.elapsedMilliseconds)
    }

    func fetchFundamentals(symbol: String) async throws -> APIResponse<StockFundamentals> {
        let symbol = symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard OrderDraft.isValidSymbol(symbol) else { throw SchwabClientError.invalidSymbols }
        let response = try await read(path: "/marketdata/v1/instruments", query: [
            URLQueryItem(name: "symbol", value: symbol), URLQueryItem(name: "projection", value: "fundamental")
        ])
        return APIResponse(value: try Self.decodeFundamentals(response.data, symbol: symbol),
                           elapsedMilliseconds: response.elapsedMilliseconds)
    }

    func fetchAccountIdentifiers() async throws -> APIResponse<[TradingAccountIdentifier]> {
        let response = try await read(path: "/trader/v1/accounts/accountNumbers")
        return APIResponse(value: try Self.decodeAccountIdentifiers(response.data),
                           elapsedMilliseconds: response.elapsedMilliseconds)
    }

    func fetchOrders(accountHash: String, from: Date, to: Date) async throws -> APIResponse<[BrokerageOrder]> {
        let path = try Self.ordersPath(accountHash: accountHash)
        guard SchwabRequestPolicy.validDateRange(from: from, to: to) else { throw SchwabClientError.invalidDateRange }
        let query = [URLQueryItem(name: "maxResults", value: "200"),
                     URLQueryItem(name: "fromEnteredTime", value: SchwabRequestPolicy.dateString(from)),
                     URLQueryItem(name: "toEnteredTime", value: SchwabRequestPolicy.dateString(to))]
        let response = try await read(path: path, query: query)
        return APIResponse(value: try Self.decodeOrders(response.data), elapsedMilliseconds: response.elapsedMilliseconds)
    }

    func fetchOrder(accountHash: String, orderID: String) async throws -> APIResponse<BrokerageOrder> {
        let response = try await read(path: Self.ordersPath(accountHash: accountHash, orderID: orderID))
        let order = try Self.decodeOrder(response.data)
        guard order.id == orderID else { throw SchwabClientError.invalidResponse }
        return APIResponse(value: order, elapsedMilliseconds: response.elapsedMilliseconds)
    }

    func placeOrder(accountHash: String, draft: OrderDraft) async throws -> OrderReceipt {
        let path = try Self.ordersPath(accountHash: accountHash)
        return try await writeOrder(path: path, accountHash: accountHash, method: "POST", body: draft.encoded())
    }

    func replaceOrder(accountHash: String, orderID: String, draft: OrderDraft) async throws -> OrderReceipt {
        let path = try Self.ordersPath(accountHash: accountHash, orderID: orderID)
        return try await writeOrder(path: path, accountHash: accountHash, method: "PUT", body: draft.encoded())
    }

    func cancelOrder(accountHash: String, orderID: String) async throws -> OrderReceipt {
        let path = try Self.ordersPath(accountHash: accountHash, orderID: orderID)
        return try await writeOrder(path: path, accountHash: accountHash, method: "DELETE", canceledOrderID: orderID)
    }

    func fetchPriceHistory(symbol: String, range: HistoryRange) async throws -> APIResponse<PriceHistory> {
        let symbol = symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let query = try SchwabRequestPolicy.historyQuery(symbol: symbol, range: range, end: now())
        let response = try await read(path: "/marketdata/v1/pricehistory", query: query)
        return APIResponse(value: try Self.decodePriceHistory(response.data, symbol: symbol),
                           elapsedMilliseconds: response.elapsedMilliseconds)
    }

    func disconnect() async throws {
        try load()
        var next = stored
        next.token = nil
        next.pending = nil
        try persist(next)
        invalidateOperations()
    }

    func clearCredentials() async throws {
        do { try store.clear() } catch { throw SchwabClientError.secureStorage }
        invalidateOperations()
        stored = StoredSession()
        hasLoaded = true
    }

    private func load() throws {
        guard !hasLoaded else { return }
        do {
            if let data = try store.read() {
                stored = try JSONDecoder().decode(StoredSession.self, from: data)
            }
            hasLoaded = true
        } catch { throw SchwabClientError.secureStorage }
    }

    private func persist(_ next: StoredSession) throws {
        do {
            let data = try JSONEncoder().encode(next)
            try store.write(data)
            stored = next
            hasLoaded = true
        } catch { throw SchwabClientError.secureStorage }
    }

    private func invalidateOperations() {
        generation &+= 1
        refreshTask?.cancel()
        refreshTask = nil
        refreshOperationID = nil
    }

    private func ensureToken() async throws -> Token {
        try load()
        guard let token = stored.token else { throw SchwabClientError.authorizationRequired }
        if token.expiresAt.timeIntervalSince(now()) > 60 { return token }
        if let refreshTask { return try await refreshTask.value }
        guard let refreshToken = token.refreshToken, let credentials = stored.credentials else {
            var next = stored
            next.token = nil
            try persist(next)
            throw SchwabClientError.authorizationRequired
        }
        let operationID = UUID()
        let currentGeneration = generation
        let task = Task {
            try await self.performRefresh(credentials: credentials, refreshToken: refreshToken,
                                          generation: currentGeneration, operationID: operationID)
        }
        refreshOperationID = operationID
        refreshTask = task
        return try await task.value
    }

    private func performRefresh(credentials: Credentials, refreshToken: String,
                                generation expectedGeneration: UInt64, operationID: UUID) async throws -> Token {
        defer {
            if refreshOperationID == operationID {
                refreshTask = nil
                refreshOperationID = nil
            }
        }
        do {
            let response = try await exchange(credentials: credentials,
                                              form: [("grant_type", "refresh_token"), ("refresh_token", refreshToken)])
            guard expectedGeneration == generation else { throw SchwabClientError.sessionChanged }
            let token = try decodeToken(response, previousRefreshToken: refreshToken)
            var next = stored
            next.token = token
            try persist(next)
            return token
        } catch {
            guard expectedGeneration == generation else { throw SchwabClientError.sessionChanged }
            if case SchwabClientError.httpStatus(let status) = error, status == 400 || status == 401 {
                var next = stored
                next.token = nil
                try persist(next)
            }
            throw Self.sanitized(error)
        }
    }

    private func exchange(credentials: Credentials, form: [(String, String)]) async throws -> SchwabHTTPResponse {
        var request = try Self.request(path: "/v1/oauth/token")
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let basic = Data("\(credentials.clientID):\(credentials.clientSecret)".utf8).base64EncodedString()
        request.setValue("Basic \(basic)", forHTTPHeaderField: "Authorization")
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        request.httpBody = Data(form.map { key, value in
            "\(key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")"
        }.joined(separator: "&").utf8)
        do {
            let response = try await transport.send(request)
            guard response.statusCode == 200 else { throw SchwabClientError.httpStatus(response.statusCode) }
            return response
        } catch { throw Self.sanitized(error) }
    }

    private func read(path: String, query: [URLQueryItem] = []) async throws -> SchwabHTTPResponse {
        try load()
        let currentGeneration = generation
        let token = try await ensureToken()
        guard currentGeneration == generation else { throw SchwabClientError.sessionChanged }
        try Task.checkCancellation()
        var request = try Self.request(path: path, query: query)
        request.setValue("Bearer \(token.accessToken)", forHTTPHeaderField: "Authorization")
        do {
            let response = try await transport.send(request)
            guard currentGeneration == generation else { throw SchwabClientError.sessionChanged }
            if response.statusCode == 401, stored.token?.accessToken == token.accessToken {
                var next = stored
                next.token = nil
                try persist(next)
            }
            guard response.statusCode == 200 else { throw SchwabClientError.httpStatus(response.statusCode) }
            return response
        } catch {
            guard currentGeneration == generation else { throw SchwabClientError.sessionChanged }
            throw Self.sanitized(error)
        }
    }

    private func writeOrder(path: String, accountHash: String, method: String, body: Data? = nil,
                            canceledOrderID: String? = nil) async throws -> OrderReceipt {
        try load()
        let currentGeneration = generation
        let token = try await ensureToken()
        guard currentGeneration == generation else { throw SchwabClientError.sessionChanged }
        try Task.checkCancellation()
        var request = try Self.request(path: path)
        request.httpMethod = method
        request.setValue("Bearer \(token.accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        // Validate before entering the send boundary, including when a test transport is injected.
        try DirectSchwabTransport.validateRequest(request)
        let response: SchwabHTTPResponse
        do {
            response = try await transport.send(request)
        } catch {
            // A lost response or cancellation can happen after Schwab has accepted the request.
            // Never retry a write or turn this into an ordinary "try again" connection error.
            throw SchwabClientError.orderOutcomeUnknown
        }
        guard currentGeneration == generation else { throw SchwabClientError.orderOutcomeUnknown }
        if response.statusCode == 401, stored.token?.accessToken == token.accessToken {
            var next = stored
            next.token = nil
            try persist(next)
        }
        if (400..<500).contains(response.statusCode), response.statusCode != 408 {
            throw SchwabClientError.httpStatus(response.statusCode)
        }
        let expectedStatus = method == "DELETE" ? 200 : 201
        guard response.statusCode == expectedStatus else { throw SchwabClientError.orderOutcomeUnknown }
        let identifier = canceledOrderID ?? Self.orderIdentifier(from: response.headers, accountHash: accountHash)
        return OrderReceipt(orderID: identifier, elapsedMilliseconds: response.elapsedMilliseconds)
    }

    private static func ordersPath(accountHash: String, orderID: String? = nil) throws -> String {
        guard SchwabRequestPolicy.validHash(accountHash) else { throw SchwabClientError.invalidTradingAccount }
        let path = "/trader/v1/accounts/\(accountHash)/orders"
        guard let orderID else { return path }
        guard SchwabRequestPolicy.validOrderID(orderID) else { throw SchwabClientError.invalidOrderIdentifier }
        return "\(path)/\(orderID)"
    }

    static func orderIdentifier(from headers: [String: String], accountHash: String) -> String? {
        guard SchwabRequestPolicy.validHash(accountHash) else { return nil }
        let matches = headers.filter { $0.key.lowercased() == "location" }
        guard matches.count == 1, let raw = matches.first?.value,
              raw.utf8.count <= 2_048, raw.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
              let components = URLComponents(string: raw), components.url != nil,
              components.port == nil, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.percentEncodedPath == components.path else { return nil }
        if components.scheme == nil {
            guard components.host == nil, raw.hasPrefix("/"), !raw.hasPrefix("//") else { return nil }
        } else {
            guard components.scheme == "https", components.host == "api.schwabapi.com" else { return nil }
        }
        let prefix = "/trader/v1/accounts/\(accountHash)/orders/"
        guard components.path.hasPrefix(prefix) else { return nil }
        let identifier = String(components.path.dropFirst(prefix.count))
        return SchwabRequestPolicy.validOrderID(identifier) ? identifier : nil
    }

    private static func request(path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "api.schwabapi.com"
        components.path = path
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw SchwabClientError.invalidResponse }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private struct TokenDTO: Decodable {
        let access_token: String
        let refresh_token: String?
        let expires_in: Double
        let token_type: String?
    }

    private func decodeToken(_ response: SchwabHTTPResponse, previousRefreshToken: String?) throws -> Token {
        do {
            let dto = try JSONDecoder().decode(TokenDTO.self, from: response.data)
            guard Self.validToken(dto.access_token), dto.expires_in.isFinite,
                  dto.expires_in > 0, dto.expires_in <= 86_400,
                  dto.token_type == nil || dto.token_type?.lowercased() == "bearer",
                  dto.refresh_token == nil || Self.validToken(dto.refresh_token ?? "") else {
                throw SchwabClientError.invalidResponse
            }
            return Token(accessToken: dto.access_token, refreshToken: dto.refresh_token ?? previousRefreshToken,
                         expiresAt: now().addingTimeInterval(dto.expires_in))
        } catch { throw SchwabClientError.invalidResponse }
    }

    private static func validCredential(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 512 && value.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil
    }

    private static func validToken(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 32_768 && value.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil
    }

    private static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
        let left = Array(lhs.utf8)
        let right = Array(rhs.utf8)
        guard left.count == right.count else { return false }
        var difference: UInt8 = 0
        for index in left.indices { difference |= left[index] ^ right[index] }
        return difference == 0
    }

    private static func sanitized(_ error: Error) -> Error {
        if let error = error as? SchwabClientError { return error }
        if error is CancellationError { return CancellationError() }
        return SchwabClientError.network
    }

    private static func normalizedSymbols(_ symbols: [String]) throws -> [String] {
        guard !symbols.isEmpty, symbols.count <= 50 else { throw SchwabClientError.invalidSymbols }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .$/_^-")
        var result: [String] = []
        for item in symbols {
            let symbol = item.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            guard !symbol.isEmpty, symbol.utf8.count <= 64,
                  symbol.rangeOfCharacter(from: allowed.inverted) == nil else { throw SchwabClientError.invalidSymbols }
            if !result.contains(symbol) { result.append(symbol) }
        }
        return result
    }

    private struct AccountEnvelopeDTO: Decodable {
        let securitiesAccount: AccountDTO
    }

    private struct AccountDTO: Decodable {
        let accountNumber: String
        let type: String?
        let currentBalances: BalancesDTO?
        let positions: [PositionDTO]?
    }

    private struct BalancesDTO: Decodable {
        let liquidationValue: Double?
        let cashBalance: Double?
        let buyingPower: Double?
    }

    private struct PositionDTO: Decodable {
        let instrument: InstrumentDTO
        let longQuantity: Double?
        let shortQuantity: Double?
        let averagePrice: Double?
        let marketValue: Double?
        let currentDayProfitLoss: Double?
        let currentDayProfitLossPercentage: Double?
    }

    private struct InstrumentDTO: Decodable {
        let symbol: String?
        let cusip: String?
        let description: String?
        let assetType: String?
    }

    static func decodeAccounts(_ data: Data) throws -> [BrokerageAccount] {
        do {
            return try JSONDecoder().decode([AccountEnvelopeDTO].self, from: data).map { envelope in
                let account = envelope.securitiesAccount
                guard !account.accountNumber.isEmpty else { throw SchwabClientError.invalidResponse }
                let positions: [Position] = try (account.positions ?? []).map { dto in
                    let instrument = dto.instrument
                    guard let symbol = instrument.symbol ?? instrument.cusip, !symbol.isEmpty,
                          dto.longQuantity != nil || dto.shortQuantity != nil else {
                        throw SchwabClientError.invalidResponse
                    }
                    return Position(id: "\(instrument.assetType ?? "UNKNOWN"):\(instrument.cusip ?? symbol)",
                                    symbol: symbol, description: instrument.description ?? symbol,
                                    assetType: instrument.assetType ?? "UNKNOWN",
                                    quantity: (dto.longQuantity ?? 0) - (dto.shortQuantity ?? 0),
                                    averagePrice: dto.averagePrice, marketValue: dto.marketValue,
                                    dayProfitLoss: dto.currentDayProfitLoss,
                                    dayProfitLossPercent: dto.currentDayProfitLossPercentage)
                }
                let masked = account.accountNumber.count > 4
                    ? "•••• \(account.accountNumber.suffix(4))"
                    : String(repeating: "•", count: account.accountNumber.count)
                return BrokerageAccount(id: account.accountNumber, displayNumber: masked,
                                        accountType: account.type ?? "UNKNOWN",
                                        liquidationValue: account.currentBalances?.liquidationValue,
                                        cashBalance: account.currentBalances?.cashBalance,
                                        buyingPower: account.currentBalances?.buyingPower, positions: positions)
            }
        } catch { throw SchwabClientError.invalidResponse }
    }

    private struct AccountIdentifierDTO: Decodable {
        let accountNumber: String
        let hashValue: String
    }

    static func decodeAccountIdentifiers(_ data: Data) throws -> [TradingAccountIdentifier] {
        do {
            let values = try JSONDecoder().decode([AccountIdentifierDTO].self, from: data)
            var accountNumbers = Set<String>()
            var hashes = Set<String>()
            return try values.map { value in
                guard !value.accountNumber.isEmpty, value.accountNumber.utf8.count <= 64,
                      value.accountNumber.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
                      SchwabRequestPolicy.validHash(value.hashValue),
                      accountNumbers.insert(value.accountNumber).inserted, hashes.insert(value.hashValue).inserted else {
                    throw SchwabClientError.invalidResponse
                }
                return TradingAccountIdentifier(accountNumber: value.accountNumber, hashValue: value.hashValue)
            }
        } catch { throw SchwabClientError.invalidResponse }
    }

    private struct OrderIdentifierDTO: Decodable {
        let value: String

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let string = try? container.decode(String.self) {
                value = string
            } else {
                value = String(try container.decode(UInt64.self))
            }
            guard SchwabRequestPolicy.validOrderID(value) else { throw SchwabClientError.invalidResponse }
        }
    }

    private struct OrderDTO: Decodable {
        let orderId: OrderIdentifierDTO
        let status: String?
        let orderType: String?
        let session: String?
        let duration: String?
        let orderStrategyType: String?
        let complexOrderStrategyType: String?
        let specialInstruction: String?
        let taxLotMethod: String?
        let requestedDestination: String?
        let cancelTime: String?
        let quantity: Double?
        let filledQuantity: Double?
        let remainingQuantity: Double?
        let price: Double?
        let stopPrice: Double?
        let enteredTime: String?
        let closeTime: String?
        let cancelable: Bool?
        let editable: Bool?
        let orderLegCollection: [OrderLegDTO]?
        let childOrderStrategies: [ChildOrderDTO]?
    }

    private struct OrderLegDTO: Decodable {
        let instruction: String?
        let instrument: InstrumentDTO?
    }

    private struct ChildOrderDTO: Decodable {}

    static func decodeOrders(_ data: Data) throws -> [BrokerageOrder] {
        do {
            let orders = try JSONDecoder().decode([OrderDTO].self, from: data).map(Self.order)
            guard Set(orders.map(\.id)).count == orders.count else { throw SchwabClientError.invalidResponse }
            return orders
        } catch { throw SchwabClientError.invalidResponse }
    }

    static func decodeOrder(_ data: Data) throws -> BrokerageOrder {
        do { return try order(JSONDecoder().decode(OrderDTO.self, from: data)) }
        catch { throw SchwabClientError.invalidResponse }
    }

    private static func order(_ dto: OrderDTO) throws -> BrokerageOrder {
        let numbers = [dto.quantity, dto.filledQuantity, dto.remainingQuantity, dto.price, dto.stopPrice].compactMap { $0 }
        guard numbers.allSatisfy({ $0.isFinite && $0 >= 0 }) else { throw SchwabClientError.invalidResponse }
        let entered = try optionalOrderDate(dto.enteredTime)
        let closed = try optionalOrderDate(dto.closeTime)
        let legs = dto.orderLegCollection ?? []
        let singleLeg = legs.count == 1 ? legs.first : nil
        let side = singleLeg?.instruction.flatMap(OrderSide.init(rawValue:))
        let kind = dto.orderType.flatMap(OrderKind.init(rawValue:))
        let duration = dto.duration.flatMap(OrderDuration.init(rawValue:))
        var symbols: [String] = []
        for leg in legs {
            if let symbol = leg.instrument?.symbol, !symbol.isEmpty, !symbols.contains(symbol) { symbols.append(symbol) }
        }
        let symbol = symbols.isEmpty ? "未知标的" : symbols.joined(separator: " / ")
        let assetType = singleLeg?.instrument?.assetType
        let simple = singleLeg != nil && assetType == "EQUITY" && side != nil && kind != nil && duration != nil
            && dto.session == "NORMAL" && dto.orderStrategyType == "SINGLE"
            && (dto.complexOrderStrategyType == nil || dto.complexOrderStrategyType == "NONE")
            && (dto.childOrderStrategies ?? []).isEmpty && OrderDraft.isValidSymbol(symbol)
        let status = dto.status ?? "UNKNOWN"
        let actionable = simple && BrokerageOrder.openStatuses.contains(status)
            && !["PENDING_CANCEL", "PENDING_REPLACE", "AWAITING_REPLACEMENT"].contains(status)
        let wholeQuantity = dto.quantity.map { $0 > 0 && $0.rounded(.towardZero) == $0 && $0 < Double(Int.max) } ?? false
        // Replacing partially filled orders needs broker-specific remaining-quantity semantics.
        // Keep them visible and cancellable, but do not expose an ambiguous replacement.
        // OrderDraft omits these execution choices. There is no NONE special instruction or
        // universal tax-lot default in the reviewed schema; even explicit FIFO must survive a PUT.
        let replacementPreservesInstructions = dto.specialInstruction == nil && dto.taxLotMethod == nil
            && (dto.requestedDestination == nil || dto.requestedDestination == "AUTO")
            && dto.cancelTime == nil
        let pricesFitDraft = [dto.price, dto.stopPrice].compactMap { $0 }.allSatisfy(Self.priceFitsDraftPrecision)
        let editable = actionable && dto.editable == true && dto.filledQuantity == 0 && wholeQuantity
            && replacementPreservesInstructions && pricesFitDraft
        return BrokerageOrder(id: dto.orderId.value, status: status, symbol: symbol, side: side, kind: kind,
                              quantity: dto.quantity, filledQuantity: dto.filledQuantity,
                              remainingQuantity: dto.remainingQuantity, limitPrice: dto.price, stopPrice: dto.stopPrice,
                              duration: duration, enteredAt: entered, closedAt: closed,
                              cancelable: actionable && dto.cancelable == true, editable: editable,
                              assetType: assetType, isSimpleEquity: simple)
    }

    private static func priceFitsDraftPrecision(_ value: Double) -> Bool {
        // Use the number's decimal spelling, not Decimal(value)'s binary floating-point expansion.
        guard var decimal = Decimal(string: String(value), locale: Locale(identifier: "en_US_POSIX")) else { return false }
        var rounded = Decimal()
        NSDecimalRound(&rounded, &decimal, 4, .plain)
        return rounded == decimal
    }

    private static func optionalOrderDate(_ value: String?) throws -> Date? {
        guard let value else { return nil }
        guard let date = SchwabRequestPolicy.parseDate(value), date.timeIntervalSince1970.isFinite else {
            throw SchwabClientError.invalidResponse
        }
        return date
    }

    private struct PriceHistoryDTO: Decodable {
        let symbol: String
        let candles: [PriceCandleDTO]
        let empty: Bool?
        let previousClose: Double?
    }

    private struct PriceCandleDTO: Decodable {
        let datetime: Double
        let open: Double
        let high: Double
        let low: Double
        let close: Double
        let volume: Double?
    }

    static func decodePriceHistory(_ data: Data, symbol: String) throws -> PriceHistory {
        do {
            let dto = try JSONDecoder().decode(PriceHistoryDTO.self, from: data)
            guard dto.symbol == symbol, dto.previousClose == nil || (dto.previousClose!.isFinite && dto.previousClose! >= 0),
                  dto.empty != true || dto.candles.isEmpty else { throw SchwabClientError.invalidResponse }
            var candlesByTime: [Date: PriceCandle] = [:]
            for candle in dto.candles {
                guard candle.datetime.isFinite, candle.datetime >= 0, candle.datetime < 32_503_680_000_000,
                      [candle.open, candle.high, candle.low, candle.close].allSatisfy({ $0.isFinite && $0 >= 0 }),
                      candle.high >= max(candle.open, candle.close), candle.low <= min(candle.open, candle.close),
                      candle.low <= candle.high,
                      candle.volume == nil || (candle.volume!.isFinite && candle.volume! >= 0) else {
                    throw SchwabClientError.invalidResponse
                }
                let time = Date(timeIntervalSince1970: candle.datetime / 1_000)
                candlesByTime[time] = PriceCandle(time: time, open: candle.open, high: candle.high, low: candle.low,
                                                 close: candle.close, volume: candle.volume)
            }
            return PriceHistory(symbol: dto.symbol, candles: candlesByTime.values.sorted { $0.time < $1.time },
                                previousClose: dto.previousClose)
        } catch { throw SchwabClientError.invalidResponse }
    }

    private struct FundamentalEnvelopeDTO: Decodable {
        let instruments: [FundamentalInstrumentDTO]
    }

    private struct FundamentalInstrumentDTO: Decodable {
        let symbol: String
        let assetType: String
        let fundamental: InstrumentFundamentalDTO?
    }

    private struct InstrumentFundamentalDTO: Decodable {
        let symbol: String?
        let marketCap: Double?
        let sharesOutstanding: Double?

        enum CodingKeys: String, CodingKey { case symbol, marketCap, sharesOutstanding }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            symbol = try values.decodeIfPresent(String.self, forKey: .symbol)
            let cap = try? values.decode(Double.self, forKey: .marketCap)
            marketCap = cap.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
            let shares = try? values.decode(Double.self, forKey: .sharesOutstanding)
            sharesOutstanding = shares.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        }
    }

    static func decodeFundamentals(_ data: Data, symbol: String) throws -> StockFundamentals {
        do {
            guard OrderDraft.isValidSymbol(symbol) else { throw SchwabClientError.invalidResponse }
            let envelope = try JSONDecoder().decode(FundamentalEnvelopeDTO.self, from: data)
            guard envelope.instruments.count == 1, let instrument = envelope.instruments.first,
                  instrument.symbol == symbol, instrument.assetType == "EQUITY",
                  instrument.fundamental?.symbol == nil || instrument.fundamental?.symbol == symbol else {
                throw SchwabClientError.invalidResponse
            }
            return StockFundamentals(symbol: symbol, marketCap: instrument.fundamental?.marketCap,
                                     sharesOutstanding: instrument.fundamental?.sharesOutstanding)
        } catch { throw SchwabClientError.invalidResponse }
    }

    private struct QuoteDTO: Decodable {
        let symbol: String?
        let realtime: Bool?
        let assetMainType: String?
        let reference: QuoteReferenceDTO?
        let quote: QuoteFieldsDTO
        let fundamental: QuoteFundamentalDTO?

        enum CodingKeys: String, CodingKey {
            case symbol, realtime, assetMainType, reference, quote, fundamental
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            symbol = try values.decodeIfPresent(String.self, forKey: .symbol)
            realtime = try values.decodeIfPresent(Bool.self, forKey: .realtime)
            assetMainType = try values.decodeIfPresent(String.self, forKey: .assetMainType)
            reference = try values.decodeIfPresent(QuoteReferenceDTO.self, forKey: .reference)
            quote = try values.decode(QuoteFieldsDTO.self, forKey: .quote)
            // Optional fundamental metadata must not discard a valid executable quote.
            fundamental = try? values.decode(QuoteFundamentalDTO.self, forKey: .fundamental)
        }
    }

    private struct QuoteFundamentalDTO: Decodable {
        let peRatio: Double?
        let avg10DaysVolume: Double?

        enum CodingKeys: String, CodingKey { case peRatio, avg10DaysVolume }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            let ratio = try? values.decode(Double.self, forKey: .peRatio)
            peRatio = ratio.flatMap { $0.isFinite ? $0 : nil }
            let volume = try? values.decode(Double.self, forKey: .avg10DaysVolume)
            avg10DaysVolume = volume.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        }
    }

    private struct QuoteReferenceDTO: Decodable {
        let description: String?
    }

    private struct QuoteFieldsDTO: Decodable {
        let lastPrice: Double?
        let bidPrice: Double?
        let askPrice: Double?
        let netChange: Double?
        let netPercentChange: Double?
        let quoteTime: Double?
        let openPrice: Double?
        let highPrice: Double?
        let lowPrice: Double?
        let closePrice: Double?
        let totalVolume: Double?
        let fiftyTwoWeekHigh: Double?
        let fiftyTwoWeekLow: Double?
        let securityStatus: String?

        enum CodingKeys: String, CodingKey {
            case lastPrice, bidPrice, askPrice, netChange, netPercentChange, quoteTime
            case openPrice, highPrice, lowPrice, closePrice, totalVolume, securityStatus
            case fiftyTwoWeekHigh = "52WeekHigh"
            case fiftyTwoWeekLow = "52WeekLow"
        }
    }

    private struct QuoteEntryDTO: Decodable {
        let value: QuoteDTO?

        init(from decoder: Decoder) throws {
            // An invalid symbol or provider metadata must not discard other quotes.
            value = try? QuoteDTO(from: decoder)
        }
    }

    static func decodeQuotes(_ data: Data, symbols: [String]) throws -> [StockQuote] {
        do {
            let payload = try JSONDecoder().decode([String: QuoteEntryDTO].self, from: data)
            let quotes = symbols.compactMap { symbol -> StockQuote? in
                guard let dto = payload[symbol]?.value, dto.symbol == nil || dto.symbol == symbol else {
                    return nil
                }
                let fields = dto.quote
                let quoteTime = fields.quoteTime.flatMap { milliseconds -> Date? in
                    guard milliseconds.isFinite, milliseconds > 0 else { return nil }
                    return Date(timeIntervalSince1970: milliseconds / 1_000)
                }
                return StockQuote(symbol: symbol, description: dto.reference?.description,
                                  lastPrice: fields.lastPrice, bidPrice: fields.bidPrice, askPrice: fields.askPrice,
                                  netChange: fields.netChange, netPercentChange: fields.netPercentChange,
                                  quoteTime: quoteTime, isRealtime: dto.realtime, assetMainType: dto.assetMainType,
                                  openPrice: fields.openPrice, highPrice: fields.highPrice, lowPrice: fields.lowPrice,
                                  closePrice: fields.closePrice, totalVolume: fields.totalVolume,
                                  high52Week: fields.fiftyTwoWeekHigh, low52Week: fields.fiftyTwoWeekLow,
                                  securityStatus: fields.securityStatus,
                                  peRatio: dto.fundamental?.peRatio,
                                  averageVolume10Day: dto.fundamental?.avg10DaysVolume)
            }
            guard !quotes.isEmpty else { throw SchwabClientError.invalidResponse }
            return quotes
        } catch { throw SchwabClientError.invalidResponse }
    }
}
