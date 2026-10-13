import SwiftUI
import AppKit

/// Prevent the window's initial key-view selection from highlighting a toolbar button.
struct WindowStartupFocus: NSViewRepresentable {
    func makeNSView(context: Context) -> StartupView { StartupView() }
    func updateNSView(_ view: StartupView, context: Context) {}

    final class StartupView: NSView {
        private var reset = false
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard !reset, let window else { return }
            reset = true
            DispatchQueue.main.async { [weak window] in
                guard let window, !(window.firstResponder is NSTextView) else { return }
                window.makeFirstResponder(nil)
            }
        }
    }
}
