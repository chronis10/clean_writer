import AppKit

/// Typesets rendered Markdown into A4 pages independently of on-screen zoom.
enum WriterPDF {
    static func data(document: String, font: NSFont, margin: CGFloat,
                     pageSize: CGSize, footerSpace: CGFloat) throws -> Data {
        let data = NSMutableData()
        var mediaBox = CGRect(origin: .zero, size: pageSize)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let bodySize = CGSize(width: pageSize.width - 2 * margin,
                              height: pageSize.height - 2 * margin - footerSpace)
        var pageNumber = 0

        for section in document.components(separatedBy: "\u{000C}") {
            let rendered = NSMutableAttributedString(attributedString:
                MarkdownPreview.native(section, font: font))
            let fullRange = NSRange(location: 0, length: rendered.length)
            rendered.enumerateAttribute(.foregroundColor, in: fullRange) { color, range, _ in
                if color == nil { rendered.addAttribute(.foregroundColor, value: NSColor.black, range: range) }
            }
            // List prefixes and paragraph separators also use the document font.
            rendered.enumerateAttribute(.font, in: fullRange) { value, range, _ in
                if value == nil { rendered.addAttribute(.font, value: font, range: range) }
            }
            let storage = NSTextStorage(attributedString: rendered)
            let layout = NSLayoutManager()
            storage.addLayoutManager(layout)
            var drawnGlyphs = 0

            repeat {
                let container = NSTextContainer(size: bodySize)
                container.lineFragmentPadding = 0
                container.widthTracksTextView = false
                layout.addTextContainer(container)
                layout.ensureLayout(for: container)
                let glyphRange = layout.glyphRange(for: container)
                guard storage.length == 0 || glyphRange.length > 0 else {
                    context.closePDF()
                    throw CocoaError(.fileWriteUnknown)
                }

                pageNumber += 1
                context.beginPDFPage(nil)
                context.setFillColor(CGColor(gray: 1, alpha: 1))
                context.fill(mediaBox)
                context.saveGState()
                // AppKit text layout uses a top-left origin. Flip the PDF coordinates once.
                context.translateBy(x: 0, y: pageSize.height)
                context.scaleBy(x: 1, y: -1)
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
                MarkdownDecoration.draw(storage: storage, layout: layout, container: container,
                                        glyphRange: glyphRange, origin: CGPoint(x: margin, y: margin))
                MarkdownCallout.drawBackgrounds(storage: storage, layout: layout, container: container,
                                               glyphRange: glyphRange, origin: CGPoint(x: margin, y: margin))
                layout.drawBackground(forGlyphRange: glyphRange, at: CGPoint(x: margin, y: margin))
                layout.drawGlyphs(forGlyphRange: glyphRange, at: CGPoint(x: margin, y: margin))
                let footer = NSAttributedString(string: "\(pageNumber)", attributes: [
                    .font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.darkGray
                ])
                footer.draw(at: CGPoint(x: pageSize.width - margin - footer.size().width,
                                        y: pageSize.height - 30 - footer.size().height))
                NSGraphicsContext.restoreGraphicsState()
                context.restoreGState()
                context.endPDFPage()
                drawnGlyphs = NSMaxRange(glyphRange)
            } while drawnGlyphs < layout.numberOfGlyphs
        }
        context.closePDF()
        return data as Data
    }
}
