import AppKit
import Combine
import UniformTypeIdentifiers

@MainActor
final class MarkdownFile: ObservableObject {
    private let defaults: UserDefaults
    private let recentFiles: RecentMarkdownFiles
    @Published var text: String {
        didSet {
            defaults.set(text, forKey: "cleanwriter.document")
            if !applyingDocument && text != oldValue {
                navigation.adjust(from: oldValue, to: text)
                persistNavigation()
                scheduleAutosave()
            }
        }
    }
    @Published private(set) var navigation = DocumentNavigation()
    @Published private(set) var navigationRevision = UUID()
    @Published private(set) var url: URL?
    @Published private var savedText: String?
    private var scopedURL: URL?
    @Published private(set) var autosaveError: String?
    private let autosaveDelay: Duration
    private var autosaveTask: Task<Void, Never>?
    private var applyingDocument = false
    private var subscriptions = Set<AnyCancellable>()

    var name: String { url?.lastPathComponent ?? "Untitled" }
    var hasChanges: Bool { savedText.map { $0 != text } ?? !text.isEmpty }
    static let contentType = UTType(filenameExtension: "md") ?? .plainText

    init(defaults: UserDefaults = .standard, recentFiles: RecentMarkdownFiles? = nil,
         autosaveDelay: Duration = .seconds(1)) {
        self.defaults = defaults
        self.autosaveDelay = autosaveDelay
        self.recentFiles = recentFiles ?? (defaults === UserDefaults.standard ? .shared : RecentMarkdownFiles(defaults: defaults))
        text = defaults.string(forKey: "cleanwriter.document") ?? "# Untitled\n\nStart writing here…"
        var restoredURL: URL?
        var stale = false
        if let bookmark = defaults.data(forKey: "cleanwriter.fileBookmark") {
            restoredURL = try? URL(resolvingBookmarkData: bookmark, options: .withSecurityScope,
                                   relativeTo: nil, bookmarkDataIsStale: &stale)
        }
        // Unsigned builds are not sandboxed and may not need a security-scoped bookmark.
        if restoredURL == nil, let path = defaults.string(forKey: "cleanwriter.filePath") {
            restoredURL = URL(fileURLWithPath: path)
        }
        if let restored = restoredURL {
            let accessing = restored.startAccessingSecurityScopedResource()
            if FileManager.default.isReadableFile(atPath: restored.path) {
                scopedURL = accessing ? restored : nil
                url = restored
                savedText = defaults.string(forKey: "cleanwriter.savedDocument")
                self.recentFiles.record(restored)
                if stale { rememberFile() }
            } else if accessing {
                restored.stopAccessingSecurityScopedResource()
            }
        }
        Publishers.Merge3(
            NotificationCenter.default.publisher(for: NSApplication.willResignActiveNotification),
            NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification),
            NotificationCenter.default.publisher(for: NSWindow.willCloseNotification)
        ).sink { [weak self] _ in self?.flushAutosave() }.store(in: &subscriptions)
        loadNavigation()
        scheduleAutosave()
    }

    deinit {
        autosaveTask?.cancel()
        scopedURL?.stopAccessingSecurityScopedResource()
    }

    func newDocument() {
        cancelAutosave()
        applyingDocument = true
        defer { applyingDocument = false }
        autosaveError = nil
        releaseAccess()
        url = nil
        savedText = nil
        text = ""
        defaults.removeObject(forKey: "cleanwriter.fileBookmark")
        defaults.removeObject(forKey: "cleanwriter.filePath")
        defaults.removeObject(forKey: "cleanwriter.savedDocument")
        navigation = DocumentNavigation()
        persistNavigation()
        navigationRevision = UUID()
    }

    func open(_ newURL: URL) throws {
        let accessing = newURL.startAccessingSecurityScopedResource()
        do {
            let loaded = try String(contentsOf: newURL, encoding: .utf8)
            cancelAutosave()
            applyingDocument = true
            defer { applyingDocument = false }
            autosaveError = nil
            releaseAccess()
            scopedURL = accessing ? newURL : nil
            url = newURL
            text = loaded
            savedText = loaded
            loadNavigation()
            navigationRevision = UUID()
            rememberFile()
        } catch {
            if accessing { newURL.stopAccessingSecurityScopedResource() }
            throw error
        }
    }

    func save(to destination: URL) throws {
        let accessing = destination.startAccessingSecurityScopedResource()
        do {
            try text.write(to: destination, atomically: true, encoding: .utf8)
            cancelAutosave()
            autosaveError = nil
            releaseAccess()
            scopedURL = accessing ? destination : nil
            url = destination
            savedText = text
            persistNavigation()
            rememberFile()
        } catch {
            if accessing { destination.stopAccessingSecurityScopedResource() }
            throw error
        }
    }

    func recordPosition(_ offset: Int) {
        let position = min(max(0, offset), (text as NSString).length)
        guard navigation.cursor != position else { return }
        navigation.cursor = position
        persistNavigation()
    }

    func toggleBookmark(at offset: Int? = nil) {
        let position = min(max(0, offset ?? navigation.cursor), (text as NSString).length)
        if let index = navigation.bookmarks.firstIndex(where: { $0.offset == position }) {
            navigation.bookmarks.remove(at: index)
        } else {
            navigation.bookmarks.append(.init(id: UUID(), offset: position,
                                             title: DocumentNavigation.title(at: position, in: text)))
            navigation.bookmarks.sort { $0.offset < $1.offset }
        }
        persistNavigation()
    }

    func removeBookmark(_ id: UUID) {
        navigation.bookmarks.removeAll { $0.id == id }
        persistNavigation()
    }

    private var navigationKey: String { url?.resolvingSymlinksInPath().standardizedFileURL.path ?? "untitled" }
    private static let navigationStorageKey = "cleanwriter.navigation"

    private func storedNavigation() -> [String: DocumentNavigation] {
        defaults.data(forKey: Self.navigationStorageKey)
            .flatMap { try? JSONDecoder().decode([String: DocumentNavigation].self, from: $0) } ?? [:]
    }

    private func loadNavigation() {
        navigation = storedNavigation()[navigationKey] ?? DocumentNavigation()
        navigation.clamp(to: text)
    }

    private func persistNavigation() {
        var all = storedNavigation()
        all[navigationKey] = navigation
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: Self.navigationStorageKey) }
    }

    /// Commit pending named-file changes before leaving the document or quitting.
    func flushAutosave() {
        cancelAutosave()
        guard let url, hasChanges else { return }
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            savedText = text
            defaults.set(savedText, forKey: "cleanwriter.savedDocument")
            autosaveError = nil
        } catch {
            // Keep the dirty state and recovered draft when the destination isn't writable.
            autosaveError = error.localizedDescription
        }
    }

    private func scheduleAutosave() {
        cancelAutosave()
        guard url != nil, hasChanges else { return }
        let delay = autosaveDelay
        autosaveTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: delay) }
            catch { return }
            guard !Task.isCancelled, let self else { return }
            self.flushAutosave()
        }
    }

    private func cancelAutosave() {
        autosaveTask?.cancel()
        autosaveTask = nil
    }

    private func rememberFile() {
        defaults.set(url?.path, forKey: "cleanwriter.filePath")
        if let url { recentFiles.record(url) }
        defaults.set(savedText, forKey: "cleanwriter.savedDocument")
        if let url, let bookmark = try? url.bookmarkData(options: .withSecurityScope,
                                                        includingResourceValuesForKeys: nil, relativeTo: nil) {
            defaults.set(bookmark, forKey: "cleanwriter.fileBookmark")
        } else {
            defaults.removeObject(forKey: "cleanwriter.fileBookmark")
        }
    }

    private func releaseAccess() {
        scopedURL?.stopAccessingSecurityScopedResource()
        scopedURL = nil
    }
}
