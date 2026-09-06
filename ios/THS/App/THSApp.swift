import SwiftUI

@main
struct THSApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = Self.makeStore()

    @MainActor static func makeStore(arguments: [String] = ProcessInfo.processInfo.arguments) -> AppStore {
        #if DEBUG
        if arguments.contains("--uitesting-demo") {
            let emptyStore = UITestEmptySecureStore()
            return AppStore(
                client: SchwabClient(store: emptyStore, transport: UITestOfflineTransport()),
                defaults: UserDefaults(suiteName: "ths.ui-tests.\(UUID().uuidString)")!,
                operationStore: emptyStore
            )
        }
        if arguments.contains("--uitesting-personal-config") {
            let fixtureStore = UITestMemorySecureStore()
            return AppStore(
                client: SchwabClient(store: fixtureStore, transport: UITestOfflineTransport(),
                    personalConfiguration: {
                        PersonalSchwabConfiguration(clientID: "fixture-client", clientSecret: "fixture-secret")
                    }),
                defaults: UserDefaults(suiteName: "ths.ui-tests.\(UUID().uuidString)")!,
                operationStore: UITestEmptySecureStore()
            )
        }
        #endif
        return AppStore(client: SchwabClient(personalConfiguration: { try PersonalSchwabConfiguration.load() }))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .task {
                    #if DEBUG
                    let arguments = ProcessInfo.processInfo.arguments
                    if arguments.contains("--uitesting-demo") {
                        let index = arguments.firstIndex(of: "--snapshot-tab")
                        let tab = index.flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
                        await store.loadUITestDemo(tab: tab)
                        return
                    }
                    #endif
                    await store.load()
                }
                .onChange(of: scenePhase) { _, phase in
                    #if DEBUG
                    // Demo UI fixtures have a separate, single initialization path above.
                    if ProcessInfo.processInfo.arguments.contains("--uitesting-demo") { return }
                    #endif
                    if phase == .active { Task { await store.load() } }
                }
        }
    }
}

#if DEBUG
private final class UITestMemorySecureStore: SchwabSecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    func read() throws -> Data? { lock.lock(); defer { lock.unlock() }; return data }
    func write(_ value: Data) throws { lock.lock(); defer { lock.unlock() }; data = value }
    func clear() throws { lock.lock(); defer { lock.unlock() }; data = nil }
}

// UI fixtures never read the device's session, pending operation, or network.
private struct UITestEmptySecureStore: SchwabSecureStore {
    func read() throws -> Data? { nil }
    func write(_ data: Data) throws { throw SchwabClientError.secureStorage }
    func clear() throws {}
}

private struct UITestOfflineTransport: SchwabHTTPTransport {
    func send(_ request: URLRequest) async throws -> SchwabHTTPResponse {
        throw SchwabClientError.network
    }
}
#endif
