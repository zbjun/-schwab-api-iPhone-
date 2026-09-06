import SwiftUI

struct ConnectionView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var clientID = ""
    @State private var clientSecret = ""
    @State private var callbackURL = ""
    @State private var isEditingCredentials = false
    @State private var isConfirmingCredentialRemoval = false
    @State private var isConfirmingDisconnect = false
    @State private var browserError: String?
    @FocusState private var focusedField: Field?
    private enum Field: Hashable { case clientID, secret, callback }
    private var locked: Bool { store.isBusy || store.isSubmittingOrder }
    private var connectionTitle: String {
        if store.isDemo { return "演示模式" }
        if store.isAuthenticated { return "已连接 Schwab" }
        return store.isConfigured ? "等待账户授权" : "连接 Schwab"
    }

    var body: some View {
        NavigationStack {
            Form {
                statusSection
                Section {
                    Toggle(isOn: Binding(get: { store.isDemo }, set: { value in
                        focusedField = nil
                        Task { await store.setDemoMode(value) }
                    })) {
                        Label("演示模式", systemImage: "sparkles")
                    }
                    .disabled(locked).accessibilityIdentifier("connection.demo")
                } footer: {
                    Text("用虚构账户体验查价、图表、下单与撤改。演示操作不会发送给券商。")
                }
                if let error = browserError ?? store.errorMessage {
                    Section { AppMessageView(message: error, isError: true) }
                } else if let message = store.statusMessage {
                    Section { AppMessageView(message: message) }
                }
                if store.isDemo {
                    Section {
                        Label("准备连接真实账户时，关闭上面的演示模式。", systemImage: "info.circle")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                } else if !store.hasLoadedSession {
                    Section {
                        if store.isBusy {
                            ProgressView("正在读取连接配置…")
                        } else {
                            Button("重新读取连接配置") { Task { await store.load() } }
                                .accessibilityIdentifier("connection.retryConfiguration")
                        }
                    }
                } else {
                    if !store.isConfigured || isEditingCredentials { credentialSection }
                    else {
                        Section("应用凭据") {
                            Label("已保存在这台 iPhone", systemImage: "key.fill")
                                .font(.subheadline).accessibilityIdentifier("connection.credentialsSaved")
                            Button("更换应用凭据") { isEditingCredentials = true }
                                .disabled(locked).accessibilityIdentifier("connection.editCredentials")
                        }
                    }
                    if store.isConfigured { authorizationSection }
                }
                privacySection
                if !store.isDemo, store.isAuthenticated || store.isConfigured {
                    Section {
                        if store.isAuthenticated {
                            Button("断开本机账户授权") { isConfirmingDisconnect = true }
                                .disabled(locked).accessibilityIdentifier("connection.disconnect")
                        }
                        if store.isConfigured {
                            Button("删除本机应用凭据", role: .destructive) { isConfirmingCredentialRemoval = true }
                                .disabled(locked).accessibilityIdentifier("connection.removeCredentials")
                        }
                    }
                }
                Section {
                    HStack { Text("THS").fontWeight(.semibold); Spacer(); Text("个人股票 / ETF 交易") }
                        .font(.caption).foregroundStyle(.secondary)
                }.listRowBackground(Color.clear)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("连接")
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("完成") { focusedField = nil } }
            }
            .confirmationDialog("删除这台设备保存的应用凭据？", isPresented: $isConfirmingCredentialRemoval, titleVisibility: .visible) {
                Button("删除凭据并断开连接", role: .destructive) {
                    clearInputs()
                    isEditingCredentials = false
                    Task { await store.removeCredentials() }
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("之后需要重新输入 Client ID 和 Client Secret 才能连接。已有券商订单不会因此撤销。")
            }
            .confirmationDialog("断开本机账户授权？", isPresented: $isConfirmingDisconnect, titleVisibility: .visible) {
                Button("断开本机授权", role: .destructive) {
                    callbackURL = ""
                    Task { await store.disconnect() }
                }
                Button("取消", role: .cancel) {}
            } message: { Text("保留应用凭据，下一次使用时重新登录。券商账户和已有订单不会被修改。") }
            .accessibilityIdentifier("screen.connection")
        }
    }

    private var statusSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 14) {
                    Image(systemName: store.isDemo ? "sparkles" : (store.isAuthenticated ? "checkmark.shield.fill" : "link"))
                        .font(.title2).foregroundStyle(store.isDemo ? Color.orange : Color.blue)
                        .frame(width: 48, height: 48)
                        .background((store.isDemo ? Color.orange : Color.blue).opacity(0.10), in: RoundedRectangle(cornerRadius: 13))
                    VStack(alignment: .leading, spacing: 5) {
                        Text(connectionTitle).font(.headline)
                        Text("你的设备，你的账户")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 10) {
                    Label("iPhone", systemImage: "iphone")
                    Image(systemName: "arrow.right").foregroundStyle(.tertiary)
                    Text("Schwab")
                    Spacer()
                    Text("直连").font(.caption.weight(.semibold)).foregroundStyle(.blue)
                }.font(.subheadline)
                if locked {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text(store.isSubmittingOrder ? "正在处理订单，请稍候…" : "正在处理连接…")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }.padding(.vertical, 8)
        }
    }

    private var credentialSection: some View {
        Section {
            SecureField("Client ID", text: $clientID)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.asciiCapable)
                .focused($focusedField, equals: .clientID).privacySensitive().disabled(locked)
                .accessibilityIdentifier("connection.clientID")
            SecureField("Client Secret", text: $clientSecret)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.asciiCapable)
                .focused($focusedField, equals: .secret).privacySensitive().disabled(locked)
                .accessibilityIdentifier("connection.clientSecret")
            Button("保存应用凭据", action: saveCredentials)
                .disabled(locked || clientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || clientSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("connection.saveCredentials")
            if store.isConfigured {
                Button("取消更换") { clearInputs(); isEditingCredentials = false }.disabled(locked)
            }
        } header: { Text("1 · 应用凭据") }
        footer: { Text("填写 Schwab 开发者后台的 Client ID 和 Client Secret。账户登录密码只在 Schwab 登录页输入。") }
    }

    private var authorizationSection: some View {
        Section {
            Button(action: beginAuthorization) {
                Label(store.isAuthenticated ? "重新授权 Schwab 账户" : "打开 Schwab 登录", systemImage: "arrow.up.forward.square")
            }
            .disabled(locked).accessibilityIdentifier("connection.authorize")
            DisclosureGroup("如何完成授权") {
                VStack(alignment: .leading, spacing: 10) {
                    Text("1. 在 Safari 登录 Schwab 并同意账户授权。")
                    Text("2. 跳转到本机回调地址后，即使页面显示无法连接，也请复制地址栏中的完整链接。")
                    Text("3. 回到这里粘贴链接，点击「完成连接」。")
                }.font(.subheadline).foregroundStyle(.secondary).padding(.vertical, 4)
            }
            SecureField("粘贴完整回调链接", text: $callbackURL)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                .focused($focusedField, equals: .callback).submitLabel(.done).onSubmit(completeAuthorization)
                .privacySensitive().disabled(locked).accessibilityIdentifier("connection.callback")
            HStack {
                PasteButton(payloadType: String.self) { values in if let value = values.first { callbackURL = value } }
                    .disabled(locked)
                Spacer()
                Button("完成连接", action: completeAuthorization)
                    .buttonStyle(.borderedProminent)
                    .disabled(locked || callbackURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("connection.complete")
            }
            DisclosureGroup("开发者后台回调设置") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Callback URL 必须与下面完全一致：")
                    Text("https://127.0.0.1").font(.system(.subheadline, design: .monospaced)).textSelection(.enabled)
                    Text("手动回填不需要自己的域名或服务器。")
                        .foregroundStyle(.secondary)
                }.font(.subheadline).padding(.vertical, 4)
            }
        } header: { Text("2 · 账户授权") }
    }

    private var privacySection: some View {
        Section("保存在你的设备") {
            Label {
                VStack(alignment: .leading, spacing: 5) {
                    Text("凭据与授权存入 iPhone 钥匙串").font(.subheadline)
                    Text("仅此设备、解锁后使用，不通过 iCloud 同步。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } icon: { Image(systemName: "lock.shield").foregroundStyle(.blue) }
            Label {
                VStack(alignment: .leading, spacing: 5) {
                    Text("直接连接 Schwab").font(.subheadline)
                    Text("不经过自建中转服务器；网络质量以手机实际连接为准。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } icon: { Image(systemName: "network").foregroundStyle(.blue) }
        }
    }

    private func clearInputs() { clientID = ""; clientSecret = ""; callbackURL = ""; focusedField = nil }

    private func saveCredentials() {
        let id = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = clientSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, !secret.isEmpty, !locked else { return }
        focusedField = nil
        browserError = nil
        Task {
            if await store.saveCredentials(clientID: id, clientSecret: secret) {
                clearInputs()
                isEditingCredentials = false
            }
        }
    }

    private func beginAuthorization() {
        guard !locked, !store.isDemo else { return }
        callbackURL = ""
        focusedField = nil
        browserError = nil
        Task {
            if let url = await store.beginAuthorization() {
                openURL(url) { accepted in
                    if !accepted { browserError = "无法打开浏览器，请稍后重试。" }
                }
            }
        }
    }

    private func completeAuthorization() {
        let value = callbackURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !locked, !store.isDemo else { return }
        callbackURL = ""
        focusedField = nil
        browserError = nil
        Task { await store.completeAuthorization(callbackURL: value) }
    }
}
