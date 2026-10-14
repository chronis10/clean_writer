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

private struct EditorFocusRequest {
    let id = UUID()
    let pageIndex: Int
    let selection: NSRange
    var takeFocus = true
    var verticalX: CGFloat? = nil
    var enterFromTop = true
}

private struct CaretScrollTarget {
    let id = UUID()
    let pageIndex: Int
    let y: CGFloat
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
    // A form feed is a persistent manual page break, excluded from page text and PDF output.
    static let pageBreak = "\u{000C}"

    static func paginate(_ document: String, font: NSFont, margin: CGFloat) -> [PageSlice] {
        var pages: [PageSlice] = []
        var offset = 0
        for section in document.components(separatedBy: pageBreak) {
            for page in paginateSection(section, font: font, margin: margin) {
                pages.append(PageSlice(index: pages.count,
                                       range: NSRange(location: offset + page.range.location, length: page.range.length),
                                       text: page.text))
            }
            offset += (section as NSString).length + (pageBreak as NSString).length
        }
        return pages
    }

    private static func paginateSection(_ document: String, font: NSFont, margin: CGFloat) -> [PageSlice] {
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
        // A newline can move the insertion point onto an empty final line even
        // though it has no glyph. Give that caret line a page when it overflows.
        if manager.extraLineFragmentTextContainer != nil,
           manager.extraLineFragmentUsedRect.maxY - yAtStart > usableHeight,
           full.length > starts.last! {
            starts.append(full.length)
        }
        var result: [PageSlice] = []
        for (index, start) in starts.enumerated() {
            let end = index + 1 < starts.count ? starts[index + 1] : full.length
            let range = NSRange(location: start, length: max(0, end - start))
            result.append(PageSlice(index: index, range: range, text: full.substring(with: range)))
        }
        return result
    }

    static func caretDestination(_ selection: NSRange, in pages: [PageSlice]) -> EditorFocusRequest? {
        guard selection.location != NSNotFound,
              let page = pages.last(where: { $0.range.location <= selection.location }) else { return nil }
        let local = min(page.range.length, selection.location - page.range.location)
        return EditorFocusRequest(pageIndex: page.index,
                                  selection: NSRange(location: local,
                                                     length: min(selection.length, page.range.length - local)))
    }
}

