import AppKit

enum CollectiblesWindowSizing {
    static func defaultFrame() -> NSRect {
        guard let screen = NSScreen.main else {
            return NSRect(x: 80, y: 80, width: 1180, height: 820)
        }

        let visible = screen.visibleFrame
        let width = min(1440, max(720, visible.width * 0.86))
        let height = min(960, max(560, visible.height * 0.86))
        let boundedWidth = min(width, max(520, visible.width - 80))
        let boundedHeight = min(height, max(420, visible.height - 80))
        let origin = NSPoint(
            x: visible.midX - boundedWidth / 2,
            y: visible.midY - boundedHeight / 2
        )

        return NSRect(
            origin: origin,
            size: NSSize(width: boundedWidth, height: boundedHeight)
        )
    }
}
