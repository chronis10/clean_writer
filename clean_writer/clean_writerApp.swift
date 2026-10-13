// Clean Writer — MIT licensed.

import SwiftUI
import AppKit

@main
struct clean_writerApp: App {
    @NSApplicationDelegateAdaptor(WriterAppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            WriterView()
        }
        .commands { WriterFileCommands() }
    }
}

@MainActor
final class WriterAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Set the running Dock icon explicitly, including when launched through Xcode.
        guard let url = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
              let icon = NSImage(contentsOf: url) else { return }
        NSApplication.shared.applicationIconImage = icon
    }
}

struct WriterFileActions {
    var new: () -> Void
    var open: () -> Void
    var openRecent: (RecentMarkdownFiles.Entry) -> Void
    var save: () -> Void
    var saveAs: () -> Void
    var exportPDF: () -> Void
}

private struct WriterFileActionsKey: FocusedValueKey {
    typealias Value = WriterFileActions
}

extension FocusedValues {
    var writerFileActions: WriterFileActions? {
        get { self[WriterFileActionsKey.self] }
        set { self[WriterFileActionsKey.self] = newValue }
    }
}

struct WriterFileCommands: Commands {
    @FocusedValue(\.writerFileActions) private var actions
    @ObservedObject private var recentFiles = RecentMarkdownFiles.shared

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New") { actions?.new() }
                .disabled(actions == nil)
                .keyboardShortcut("n")
            Divider()
            Button("Open") { actions?.open() }
                .disabled(actions == nil)
                .keyboardShortcut("o")
            Menu("Open Recent") {
                if recentFiles.entries.isEmpty {
                    Button("No Recent Files") {}.disabled(true)
                } else {
                    ForEach(recentFiles.entries) { entry in
                        Button(recentFiles.menuTitle(entry)) { actions?.openRecent(entry) }
                            .help(entry.path)
                    }
                }
            }
            .disabled(actions == nil)
            Button("Save") { actions?.save() }
                .disabled(actions == nil)
                .keyboardShortcut("s")
            Button("Save As…") { actions?.saveAs() }
                .disabled(actions == nil)
                .keyboardShortcut("s", modifiers: [.command, .shift])
            Divider()
            Button("Export PDF…") { actions?.exportPDF() }
                .disabled(actions == nil)
                .keyboardShortcut("e", modifiers: [.command, .shift])
        }
    }
}
