import Foundation
import XCTest
@testable import THS

@MainActor
final class PersonalConfigurationTests: XCTestCase {
    func testValidXMLAndBinaryConfigurationsPreserveBothCredentials() throws {
        let configuration = PersonalSchwabConfiguration(clientID: "fixture-personal-client", clientSecret: "fixture:personal-secret")
        for format in [PropertyListSerialization.PropertyListFormat.xml, .binary] {
            let encoder = PropertyListEncoder()
            encoder.outputFormat = format
            let decoded = try PersonalSchwabConfiguration.decode(encoder.encode(configuration))
            XCTAssertEqual(decoded, configuration)
            XCTAssertEqual(decoded.schemaVersion, 1)
        }
    }

    func testFirstLoadImportsAndPersistsConfigurationOnlyOnce() async throws {
        let vault = PersonalConfigurationVault()
        let loader = PersonalConfigurationLoader()
        let transport = PersonalConfigurationTransport()
        let client = makeClient(vault: vault, loader: loader, transport: transport)

        let status = try await client.sessionStatus()
        XCTAssertTrue(status.configured)
        XCTAssertFalse(status.authenticated)
        XCTAssertNil(status.expiresAt)
        let saved = try storedObject(vault)
        assertCredentials(saved, equalTo: PersonalConfigurationFixture.configuration)
        XCTAssertNil(saved["token"])
        XCTAssertNil(saved["pending"])
        XCTAssertNil(saved["personalConfigurationDisabled"])
        XCTAssertEqual(vault.writeCount(), 1)

        let repeated = try await client.sessionStatus()
        XCTAssertTrue(repeated.configured)
        XCTAssertEqual(loader.callCount(), 1)
        XCTAssertEqual(vault.readCount(), 1)
        XCTAssertEqual(vault.writeCount(), 1)
        let requests = await transport.requestCount()
        XCTAssertEqual(requests, 0)
    }

    func testRestartPrefersSavedCredentialsWithoutReadingTheBundleAgain() async throws {
        let vault = PersonalConfigurationVault()
        let client = makeClient(vault: vault, loader: PersonalConfigurationLoader())
        let firstStatus = try await client.sessionStatus()
        XCTAssertTrue(firstStatus.configured)
        let saved = try XCTUnwrap(vault.snapshot())
        let writes = vault.writeCount()
        let loader = PersonalConfigurationLoader()
        loader.failNextLoad()
        let transport = PersonalConfigurationTransport()
        let restarted = makeClient(vault: vault, loader: loader, transport: transport)

        let status = try await restarted.sessionStatus()
        XCTAssertTrue(status.configured)
        XCTAssertFalse(status.authenticated)
        XCTAssertEqual(loader.callCount(), 0)
        XCTAssertEqual(vault.snapshot(), saved)
        XCTAssertEqual(vault.writeCount(), writes)
        let requests = await transport.requestCount()
        XCTAssertEqual(requests, 0)
    }

