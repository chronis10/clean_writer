<p align="center"><img src="src-tauri/icons/128x128.png" width="112" alt="Clean Writer icon"></p>

# Clean Writer

## Recent updates

- **Independent A4 pages:** Each page has its own editor and bounded content area. Overflow scrolls inside the page instead of bleeding into neighbouring pages.
- **Reliable page insertion:** Add page inserts immediately below the current page indicated in the sidebar, preserving later content.
- **Page removal:** Right-click a sidebar thumbnail and choose **Remove page**. Undo restores the page and its contents.
- **Sidebar tracking:** The sidebar follows your position and updates its current-page indicator in both editor and preview.
- **Editor/preview synchronisation:** Both modes share the same page containers, and switching modes preserves your reading position.
- **Intact Markdown blocks:** Automatic page boundaries keep code blocks, tables, lists, paragraphs, and other Markdown blocks together.
- **HTML image rendering:** HTML image blocks render as images, respecting alignment, width, and relative file paths.
- **Autosave settings:** Autosave is enabled by default and can be changed in Settings.
- **Current-page bookmarks:** The bookmark button and Ctrl/⌘D toggle a bookmark on the current visible page in both editor and preview.
- **Separate font settings:** Choose editor and preview fonts independently, with Serif, Sans Serif, and Monospaced options.
- **Markdown syntax colours:** Source Markdown uses readable colours tailored to light and dark mode.
- **Settings display fix:** Removed the fading grey scrollbar that appeared over Settings while preserving page scrolling.
- **Dictionary installer:** Settings → Spelling dictionaries offers 12 additional languages using `.aff`/`.dic` pairs. Installed dictionaries activate immediately and work offline. Greek and US English remain bundled.

## About

A focused Markdown editor for **Linux, Windows, and macOS**, rebuilt with **Rust + Tauri 2** on the `rust` branch. The interface uses TypeScript, CSS, and CodeMirror; Rust handles Markdown parsing, native file dialogs, document storage, and recovery. No Swift or Xcode application code is required.

This branch is the cross-platform 2.0 development version. The existing 1.x GitHub releases are the previous macOS application, not builds of this branch.

![Clean Writer cross-platform preview](docs/screenshots/light-preview.png)

## Features

- A4 source pages with the Swift app’s 595.28 × 841.89-point canvas, neutral light/dark appearance, 192-point sidebar, icon toolbar, and footer. Each source page has its own CodeMirror editor and bounded scrolling text area. Editing one page leaves neighbouring page contents unchanged; undo/redo and search still cover the whole document.
- Local and web images in preview, thumbnails, and PDF export, with an Insert → Image file picker and relative paths.
- HTML image blocks (including alignment and width attributes) render in preview and PDF with images resolved relative to the Markdown file. Switching editor/preview preserves the visible page and reading position, using source block positions to account for formatting differences. The sidebar scrolls and moves its current-page indicator as you navigate the editor or preview. Right-click a thumbnail and choose Remove page to delete that page and its contents; Undo restores it. Editor and formatted preview share the same independent A4 page containers, page numbers, thumbnails, and manual page boundaries. Add page inserts a blank container immediately below the selected sidebar thumbnail in either mode, preserving later content.
- Headings, emphasis, strikethrough, code, links, tables, nested lists, quotes, and task lists.
- Blue `[!NOTE]` and amber `[!TODO]` callouts. Quoted and bare markers are supported; markers inside code stay literal.
- New, Open, Open Recent, Save, Save As, and Export PDF through native File menus.
- Automatic draft recovery, explicit Save, per-file cursor positions, and bookmarks that follow edits. A small bookmark symbol appears at the top-left of page thumbnails; note/todo symbols stay bottom-right. The bookmark button and Ctrl/⌘D toggle the current visible page in both editor and preview.
- Safe file replacement and external-change detection. Autosave is enabled by default for named files and can be switched off in Settings. Closing with unsaved edits offers Save / Discard / Cancel; canceled or failed saves keep the window open. Discarded edits are removed from recovery. A failed save retains your recovery copy; use Save As if another editor changed the file.
- Light/dark appearance, serif/sans/monospaced fonts, font size, margins, sidebar visibility, and 50–200% zoom.
- Offline English and Greek spell-check with bundled dictionaries, misspelling underlines, and click-to-apply hover/right-click suggestions. Works on first launch, including Windows and Linux installers.
- Markdown file associations in installers, command-line file opening, and a single desktop instance.
- Local-only storage: no account, analytics, cloud backend, or automatic updater.

## Run from source

Install **Node.js 22 LTS**, **Rust stable**, and the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system.

Rust and Node.js are required to build/run from source. They are not required to use a packaged installer.

