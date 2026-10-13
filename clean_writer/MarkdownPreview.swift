import SwiftUI
import AppKit

/// Converts Markdown semantics into explicit typography and native paragraph layout.
enum MarkdownPreview {
    static func render(_ source: String, font: NSFont) -> AttributedString { layout(source, font: font).preview }
    static func native(_ source: String, font: NSFont) -> NSAttributedString { layout(source, font: font).native }

    private struct Block {
        var identity: Int?
        var heading: Int?
        var list: Int?
        var rootList: Int?
        var item: Int?
        var ordinal: Int?
        var ordered = false
        var listDepth = 0
        var quoteDepth = 0
        var code = false
        var rule = false
        var table: Int?
        var columns: [PresentationIntent.TableColumn] = []
        var column = 0
        var row = 0
        var tableHeader = false

        init(_ intent: PresentationIntent?) {
            identity = intent?.components.first?.identity
            for component in intent?.components ?? [] {
                // Components are ordered from the innermost block to its ancestors.
                switch component.kind {
                case .header(level: let level): heading = level
                case .orderedList:
                    rootList = component.identity
                    if list == nil { list = component.identity; ordered = true }
                    listDepth += 1
                case .unorderedList:
                    rootList = component.identity
                    if list == nil { list = component.identity; ordered = false }
                    listDepth += 1
                case .listItem(ordinal: let number):
                    if item == nil { item = component.identity; ordinal = number }
                case .blockQuote: quoteDepth += 1
                case .codeBlock: code = true
                case .thematicBreak: rule = true
                case .table(columns: let value): table = component.identity; columns = value
                case .tableCell(columnIndex: let value): column = value
                case .tableRow(rowIndex: let value): row = value
                case .tableHeaderRow: tableHeader = true; row = 0
                default: break
                }
            }
        }
    }