    func testManualOverrideSurvivesRestartWithoutReimportingPersonalCredentials() async throws {
        let vault = PersonalConfigurationVault()
        let loader = PersonalConfigurationLoader()
        let client = makeClient(vault: vault, loader: loader)
        _ = try await client.sessionStatus()
        let manual = PersonalSchwabConfiguration(clientID: "fixture-manual-client", clientSecret: "fixture-manual-secret")
        try await client.saveCredentials(clientID: manual.clientID, clientSecret: manual.clientSecret)
        assertCredentials(try storedObject(vault), equalTo: manual)

        let restartLoader = PersonalConfigurationLoader()
        let restarted = makeClient(vault: vault, loader: restartLoader)
        let status = try await restarted.sessionStatus()
        XCTAssertTrue(status.configured)
        XCTAssertFalse(status.authenticated)
        let authorizationURL = try await restarted.beginAuthorization()
        let items = URLComponents(url: authorizationURL, resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(items?.first { $0.name == "client_id" }?.value, manual.clientID)
        assertCredentials(try storedObject(vault), equalTo: manual)
        XCTAssertEqual(loader.callCount(), 1)
        XCTAssertEqual(restartLoader.callCount(), 0)
    }

    func testExplicitDeletionRemovesTheWholeSessionAndPreventsImportAfterRestart() async throws {
        let vault = PersonalConfigurationVault(data: try legacySession())
        let loader = PersonalConfigurationLoader()
        let transport = PersonalConfigurationTransport()
        let client = makeClient(vault: vault, loader: loader, transport: transport)
        let initial = try await client.sessionStatus()
        XCTAssertTrue(initial.configured)
        XCTAssertTrue(initial.authenticated)
        let before = try storedObject(vault)
        XCTAssertNotNil(before["credentials"])
        XCTAssertNotNil(before["token"])
        XCTAssertNotNil(before["pending"])

        try await client.clearCredentials()
        assertOnlyOptOut(try storedObject(vault))
        let cleared = try await client.sessionStatus()
        XCTAssertFalse(cleared.configured)
        XCTAssertFalse(cleared.authenticated)
        XCTAssertNil(cleared.expiresAt)

        let restartLoader = PersonalConfigurationLoader()
        let restarted = makeClient(vault: vault, loader: restartLoader, transport: transport)
        let status = try await restarted.sessionStatus()
        XCTAssertFalse(status.configured)
        XCTAssertFalse(status.authenticated)
        XCTAssertNil(status.expiresAt)
        await assertFailure(.credentialsRequired) { _ = try await restarted.beginAuthorization() }
        XCTAssertEqual(loader.callCount(), 0)
        XCTAssertEqual(restartLoader.callCount(), 0)
        XCTAssertEqual(vault.clearCount(), 0)
        assertOnlyOptOut(try storedObject(vault))
        let requests = await transport.requestCount()
        XCTAssertEqual(requests, 0)
    }

    func testDeletionBeforeFirstLoadDoesNotReadAnInvalidSessionOrBundledConfiguration() async throws {
        let vault = PersonalConfigurationVault(data: Data("fixture-private-invalid-session".utf8))
        let loader = PersonalConfigurationLoader()
        loader.failNextLoad()
        let client = makeClient(vault: vault, loader: loader)

        try await client.clearCredentials()
        XCTAssertEqual(vault.readCount(), 0)
        XCTAssertEqual(loader.callCount(), 0)
        assertOnlyOptOut(try storedObject(vault))
        let status = try await client.sessionStatus()
        XCTAssertFalse(status.configured)
        XCTAssertFalse(status.authenticated)
        XCTAssertEqual(vault.readCount(), 0)
    }

    func testManualSaveAfterOptOutIsRetainedOnRestart() async throws {
        let vault = PersonalConfigurationVault(data: Data("{\"personalConfigurationDisabled\":true}".utf8))
        let loader = PersonalConfigurationLoader()
        let client = makeClient(vault: vault, loader: loader)
        let manual = PersonalSchwabConfiguration(clientID: "fixture-new-manual-client", clientSecret: "fixture-new-manual-secret")
        try await client.saveCredentials(clientID: manual.clientID, clientSecret: manual.clientSecret)
        let restarted = makeClient(vault: vault, loader: loader)

        let status = try await restarted.sessionStatus()
        XCTAssertTrue(status.configured)
        XCTAssertFalse(status.authenticated)
        XCTAssertEqual(loader.callCount(), 0)
        assertCredentials(try storedObject(vault), equalTo: manual)
    }

    func testSecureStoreReadFailureDoesNotReadTheBundleAndCanBeRetried() async throws {
        let vault = PersonalConfigurationVault()
        vault.failNextRead()
        let loader = PersonalConfigurationLoader()
        let client = makeClient(vault: vault, loader: loader)

        await assertFailure(.secureStorage) { _ = try await client.sessionStatus() }
        XCTAssertEqual(loader.callCount(), 0)
        XCTAssertEqual(vault.writeCount(), 0)
        XCTAssertNil(vault.snapshot())

        let status = try await client.sessionStatus()
        XCTAssertTrue(status.configured)
        XCTAssertFalse(status.authenticated)
        XCTAssertEqual(loader.callCount(), 1)
        XCTAssertEqual(vault.readCount(), 2)
        assertCredentials(try storedObject(vault), equalTo: PersonalConfigurationFixture.configuration)
    }

    func testFirstImportWriteFailureLeavesStorageUntouchedAndCanBeRetried() async throws {
        let vault = PersonalConfigurationVault()
        vault.failNextWrite()
        let loader = PersonalConfigurationLoader()
        let client = makeClient(vault: vault, loader: loader)

        await assertFailure(.secureStorage) { _ = try await client.sessionStatus() }
        XCTAssertNil(vault.snapshot())
        XCTAssertEqual(loader.callCount(), 1)
        XCTAssertEqual(vault.writeCount(), 1)

        let status = try await client.sessionStatus()
        XCTAssertTrue(status.configured)
        XCTAssertFalse(status.authenticated)
        XCTAssertEqual(loader.callCount(), 2)
        XCTAssertEqual(vault.writeCount(), 2)
        assertCredentials(try storedObject(vault), equalTo: PersonalConfigurationFixture.configuration)
        _ = try await client.sessionStatus()
        XCTAssertEqual(loader.callCount(), 2)
        XCTAssertEqual(vault.writeCount(), 2)
    }

    func testBundleReadFailureIsRedactedAndCanBeRetriedOnTheSameClient() async throws {
        let vault = PersonalConfigurationVault()
        let loader = PersonalConfigurationLoader()
        loader.failNextLoad()
        let client = makeClient(vault: vault, loader: loader)

        await assertFailure(.invalidPersonalConfiguration) { _ = try await client.sessionStatus() }
        XCTAssertNil(vault.snapshot())
        XCTAssertEqual(vault.writeCount(), 0)
        let status = try await client.sessionStatus()
        XCTAssertTrue(status.configured)
        XCTAssertEqual(loader.callCount(), 2)
        XCTAssertEqual(vault.writeCount(), 1)
    }

    func testLegacyJSONWithoutOptOutRetainsTokensAndPendingAuthorization() async throws {
        let vault = PersonalConfigurationVault(data: try legacySession())
        let loader = PersonalConfigurationLoader()
        loader.failNextLoad()
        let transport = PersonalConfigurationTransport(tokenResponse: true)
        let client = makeClient(vault: vault, loader: loader, transport: transport)

        let status = try await client.sessionStatus()
        XCTAssertTrue(status.configured)
        XCTAssertTrue(status.authenticated)
        XCTAssertEqual(status.expiresAt, PersonalConfigurationFixture.now.addingTimeInterval(1_800))
        XCTAssertEqual(loader.callCount(), 0)
        XCTAssertEqual(vault.writeCount(), 0)
        try await client.completeAuthorization(callbackURL: "https://127.0.0.1/?code=fixture-legacy-code&state=fixture-legacy-state")
        let completed = try await client.sessionStatus()
        XCTAssertTrue(completed.authenticated)
        let saved = try storedObject(vault)
        XCTAssertNil(saved["pending"])
        XCTAssertEqual((saved["token"] as? [String: Any])?["accessToken"] as? String, "fixture-new-access")
        XCTAssertEqual(loader.callCount(), 0)
        let requests = await transport.requestCount()
        XCTAssertEqual(requests, 1)
    }

    func testLegacyEmptySessionCanImportPersonalConfiguration() async throws {
        let vault = PersonalConfigurationVault(data: Data("{}".utf8))
        let loader = PersonalConfigurationLoader()
        let client = makeClient(vault: vault, loader: loader)
        let status = try await client.sessionStatus()

        XCTAssertTrue(status.configured)
        XCTAssertFalse(status.authenticated)
        XCTAssertEqual(loader.callCount(), 1)
        assertCredentials(try storedObject(vault), equalTo: PersonalConfigurationFixture.configuration)
    }

    func testMalformedStoredSessionIsNotOverwrittenByBundledCredentials() async throws {
        let original = Data("fixture-private-malformed-session".utf8)
        let vault = PersonalConfigurationVault(data: original)
        let loader = PersonalConfigurationLoader()
        let client = makeClient(vault: vault, loader: loader)

        await assertFailure(.secureStorage) { _ = try await client.sessionStatus() }
        XCTAssertEqual(vault.snapshot(), original)
        XCTAssertEqual(loader.callCount(), 0)
        XCTAssertEqual(vault.writeCount(), 0)
    }

    func testMissingConfigurationLeavesManualSetupAvailable() async throws {
        let vault = PersonalConfigurationVault()
        let loader = PersonalConfigurationLoader(configuration: nil)
        let transport = PersonalConfigurationTransport()
        let client = makeClient(vault: vault, loader: loader, transport: transport)
        let initial = try await client.sessionStatus()
        XCTAssertFalse(initial.configured)
        XCTAssertFalse(initial.authenticated)
        XCTAssertNil(initial.expiresAt)
        XCTAssertNil(vault.snapshot())
        await assertFailure(.credentialsRequired) { _ = try await client.beginAuthorization() }

        let manual = PersonalSchwabConfiguration(clientID: "fixture-manual-only-client", clientSecret: "fixture-manual-only-secret")
        try await client.saveCredentials(clientID: manual.clientID, clientSecret: manual.clientSecret)
        let saved = try await client.sessionStatus()
        XCTAssertTrue(saved.configured)
        XCTAssertFalse(saved.authenticated)
        assertCredentials(try storedObject(vault), equalTo: manual)
        XCTAssertEqual(loader.callCount(), 1)
        let requests = await transport.requestCount()
        XCTAssertEqual(requests, 0)
    }

    func testInvalidSchemaVersionsAreRejectedWithOnlyTheSanitizedError() throws {
        for version in [-1, 0, 2, Int.max] {
            assertConfigurationRejected(try configurationData(overrides: ["schemaVersion": version]))
        }
    }

    func testMissingAndWrongTypeFieldsAreRejectedWithoutLeakingCredentials() throws {
        for field in ["schemaVersion", "clientID", "clientSecret"] {
            assertConfigurationRejected(try configurationData(removing: [field]))
        }
        let invalidFields: [[String: Any]] = [
            ["schemaVersion": "1"], ["schemaVersion": 1.5],
            ["clientID": 123], ["clientID": ["fixture-private-value"]],
            ["clientSecret": false], ["clientSecret": ["value": "fixture-private-value"]]
        ]
        for fields in invalidFields {
            assertConfigurationRejected(try configurationData(overrides: fields))
        }
    }

    func testColonInClientIDIsRejected() throws {
        assertConfigurationRejected(try configurationData(overrides: ["clientID": "fixture-private:client"]))
    }

    func testEmptyWhitespaceAndControlCharactersAreRejectedInBothCredentials() throws {
        let invalid = ["", " ", " fixture-private", "fixture-private ", "fixture private",
                       "fixture\tprivate", "fixture\nprivate", "fixture\rprivate",
                       "fixture\u{0000}private", "fixture\u{00A0}private"]
        for field in ["clientID", "clientSecret"] {
            for value in invalid {
                assertConfigurationRejected(try configurationData(overrides: [field: value]))
            }
        }
    }

    func testCredentialLengthLimitCountsUTF8BytesForBothFields() throws {
        for field in ["clientID", "clientSecret"] {
            for value in [String(repeating: "a", count: 512), String(repeating: "é", count: 256)] {
                let configuration = try PersonalSchwabConfiguration.decode(configurationData(overrides: [field: value]))
                XCTAssertEqual(field == "clientID" ? configuration.clientID : configuration.clientSecret, value)
            }
            for value in [String(repeating: "a", count: 513), String(repeating: "é", count: 257)] {
                assertConfigurationRejected(try configurationData(overrides: [field: value]))
            }
        }
    }

    func testOversizedAndMalformedPropertyListsReturnOnlyTheSanitizedError() {
        let malformed = [Data(), Data(repeating: 65, count: 4_097),
                         Data("<plist><dict><key>clientSecret</key><string>fixture-private-secret".utf8),
                         Data("bplist00fixture-private-broken-binary".utf8)]
        for data in malformed { assertConfigurationRejected(data) }
    }

    func testInvalidConfigurationIsNeverPersistedOrSentAndDoesNotCacheSuccess() async throws {
        let invalid = PersonalSchwabConfiguration(clientID: "fixture-private:invalid", clientSecret: "fixture-private-secret")
        let vault = PersonalConfigurationVault()
        let loader = PersonalConfigurationLoader(configuration: invalid)
        let transport = PersonalConfigurationTransport()
        let client = makeClient(vault: vault, loader: loader, transport: transport)
        for _ in 0..<2 {
            await assertFailure(.invalidPersonalConfiguration) { _ = try await client.sessionStatus() }
        }
        XCTAssertEqual(loader.callCount(), 2)
        XCTAssertNil(vault.snapshot())
        XCTAssertEqual(vault.writeCount(), 0)
        let requests = await transport.requestCount()
        XCTAssertEqual(requests, 0)
    }

    func testAppStoreRetriesFailedSecureReadAndOpensConnectionAfterImport() async throws {
        let vault = PersonalConfigurationVault()
        vault.failNextRead()
        try await assertAppStoreRetries(vault: vault, expectedLoaderCallsAfterFailure: 0)
    }

    func testAppStoreRetriesFailedFirstImportWriteAndOpensConnectionAfterImport() async throws {
        let vault = PersonalConfigurationVault()
        vault.failNextWrite()
        try await assertAppStoreRetries(vault: vault, expectedLoaderCallsAfterFailure: 1)
    }

    func testAppStoreRetryAfterEnteringDemoKeepsWatchlistAndDemoDataWithoutNetwork() async throws {
        let vault = PersonalConfigurationVault()
        vault.failNextRead()
        let loader = PersonalConfigurationLoader()
        let transport = PersonalConfigurationTransport()
        let suite = "ths.personal-configuration-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppStore(client: makeClient(vault: vault, loader: loader, transport: transport),
                           defaults: defaults, operationStore: PersonalConfigurationVault())

        await app.load()
        XCTAssertFalse(app.hasLoadedSession)
        XCTAssertFalse(app.isBusy)
        XCTAssertEqual(app.errorMessage, SchwabClientError.secureStorage.localizedDescription)
        XCTAssertEqual(loader.callCount(), 0)

        await app.setDemoMode(true)
        app.activeTab = .watchlist
        XCTAssertTrue(app.isDemo)
        XCTAssertFalse(app.hasLoadedSession)
        XCTAssertFalse(app.accounts.isEmpty)
        XCTAssertFalse(app.quotes.isEmpty)
        let accountIDs = app.accounts.map(\.id)
        let quoteSymbols = app.quotes.map(\.symbol)
        let orderIDs = app.orders.map(\.id)
        let selectedAccountID = app.selectedAccountID
        let demoNotice = app.statusMessage

        await app.load()
        XCTAssertTrue(app.hasLoadedSession)
        XCTAssertFalse(app.isBusy)
        XCTAssertTrue(app.isConfigured)
        XCTAssertFalse(app.isAuthenticated)
        XCTAssertTrue(app.isDemo)
        XCTAssertEqual(app.activeTab, .watchlist)
        XCTAssertEqual(app.accounts.map(\.id), accountIDs)
        XCTAssertEqual(app.quotes.map(\.symbol), quoteSymbols)
        XCTAssertEqual(app.orders.map(\.id), orderIDs)
        XCTAssertEqual(app.selectedAccountID, selectedAccountID)
        XCTAssertEqual(app.statusMessage, demoNotice)
        XCTAssertNil(app.errorMessage)
        XCTAssertEqual(loader.callCount(), 1)
        XCTAssertEqual(vault.writeCount(), 1)
        assertCredentials(try storedObject(vault), equalTo: PersonalConfigurationFixture.configuration)
        let requests = await transport.requestCount()
        XCTAssertEqual(requests, 0)
    }

