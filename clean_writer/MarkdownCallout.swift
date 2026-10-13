import Foundation
import AppKit

enum MarkdownCallout: String {
    case note = "NOTE"
    case todo = "TODO"

    var marker: String { "[!\(rawValue)]" }
    var title: String { self == .note ? "Note" : "To do" }
    var color: NSColor {
        self == .note
            ? NSColor(calibratedRed: 0.18, green: 0.48, blue: 0.83, alpha: 1)
            : NSColor(calibratedRed: 0.76, green: 0.43, blue: 0.10, alpha: 1)
    }
    static let attribute = NSAttributedString.Key("CleanWriterCallout")

    static func matching(_ text: String) -> MarkdownCallout? {
        [MarkdownCallout.note, .todo].first { text.uppercased().hasPrefix($0.marker) }
    }

    // Also accept a bare marker at the start of a paragraph. Keep fenced code literal.
    static func prepare(_ source: String) -> String {
        var fence: Character?
        var fenceLength = 0
        var bareCallout = false
        return source.components(separatedBy: "\n").map { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let first = trimmed.first, first == "`" || first == "~" {
                let length = trimmed.prefix { $0 == first }.count
                if length >= 3 {
                    if fence == nil { fence = first; fenceLength = length }
                    else if fence == first && length >= fenceLength { fence = nil }
                    bareCallout = false
                    return line
                }
            }
            guard fence == nil else { return line }
            if trimmed.isEmpty { bareCallout = false; return line }
            if matching(line) != nil { bareCallout = true }
            if bareCallout {
                if trimmed.hasPrefix(">") { bareCallout = false; return line }
                return "> " + line
            }
            return line
        }.joined(separator: "\n")
    }

    static func quoteID(_ intent: PresentationIntent?) -> Int? {
        intent?.components.first { component in
            if case .blockQuote = component.kind { return true }
            return false
        }?.identity
    }

    static func drawBackgrounds(storage: NSTextStorage, layout: NSLayoutManager,
                                container: NSTextContainer, glyphRange: NSRange,
                                origin: CGPoint) {
        storage.enumerateAttribute(attribute, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard let raw = value as? String, let style = MarkdownCallout(rawValue: raw) else { return }
            let glyphs = NSIntersectionRange(layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil), glyphRange)
            guard glyphs.length > 0 else { return }
            let bounds = layout.boundingRect(forGlyphRange: glyphs, in: container)
            let top = max(0, bounds.minY - 5)
            let bottom = min(container.size.height, bounds.maxY + 5)
            let rect = CGRect(x: origin.x, y: origin.y + top, width: container.size.width, height: bottom - top)
            style.color.withAlphaComponent(0.08).setFill()
            NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6).fill()
            style.color.setFill()
            NSBezierPath(roundedRect: CGRect(x: rect.minX, y: rect.minY, width: 3, height: rect.height),
                         xRadius: 1.5, yRadius: 1.5).fill()
        }
    }
}
