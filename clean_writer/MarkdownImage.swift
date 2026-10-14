import AppKit

/// Local Markdown images resolve against the document, never the app's working directory.
enum MarkdownImage {
    static func markdown(_ image: URL, relativeTo document: URL) -> String {
        let base = document.deletingLastPathComponent().standardizedFileURL.pathComponents
        let target = image.standardizedFileURL.pathComponents
        var shared = 0
        while shared < min(base.count, target.count), base[shared] == target[shared] { shared += 1 }
        let components = Array(repeating: "..", count: base.count - shared) + target.dropFirst(shared)
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "%?#<>\\")
        let path = components.map { $0.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0 }.joined(separator: "/")
        let alt = image.deletingPathExtension().lastPathComponent
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
        return "![\(alt)](<\(path)>)"
    }

    static func resolve(_ source: URL, documentURL: URL?) -> URL? {
        if source.isFileURL { return source }
        guard source.scheme == nil, let documentURL else { return nil }
        return URL(string: source.relativeString, relativeTo: documentURL.deletingLastPathComponent())?.absoluteURL
    }

    static func attachment(_ source: URL, documentURL: URL?, size: CGSize) -> NSTextAttachment? {
        guard let url = resolve(source, documentURL: documentURL), url.isFileURL,
              let image = NSImage(contentsOf: url), image.size.width > 0, image.size.height > 0 else { return nil }
        let scale = min(1, max(1, size.width) / image.size.width, max(1, size.height - 24) / image.size.height)
        let fitted = NSImage(size: CGSize(width: image.size.width * scale, height: image.size.height * scale))
        fitted.lockFocus()
        image.draw(in: CGRect(origin: .zero, size: fitted.size))
        fitted.unlockFocus()
        let attachment = NSTextAttachment()
        attachment.attachmentCell = NSTextAttachmentCell(imageCell: fitted)
        return attachment
    }
}