    private func assertAppStoreRetries(vault: PersonalConfigurationVault, expectedLoaderCallsAfterFailure: Int) async throws {
        let loader = PersonalConfigurationLoader()
        let transport = PersonalConfigurationTransport()
        let suite = "ths.personal-configuration-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppStore(client: makeClient(vault: vault, loader: loader, transport: transport),
                           defaults: defaults, operationStore: PersonalConfigurationVault())

        await app.load()
        XCTAssertFalse(app.hasLoadedSession)
        XCTAssertFalse(app.isBusy)
        XCTAssertFalse(app.isConfigured)
        XCTAssertFalse(app.isAuthenticated)
        XCTAssertEqual(app.errorMessage, SchwabClientError.secureStorage.localizedDescription)
        XCTAssertEqual(loader.callCount(), expectedLoaderCallsAfterFailure)
        XCTAssertNil(vault.snapshot())

        await app.load()
        XCTAssertTrue(app.hasLoadedSession)
        XCTAssertFalse(app.isBusy)
        XCTAssertTrue(app.isConfigured)
        XCTAssertFalse(app.isAuthenticated)
        XCTAssertFalse(app.isDemo)
        XCTAssertEqual(app.activeTab, .connection)
        XCTAssertNil(app.errorMessage)
        XCTAssertTrue(app.accounts.isEmpty)
        XCTAssertTrue(app.quotes.isEmpty)
        XCTAssertEqual(loader.callCount(), expectedLoaderCallsAfterFailure + 1)
        assertCredentials(try storedObject(vault), equalTo: PersonalConfigurationFixture.configuration)

