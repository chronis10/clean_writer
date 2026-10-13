import Foundation
import Combine

@MainActor
final class RecentMarkdownFiles: ObservableObject {
    static let shared = RecentMarkdownFiles()

    struct Entry: Codable, Identifiable {
        let path: String
        let bookmark: Data?
        var id: String { path }
        var filename: String { URL(fileURLWithPath: path).lastPathComponent }
    }

    @Published private(set) var entries: [Entry]
    private let defaults: UserDefaults
    private static let key = "cleanwriter.recentFiles"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        entries = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
        var seen = Set<String>()
        entries = Array(entries.filter { seen.insert($0.path).inserted }.prefix(10))
    }

    func record(_ url: URL) {
        let path = url.standardizedFileURL.path
        let bookmark = try? url.bookmarkData(options: .withSecurityScope,
                                             includingResourceValuesForKeys: nil, relativeTo: nil)
        // Preserve an existing permission bookmark if refreshing it temporarily fails.
        let permission = bookmark ?? entries.first { $0.path == path }?.bookmark
        entries = [Entry(path: path, bookmark: permission)] + entries.filter { $0.path != path }
        entries = Array(entries.prefix(10))
        persist()
    }

    func resolve(_ entry: Entry) throws -> URL {
        guard let bookmark = entry.bookmark else { return URL(fileURLWithPath: entry.path) }
        var stale = false
        do {
            return try URL(resolvingBookmarkData: bookmark, options: .withSecurityScope,
                           relativeTo: nil, bookmarkDataIsStale: &stale)
        } catch {
            if FileManager.default.isReadableFile(atPath: entry.path) {
                return URL(fileURLWithPath: entry.path)
            }
            throw error
        }
    }

    func menuTitle(_ entry: Entry) -> String {
        if entries.filter({ $0.filename == entry.filename }).count > 1 {
            return "\(entry.filename) — \(URL(fileURLWithPath: entry.path).deletingLastPathComponent().path)"
        }
        return entry.filename
    }

    func remove(_ entry: Entry) {
        entries.removeAll { $0.id == entry.id }
        persist()
    }

    func clear() {
        entries = []
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(entries) { defaults.set(data, forKey: Self.key) }
    }
}
