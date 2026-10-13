import Foundation

/// Literal document search using the UTF-16 ranges shared by TextKit and pagination.
enum DocumentSearch {
    static func matches(in document: String, query: String, matchCase: Bool) -> [NSRange] {
        guard !query.isEmpty else { return [] }
        let text = document as NSString
        let options: NSString.CompareOptions = matchCase ? [.literal] : [.literal, .caseInsensitive]
        var remaining = NSRange(location: 0, length: text.length)
        var result: [NSRange] = []
        while remaining.length > 0 {
            let match = text.range(of: query, options: options, range: remaining)
            guard match.location != NSNotFound, match.length > 0 else { break }
            result.append(match)
            let next = NSMaxRange(match)
            remaining = NSRange(location: next, length: text.length - next)
        }
        return result
    }
}
