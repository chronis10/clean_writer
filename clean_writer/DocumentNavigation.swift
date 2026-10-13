import Foundation

/// Local navigation metadata. Offsets use UTF-16 to match NSTextView and page ranges.
struct DocumentNavigation: Codable {
    struct Bookmark: Codable, Identifiable {
        let id: UUID
        var offset: Int
        var title: String
    }

    var cursor = 0
    var bookmarks: [Bookmark] = []

    mutating func clamp(to text: String) {
        let length = (text as NSString).length
        cursor = min(max(0, cursor), length)
        for index in bookmarks.indices {
            bookmarks[index].offset = min(max(0, bookmarks[index].offset), length)
        }
    }

    /// Move anchors along with an edit, including paste, delete, undo, and page breaks.
    mutating func adjust(from oldText: String, to newText: String) {
        let old = Array(oldText.utf16), new = Array(newText.utf16)
        var start = 0
        while start < min(old.count, new.count), old[start] == new[start] { start += 1 }
        var suffix = 0
        while suffix < min(old.count, new.count) - start,
              old[old.count - suffix - 1] == new[new.count - suffix - 1] { suffix += 1 }
        let end = old.count - suffix
        let inserted = new.count - start - suffix
        func moved(_ offset: Int) -> Int {
            if offset < start { return offset }
            if offset >= end { return offset + inserted - (end - start) }
            return start + inserted
        }
        cursor = moved(cursor)
        for index in bookmarks.indices { bookmarks[index].offset = moved(bookmarks[index].offset) }
        clamp(to: newText)
    }

    static func title(at offset: Int, in text: String) -> String {
        let source = text as NSString
        guard source.length > 0 else { return "Empty page" }
        let range = source.lineRange(for: NSRange(location: min(max(0, offset), source.length - 1), length: 0))
        let line = source.substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines)
        return line.isEmpty ? "Bookmark" : String(line.prefix(48))
    }
}