        let calls = loader.callCount()
        let writes = vault.writeCount()
        await app.load()
        XCTAssertEqual(loader.callCount(), calls)
        XCTAssertEqual(vault.writeCount(), writes)
        let requests = await transport.requestCount()
        XCTAssertEqual(requests, 0)
    }

    private func makeClient(vault: PersonalConfigurationVault, loader: PersonalConfigurationLoader,
                            transport: PersonalConfigurationTransport = PersonalConfigurationTransport()) -> SchwabClient {
        SchwabClient(store: vault, transport: transport, now: { PersonalConfigurationFixture.now },
                     personalConfiguration: { try loader.load() })
    }

    private func storedObject(_ vault: PersonalConfigurationVault) throws -> [String: Any] {
        let data = try XCTUnwrap(vault.snapshot())
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func assertCredentials(_ object: [String: Any], equalTo configuration: PersonalSchwabConfiguration,
                                   file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(object["credentials"] as? [String: String],
                       ["clientID": configuration.clientID, "clientSecret": configuration.clientSecret], file: file, line: line)
    }

    private func assertOnlyOptOut(_ object: [String: Any], file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(Set(object.keys), ["personalConfigurationDisabled"], file: file, line: line)
        XCTAssertEqual(object["personalConfigurationDisabled"] as? Bool, true, file: file, line: line)
    }

    private func legacySession() throws -> Data {
        let object: [String: Any] = [
            "credentials": ["clientID": "fixture-legacy-client", "clientSecret": "fixture-legacy-secret"],
            "token": ["accessToken": "fixture-legacy-access", "refreshToken": "fixture-legacy-refresh",
                      "expiresAt": PersonalConfigurationFixture.now.addingTimeInterval(1_800).timeIntervalSinceReferenceDate],
            "pending": ["state": "fixture-legacy-state", "createdAt": PersonalConfigurationFixture.now.timeIntervalSinceReferenceDate]
        ]
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func configurationData(overrides: [String: Any] = [:], removing: [String] = []) throws -> Data {
        var object: [String: Any] = ["schemaVersion": 1, "clientID": "fixture-private-client", "clientSecret": "fixture-private-secret"]
        for (key, value) in overrides { object[key] = value }
        for key in removing { object.removeValue(forKey: key) }
        return try PropertyListSerialization.data(fromPropertyList: object, format: .binary, options: 0)
    }

    private func assertConfigurationRejected(_ data: Data, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try PersonalSchwabConfiguration.decode(data), file: file, line: line) { error in
            XCTAssertEqual(error as? SchwabClientError, .invalidPersonalConfiguration, file: file, line: line)
            XCTAssertEqual(error.localizedDescription, SchwabClientError.invalidPersonalConfiguration.localizedDescription,
                           file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("fixture-private"), file: file, line: line)
        }
    }

    private func assertFailure(_ expected: SchwabClientError, file: StaticString = #filePath, line: UInt = #line,
                               operation: () async throws -> Void) async {
        do {
            try await operation()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? SchwabClientError, expected, file: file, line: line)
            XCTAssertEqual(error.localizedDescription, expected.localizedDescription, file: file, line: line)
            XCTAssertFalse(error.localizedDescription.contains("fixture-private"), file: file, line: line)
        }
    }
}

