import Foundation

/// Counts visible Markdown words using the system's language-aware word boundaries.
enum WordCounter {
    static func count(_ markdown: String) -> Int {
        let source = markdown.replacingOccurrences(of: "\u{000C}", with: "\n\n")
        var text = source
        if let parsed = try? AttributedString(markdown: MarkdownCallout.prepare(source)) {
            text = ""
            var previousBlock: Int?
            for run in parsed.runs {
                let block = run.presentationIntent?.components.first?.identity
                if block != previousBlock { text += " " }
                var visible = String(parsed[run.range].characters)
                if MarkdownCallout.quoteID(run.presentationIntent) != nil,
                   run.inlinePresentationIntent?.contains(.code) != true,
                   run.presentationIntent?.components.contains(where: { component in
                       if case .codeBlock = component.kind { return true }
                       return false
                   }) != true,
                   let callout = MarkdownCallout.matching(visible) {
                    visible.removeFirst(callout.marker.count)
                }
                let listItem = run.presentationIntent?.components.contains { component in
                    if case .listItem = component.kind { return true }
                    return false
                } ?? false
                if listItem && (visible.hasPrefix("[ ] ") || visible.lowercased().hasPrefix("[x] ")) {
                    visible.removeFirst(4)
                }
                text += visible
                previousBlock = block
            }
        }
        var count = 0
        text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .byWords) { _, _, _, _ in
            count += 1
        }
        return count
    }
}
