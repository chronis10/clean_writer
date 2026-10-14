import Foundation

struct MarkdownInsertEntry: Identifiable {
    var label: String
    var command: String? = nil
    var children: [MarkdownInsertEntry] = []
    var id: String { command ?? label }
    static let menu: [MarkdownInsertEntry] = [
.init(label: "Heading", children: [.init(label: "Heading 1 (#)", command: "heading-1"),
.init(label: "Heading 2 (##)", command: "heading-2"),
.init(label: "Heading 3 (###)", command: "heading-3"),
.init(label: "Heading 4 (####)", command: "heading-4"),
.init(label: "Heading 5 (#####)", command: "heading-5"),
.init(label: "Heading 6 (######)", command: "heading-6"),
.init(label: "Underline Heading 1 (=)", command: "setext-1"),
.init(label: "Underline Heading 2 (-)", command: "setext-2")]),
.init(label: "Text Style", children: [.init(label: "Bold (**text**)", command: "bold"),
.init(label: "Italic (*text*)", command: "italic"),
.init(label: "Bold Italic (***text***)", command: "bold-italic"),
.init(label: "Strikethrough (~~text~~)", command: "strike"),
.init(label: "Inline Code (`code`)", command: "inline-code"),
.init(label: "Literal / Escaped Punctuation", command: "escape")]),
.init(label: "List", children: [.init(label: "Bulleted List (-)", command: "bullet"),
.init(label: "Numbered List (1.)", command: "numbered"),
.init(label: "Task List (- [ ])", command: "task"),
.init(label: "Completed Task (- [x])", command: "checked-task"),
.init(label: "Nested Bulleted List", command: "nested-bullet"),
.init(label: "Nested Numbered List", command: "nested-numbered")]),
.init(label: "Quote", children: [.init(label: "Block Quote (>)", command: "quote"),
.init(label: "Nested Quote (> >)", command: "nested-quote")]),
.init(label: "Code Block", children: [.init(label: "Fenced Code Block (```)", command: "code-block"),
.init(label: "Indented Code Block", command: "indented-code")]),
.init(label: "Link", children: [.init(label: "Link…", command: "link"),
.init(label: "Reference Link…", command: "reference-link"),
.init(label: "Automatic URL Link…", command: "autolink"),
.init(label: "Email Link…", command: "email-link")]),
.init(label: "Image…", command: "image"),
.init(label: "Table", command: "table"),
.init(label: "Horizontal Rule (---)", command: "rule"),
.init(label: "Note ([!NOTE])", command: "note"),
.init(label: "To-do ([!TODO])", command: "todo"),
.init(label: "Line Break", command: "line-break"),
.init(label: "Page Break", command: "page-break")
    ]
}

