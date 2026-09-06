import SwiftUI

struct ConnectionView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var clientID = ""
    @State private var clientSecret = ""
    @State private var callbackURL = ""
    @State private var isEditingCredentials = false
    @State private var isConfirmingCredentialRemoval = false
    @State private var browserError: String?

    private var connectionTitle: String {
        if store.isDemo { return "正在查看演示" }
        if store.isAuthenticated { return "已连接 Schwab" }
        if store.isConfigured { return "等待账户授权" }
        return "连接 Schwab"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(connectionTitle).font(.headline)
                            Text("账户与行情预览")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: store.isDemo ? "sparkles" : (store.isAuthenticated ? "checkmark.circle" : "link"))
                            .foregroundStyle(store.isDemo ? Color.orange : (store.isAuthenticated ? Color.green : Color.accentColor))
                    }
                    LabeledContent("连接方式", value: "iPhone → Schwab")
                    if store.isBusy {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("正在处理…").foregroundStyle(.secondary)
                        }
                    }
                }

                if let error = browserError ?? store.errorMessage {
                    Section { AppMessageView(message: error, isError: true) }
                } else if let status = store.statusMessage {
                    Section { AppMessageView(message: status) }
                }

                if !store.isConfigured || isEditingCredentials {
                    credentialSection
                } else {
                    Section("应用凭据") {
                        Label("已保存到这台设备", systemImage: "key")
                        Button("更换应用凭据") { isEditingCredentials = true }
                            .disabled(store.isBusy)
                    }
                }

                if store.isConfigured {
                    authorizationSection
                }

                Section {
                    Toggle("查看演示数据", isOn: Binding(
                        get: { store.isDemo },
                        set: { value in
                            Task { await store.setDemoMode(value) }
                        }
                    ))
                    .disabled(store.isBusy)
                } footer: {
                    Text("演示模式使用示例账户和行情。")
                }

                if store.isAuthenticated || store.isConfigured {
                    Section {
                        if store.isAuthenticated {
                            Button("断开本机连接") {
                                callbackURL = ""
                                Task { await store.disconnect() }
                            }
                            .disabled(store.isBusy)
                        }
                        if store.isConfigured {
                            Button("删除本机应用凭据", role: .destructive) {
                                isConfirmingCredentialRemoval = true
                            }
                            .disabled(store.isBusy)
                        }
                    }
                }
            }
            .navigationTitle("连接")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { RefreshToolbarButton() }
            }
            .confirmationDialog(
                "删除这台设备保存的应用凭据？",
                isPresented: $isConfirmingCredentialRemoval,
                titleVisibility: .visible
            ) {
                Button("删除凭据并断开连接", role: .destructive) {
                    clientID = ""
                    clientSecret = ""
                    callbackURL = ""
                    isEditingCredentials = false
                    Task { await store.removeCredentials() }
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("之后需要重新输入 Client ID 和 Client Secret 才能连接。")
            }
        }
    }

    private var credentialSection: some View {
        Section {
            SecureField("Client ID", text: $clientID)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .privacySensitive()
            SecureField("Client Secret", text: $clientSecret)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .privacySensitive()

            Button("保存应用凭据", action: saveCredentials)
                .disabled(
                    store.isBusy ||
                    clientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    clientSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            if store.isConfigured {
                Button("取消更换") {
                    clientID = ""
                    clientSecret = ""
                    isEditingCredentials = false
                }
                .disabled(store.isBusy)
            }
        } header: {
            Text("1 · 应用凭据")
        } footer: {
            Text("填写 Schwab 开发者后台的 Client ID 和 Client Secret。这不是券商账户的登录密码。")
        }
    }

    private var authorizationSection: some View {
        Section {
            Button(action: beginAuthorization) {
                Label(
                    store.isAuthenticated ? "重新授权 Schwab 账户" : "打开 Schwab 登录",
                    systemImage: "arrow.up.forward.square"
                )
            }
            .disabled(store.isBusy || store.isDemo)

            VStack(alignment: .leading, spacing: 10) {
                Text("登录并同意授权后，Safari 会跳转到本机回调地址。页面显示无法连接是正常的；复制地址栏中的完整链接，再回到这里粘贴。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                SecureField("粘贴完整回调链接", text: $callbackURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.done)
                    .onSubmit(completeAuthorization)
                    .privacySensitive()

                PasteButton(payloadType: String.self) { values in
                    if let value = values.first { callbackURL = value }
                }
                .disabled(store.isBusy || store.isDemo)

                Button("完成连接", action: completeAuthorization)
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        store.isBusy || store.isDemo ||
                        callbackURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
            }
            .padding(.vertical, 4)

            DisclosureGroup("回调地址设置") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("开发者后台的 Callback URL 需要与下面完全一致：")
                    Text("https://127.0.0.1")
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                    Text("这种手动回填方式不需要自己的域名或服务器。")
                        .foregroundStyle(.secondary)
                }
                .font(.subheadline)
                .padding(.vertical, 4)
            }
        } header: {
            Text("2 · 账户授权")
        }
    }

    private func saveCredentials() {
        let id = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = clientSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, !secret.isEmpty, !store.isBusy else { return }
        clientID = ""
        clientSecret = ""
        callbackURL = ""
        browserError = nil
        Task {
            if await store.saveCredentials(clientID: id, clientSecret: secret) {
                isEditingCredentials = false
            }
        }
    }

    private func beginAuthorization() {
        guard !store.isBusy, !store.isDemo else { return }
        callbackURL = ""
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
        guard !value.isEmpty, !store.isBusy, !store.isDemo else { return }
        callbackURL = ""
        browserError = nil
        Task { await store.completeAuthorization(callbackURL: value) }
    }
}
