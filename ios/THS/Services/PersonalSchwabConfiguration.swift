import Foundation

/// Added to the unsigned personal IPA locally, after the generic app is built.
struct PersonalSchwabConfiguration: Codable, Equatable, Sendable {
    static let resourceName = "SchwabPersonalConfiguration"
    let schemaVersion: Int
    let clientID: String
    let clientSecret: String

    init(clientID: String, clientSecret: String) {
        self.schemaVersion = 1
        self.clientID = clientID
        self.clientSecret = clientSecret
    }

    static func load(bundle: Bundle = .main) throws -> Self? {
        guard let url = bundle.url(forResource: resourceName, withExtension: "plist") else { return nil }
        do { return try decode(Data(contentsOf: url)) }
        catch { throw SchwabClientError.invalidPersonalConfiguration }
    }

    static func decode(_ data: Data) throws -> Self {
        do {
            guard data.count <= 4_096 else { throw SchwabClientError.invalidPersonalConfiguration }
            return try PropertyListDecoder().decode(Self.self, from: data).validated()
        } catch { throw SchwabClientError.invalidPersonalConfiguration }
    }

    func validated() throws -> Self {
        guard schemaVersion == 1, SchwabClient.validCredential(clientID), !clientID.contains(":"),
              SchwabClient.validCredential(clientSecret) else {
            throw SchwabClientError.invalidPersonalConfiguration
        }
        return self
    }
}