// A native NSTextView keeps typing, selection, undo, IME input, and paste familiar.
private struct PageTextEditor: NSViewRepresentable {
    var text: String
    var font: NSFont
    var foreground: NSColor
    var focusRequest: EditorFocusRequest? = nil
    var searchHighlights: [NSRange] = []
    var onFocusApplied: (UUID, CGFloat) -> Void = { _, _ in }
    var onNavigate: (Bool, CGFloat?) -> Bool = { _, _ in false }
    var onSelection: (NSRange) -> Void = { _ in }
    var onEdit: (String, NSRange, Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onEdit: onEdit) }

    func makeNSView(context: Context) -> NSTextView {
        let view = NSTextView(frame: .zero)
        view.isRichText = false
        view.isEditable = true
        view.isSelectable = true
        // Use the macOS dictionaries, spelling suggestions, and correction UI.
        view.isContinuousSpellCheckingEnabled = true
        view.isAutomaticSpellingCorrectionEnabled = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        context.coordinator.onNavigate = onNavigate
        context.coordinator.onSelection = onSelection
        view.delegate = context.coordinator
        view.font = font
        view.textColor = foreground
        view.string = text
        return view
    }

    func updateNSView(_ view: NSTextView, context: Context) {
        context.coordinator.onEdit = onEdit
        context.coordinator.onNavigate = onNavigate
        context.coordinator.onSelection = onSelection
        context.coordinator.onFocusApplied = onFocusApplied
        context.coordinator.currentFocusID = focusRequest?.id
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
        if let manager = view.layoutManager {
            let full = NSRange(location: 0, length: (view.string as NSString).length)
            manager.removeTemporaryAttribute(.backgroundColor, forCharacterRange: full)
            for range in searchHighlights where NSMaxRange(range) <= full.length {
                manager.addTemporaryAttribute(.backgroundColor,
                                              value: NSColor.systemYellow.withAlphaComponent(0.35),
                                              forCharacterRange: range)
            }
        }
        if let focusRequest { context.coordinator.applyFocus(focusRequest, to: view) }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var onEdit: (String, NSRange, Bool) -> Void
        var onNavigate: (Bool, CGFloat?) -> Bool = { _, _ in false }
        var onSelection: (NSRange) -> Void = { _ in }
        var onFocusApplied: (UUID, CGFloat) -> Void = { _, _ in }
        var currentFocusID: UUID?
        private var queuedFocusID: UUID?
        private var appliedFocusID: UUID?
        var updating = false
        init(onEdit: @escaping (String, NSRange, Bool) -> Void) { self.onEdit = onEdit }

        func applyFocus(_ request: EditorFocusRequest, to view: NSTextView) {
            guard queuedFocusID != request.id, appliedFocusID != request.id else { return }
            queuedFocusID = request.id
            // Wait for SwiftUI to attach the destination editor to its window.
            DispatchQueue.main.async { [weak self, weak view] in
                guard let self else { return }
                self.queuedFocusID = nil
                guard self.currentFocusID == request.id, let view, let window = view.window else { return }
                self.updating = true
                if request.takeFocus { window.makeFirstResponder(view) }
                let length = (view.string as NSString).length
                let location = min(request.selection.location, length)
                var selection = NSRange(location: location,
                                        length: min(request.selection.length, length - location))
                if let x = request.verticalX, let manager = view.layoutManager,
                   let container = view.textContainer {
                    manager.ensureLayout(for: container)
                    let line: NSRect
                    if !request.enterFromTop, manager.extraLineFragmentTextContainer != nil {
                        line = manager.extraLineFragmentRect
                    } else if manager.numberOfGlyphs > 0 {
                        line = manager.lineFragmentRect(forGlyphAt: request.enterFromTop ? 0 : manager.numberOfGlyphs - 1,
                                                        effectiveRange: nil)
                    } else {
                        line = NSRect(x: 0, y: 0, width: container.size.width, height: view.font?.pointSize ?? 15)
                    }
                    let origin = view.textContainerOrigin
                    let point = NSPoint(x: x + origin.x, y: line.midY + origin.y)
                    selection = NSRange(location: min(length, view.characterIndexForInsertion(at: point)), length: 0)
                }
                view.setSelectedRange(selection)
                view.scrollRangeToVisible(view.selectedRange())
                self.updating = false
                self.appliedFocusID = request.id
                self.onSelection(selection)
                let screenRect = view.firstRect(forCharacterRange: NSRange(location: selection.location, length: 0), actualRange: nil)
                let caretRect = view.convert(window.convertFromScreen(screenRect), from: nil)
                self.onFocusApplied(request.id, caretRect.midY)
            }
        }
        func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard !updating, !view.hasMarkedText(), view.selectedRange().length == 0 else { return false }
            let location = view.selectedRange().location
            let length = (view.string as NSString).length
            switch NSStringFromSelector(selector) {
            case "moveRight:", "moveForward:":
                return location == length && onNavigate(true, nil)
            case "moveLeft:", "moveBackward:":
                return location == 0 && onNavigate(false, nil)
            case "moveDown:", "moveUp:":
                guard let manager = view.layoutManager, let container = view.textContainer else { return false }
                manager.ensureLayout(for: container)
                let forward = NSStringFromSelector(selector) == "moveDown:"
                guard manager.numberOfGlyphs > 0 else { return onNavigate(forward, 0) }
                let hasExtraLine = manager.extraLineFragmentTextContainer != nil
                let caretLine: NSRect
                if location == length && hasExtraLine {
                    caretLine = manager.extraLineFragmentRect
                } else if manager.numberOfGlyphs > 0 {
                    let glyph = manager.glyphIndexForCharacter(at: min(location, max(0, length - 1)))
                    caretLine = manager.lineFragmentRect(forGlyphAt: min(glyph, manager.numberOfGlyphs - 1), effectiveRange: nil)
                } else {
                    return onNavigate(forward, 0)
                }
                let edgeLine = forward && hasExtraLine ? manager.extraLineFragmentRect :
                    manager.lineFragmentRect(forGlyphAt: forward ? manager.numberOfGlyphs - 1 : 0, effectiveRange: nil)
                guard abs(caretLine.minY - edgeLine.minY) < 0.5 else { return false }
                // NSTextView supplies the insertion rectangle in screen coordinates.
                // Convert it back to text-container points to keep the horizontal column.
                guard let window = view.window else { return false }
                let screenRect = view.firstRect(forCharacterRange: NSRange(location: location, length: 0), actualRange: nil)
                let localRect = view.convert(window.convertFromScreen(screenRect), from: nil)
                return onNavigate(forward, max(0, localRect.minX - view.textContainerOrigin.x))
            default:
                return false
            }
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard !updating, let view = notification.object as? NSTextView,
                  view.window?.firstResponder === view, !view.hasMarkedText() else { return }
            onSelection(view.selectedRange())
        }

        func textDidChange(_ notification: Notification) {
            guard !updating, let textView = notification.object as? NSTextView else { return }
            onEdit(textView.string, textView.selectedRange(), textView.hasMarkedText())
        }
    }
}