/// UTF-16 ranges match NSTextView selections and the canonical document.
enum MarkdownInsertion {
    struct Edit { var range: NSRange; var text: String; var selection: NSRange }
    static func edit(_ source: String, selection: NSRange, command: String) -> Edit {
        let full = source as NSString
        var range = NSRange(location: min(selection.location, full.length), length: 0)
        range.length = min(selection.length, full.length - range.location)
        let selected = full.substring(with: range)
        func result(_ text: String, _ focus: NSRange? = nil) -> Edit {
            let focus = focus ?? NSRange(location: (text as NSString).length, length: 0)
            return Edit(range: range, text: text,
                        selection: NSRange(location: range.location + focus.location, length: focus.length))
        }
        func focused(_ text: String, _ value: String) -> Edit { result(text, (text as NSString).range(of: value)) }
        func block(_ text: String, focus: String? = nil) -> Edit {
            let before = full.substring(to: range.location), after = full.substring(from: NSMaxRange(range))
            let prefix = before.isEmpty || before.hasSuffix("\n\n") || before.hasSuffix("\u{000C}") ? "" : before.hasSuffix("\n") ? "\n" : "\n\n"
            let suffix = after.isEmpty || after.hasPrefix("\n\n") || after.hasPrefix("\u{000C}") ? "" : after.hasPrefix("\n") ? "\n" : "\n\n"
            let textRange = focus.map { (text as NSString).range(of: $0) } ?? NSRange(location: (text as NSString).length, length: 0)
            return result(prefix + text + suffix, NSRange(location: (prefix as NSString).length + textRange.location, length: textRange.length))
        }
        let styles = ["bold": ("**", "bold text"), "italic": ("*", "italic text"), "bold-italic": ("***", "bold italic text"), "strike": ("~~", "removed text")]
        if let (marker, placeholder) = styles[command] {
            let content = selected.isEmpty ? placeholder : selected
            return result(marker + content + marker, NSRange(location: marker.count, length: (content as NSString).length))
        }
        func fence(_ content: String, minimum: Int) -> String {
            let runs = content.components(separatedBy: CharacterSet(charactersIn: "`" ).inverted).map(\.count)
            return String(repeating: "`", count: max(minimum, (runs.max() ?? 0) + 1))
        }
        if command == "inline-code" {
            let content = selected.isEmpty ? "code" : selected, marker = fence(content, minimum: 1)
            let padding = content.hasPrefix("`") || content.hasSuffix("`") ? " " : ""
            return result(marker + padding + content + padding + marker,
                          NSRange(location: marker.count + padding.count, length: (content as NSString).length))
        }
        if command == "escape" {
            let content = selected.isEmpty ? "*literal text*" : selected
            let escaped = content.map { "\\`*_{}[]()#+.!|>~-".contains($0) ? "\\" + String($0) : String($0) }.joined()
            return result(escaped, NSRange(location: 0, length: (escaped as NSString).length))
        }
        if command == "line-break" { return result("  \n") }
        if command == "page-break" { return result("\u{000C}") }
        if command == "autolink" || command == "email-link" {
            let content = selected.isEmpty ? (command == "autolink" ? "https://example.com" : "name@example.com") : selected
            return result("<" + content + ">", NSRange(location: 1, length: (content as NSString).length))
        }
        if command == "link" {
            let content = selected.isEmpty ? "link text" : selected
            let label = content.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
            return focused("[" + label + "](https://example.com)", "https://example.com")
        }
        let listCommands = ["bullet", "numbered", "task", "checked-task", "nested-bullet", "nested-numbered"]
        let lineCommands = listCommands + ["quote", "nested-quote", "indented-code", "setext-1", "setext-2"]
        if command.hasPrefix("heading-") || lineCommands.contains(command) {
            // Stop at manual page boundaries as well as line boundaries.
            var start = range.location
            while start > 0 && full.character(at: start - 1) != 10 && full.character(at: start - 1) != 12 { start -= 1 }
            var end = NSMaxRange(range)
            if range.length > 0 && end > start && full.character(at: end - 1) == 10 { end -= 1 }
            while end < full.length && full.character(at: end) != 10 && full.character(at: end) != 12 { end += 1 }
            range = NSRange(location: start, length: end - start)
            let original = full.substring(with: range)
            if original.isEmpty && ["nested-bullet", "nested-numbered"].contains(command) {
                return block(command == "nested-bullet" ? "- List item\n  - Nested item" : "1. List item\n   1. Nested item", focus: "Nested item")
            }
            let placeholder = command.hasPrefix("heading") || command.hasPrefix("setext") ? "Heading" : command.contains("code") ? "code" : command.contains("quote") ? "Quote" : command.contains("task") ? "Task" : "List item"
            let content = original.isEmpty ? placeholder : original
            if command.hasPrefix("setext") { return block(content + "\n" + (command == "setext-1" ? "===" : "---"), focus: original.isEmpty ? placeholder : nil) }
            let text = content.components(separatedBy: "\n").enumerated().map { index, originalLine in
                var line = originalLine
                if command.hasPrefix("heading-"), let level = Int(command.replacingOccurrences(of: "heading-", with: "")) {
                    line = line.replacingOccurrences(of: "^#{1,6}\\s+", with: "", options: .regularExpression)
                    return String(repeating: "#", count: level) + " " + line
                }
                if listCommands.contains(command) {
                    line = line.replacingOccurrences(of: "^(\\s*)(?:[-+*]\\s+(?:\\[[ xX]\\]\\s+)?|\\d+[.)]\\s+)", with: "$1", options: .regularExpression)
                }
                let prefixes = ["bullet": "- ", "numbered": "\(index + 1). ", "task": "- [ ] ", "checked-task": "- [x] ", "nested-bullet": "  - ", "nested-numbered": "   \(index + 1). ", "quote": "> ", "nested-quote": "> > ", "indented-code": "    "]
                return (prefixes[command] ?? "") + line
            }.joined(separator: "\n")
            if command == "indented-code" { return block(text, focus: original.isEmpty ? placeholder : nil) }
            return original.isEmpty ? focused(text, placeholder) : result(text)
        }
        if command == "note" || command == "todo" {
            let content = selected.isEmpty ? (command == "note" ? "Your note" : "- [ ] Task") : selected
            return block("> [!" + command.uppercased() + "]\n" + content.components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n"), focus: selected.isEmpty ? (command == "note" ? "Your note" : "Task") : nil)
        }
        if command == "code-block" {
            let content = selected.isEmpty ? "code" : selected, marker = fence(content, minimum: 3)
            return block(marker + "\n" + content + "\n" + marker, focus: selected.isEmpty ? "code" : nil)
        }
        if command == "reference-link" { return block("[" + (selected.isEmpty ? "link text" : selected) + "][reference]\n\n[reference]: https://example.com", focus: "https://example.com") }
        if command == "table" { return block("| Column 1 | Column 2 | Column 3 |\n| :--- | :---: | ---: |\n| Cell | Cell | Cell |", focus: "Cell") }
        if command == "rule" { return block("---") }
        return result(selected)
    }
}
