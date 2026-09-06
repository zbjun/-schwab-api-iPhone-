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
        case .redirectRejected: return "Schwab API 返回了非预期跳转，请稍后重试。"
        case .httpStatus(let status):
            switch status {
            case 400: return "Schwab 未接受请求，请检查应用配置或重新授权（HTTP 400）。"
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
        guard let url = request.url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "https", components.host == "api.schwabapi.com",
              components.port == nil, components.user == nil, components.password == nil,
              components.fragment == nil else { throw SchwabClientError.invalidResponse }
        let items = components.queryItems ?? []
        let allowed: Bool
        switch (request.httpMethod ?? "GET", components.path) {
        case ("POST", "/v1/oauth/token"):
            allowed = items.isEmpty
        case ("GET", "/trader/v1/accounts"):
            allowed = items.count == 1 && items[0].name == "fields" && items[0].value == "positions"
        case ("GET", "/marketdata/v1/quotes"):
            allowed = items.count == 1 && items[0].name == "symbols" && !(items[0].value ?? "").isEmpty
        default: allowed = false
        }
        guard allowed else { throw SchwabClientError.invalidResponse }
        let started = ProcessInfo.processInfo.systemUptime
        do {
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse, data.count <= 8 * 1_024 * 1_024 else {
                throw SchwabClientError.invalidResponse
            }
            guard !(300..<400).contains(response.statusCode) else {
                throw SchwabClientError.redirectRejected
            }
            return SchwabHTTPResponse(statusCode: response.statusCode, data: data,
                                      elapsedMilliseconds: (ProcessInfo.processInfo.systemUptime - started) * 1_000)
        } catch let error as SchwabClientError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw SchwabClientError.network
        }
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

    private func read(path: String, query: [URLQueryItem]) async throws -> SchwabHTTPResponse {
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

    private struct QuoteDTO: Decodable {
        let symbol: String?
        let realtime: Bool?
        let reference: QuoteReferenceDTO?
        let quote: QuoteFieldsDTO
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
                                  quoteTime: quoteTime, isRealtime: dto.realtime)
            }
            guard !quotes.isEmpty else { throw SchwabClientError.invalidResponse }
            return quotes
        } catch { throw SchwabClientError.invalidResponse }
    }
}