private enum PersonalConfigurationFixture {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)
    static let configuration = PersonalSchwabConfiguration(clientID: "fixture-personal-client", clientSecret: "fixture-personal-secret")
}

private final class PersonalConfigurationVault: SchwabSecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    private var reads = 0
    private var writes = 0
    private var clears = 0
    private var failRead = false
    private var failWrite = false

    init(data: Data? = nil) { self.data = data }
    func read() throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        reads += 1
        if failRead { failRead = false; throw PersonalConfigurationFixtureError.privateStorage }
        return data
    }
    func write(_ data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        writes += 1
        if failWrite { failWrite = false; throw PersonalConfigurationFixtureError.privateStorage }
        self.data = data
    }
    func clear() throws {
        lock.lock(); defer { lock.unlock() }
        clears += 1
        data = nil
    }
    func snapshot() -> Data? { lock.lock(); defer { lock.unlock() }; return data }
    func readCount() -> Int { lock.lock(); defer { lock.unlock() }; return reads }
    func writeCount() -> Int { lock.lock(); defer { lock.unlock() }; return writes }
    func clearCount() -> Int { lock.lock(); defer { lock.unlock() }; return clears }
    func failNextRead() { lock.lock(); defer { lock.unlock() }; failRead = true }
    func failNextWrite() { lock.lock(); defer { lock.unlock() }; failWrite = true }
}

