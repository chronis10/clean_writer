import AppKit

/// Block decorations shared by the native preview and PDF renderer.
enum MarkdownDecoration {
    static let code = NSAttributedString.Key("CleanWriterCodeBlock")
    static let quote = NSAttributedString.Key("CleanWriterBlockQuote")
    static let rule = NSAttributedString.Key("CleanWriterHorizontalRule")

    static func draw(storage: NSTextStorage, layout: NSLayoutManager,
                     container: NSTextContainer, glyphRange: NSRange, origin: CGPoint) {
        storage.enumerateAttribute(quote, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard let metadata = value as? [String: Double], let depth = metadata["depth"], let step = metadata["step"] else { return }
            let glyphs = NSIntersectionRange(layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil), glyphRange)
            guard glyphs.length > 0 else { return }
            let bounds = layout.boundingRect(forGlyphRange: glyphs, in: container)
            NSColor.gray.withAlphaComponent(0.4).setFill()
            for level in 0..<Int(depth) {
                NSBezierPath(rect: CGRect(x: origin.x + CGFloat(level) * CGFloat(step), y: origin.y + bounds.minY,
                                          width: 2, height: bounds.height)).fill()
            }
        }
        for key in [code, rule] {
            storage.enumerateAttribute(key, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
                guard value as? Bool == true else { return }
                let glyphs = NSIntersectionRange(layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil), glyphRange)
                guard glyphs.length > 0 else { return }
                let bounds = layout.boundingRect(forGlyphRange: glyphs, in: container)
                if key == rule {
                    NSColor.gray.withAlphaComponent(0.4).setFill()
                    NSBezierPath(rect: CGRect(x: origin.x, y: origin.y + bounds.midY,
                                              width: container.size.width, height: 0.75)).fill()
                } else {
                    NSColor.gray.withAlphaComponent(0.08).setFill()
                    let top = max(0, bounds.minY - 4)
                    let bottom = min(container.size.height, bounds.maxY + 4)
                    NSBezierPath(roundedRect: CGRect(x: origin.x, y: origin.y + top,
                                                    width: container.size.width, height: bottom - top),
                                 xRadius: 5, yRadius: 5).fill()
                }
            }
        }
    }
}