    private static func layout(_ source: String, font: NSFont) -> (preview: AttributedString, native: NSAttributedString) {
        guard let parsed = try? AttributedString(markdown: MarkdownCallout.prepare(source)) else {
            var fallback = AttributedString(source)
            fallback.swiftUI.font = Font(font)
            return (fallback, NSAttributedString(string: source, attributes: [.font: font]))
        }
        var callouts: [Int: MarkdownCallout] = [:]
        var seenQuotes = Set<Int>()
        for run in parsed.runs {
            if let quote = MarkdownCallout.quoteID(run.presentationIntent), seenQuotes.insert(quote).inserted,
               !Block(run.presentationIntent).code, run.inlinePresentationIntent?.contains(.code) != true,
               let style = MarkdownCallout.matching(String(parsed[run.range].characters)) {
                callouts[quote] = style
            }
        }

        var output = AttributedString()
        let native = NSMutableAttributedString()
        var tables: [Int: NSTextTable] = [:]
        var labeledQuotes = Set<Int>()
        var seenItems = Set<Int>()
        var previous: Block?
        var previousQuote: Int?
        var blockStart = 0
        var blockIndent: CGFloat = 0
        var contentIndent: CGFloat = 0
        var currentCallout: MarkdownCallout?

        func append(_ text: AttributedString, nativeFont: NSFont, style: MarkdownCallout? = nil, label: Bool = false) {
            var preview = text
            preview.swiftUI.font = Font(nativeFont)
            preview.presentationIntent = nil
            let value = NSMutableAttributedString(attributedString: NSAttributedString(preview))
            let range = NSRange(location: 0, length: value.length)
            value.addAttribute(.font, value: nativeFont, range: range)
            if let style { value.addAttribute(MarkdownCallout.attribute, value: style.rawValue, range: range) }
            if label, let style {
                value.addAttribute(.foregroundColor, value: style.color, range: range)
                preview.swiftUI.foregroundColor = Color(style.color)
            }
            if text.inlinePresentationIntent?.contains(.strikethrough) == true {
                value.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range)
            }
            if let link = text.link {
                value.addAttribute(.foregroundColor, value: NSColor(calibratedRed: 0.18, green: 0.48, blue: 0.83, alpha: 1), range: range)
                value.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: range)
                value.addAttribute(.link, value: link, range: range)
            }
            native.append(value)
            output.append(preview)
        }
        func plain(_ string: String, style: MarkdownCallout? = nil, label: Bool = false) {
            let face = label ? NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) : font
            append(AttributedString(string), nativeFont: face, style: style, label: label)
        }
        func finishBlock() {
            guard let block = previous, native.length > blockStart else { return }
            let range = NSRange(location: blockStart, length: native.length - blockStart)
            let paragraph = NSMutableParagraphStyle()
            paragraph.firstLineHeadIndent = blockIndent
            paragraph.headIndent = contentIndent
            paragraph.tabStops = [NSTextTab(textAlignment: .left, location: contentIndent)]
            paragraph.defaultTabInterval = max(18, font.pointSize * 1.6)
            if currentCallout != nil {
                paragraph.tailIndent = -font.pointSize * 0.8
                paragraph.paragraphSpacingBefore = 4
                paragraph.paragraphSpacing = 4
            }
            if block.code {
                paragraph.paragraphSpacingBefore = 0
                paragraph.paragraphSpacing = 0
                paragraph.tabStops = []
                paragraph.defaultTabInterval = (" " as NSString).size(withAttributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: font.pointSize, weight: .regular)
                ]).width * 4
                native.addAttribute(MarkdownDecoration.code, value: true, range: range)
            }
            if block.quoteDepth > 0 && currentCallout == nil {
                native.addAttribute(MarkdownDecoration.quote, value: [
                    "depth": Double(block.quoteDepth), "step": Double(font.pointSize * 0.8)
                ], range: range)
            }
            if block.rule {
                paragraph.paragraphSpacingBefore = 8
                paragraph.paragraphSpacing = 8
                native.addAttribute(MarkdownDecoration.rule, value: true, range: range)
            }
            if let tableID = block.table {
                let table: NSTextTable
                if let existing = tables[tableID] { table = existing }
                else {
                    table = NSTextTable()
                    table.numberOfColumns = block.columns.count
                    table.layoutAlgorithm = .fixedLayoutAlgorithm
                    table.collapsesBorders = true
                    table.setContentWidth(100, type: .percentageValueType)
                    tables[tableID] = table
                }
                let cell = NSTextTableBlock(table: table, startingRow: block.row, rowSpan: 1,
                                           startingColumn: block.column, columnSpan: 1)
                cell.setContentWidth(100 / CGFloat(max(1, block.columns.count)), type: .percentageValueType)
                cell.setWidth(6, type: .absoluteValueType, for: .padding)
                cell.setWidth(0.5, type: .absoluteValueType, for: .border)
                cell.setBorderColor(NSColor.gray.withAlphaComponent(0.3))
                if block.tableHeader { cell.backgroundColor = NSColor.gray.withAlphaComponent(0.08) }
                paragraph.textBlocks = [cell]
                paragraph.firstLineHeadIndent = 0
                paragraph.headIndent = 0
                if block.column < block.columns.count {
                    switch block.columns[block.column].alignment {
                    case .center: paragraph.alignment = .center
                    case .right: paragraph.alignment = .right
                    default: paragraph.alignment = .left
                    }
                }
            }
            native.addAttribute(.paragraphStyle, value: paragraph, range: range)
        }

        for run in parsed.runs {
            let block = Block(run.presentationIntent)
            let quoteID = MarkdownCallout.quoteID(run.presentationIntent)
            let callout = quoteID.flatMap { callouts[$0] }
            let newBlock = block.identity != previous?.identity
            let plainText = String(parsed[run.range].characters)
            let checklist = plainText.hasPrefix("[ ] ") || plainText.lowercased().hasPrefix("[x] ")
            var newItem = false

            if newBlock {
                finishBlock()
                if !output.characters.isEmpty {
                    let sameTable = block.table != nil && block.table == previous?.table
                    let listTransition = block.rootList != nil && block.rootList == previous?.rootList
                    let sameQuote = quoteID != nil && quoteID == previousQuote
                    let separator = sameTable || listTransition || sameQuote ? "\n" : "\n\n"
                    let trailing = output.characters.reversed().prefix { $0 == "\n" }.count
                    plain(String(separator.dropFirst(min(trailing, separator.count))),
                          style: sameQuote ? callout : nil)
                }
                blockStart = native.length
                currentCallout = callout
                let inset = callout != nil ? font.pointSize * 0.8 : CGFloat(block.quoteDepth) * font.pointSize * 0.8
                blockIndent = inset + CGFloat(max(0, block.listDepth - 1)) * font.pointSize * 1.6
                contentIndent = blockIndent
                if let item = block.item { newItem = seenItems.insert(item).inserted }
                if block.list != nil {
                    let marker = checklist ? (plainText.hasPrefix("[ ] ") ? "☐" : "☑")
                        : (block.ordered ? "\(block.ordinal ?? 1)." : ["•", "◦", "▪"][min(2, max(0, block.listDepth - 1))])
                    let markerWidth = (marker as NSString).size(withAttributes: [.font: font]).width
                    contentIndent += max(font.pointSize * 1.3, markerWidth + 7)
                    if newItem { plain(marker + "\t", style: callout) }
                    else { blockIndent = contentIndent }
                }
                if block.code { blockIndent += 8; contentIndent = blockIndent }
                previous = block
                previousQuote = quoteID
            }

            var text = AttributedString(parsed[run.range])
            if newItem && checklist {
                let end = text.characters.index(text.startIndex, offsetBy: 4)
                text.removeSubrange(text.startIndex..<end)
            }
            if let callout, let quoteID, labeledQuotes.insert(quoteID).inserted {
                let end = text.characters.index(text.startIndex, offsetBy: callout.marker.count)
                text.removeSubrange(text.startIndex..<end)
                while text.characters.first == " " { text.removeSubrange(text.startIndex..<text.characters.index(after: text.startIndex)) }
                plain(callout.title + (text.characters.isEmpty ? "" : "\n"), style: callout, label: true)
            }
            let inline = run.inlinePresentationIntent ?? []
            if inline.contains(.softBreak) || inline.contains(.lineBreak) { text = AttributedString("\n") }
            // The rule has a layout placeholder, replaced by a full-width line when drawn.
            if block.rule { text = AttributedString(" ") }
            var face = font
            if let level = block.heading {
                let factors: [CGFloat] = [2, 1.6, 1.35, 1.15, 1, 1]
                face = NSFont(descriptor: font.fontDescriptor, size: font.pointSize * factors[min(5, max(0, level - 1))]) ?? font
                face = NSFontManager.shared.convert(face, toHaveTrait: .boldFontMask)
            }
            if block.code || inline.contains(.code) { face = .monospacedSystemFont(ofSize: font.pointSize, weight: .regular) }
            if block.tableHeader || inline.contains(.stronglyEmphasized) { face = NSFontManager.shared.convert(face, toHaveTrait: .boldFontMask) }
            if inline.contains(.emphasized) { face = NSFontManager.shared.convert(face, toHaveTrait: .italicFontMask) }
            append(text, nativeFont: face, style: callout)
            if inline.contains(.code) && !block.code {
                let range = NSRange(location: native.length - (String(text.characters) as NSString).length,
                                    length: (String(text.characters) as NSString).length)
                native.addAttribute(.backgroundColor, value: NSColor.gray.withAlphaComponent(0.10), range: range)
            }
        }
        finishBlock()
        return (output, native)
    }
}
