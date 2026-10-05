import Foundation

let collectiblesProductionOrigin = URL(string: "https://julianchow21.github.io/Kujira-Collectibles/")!
let collectiblesProductionPath = "/Kujira-Collectibles/"

enum CollectiblesNavigation {
    static func isTrustedAppURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              components.host?.lowercased() == "julianchow21.github.io",
              components.port == nil || components.port == 443,
              components.user == nil,
              components.password == nil else {
            return false
        }

        let path = components.path
        return path == collectiblesProductionPath || path.hasPrefix(collectiblesProductionPath)
    }

    static func isUserOpenableExternalURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              components.host != nil,
              components.user == nil,
              components.password == nil else {
            return false
        }

        return !isTrustedAppURL(url)
    }

    static func isTrustedBlobURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "blob" else {
            return false
        }

        let raw = url.absoluteString
        guard raw.count > 5 else { return false }
        let embeddedOriginURL = URL(string: String(raw.dropFirst(5)))
        return embeddedOriginURL.map(isTrustedAppURL) ?? false
    }

    static func isTrustedContentURL(_ url: URL) -> Bool {
        isTrustedAppURL(url) || isTrustedBlobURL(url)
    }

    static func isSensitiveURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return true
        }

        return components.user != nil || components.password != nil
    }
}
