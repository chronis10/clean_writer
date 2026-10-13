import SwiftUI
import AppKit
import UniformTypeIdentifiers

// All dimensions are points (A4 at 72 pt/in = 595.28 x 841.89).
private enum A4 {
    static let width: CGFloat = 595.28
    static let height: CGFloat = 841.89
    static let footerSpace: CGFloat = 42
}

private struct PageSlice: Identifiable {
    let index: Int
    let range: NSRange             // UTF-16 character range in the whole document
    let text: String
    var id: Int { index }
}

private enum PageLayout {
    static func font(name: String, size: Double) -> NSFont {
        switch name {
        case "Serif": return NSFont(name: "NewYork-Regular", size: CGFloat(size)) ?? .systemFont(ofSize: CGFloat(size))
        case "Monospaced": return .monospacedSystemFont(ofSize: CGFloat(size), weight: .regular)
        default: return .systemFont(ofSize: CGFloat(size))
        }
    }

    // Pages are derived from ONE Markdown document. TextKit measures the actual
    // wrapped lines, so adding/removing text automatically creates/removes pages.
    static func paginate(_ document: String, font: NSFont, margin: CGFloat) -> [PageSlice] {
        let full = document as NSString
        guard full.length > 0 else { return [PageSlice(index: 0, range: NSRange(location: 0, length: 0), text: "")] }
        let storage = NSTextStorage(string: document, attributes: [.font: font])
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: max(100, A4.width - 2 * margin), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        let glyphs = manager.glyphRange(for: container)
        let usableHeight = max(120, A4.height - margin * 2 - A4.footerSpace)

        var starts = [0]
        var yAtStart: CGFloat = 0
        var glyph = glyphs.location
        while glyph < NSMaxRange(glyphs) {
            var lineGlyphRange = NSRange(location: 0, length: 0)
            let rect = manager.lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: &lineGlyphRange)
            if rect.maxY - yAtStart > usableHeight && glyph > glyphs.location {
                let charStart = manager.characterIndexForGlyph(at: glyph)
                if charStart > starts[starts.count - 1] {
                    starts.append(charStart)
                    yAtStart = rect.minY
                }
            }
            let next = NSMaxRange(lineGlyphRange)
            glyph = next > glyph ? next : glyph + 1
        }
        var result: [PageSlice] = []
        for (index, start) in starts.enumerated() {
            let end = index + 1 < starts.count ? starts[index + 1] : full.length
            let range = NSRange(location: start, length: max(0, end - start))
            result.append(PageSlice(index: index, range: range, text: full.substring(with: range)))
        }
        return result
    }
}

// A native NSTextView keeps typing, selection, undo, IME input, and paste familiar.
private struct PageTextEditor: NSViewRepresentable {
    var text: String
    var font: NSFont
    var foreground: NSColor
    var onEdit: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onEdit: onEdit) }

    func makeNSView(context: Context) -> NSTextView {
        let view = NSTextView(frame: .zero)
        view.isRichText = false
        view.isEditable = true
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.delegate = context.coordinator
        view.font = font
        view.textColor = foreground
        view.string = text
        return view
    }

    func updateNSView(_ view: NSTextView, context: Context) {
        context.coordinator.onEdit = onEdit
        view.font = font
        view.textColor = foreground
        if view.string != text {
            // Preserve caret location where possible after an automatic page break.
            let oldSelection = view.selectedRange()
            context.coordinator.updating = true
            view.string = text
            view.setSelectedRange(NSRange(location: min(oldSelection.location, (text as NSString).length), length: 0))
            context.coordinator.updating = false
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var onEdit: (String) -> Void
        var updating = false
        init(onEdit: @escaping (String) -> Void) { self.onEdit = onEdit }
        func textDidChange(_ notification: Notification) {
            guard !updating, let textView = notification.object as? NSTextView else { return }
            onEdit(textView.string)
        }
    }
}

struct WriterView: View {
    @AppStorage("cleanwriter.dark") private var dark = false
    @AppStorage("cleanwriter.fontName") private var fontName = "Serif"
    @AppStorage("cleanwriter.fontSize") private var fontSize = 15.0
    @AppStorage("cleanwriter.margin") private var margin = 64.0
    @AppStorage("cleanwriter.preview") private var preview = false
    @State private var document = UserDefaults.standard.string(forKey: "cleanwriter.document") ?? "# Untitled\n\nStart writing here…"
    @State private var selectedPage = 0
    @State private var settingsOpen = false

    private var paper: Color { dark ? Color(white: 0.13) : .white }
    private var ink: Color { dark ? Color(white: 0.93) : Color(white: 0.12) }
    private var chrome: Color { dark ? Color(white: 0.09) : Color(white: 0.97) }
    private var canvas: Color { dark ? Color(white: 0.065) : Color(white: 0.92) }
    private var typeface: NSFont { PageLayout.font(name: fontName, size: fontSize) }
    private var pages: [PageSlice] { PageLayout.paginate(document, font: typeface, margin: CGFloat(margin)) }