struct WriterView: View {
    @AppStorage("cleanwriter.dark") private var dark = false
    @AppStorage("cleanwriter.fontName") private var fontName = "Serif"
    @AppStorage("cleanwriter.fontSize") private var fontSize = 15.0
    @AppStorage("cleanwriter.margin") private var margin = 64.0
    @AppStorage("cleanwriter.preview") private var preview = false
    @AppStorage("cleanwriter.zoom") private var zoom = 1.0
    @AppStorage("cleanwriter.sidebarVisible") private var sidebarVisible = true
    @StateObject private var file: MarkdownFile

    @MainActor
    init(file: MarkdownFile? = nil) {
        _file = StateObject(wrappedValue: file ?? MarkdownFile())
    }
    @State private var findVisible = false
    @State private var findQuery = ""
    @State private var matchCase = false
    @State private var findMatches: [NSRange] = []
    @State private var activeMatch = 0
    @FocusState private var findFieldFocused: Bool
    @State private var fileError: String?
    private var document: String {
        get { file.text }
        nonmutating set { file.text = newValue }
    }
    @State private var selectedPage = 0
    @State private var insertionSelection = NSRange(location: 0, length: 0)
    @State private var settingsOpen = false
    @State private var editorFocus: EditorFocusRequest?
    @State private var caretScrollTarget: CaretScrollTarget?
    @State private var wordCount = 0
    @State private var calloutSpans: [PageCalloutMarkers.Span] = []
    private var documentTitle: String { "Clean Writer - \(file.name)" }

    private var paper: Color { dark ? Color(white: 0.13) : .white }
    private var ink: Color { dark ? Color(white: 0.93) : Color(white: 0.12) }
    private var chrome: Color { dark ? Color(white: 0.09) : Color(white: 0.97) }
    private var canvas: Color { dark ? Color(white: 0.065) : Color(white: 0.92) }
    private var typeface: NSFont { PageLayout.font(name: fontName, size: fontSize) }
    private var pageScale: CGFloat { CGFloat(min(2, max(0.5, zoom))) }
    // Scale paper and typography by the same factor; PDF and pagination stay in print points.
    private var displayTypeface: NSFont { PageLayout.font(name: fontName, size: fontSize * Double(pageScale)) }
    private var pages: [PageSlice] { PageLayout.paginate(document, font: typeface, margin: CGFloat(margin)) }

