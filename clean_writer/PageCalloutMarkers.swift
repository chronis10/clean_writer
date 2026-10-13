import Foundation

/// Tracks callout content in the original source so continued notes mark every page they occupy.
enum PageCalloutMarkers {
    struct Span {
        let kind: MarkdownCallout
        let range: NSRange
    }

    static func scan(_ document: String) -> [Span] {
        var spans: [Span] = []
        var sectionOffset = 0
        for section in document.components(separatedBy: "\u{000C}") {
            defer { sectionOffset += (section as NSString).length + 1 }
            let prepared = MarkdownCallout.prepare(section)
            guard let parsed = try? AttributedString(markdown: prepared,
                options: .init(appliesSourcePositionAttributes: true)) else { continue }
            let lines = section.components(separatedBy: "\n")
            var lineOffsets = [Int]()
            var offset = 0
            for line in lines { lineOffsets.append(offset); offset += (line as NSString).length + 1 }
            var kinds: [Int: MarkdownCallout] = [:]
            var seen = Set<Int>()
            for run in parsed.runs {
                guard let quote = MarkdownCallout.quoteID(run.presentationIntent), seen.insert(quote).inserted,
                      !isCode(run.presentationIntent), run.inlinePresentationIntent?.contains(.code) != true,
                      let kind = MarkdownCallout.matching(String(parsed[run.range].characters)) else { continue }
                kinds[quote] = kind
            }
            var quoteRanges: [Int: NSRange] = [:]
            for run in parsed.runs {
                guard let position = run.markdownSourcePosition,
                      position.startLine > 0, position.endLine <= lines.count else { continue }
                let start = lineOffsets[position.startLine - 1]
                let end = lineOffsets[position.endLine - 1] + (lines[position.endLine - 1] as NSString).length
                let range = NSRange(location: sectionOffset + start, length: end - start)
                for component in run.presentationIntent?.components ?? [] {
                    if case .blockQuote = component.kind, kinds[component.identity] != nil {
                        quoteRanges[component.identity] = quoteRanges[component.identity].map {
                            NSUnionRange($0, range)
                        } ?? range
                    }
                }
                // Ordinary Markdown checklists also get the quiet todo reminder.
                let text = String(parsed[run.range].characters)
                let listItem = run.presentationIntent?.components.contains { component in
                    if case .listItem = component.kind { return true }
                    return false
                } ?? false
                if listItem && !isCode(run.presentationIntent),
                   run.inlinePresentationIntent?.contains(.code) != true,
                   text.hasPrefix("[ ] ") || text.lowercased().hasPrefix("[x] ") {
                    spans.append(Span(kind: .todo, range: range))
                }
            }
            for (quote, range) in quoteRanges {
                if let kind = kinds[quote] { spans.append(Span(kind: kind, range: range)) }
            }
        }
        return spans
    }

    static func kinds(on range: NSRange, spans: [Span]) -> [MarkdownCallout] {
        [.note, .todo].filter { kind in
            spans.contains { $0.kind == kind && NSIntersectionRange($0.range, range).length > 0 }
        }
    }

    private static func isCode(_ intent: PresentationIntent?) -> Bool {
        intent?.components.contains { component in
            if case .codeBlock = component.kind { return true }
            return false
        } ?? false
    }
}