    var body: some View {
        HStack(spacing: 0) {
            sidebar.frame(width: 192)
            Rectangle().fill(ink.opacity(0.10)).frame(width: 1)
            VStack(spacing: 0) {
                toolbar
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 24) {
                            ForEach(pages) { page in
                                pageView(page)
                                    .id(page.index)

                            }
                        }
                        .padding(.vertical, 32)
                        .frame(maxWidth: .infinity)
                    }
                    .background(canvas)
                    .onChange(of: selectedPage) { _, page in
                        withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(page, anchor: .top) }
                    }
                }
            }
        }
        .preferredColorScheme(dark ? .dark : .light)
        .onChange(of: document) { _, newValue in
            UserDefaults.standard.set(newValue, forKey: "cleanwriter.document")
            selectedPage = min(selectedPage, max(0, pages.count - 1))
        }
    }

    private var toolbar: some View {
        HStack(spacing: 14) {
            Text("Clean Writer").font(.system(size: 13, weight: .medium))
            Spacer()
            Text("\(pages.count) \(pages.count == 1 ? "page" : "pages")")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            Button { exportPDF() } label: { Image(systemName: "square.and.arrow.up") }
                .help("Export PDF")
            Button { settingsOpen.toggle() } label: { Image(systemName: "gearshape") }
                .help("Settings")
                .popover(isPresented: $settingsOpen, arrowEdge: .bottom) { settings }
        }
        .buttonStyle(.plain)
        .foregroundStyle(ink)
        .padding(.horizontal, 22)
        .frame(height: 48)
        .background(chrome)
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Settings").font(.headline)
            Toggle("Black background", isOn: $dark)
            Toggle("Markdown preview (read-only)", isOn: $preview)
            Divider()
            Text("Typography").font(.subheadline.weight(.semibold))
            Picker("Font", selection: $fontName) {
                Text("Serif").tag("Serif")
                Text("Sans Serif").tag("Sans Serif")
                Text("Monospaced").tag("Monospaced")
            }
            HStack {
                Text("Size")
                Slider(value: $fontSize, in: 11...22, step: 1)
                Text("\(Int(fontSize)) pt").monospacedDigit().frame(width: 42)
            }
            Text("Page margins").font(.subheadline.weight(.semibold))
            Picker("Margin", selection: $margin) {
                Text("Narrow — 45 pt").tag(45.0)
                Text("Normal — 64 pt").tag(64.0)
                Text("Wide — 85 pt").tag(85.0)
            }
            Divider()
            Button("Export as PDF…") { settingsOpen = false; exportPDF() }
            Text("The complete Markdown source is saved automatically. Preview is for reading; edit in source mode.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 320)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("PAGES")
                .font(.system(size: 10, weight: .semibold))
                .tracking(2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)
                .padding(.top, 24)
                .padding(.bottom, 18)
            ScrollView {
                LazyVStack(spacing: 15) {
                    ForEach(pages) { page in
                        Button { selectedPage = page.index } label: {
                            VStack(spacing: 6) {
                                ZStack(alignment: .topLeading) {
                                    paper
                                    Text(page.text.isEmpty ? " " : page.text)
                                        .font(.system(size: 4.0, design: .monospaced))
                                        .foregroundStyle(ink.opacity(0.75))
                                        .padding(12)
                                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                                        .clipped()
                                }
                                .frame(width: 108, height: 153)
                                .overlay(Rectangle().strokeBorder(selectedPage == page.index ? Color.accentColor : ink.opacity(0.12), lineWidth: selectedPage == page.index ? 2 : 1))
                                Text("\(page.index + 1)").font(.system(size: 11)).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(chrome)
    }

    private func pageView(_ page: PageSlice) -> some View {
        ZStack(alignment: .bottomTrailing) {
            paper
            Group {
                if preview {
                    ScrollView {
                        Text((try? AttributedString(markdown: page.text)) ?? AttributedString(page.text))
                            .font(Font(typeface))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    PageTextEditor(text: page.text, font: typeface,
                                   foreground: dark ? NSColor(white: 0.93, alpha: 1) : NSColor(white: 0.12, alpha: 1)) { replacement in
                        // Each visible page edits one range of the canonical Markdown string.
                        // Pagination recalculates immediately after every edit.
                        let original = document as NSString
                        guard NSMaxRange(page.range) <= original.length else { return }
                        document = original.replacingCharacters(in: page.range, with: replacement)
                    }
                }
            }
            .frame(width: A4.width - 2 * CGFloat(margin),
                   height: A4.height - 2 * CGFloat(margin) - A4.footerSpace,
                   alignment: .topLeading)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.horizontal, CGFloat(margin))
            .padding(.top, CGFloat(margin))
            Text("\(page.index + 1)")
                .font(.system(size: 11))
                .foregroundStyle(ink.opacity(0.65))
                .padding(.trailing, CGFloat(margin))
                .padding(.bottom, 30)
        }
        .frame(width: A4.width, height: A4.height)
        .foregroundStyle(ink)
        .shadow(color: .black.opacity(dark ? 0.28 : 0.1), radius: 12, y: 4)
    }

    private func exportPDF() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        panel.nameFieldStringValue = "Clean Writer.pdf"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let allPages = pages
        var mediaBox = CGRect(x: 0, y: 0, width: A4.width, height: A4.height)
        guard let context = CGContext(url as CFURL, mediaBox: &mediaBox, nil) else { return }
        for page in allPages {
            context.beginPDFPage(nil)
            context.setFillColor(CGColor(gray: 1, alpha: 1))
            context.fill(mediaBox)
            let graphic = NSGraphicsContext(cgContext: context, flipped: false)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = graphic
            let source = NSAttributedString(string: page.text, attributes: [
                .font: typeface,
                .foregroundColor: NSColor.black
            ])
            let body = CGRect(x: CGFloat(margin), y: CGFloat(margin) + A4.footerSpace,
                              width: A4.width - 2 * CGFloat(margin),
                              height: A4.height - 2 * CGFloat(margin) - A4.footerSpace)
            source.draw(with: body, options: [.usesLineFragmentOrigin, .usesFontLeading])
            let footer = NSAttributedString(string: "\(page.index + 1)", attributes: [
                .font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.darkGray
            ])
            footer.draw(at: CGPoint(x: A4.width - CGFloat(margin) - footer.size().width, y: 30))
            NSGraphicsContext.restoreGraphicsState()
            context.endPDFPage()
        }
        context.closePDF()
    }
}
