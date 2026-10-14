import SwiftUI
import AppKit

/// Native text layout keeps callout backgrounds and Markdown styling consistent with PDF export.
struct MarkdownPagePreview: NSViewRepresentable {
    var source: String
    var font: NSFont
    var documentURL: URL? = nil
    var imageSize = CGSize(width: 467, height: 672)

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        let text = CalloutTextView(frame: .zero)
        text.isEditable = false
        text.isSelectable = true
        text.drawsBackground = false
        text.textContainerInset = .zero
        text.textContainer?.lineFragmentPadding = 0
        text.textContainer?.widthTracksTextView = true
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        scroll.documentView = text
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let text = scroll.documentView as? CalloutTextView else { return }
        let rendered = NSMutableAttributedString(attributedString: MarkdownPreview.native(source, font: font, documentURL: documentURL, imageSize: imageSize))
        rendered.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: rendered.length)) { color, range, _ in
            if color == nil { rendered.addAttribute(.foregroundColor, value: NSColor.labelColor, range: range) }
        }
        if text.textStorage?.isEqual(to: rendered) != true {
            text.textStorage?.setAttributedString(rendered)
        }
        text.frame.size.width = scroll.contentSize.width
        text.sizeToFit()
        text.needsDisplay = true
    }

    final class CalloutTextView: NSTextView {
        override func draw(_ dirtyRect: NSRect) {
            if let storage = textStorage, let layout = layoutManager, let container = textContainer {
                layout.ensureLayout(for: container)
                MarkdownDecoration.draw(storage: storage, layout: layout, container: container,
                                        glyphRange: layout.glyphRange(for: container), origin: textContainerOrigin)
                MarkdownCallout.drawBackgrounds(storage: storage, layout: layout, container: container,
                                               glyphRange: layout.glyphRange(for: container), origin: textContainerOrigin)
            }
            super.draw(dirtyRect)
        }
    }
}
