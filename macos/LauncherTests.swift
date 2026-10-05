import Foundation

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("launcher-tests=fail: \(message)\n", stderr)
        exit(1)
    }
}

@main
struct LauncherTests {
    static func main() {
        let appURL = collectiblesProductionOrigin
        check(CollectiblesNavigation.isTrustedAppURL(appURL), "production root should be trusted")
        check(
            CollectiblesNavigation.isTrustedAppURL(
                URL(string: "https://julianchow21.github.io/Kujira-Collectibles/Assets/manifest.webmanifest?cache=1")!
            ),
            "production asset should be trusted"
        )
        check(
            !CollectiblesNavigation.isTrustedAppURL(URL(string: "https://julianchow21.github.io/Kujira-Collectibles-evil/")!),
            "lookalike path should be blocked"
        )
        check(
            !CollectiblesNavigation.isTrustedAppURL(URL(string: "https://example.test/Kujira-Collectibles/")!),
            "lookalike host should be blocked"
        )
        check(
            !CollectiblesNavigation.isTrustedAppURL(URL(string: "https://user:password@julianchow21.github.io/Kujira-Collectibles/")!),
            "credential-bearing URL should be blocked"
        )
        check(
            CollectiblesNavigation.isUserOpenableExternalURL(URL(string: "https://tcgplayer.com/")!),
            "ordinary HTTPS link should be openable"
        )
        check(
            CollectiblesNavigation.isUserOpenableExternalURL(URL(string: "http://example.test/")!),
            "ordinary HTTP link should be openable"
        )
        check(
            CollectiblesNavigation.isTrustedBlobURL(
                URL(string: "blob:https://julianchow21.github.io/Kujira-Collectibles/export-123")!
            ),
            "trusted production Blob URL should be recognised"
        )
        check(
            CollectiblesNavigation.isTrustedContentURL(
                URL(string: "blob:https://julianchow21.github.io/Kujira-Collectibles/export-123")!
            ),
            "trusted Blob download should be treated as trusted content"
        )
        check(
            !CollectiblesNavigation.isTrustedBlobURL(URL(string: "blob:https://example.test/Kujira-Collectibles/export-123")!),
            "Blob URL from an untrusted origin should be blocked"
        )
        check(
            !CollectiblesNavigation.isTrustedContentURL(URL(string: "https://example.test/redirected-file.json")!),
            "final response from an untrusted redirect should be blocked"
        )
        check(
            !CollectiblesNavigation.isTrustedBlobURL(URL(string: "blob:null/export-123")!),
            "opaque-origin Blob URL should be blocked"
        )
        check(
            !CollectiblesNavigation.isUserOpenableExternalURL(URL(string: "mailto:test@example.test")!),
            "mailto link should not be handed off"
        )
        check(
            !CollectiblesNavigation.isUserOpenableExternalURL(URL(string: "file:///tmp/export.json")!),
            "file URL should not be handed off"
        )

        print("launcher-tests=pass")
    }
}
