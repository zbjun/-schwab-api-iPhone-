import SwiftUI

@main
struct THSApp: App {
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
        #endif
        return AppStore()
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
        }
    }
}

#if DEBUG
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
