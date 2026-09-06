import SwiftUI

@main
struct THSApp: App {
    @State private var store = AppStore()

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