private final class PersonalConfigurationLoader: @unchecked Sendable {
    private let lock = NSLock()
    private let configuration: PersonalSchwabConfiguration?
    private var calls = 0
    private var failLoad = false

    init(configuration: PersonalSchwabConfiguration? = PersonalConfigurationFixture.configuration) {
        self.configuration = configuration
    }
    func load() throws -> PersonalSchwabConfiguration? {
        lock.lock(); defer { lock.unlock() }
        calls += 1
        if failLoad { failLoad = false; throw PersonalConfigurationFixtureError.privateBundle }
        return configuration
    }
    func callCount() -> Int { lock.lock(); defer { lock.unlock() }; return calls }
    func failNextLoad() { lock.lock(); defer { lock.unlock() }; failLoad = true }
}

private enum PersonalConfigurationFixtureError: Error, LocalizedError, Sendable {
    case privateStorage, privateBundle, unexpectedRequest
    var errorDescription: String? {
        switch self {
        case .privateStorage: return "fixture-private-storage-detail"
        case .privateBundle: return "fixture-private-bundle-path-and-secret"
        case .unexpectedRequest: return "fixture-private-unexpected-request"
        }
    }
}

private actor PersonalConfigurationTransport: SchwabHTTPTransport {
    private let tokenResponse: Bool
    private var requests = 0
    init(tokenResponse: Bool = false) { self.tokenResponse = tokenResponse }
    func requestCount() -> Int { requests }
    func send(_ request: URLRequest) async throws -> SchwabHTTPResponse {
        requests += 1
        guard tokenResponse, requests == 1, request.httpMethod == "POST", request.url?.path == "/v1/oauth/token" else {
            throw PersonalConfigurationFixtureError.unexpectedRequest
        }
        let body = "{\"access_token\":\"fixture-new-access\",\"refresh_token\":\"fixture-new-refresh\",\"expires_in\":1800,\"token_type\":\"Bearer\"}"
        return SchwabHTTPResponse(statusCode: 200, data: Data(body.utf8), elapsedMilliseconds: 1)
    }
}