On Linux/macOS, install Rust using the [official rustup installer](https://rust-lang.org/tools/install/):

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
. "$HOME/.cargo/env"
cargo --version
rustc --version
```

Choose the default installation when prompted. On Windows, download and run `rustup-init.exe` from the official installation page, then open a new terminal and verify `cargo --version` and `rustc --version`.

On Debian/Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Windows requires Microsoft C++ Build Tools with the desktop C++ workload and WebView2. macOS requires Xcode Command Line Tools. Linux file dialogs use the desktop's XDG portal; a working `xdg-desktop-portal` and an appropriate desktop backend are needed.

From the repository root:

```sh
npm ci
npm run desktop
```

### Troubleshooting: Cargo not found

If `npm run desktop` reports `failed to run 'cargo metadata'` with `No such file or directory (os error 2)`, Tauri cannot find Cargo. Install Rust using the instructions above, or open a new terminal after an existing installation.

On Linux/macOS, activate the default installation in your current shell:

```sh
. "$HOME/.cargo/env"
cargo --version
npm run desktop
```

On Windows, ensure `%USERPROFILE%\.cargo\bin` is on `PATH` and restart your terminal. Temporary tools under `.local-tools/` are not included in Git; a fresh checkout needs its own Rust installation.

`npm run dev` opens only the browser interface for layout work. Native files, Rust Markdown rendering, and PDF export require `npm run desktop`.

## Build installers

```sh
npm run desktop:build
```

Output is under `src-tauri/target/release/bundle/`. Build on the target operating system: Windows installers on Windows, macOS bundles/DMGs on macOS, and Linux packages on Linux. The GitHub Actions workflow checks and builds all three platforms. Pushing a `v2.*` tag also publishes the installers and SHA-256 checksums to GitHub Releases; tags containing a hyphen are marked as prereleases. Builds are unsigned unless signing is configured separately. The macOS CI job builds the runner's architecture, not a universal Intel/Apple Silicon binary.

## Insert menu

Use **Insert** to add supported Markdown without memorizing its syntax. It offers all six headings and underline-style headings, bold/italic/bold italic/strikethrough, inline and block code, escaped punctuation, bulleted/numbered/nested lists, pending/completed tasks, quotes/nested quotes, links/reference links/automatic URL and email links, images, aligned tables, horizontal rules, notes, todos, line breaks, and page breaks.

Inline formatting wraps selected text. Headings and lists format the current or selected lines. With no content selected, commands insert a template and select its editable placeholder. Each insertion can be undone normally.

**Insert → Image…** opens the native file browser in the Markdown file’s folder. Save an untitled document first; canceling the save or image picker leaves the text unchanged. Images beside the document use a filename such as `photo.png`; images in subfolders use `images/photo.png`; images in sibling folders use `../assets/photo.png`. Spaces and special characters are URL-encoded. The image file stays in its original location. On Windows, an image on another drive falls back to a file URL because a relative path cannot cross drives.

Keep the `.md` file and its image folders together when sharing or moving the document. Renaming or moving an image without updating its Markdown path makes that image unavailable.

## Keyboard shortcuts

Use **Ctrl** on Windows/Linux and **⌘** on macOS.

| Action                       | Shortcut                |
| ---------------------------- | ----------------------- |
| New                          | Ctrl/⌘N                 |
| Open                         | Ctrl/⌘O                 |
| Save                         | Ctrl/⌘S                 |
| Save As                      | Ctrl/⌘Shift+S           |
| Export PDF                   | Ctrl/⌘Shift+E           |
| Find                         | Ctrl/⌘F                 |
| Next / previous match        | Ctrl/⌘G / Ctrl/⌘Shift+G |
| Toggle current page bookmark | Ctrl/⌘D                 |
| Toggle sidebar               | Ctrl/⌘Alt+S             |
| Undo / redo                  | Ctrl/⌘Z / Ctrl/⌘Shift+Z |
| Quit                         | Ctrl/⌘Q                 |

Use the zoom slider, Ctrl+wheel/trackpad pinch, or click the zoom percentage to reset to 100%. Preview is read-only; edit task-list markers in source to complete tasks.

## Documents and recovery

Documents remain UTF-8 `.md` files. Manual page breaks retain the original form-feed character (`U+000C`) and create a new A4 source page. Existing Markdown is split into independent source page containers only between complete Markdown blocks, without changing its text. Fenced code, lists, tables, quotes, HTML, and paragraphs stay intact; oversized blocks scroll within one container. Older saved boundaries inside blocks are repaired once when opened. Their boundaries are retained in recovery and per-file navigation metadata; changing typography does not redistribute their contents. Text that exceeds a source page stays scrollable within its margins. Preview renders each source page into its own fixed A4 container, with local overflow scrolling and stable container identity. PDF export separately paginates the complete formatted content so overflow is included.

Settings, recent paths, navigation, the active document, and its saved baseline are stored in `session-v2.json` in Tauri's OS-specific application data directory. A recovery checkpoint is scheduled 200 ms after edits or cursor changes. Autosave writes named Markdown files after one second of inactivity by default; toggle it in Settings. Untitled documents retain draft recovery until Save chooses a path. Close/quit asks before closing unsaved edits. Recovery checkpoints do not clear the unsaved state. Abrupt process termination can lose edits made since the last completed checkpoint.

The Swift application's macOS preferences are not imported. Your existing Markdown documents can be opened directly; previously stored settings, recent files, bookmarks, and unsaved Swift drafts remain in the old application's preferences.

## Images

Use **··· → Insert image…**, or ordinary Markdown:

```markdown
![A photo](images/photo.png)
![A filename with spaces](<images/my photo.jpg>)
![A web image](https://example.com/photo.png)
```

Local paths resolve relative to the saved Markdown file. Keep an `images/` folder beside your document for portability. The picker inserts a relative link for files within the document's folder, and an absolute `file://` link otherwise. Save an untitled document before using relative paths; absolute links work in untitled drafts.

PNG, JPEG, GIF, WebP, and BMP are supported. GIFs render their first frame. JPEG camera orientation is applied. SVG is not supported. Images fit within A4 content margins, move intact between pages, and are embedded into exported PDFs. Missing or unsupported images show an inline placeholder; hover over it for the error.

Web image URLs are downloaded when rendering preview or generating page thumbnails, including while editing source. PDF export fetches them again. Requests do not use browser login cookies. Local-only documents remain offline; linking a web image contacts its host. Embedded base64 raster images are also supported.

Images are limited to 16 MB per file/download and 8192 pixels per dimension; large images are resized to at most 2400 pixels per dimension for display/export. Preview caches up to 16 images for 30 seconds; reopening preview refreshes them.

## Spell-check

English and Greek spelling data and the checker are embedded in the application executable on every supported platform. The `.exe`, `.msi`, `.deb`, and other bundles need no dictionary downloads, language-pack setup, administrator commands, or network connection for spelling.

In edit mode, hover over an underlined word or right-click it to open suggestions. Click a suggestion to replace only that word; Undo restores it. Correct words keep the standard context menu. Accented Greek text, including decomposed Unicode input, is supported. Text is never automatically corrected or sent to a service.

The checker runs in the background and checks visible source text as you type or scroll. Dictionary redistribution notices are included in the installer resources under `licenses/spelling`; the corresponding source files are in `src-tauri/dictionaries`.

## Current differences and limits

- Editor and preview keep the same page count and content boundaries. PDF export may use additional pages to include all formatted content, including content reached by scrolling inside an editor/preview page.
- PDF pages are high-resolution images of the formatted layout, including Unicode and page numbers. Exported text is **not selectable/searchable**, and long PDFs can be large. This differs from the previous native text PDF exporter.
- Fonts and webview text metrics can differ between operating systems. Long blocks flow across pages; unusual oversized non-text content may require smaller fonts or margins.
- HTML is displayed as literal text. No mathematical formulas, syntax colouring, or footnotes are provided.
- Files must be UTF-8 and at most 20 MB when opened. Very long documents may take time to paginate or export.
- Installers require their respective build/test environments. UI and backend checks on one platform do not prove installer behavior on other operating systems.

## Checks

```sh
npm test
npm run format:check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked -- --ignored
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
npx playwright install chromium
npm run test:ui
```

Rust tests cover Markdown rendering, image decoding and path resolution, JPEG orientation, Unicode saves, recovery, navigation, external-change protection, and failed-open rollback. TypeScript tests cover document anchors and preferences. UI tests exercise editing, save failures, document replacement, search, pagination, appearance, and PDF generation using a mocked desktop bridge; they do not replace native OS testing. Linux CI additionally runs `tests/native_close.py` against the packaged `.deb` in isolated X11/D-Bus sessions at 100% and 200% display scaling. It checks every page boundary in a long Markdown document at 130% zoom, verifies native caret placement and actual typing at 50%, 100%, and 150% page zoom on the first and later pages, then sends a real native close event after a typing pause and verifies Cancel and Save.

## Project structure

```text
src/                 TypeScript editor, interface, and page layout
src-tauri/src/       Rust desktop commands, Markdown parser, storage
src-tauri/icons/     Desktop icons
src-tauri/           Tauri configuration and Rust dependencies
tests/               Unit tests and browser interface tests
.github/workflows/   Windows, Linux, and macOS build pipeline
```

## License

[MIT](LICENSE). Copyright © 2026 chronis10.

Editor and preview fonts can be selected independently in Settings → Typography (Serif, Sans Serif, or Monospaced). Source Markdown uses a readable syntax palette that follows light and dark appearance.

Settings → Spelling dictionaries lets you install English (UK), French, German,
Spanish (Spain), Italian, Portuguese (Brazil), Dutch, Russian, Ukrainian, Polish,
Portuguese (Portugal), and Swedish. Greek and English (US) are included. Additional languages
are enabled immediately, work offline after installation, and reload on startup.
The installer downloads pinned Hunspell `.aff`/`.dic` pairs and license notices
from [LibreOffice dictionaries](https://github.com/LibreOffice/dictionaries),
converts the declared encoding to UTF-8, and validates the pair before saving it.
Each language is stored under the app data directory's `dictionaries/<locale>/`
folder (`~/.local/share/com.chronis10.cleanwriter/dictionaries/` on Linux).
The installed pair, original license notices, and source revision stay together;
no administrator access is required. Failed downloads can be retried in Settings.
