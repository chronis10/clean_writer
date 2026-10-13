import SwiftUI
import AppKit

/// Receives native trackpad pinch events over the canvas, including NSTextView content.
struct PageZoomGesture: NSViewRepresentable {
    var onMagnify: (CGFloat) -> Void

    func makeNSView(context: Context) -> ZoomView {
        let view = ZoomView()
        view.onMagnify = onMagnify
        view.startMonitoring()
        return view
    }

    func updateNSView(_ view: ZoomView, context: Context) { view.onMagnify = onMagnify }
    static func dismantleNSView(_ view: ZoomView, coordinator: ()) { view.stopMonitoring() }

    final class ZoomView: NSView {
        var onMagnify: ((CGFloat) -> Void)?
        private var monitor: Any?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        func startMonitoring() {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .magnify) { [weak self] event in
                guard let self, let window = self.window, event.window === window,
                      self.bounds.contains(self.convert(event.locationInWindow, from: nil)) else { return event }
                self.onMagnify?(event.magnification)
                return nil
            }
        }

        func stopMonitoring() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }
    }
}