    var body: some View {
        HStack(spacing: 0) {
            if sidebarVisible {
                sidebar.frame(width: 192)
                Rectangle().fill(ink.opacity(0.10)).frame(width: 1)
            }
            VStack(spacing: 0) {
                toolbar
                if findVisible { findBar }
                GeometryReader { geometry in
                    ScrollViewReader { proxy in
                        ScrollView([.horizontal, .vertical], showsIndicators: false) {
                            VStack(spacing: 24) {
                                ForEach(pages) { page in
                                    pageView(page)
                                        .id(page.index)
                                }
                            }
                            .padding(32)
                            .frame(width: max(geometry.size.width, A4.width * pageScale + 64))
                        }
                        .defaultScrollAnchor(.top)
                        .background(canvas)
                        .background(PageZoomGesture { magnification in
                            zoom = min(2, max(0.5, Double(pageScale) * (1 + Double(magnification))))
                        })
                        .onChange(of: caretScrollTarget?.id) { _, id in
                            if let id { proxy.scrollTo(id, anchor: .center) }
                        }
                        .onChange(of: editorFocus?.id) { _, id in
                            if id != nil { proxy.scrollTo(selectedPage, anchor: .top) }
                        }
                        .onChange(of: selectedPage) { _, page in
                            if editorFocus != nil {
                                proxy.scrollTo(page, anchor: .top)
                            } else {
                                withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(page, anchor: .top) }
                            }
                        }
                    }
                }
                zoomControls
            }
        }
        .background(WindowStartupFocus())
        .preferredColorScheme(dark ? .dark : .light)
        .navigationTitle(documentTitle)
        .focusedSceneValue(\.writerFileActions, WriterFileActions(
            new: newMarkdown, open: openMarkdown, openRecent: openRecentMarkdown, save: { _ = saveMarkdown() },
            saveAs: { _ = saveMarkdown(saveAs: true) }, exportPDF: exportPDF,
            find: showFind, findNext: { navigateMatch(1) }, findPrevious: { navigateMatch(-1) }, toggleBookmark: toggleCurrentPageBookmark, insert: insertMarkdown))
        .alert("File operation failed", isPresented: Binding(
            get: { fileError != nil }, set: { if !$0 { fileError = nil } })) {
                Button("OK") { fileError = nil }
            } message: { Text(fileError ?? "") }
        .onDisappear { file.flushAutosave() }
        .onChange(of: document, initial: true) { _, newValue in
            wordCount = WordCounter.count(newValue)
            calloutSpans = PageCalloutMarkers.scan(newValue)
            selectedPage = min(selectedPage, max(0, pages.count - 1))
            refreshMatches(select: false)
        }
        .onChange(of: file.navigationRevision, initial: true) { _, _ in restorePosition() }
        .onChange(of: findQuery) { _, _ in refreshMatches(select: true) }
        .onChange(of: matchCase) { _, _ in refreshMatches(select: true) }
    }

    private var toolbar: some View {
        HStack(spacing: 14) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { sidebarVisible.toggle() }
            } label: {
                Image(systemName: "sidebar.left")
            }
            .help(sidebarVisible ? "Hide page sidebar" : "Show page sidebar")
            .accessibilityLabel("Toggle page sidebar")
            .accessibilityValue(sidebarVisible ? "Visible" : "Hidden")
            .keyboardShortcut("s", modifiers: [.command, .control])
            Text(file.name)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
                .help(file.url?.path ?? "Unsaved Markdown document")
            if file.hasChanges {
                Circle().fill(.secondary).frame(width: 6, height: 6)
                    .accessibilityLabel("Unsaved changes")
            }
            Spacer()
            Button(action: toggleCurrentPageBookmark) {
                Image(systemName: currentPageBookmarks.isEmpty ? "bookmark" : "bookmark.fill")
            }
            .help(currentPageBookmarks.isEmpty ? "Bookmark this page at the cursor (⌘D)" : "Remove this page's bookmark (⌘D)")
            .accessibilityLabel("Toggle bookmark")
            Button(action: showFind) { Image(systemName: "magnifyingglass") }
                .help("Find in document (⌘F)")
                .accessibilityLabel("Find in document")
            Button { preview.toggle() } label: {
                Image(systemName: preview ? "eye.fill" : "eye")
                    .foregroundStyle(preview ? Color.accentColor : ink)
            }
            .help(preview ? "Edit Markdown source" : "Preview Markdown")
            .accessibilityLabel("Markdown preview")
            .accessibilityValue(preview ? "On" : "Off")
            Button { dark.toggle() } label: {
                Image(systemName: dark ? "sun.max" : "moon")
            }
            .help(dark ? "Switch to light appearance" : "Switch to dark appearance")
            .accessibilityLabel(dark ? "Switch to light appearance" : "Switch to dark appearance")
            Button { settingsOpen.toggle() } label: { Image(systemName: "gearshape") }
                .help("Settings")
                .popover(isPresented: $settingsOpen, arrowEdge: .bottom) { settings }
        }
        .buttonStyle(.plain)
        .focusEffectDisabled()
        .foregroundStyle(ink)
        .padding(.horizontal, 22)
        .frame(height: 48)
        .background(chrome)
    }

    private var findBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Find in document", text: $findQuery)
                .textFieldStyle(.roundedBorder)
                .focused($findFieldFocused)
                .onSubmit { navigateMatch(1) }
                .onExitCommand(perform: closeFind)
                .accessibilityLabel("Find in document")
            Text(findQuery.isEmpty ? "" : findMatches.isEmpty ? "No matches" : "\(activeMatch + 1) of \(findMatches.count)")
                .font(.system(size: 12)).monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 76)
                .accessibilityLabel("Search results")
            Toggle("Aa", isOn: $matchCase)
                .toggleStyle(.button)
                .help("Match case")
                .accessibilityLabel("Match case")
            Button { navigateMatch(-1) } label: { Image(systemName: "chevron.up") }
                .disabled(findMatches.isEmpty).help("Previous match (⇧⌘G)")
                .accessibilityLabel("Previous match")
            Button { navigateMatch(1) } label: { Image(systemName: "chevron.down") }
                .disabled(findMatches.isEmpty).help("Next match (⌘G)")
                .accessibilityLabel("Next match")
            Button(action: closeFind) { Image(systemName: "xmark") }
                .help("Close find (Escape)").accessibilityLabel("Close find")
        }
        .padding(.horizontal, 22).padding(.vertical, 8)
        .foregroundStyle(ink).background(chrome)
    }

    private func showFind() {
        findVisible = true
        preview = false
        refreshMatches(select: true)
        findFieldFocused = true
    }

    private func closeFind() {
        findVisible = false
        findFieldFocused = false
        if !findMatches.isEmpty { selectMatch(takeFocus: true) }
    }

    private func refreshMatches(select: Bool) {
        findMatches = DocumentSearch.matches(in: document, query: findQuery, matchCase: matchCase)
        activeMatch = select ? 0 : min(activeMatch, max(0, findMatches.count - 1))
        if select && findVisible { selectMatch(takeFocus: false) }
    }

    private func navigateMatch(_ direction: Int) {
        if !findVisible { showFind() }
        guard !findMatches.isEmpty else { return }
        activeMatch = (activeMatch + direction + findMatches.count) % findMatches.count
        preview = false
        selectMatch(takeFocus: false)
    }

    private func selectMatch(takeFocus: Bool) {
        guard findMatches.indices.contains(activeMatch),
              var destination = PageLayout.caretDestination(findMatches[activeMatch], in: pages) else { return }
        destination.takeFocus = takeFocus
        selectedPage = destination.pageIndex
        editorFocus = destination
    }

    private func highlights(on page: PageSlice) -> [NSRange] {
        guard findVisible else { return [] }
        return findMatches.compactMap { match in
            let overlap = NSIntersectionRange(match, page.range)
            guard overlap.length > 0 else { return nil }
            return NSRange(location: overlap.location - page.range.location, length: overlap.length)
        }
    }

    private var zoomControls: some View {
        HStack(spacing: 12) {
            Text("\(wordCount) \(wordCount == 1 ? "word" : "words")")
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .help("Word count for the complete document")
            Text("·").foregroundStyle(.tertiary)
            Text("\(pages.count) \(pages.count == 1 ? "page" : "pages")")
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .help("Page count for the complete document")
            if let error = file.autosaveError {
                Button { file.flushAutosave() } label: {
                    Label("Auto-save failed", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                .help("\(error) Click to retry, or use File → Save As to choose another location.")
            }
            Spacer()
            Button { zoom = max(0.5, ((Double(pageScale) - 0.1) * 10).rounded() / 10) } label: {
                Image(systemName: "minus.magnifyingglass")
            }
            .disabled(pageScale <= 0.5)
            .help("Zoom out")
            .accessibilityLabel("Zoom out")
            Slider(value: $zoom, in: 0.5...2, step: 0.1)
                .frame(width: 110)
                .accessibilityLabel("Page zoom")
            Button { zoom = min(2, ((Double(pageScale) + 0.1) * 10).rounded() / 10) } label: {
                Image(systemName: "plus.magnifyingglass")
            }
            .disabled(pageScale >= 2)
            .help("Zoom in")
            .accessibilityLabel("Zoom in")
            Button { zoom = 1 } label: {
                Text("\(Int((Double(pageScale) * 100).rounded()))%")
                    .monospacedDigit()
                    .frame(width: 44)
            }
            .help("Reset zoom to 100%")
            .accessibilityLabel("Reset page zoom to 100 percent")
        }
        .buttonStyle(.plain)
        .font(.system(size: 12))
        .foregroundStyle(ink)
        .padding(.horizontal, 22)
        .frame(height: 40)
        .background(chrome)
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Settings").font(.headline)
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
            Text("Named files save automatically after a typing pause. Untitled drafts are recovered automatically; use File → Save to choose a location.")
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
            ScrollView(showsIndicators: false) {
                LazyVStack(spacing: 15) {
                    ForEach(pages) { page in
                        Button {
                            let bookmark = bookmarks(on: page).first
                            jump(to: bookmark?.offset ?? page.range.location, takeFocus: bookmark != nil || !preview)
                        } label: {
                            VStack(spacing: 6) {
                                ZStack(alignment: .topLeading) {
                                    paper
                                    Group {
                                        if preview {
                                            MarkdownPagePreview(source: page.text,
                                                font: PageLayout.font(name: fontName, size: fontSize * 108 / Double(A4.width)),
                                                documentURL: file.url,
                                                imageSize: CGSize(width: (A4.width - 2 * CGFloat(margin)) * 108 / A4.width,
                                                                  height: (A4.height - 2 * CGFloat(margin) - A4.footerSpace) * 108 / A4.width))
                                                .allowsHitTesting(false)
                                        } else {
                                            Text(page.text.isEmpty ? " " : page.text)
                                                .font(Font(PageLayout.font(name: fontName, size: fontSize * 108 / Double(A4.width))))
                                                .foregroundStyle(ink.opacity(0.75))
                                        }
                                    }
                                        .padding(CGFloat(margin) * 108 / A4.width)
                                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                                        .clipped()
                                }
                                .frame(width: 108, height: 108 * A4.height / A4.width)
                                .overlay(alignment: .topLeading) { thumbnailBookmark(for: page) }
                                .overlay(alignment: .bottomTrailing) { thumbnailMarkers(for: page) }
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
            Divider()
            Button(action: addPage) {
                Label("Add page", systemImage: "plus")
                    .font(.system(size: 12, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .frame(height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(ink)
            .help("Add a blank page at the end")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(chrome)
    }

    @ViewBuilder
    private func thumbnailMarkers(for page: PageSlice) -> some View {
        let kinds = PageCalloutMarkers.kinds(on: page.range, spans: calloutSpans)
        if !kinds.isEmpty {
            HStack(spacing: 5) {
                ForEach(kinds, id: \.rawValue) { kind in
                    Image(systemName: kind == .note ? "note.text" : "checklist")
                        .font(.system(size: 9, weight: .regular))
                        .foregroundStyle(Color(kind.color).opacity(dark ? 0.8 : 0.65))
                        .help(kind == .note ? "Contains notes" : "Contains to-dos")
                        .accessibilityLabel(kind == .note ? "Contains notes" : "Contains to-dos")
                }
            }
            .padding(4)
            .background(paper.opacity(0.95), in: RoundedRectangle(cornerRadius: 3))
            .padding(5)
        }
    }

    private var currentPageBookmarks: [DocumentNavigation.Bookmark] {
        let currentPages = pages
        let index = PageLayout.caretDestination(NSRange(location: file.navigation.cursor, length: 0),
                                               in: currentPages)?.pageIndex ?? selectedPage
        return file.navigation.bookmarks.filter {
            PageLayout.caretDestination(NSRange(location: $0.offset, length: 0), in: currentPages)?.pageIndex == index
        }
    }

    private func toggleCurrentPageBookmark() {
        let marks = currentPageBookmarks
        if marks.isEmpty {
            file.toggleBookmark()
        } else {
            // Remove every existing anchor on this page, including older multiple bookmarks.
            for bookmark in marks { file.removeBookmark(bookmark.id) }
        }
    }

    private func bookmarks(on page: PageSlice) -> [DocumentNavigation.Bookmark] {
        file.navigation.bookmarks.filter {
            PageLayout.caretDestination(NSRange(location: $0.offset, length: 0), in: pages)?.pageIndex == page.index
        }
    }

    @ViewBuilder
    private func thumbnailBookmark(for page: PageSlice) -> some View {
        let marks = bookmarks(on: page)
        if !marks.isEmpty {
            Image(systemName: "bookmark.fill")
                .font(.system(size: 12, weight: .regular))
                .foregroundStyle(ink.opacity(0.65))
                .padding(3)
                .background(paper.opacity(0.95), in: RoundedRectangle(cornerRadius: 2))
                .padding(5)
                .help("\(marks.count) \(marks.count == 1 ? "bookmark" : "bookmarks"). Click to jump; right-click for options.")
                .accessibilityLabel("Bookmarked page")
                .contextMenu {
                    ForEach(Array(marks.enumerated()), id: \.element.id) { index, bookmark in
                        Menu("Bookmark \(index + 1)") {
                            Button("Jump to Bookmark") { jump(to: bookmark.offset, takeFocus: true) }
                            Button("Remove Bookmark") { file.removeBookmark(bookmark.id) }
                        }
                    }
                }
        }
    }

    private func restorePosition() {
        jump(to: file.navigation.cursor, takeFocus: !preview)
    }

    private func jump(to offset: Int, takeFocus: Bool) {
        guard var destination = PageLayout.caretDestination(NSRange(location: offset, length: 0), in: pages) else { return }
        destination.takeFocus = takeFocus
        if takeFocus { preview = false }
        file.recordPosition(offset)
        insertionSelection = NSRange(location: offset, length: 0)
        selectedPage = destination.pageIndex
        editorFocus = destination
    }

    private func applyInsertionDocument(_ text: String, selection: NSRange, undo: UndoManager?) {
        let previous = document, previousSelection = insertionSelection
        undo?.registerUndo(withTarget: file) { _ in
            applyInsertionDocument(previous, selection: previousSelection, undo: undo)
        }
        undo?.setActionName("Insert Markdown")
        document = text
        insertionSelection = selection
        preview = false
        file.recordPosition(selection.location)
        if let destination = PageLayout.caretDestination(selection, in: pages) {
            selectedPage = destination.pageIndex
            editorFocus = destination
        }
    }

    private func insertMarkdown(_ command: String) {
        if command == "image" { insertImage(); return }
        let edit = MarkdownInsertion.edit(document, selection: insertionSelection, command: command)
        let text = (document as NSString).replacingCharacters(in: edit.range, with: edit.text)
        applyInsertionDocument(text, selection: edit.selection, undo: NSApp.keyWindow?.undoManager)
    }

    private func insertImage() {
        guard file.url != nil || saveMarkdown(), let documentURL = file.url else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP, .bmp, .tiff]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.directoryURL = documentURL.deletingLastPathComponent()
        guard panel.runModal() == .OK, let imageURL = panel.url else { return }
        let accessing = imageURL.startAccessingSecurityScopedResource()
        defer { if accessing { imageURL.stopAccessingSecurityScopedResource() } }
        guard NSImage(contentsOf: imageURL) != nil else {
            fileError = "This image could not be opened."
            return
        }
        let markdown = "\n" + MarkdownImage.markdown(imageURL, relativeTo: documentURL) + "\n"
        let full = document as NSString
        let location = min(insertionSelection.location, full.length)
        let range = NSRange(location: location, length: min(insertionSelection.length, full.length - location))
        applyInsertionDocument(full.replacingCharacters(in: range, with: markdown),
                               selection: NSRange(location: location + (markdown as NSString).length, length: 0),
                               undo: NSApp.keyWindow?.undoManager)
    }

    private func addPage() {
        document += PageLayout.pageBreak
        preview = false
        selectedPage = pages.count - 1
        editorFocus = EditorFocusRequest(pageIndex: selectedPage, selection: NSRange(location: 0, length: 0))
    }

    private func pageView(_ page: PageSlice) -> some View {
        ZStack(alignment: .bottomTrailing) {
            paper
            Group {
                if preview {
                    MarkdownPagePreview(source: page.text, font: displayTypeface, documentURL: file.url,
                                        imageSize: CGSize(width: (A4.width - 2 * CGFloat(margin)) * pageScale,
                                                          height: (A4.height - 2 * CGFloat(margin) - A4.footerSpace) * pageScale))
                } else {
                    PageTextEditor(text: page.text, font: displayTypeface,
                                   foreground: dark ? NSColor(white: 0.93, alpha: 1) : NSColor(white: 0.12, alpha: 1),
                                   focusRequest: editorFocus?.pageIndex == page.index ? editorFocus : nil,
                                   searchHighlights: highlights(on: page),
                                   onFocusApplied: { id, y in
                                       if editorFocus?.id == id {
                                           caretScrollTarget = CaretScrollTarget(pageIndex: page.index, y: y)
                                           editorFocus = nil
                                       }
                                   }, onNavigate: { forward, x in
                                       let next = page.index + (forward ? 1 : -1)
                                       let currentPages = pages
                                       guard currentPages.indices.contains(next) else { return false }
                                       let target = currentPages[next]
                                       editorFocus = EditorFocusRequest(
                                           pageIndex: next,
                                           selection: NSRange(location: forward ? 0 : target.range.length, length: 0),
                                           verticalX: x, enterFromTop: forward)
                                       selectedPage = next
                                       return true
                                   }, onSelection: { selection in
                                       guard selection.location != NSNotFound else { return }
                                       insertionSelection = NSRange(location: page.range.location + selection.location, length: selection.length)
                                       file.recordPosition(insertionSelection.location)
                                   }) { replacement, selection, composing in
                        // Each visible page edits one range of the canonical Markdown string.
                        // Pagination recalculates immediately after every edit.
                        let original = document as NSString
                        guard NSMaxRange(page.range) <= original.length else { return }
                        document = original.replacingCharacters(in: page.range, with: replacement)
                        guard !composing, selection.location != NSNotFound else { return }
                        let globalSelection = NSRange(location: page.range.location + selection.location,
                                                      length: selection.length)
                        insertionSelection = globalSelection
                        file.recordPosition(globalSelection.location)
                        if let destination = PageLayout.caretDestination(globalSelection, in: pages),
                           destination.pageIndex != page.index {
                            editorFocus = destination
                            selectedPage = destination.pageIndex
                        }
                    }
                }
            }
            .frame(width: (A4.width - 2 * CGFloat(margin)) * pageScale,
                   height: (A4.height - 2 * CGFloat(margin) - A4.footerSpace) * pageScale,
                   alignment: .topLeading)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.horizontal, CGFloat(margin) * pageScale)
            .padding(.top, CGFloat(margin) * pageScale)
            Text("\(page.index + 1)")
                .font(.system(size: 11 * pageScale))
                .foregroundStyle(ink.opacity(0.65))
                .padding(.trailing, CGFloat(margin) * pageScale)
                .padding(.bottom, 30 * pageScale)
        }
        .frame(width: A4.width * pageScale, height: A4.height * pageScale)
        .overlay(alignment: .topLeading) {
            if let target = caretScrollTarget, target.pageIndex == page.index, !preview {
                VStack(spacing: 0) {
                    Color.clear.frame(height: max(0, CGFloat(margin) * pageScale + target.y))
                    Color.clear.frame(height: 1).id(target.id)
                    Spacer(minLength: 0)
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
        .foregroundStyle(ink)
        .shadow(color: .black.opacity(dark ? 0.28 : 0.1), radius: 12, y: 4)
    }

    private func confirmReplacingDocument() -> Bool {
        file.flushAutosave()
        guard file.hasChanges else { return true }
        let alert = NSAlert()
        alert.messageText = "Save changes to \(file.name)?"
        alert.informativeText = "The current document will be replaced."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Discard Changes")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn: return saveMarkdown()
        case .alertSecondButtonReturn: return true
        default: return false
        }
    }

    private func newMarkdown() {
        guard confirmReplacingDocument() else { return }
        file.newDocument()
        preview = false
        selectedPage = 0
        editorFocus = EditorFocusRequest(pageIndex: 0, selection: NSRange(location: 0, length: 0))
    }

    private func openMarkdown() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [MarkdownFile.contentType, .plainText]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        openMarkdown(at: url)
    }

    private func openRecentMarkdown(_ entry: RecentMarkdownFiles.Entry) {
        do {
            let url = try RecentMarkdownFiles.shared.resolve(entry)
            if openMarkdown(at: url), url.standardizedFileURL.path != entry.path {
                RecentMarkdownFiles.shared.remove(entry)
            }
        } catch { fileError = error.localizedDescription }
    }

    @discardableResult
    private func openMarkdown(at url: URL) -> Bool {
        guard confirmReplacingDocument() else { return false }
        do {
            try file.open(url)
            restorePosition()
            return true
        } catch {
            fileError = error.localizedDescription
            return false
        }
    }

    @discardableResult
    private func saveMarkdown(saveAs: Bool = false) -> Bool {
        var destination = file.url
        if saveAs || destination == nil {
            let panel = NSSavePanel()
            panel.allowedContentTypes = [MarkdownFile.contentType]
            panel.nameFieldStringValue = file.url?.lastPathComponent ?? "Untitled.md"
            panel.canCreateDirectories = true
            guard panel.runModal() == .OK, let url = panel.url else { return false }
            destination = url
        }
        guard let destination else { return false }
        do {
            try file.save(to: destination)
            return true
        } catch {
            fileError = error.localizedDescription
            return false
        }
    }

    private func exportPDF() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        panel.nameFieldStringValue = (file.url?.deletingPathExtension().lastPathComponent ?? "Untitled") + ".pdf"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try WriterPDF.data(document: document, font: typeface, margin: CGFloat(margin),
                                          pageSize: CGSize(width: A4.width, height: A4.height),
                                          footerSpace: A4.footerSpace, documentURL: file.url)
            try data.write(to: url, options: .atomic)
        } catch { fileError = error.localizedDescription }
    }
}
