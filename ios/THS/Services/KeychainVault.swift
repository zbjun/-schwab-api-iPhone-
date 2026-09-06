import Foundation
import Security

/// One Keychain item makes credentials, tokens, and pending OAuth state an atomic update.
protocol SchwabSecureStore: Sendable {
    func read() throws -> Data?
    func write(_ data: Data) throws
    func clear() throws
}

struct KeychainVault: SchwabSecureStore {
    private let service: String
    private let account: String

    init(service: String = "THS.Schwab", account: String = "personal-session") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    func read() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw SchwabClientError.secureStorage
        }
        return data
    }

    func write(_ data: Data) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var newItem = query
            attributes.forEach { newItem[$0.key] = $0.value }
            guard SecItemAdd(newItem as CFDictionary, nil) == errSecSuccess else {
                throw SchwabClientError.secureStorage
            }
        } else if status != errSecSuccess {
            throw SchwabClientError.secureStorage
        }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SchwabClientError.secureStorage
        }
    }
}
