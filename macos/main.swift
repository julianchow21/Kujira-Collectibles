import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        configureMainMenu()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true

        let window = NSWindow(
            contentRect: CollectiblesWindowSizing.defaultFrame(),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Collectibles Desktop"
        window.titleVisibility = .visible
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("CollectiblesDesktopMainWindow")
        window.delegate = self
        window.contentView = webView

        self.window = window
        self.webView = webView

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: collectiblesProductionOrigin))
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            window?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }

        if navigationAction.shouldPerformDownload {
            if CollectiblesNavigation.isTrustedContentURL(url) {
                decisionHandler(.download)
            } else {
                presentBlockedNavigation(for: url)
                decisionHandler(.cancel)
            }
            return
        }

        if CollectiblesNavigation.isTrustedAppURL(url) {
            decisionHandler(.allow)
            return
        }

        if navigationAction.navigationType == .linkActivated,
           CollectiblesNavigation.isUserOpenableExternalURL(url) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }

        presentBlockedNavigation(for: url)
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        guard let responseURL = navigationResponse.response.url else {
            showNotice(title: "Navigation blocked", message: "The production site returned a response without a verifiable URL.")
            decisionHandler(.cancel)
            return
        }

        guard CollectiblesNavigation.isTrustedContentURL(responseURL) else {
            presentBlockedNavigation(for: responseURL)
            decisionHandler(.cancel)
            return
        }

        if CollectiblesNavigation.isTrustedBlobURL(responseURL) {
            decisionHandler(navigationResponse.canShowMIMEType ? .cancel : .download)
            return
        }

        if navigationResponse.canShowMIMEType {
            decisionHandler(.allow)
        } else {
            decisionHandler(.download)
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else {
            return nil
        }

        if navigationAction.shouldPerformDownload {
            if CollectiblesNavigation.isTrustedContentURL(url) {
                webView.startDownload(using: navigationAction.request) { [weak self] download in
                    download.delegate = self
                }
            } else {
                presentBlockedNavigation(for: url)
            }
        } else if CollectiblesNavigation.isTrustedAppURL(url) {
            webView.load(navigationAction.request)
        } else if navigationAction.navigationType == .linkActivated,
                  CollectiblesNavigation.isUserOpenableExternalURL(url) {
            NSWorkspace.shared.open(url)
        } else {
            presentBlockedNavigation(for: url)
        }

        return nil
    }

    func webView(
        _ webView: WKWebView,
        navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func webView(
        _ webView: WKWebView,
        navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        guard let window else {
            completionHandler(nil)
            return
        }

        let panel = NSSavePanel()
        panel.canCreateDirectories = true
        let safeFilename = suggestedFilename
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        panel.nameFieldStringValue = safeFilename.isEmpty ? "collectibles-download" : safeFilename
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.url : nil)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        showNotice(title: "Download saved", message: "The file was saved using the location you selected.")
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        showNotice(title: "Download failed", message: error.localizedDescription)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = "Collectibles Desktop"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        beginSheet(alert) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = "Collectibles Desktop"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        beginSheet(alert) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = "Collectibles Desktop"
        alert.informativeText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")

        let input = NSTextField(string: defaultText ?? "")
        input.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = input

        beginSheet(alert) { response in
            completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard let window else {
            completionHandler(nil)
            return
        }

        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation?, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled {
            showNotice(title: "Unable to open Collectibles Desktop", message: error.localizedDescription)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled {
            showNotice(title: "Page error", message: error.localizedDescription)
        }
    }

    @objc private func reloadPage(_ sender: Any?) {
        webView?.reload()
    }

    @objc private func showAbout(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Collectibles Desktop"
        alert.informativeText = "Production standalone launcher\nIndependent app storage"
        alert.addButton(withTitle: "OK")
        beginSheet(alert) { _ in }
    }

    private func configureMainMenu() {
        let menu = NSMenu()
        let appMenuItem = NSMenuItem(title: "Collectibles Desktop", action: nil, keyEquivalent: "")
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        menu.addItem(appMenuItem)

        appMenu.addItem(
            withTitle: "About Collectibles Desktop",
            action: #selector(showAbout(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Quit Collectibles Desktop",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )

        let fileMenuItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        fileMenuItem.submenu = fileMenu
        menu.addItem(fileMenuItem)
        fileMenu.addItem(
            withTitle: "Reload",
            action: #selector(reloadPage(_:)),
            keyEquivalent: "r"
        )

        NSApp.mainMenu = menu
    }

    private func beginSheet(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        guard let window else {
            completion(.alertSecondButtonReturn)
            return
        }
        alert.beginSheetModal(for: window, completionHandler: completion)
    }

    private func presentBlockedNavigation(for url: URL) {
        let destination = url.host ?? url.absoluteString
        showNotice(
            title: "Navigation blocked",
            message: "This app only loads the production Collectibles site. The requested destination was not opened: \(destination)"
        )
    }

    private func showNotice(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        beginSheet(alert) { _ in }
    }
}

@main
struct CollectiblesApplication {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.run()
    }
}
