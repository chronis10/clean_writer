mod document;
mod images;
use document::{atomic_write, read_document, Bookmark, Document, Rendered, Session};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn update_recent_menu(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let Some(tauri::menu::MenuItemKind::Submenu(file)) = menu.get("file") else {
        return Ok(());
    };
    let Some(tauri::menu::MenuItemKind::Submenu(recent)) = file.get("recent") else {
        return Ok(());
    };
    while !recent.items().map_err(|e| e.to_string())?.is_empty() {
        recent.remove_at(0).map_err(|e| e.to_string())?;
    }
    if paths.is_empty() {
        recent
            .append(
                &tauri::menu::MenuItem::with_id(
                    &app,
                    "no-recent",
                    "No Recent Files",
                    false,
                    None::<&str>,
                )
                .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
    } else {
        for (index, path) in paths.iter().take(10).enumerate() {
            let title = Path::new(path)
                .file_name()
                .and_then(|p| p.to_str())
                .unwrap_or(path);
            recent
                .append(
                    &tauri::menu::MenuItem::with_id(
                        &app,
                        format!("recent-{index}"),
                        title,
                        true,
                        None::<&str>,
                    )
                    .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct InsertEntry {
    label: String,
    id: Option<String>,
    #[serde(default)]
    items: Vec<InsertEntry>,
}
fn append_insert_items(
    app: &tauri::AppHandle,
    menu: &tauri::menu::Submenu<tauri::Wry>,
    entries: &[InsertEntry],
) -> Result<(), tauri::Error> {
    for entry in entries {
        if let Some(id) = &entry.id {
            menu.append(&tauri::menu::MenuItem::with_id(
                app,
                format!("insert-{id}"),
                &entry.label,
                true,
                None::<&str>,
            )?)?;
        } else {
            let child = tauri::menu::Submenu::new(app, &entry.label, true)?;
            append_insert_items(app, &child, &entry.items)?;
            menu.append(&child)?;
        }
    }
    Ok(())
}

fn image_markdown(path: &Path, document: &Path) -> Result<String, String> {
    let url = tauri::Url::from_file_path(path).map_err(|_| "Invalid image path.")?;
    let parent = document
        .parent()
        .ok_or("Save the Markdown file before inserting an image.")?;
    let base =
        tauri::Url::from_directory_path(parent).map_err(|_| "Invalid document directory.")?;
    // Windows drive letters/UNC volumes cannot be represented by a relative file path.
    let same_root = parent.components().next() == path.components().next();
    let source = if same_root {
        base.make_relative(&url)
    } else {
        None
    }
    .unwrap_or_else(|| url.to_string());
    let alt = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]");
    Ok(format!("![{alt}](<{source}>)"))
}

struct Runtime {
    session: Session,
    saved_text: Option<String>,
    navigation: HashMap<String, Document>,
    store: PathBuf,
    pending_open: Option<PathBuf>,
}
struct Writer(Mutex<Runtime>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    session: Session,
    saved_text: Option<String>,
    pending_open: bool,
}
impl Runtime {
    fn persist(&self) -> Result<(), String> {
        let data = serde_json::json!({"session":self.session,"navigation":self.navigation,"savedText":self.saved_text});
        atomic_write(
            &self.store,
            &serde_json::to_vec(&data).map_err(|e| e.to_string())?,
        )
    }
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            session: self.session.clone(),
            saved_text: self.saved_text.clone(),
            pending_open: self.pending_open.is_some(),
        }
    }
    fn remember(&mut self, path: &str) {
        self.session.recent.retain(|item| item != path);
        self.session.recent.insert(0, path.into());
        self.session.recent.truncate(10);
    }
    fn keep_navigation(&mut self) {
        if let Some(path) = &self.session.document.path {
            let mut metadata = self.session.document.clone();
            metadata.text.clear();
            self.navigation.insert(path.clone(), metadata);
        }
    }
    fn save(&mut self, destination: &Path, save_as: bool) -> Result<Snapshot, String> {
        if !save_as && self.session.document.path.is_some() {
            if let Some(saved) = &self.saved_text {
                if read_document(destination)? != *saved {
                    return Err("The file changed outside Clean Writer. Use Save As to preserve your edits, then reopen the original.".into());
                }
            }
        }
        atomic_write(destination, self.session.document.text.as_bytes())?;
        let path = fs::canonicalize(destination)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        self.session.document.path = Some(path.clone());
        self.saved_text = Some(self.session.document.text.clone());
        self.remember(&path);
        self.keep_navigation();
        self.persist()?;
        Ok(self.snapshot())
    }
    // Opening/new must not change the active path if recovery storage fails.
    // Otherwise the frontend's old text could later be saved to the new path.
    fn transition(&mut self, change: impl FnOnce(&mut Self)) -> Result<Snapshot, String> {
        let previous = (
            self.session.clone(),
            self.saved_text.clone(),
            self.navigation.clone(),
        );
        change(self);
        if let Err(error) = self.persist() {
            (self.session, self.saved_text, self.navigation) = previous;
            return Err(error);
        }
        Ok(self.snapshot())
    }
    fn open(&mut self, path: PathBuf) -> Result<Snapshot, String> {
        let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
        let text = read_document(&path)?;
        let key = path.to_string_lossy().into_owned();
        self.transition(move |writer| {
            writer.keep_navigation();
            let mut doc = writer.navigation.get(&key).cloned().unwrap_or_default();
            doc.path = Some(key.clone());
            doc.text = text.clone();
            writer.session.document = doc;
            writer.saved_text = Some(text);
            writer.remember(&key);
        })
    }
}
fn lock(state: &Writer) -> Result<std::sync::MutexGuard<'_, Runtime>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Document state is unavailable.".into())
}
#[tauri::command]
fn initial_state(state: State<Writer>) -> Result<Snapshot, String> {
    Ok(lock(&state)?.snapshot())
}
#[tauri::command]
fn render_markdown(text: String) -> Rendered {
    document::render(&text)
}
#[tauri::command]
async fn load_image(
    source: String,
    document_path: Option<String>,
    state: State<'_, Writer>,
) -> Result<images::LoadedImage, String> {
    if document_path != lock(&state)?.session.document.path {
        return Err("Document changed while loading images.".into());
    }
    images::load(source, document_path.map(PathBuf::from)).await
}
// Give native pickers an owner so the OS keeps them above the editor window.
fn file_dialog(window: &tauri::WebviewWindow) -> rfd::AsyncFileDialog {
    rfd::AsyncFileDialog::new().set_parent(window)
}
#[tauri::command]
async fn pick_image(
    window: tauri::WebviewWindow,
    state: State<'_, Writer>,
) -> Result<Option<String>, String> {
    let current = lock(&state)?
        .session
        .document
        .path
        .clone()
        .ok_or("Save the Markdown file before inserting an image.")?;
    let document = PathBuf::from(&current);
    let mut dialog =
        file_dialog(&window).add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
    if let Some(parent) = document.parent() {
        dialog = dialog.set_directory(parent);
    }
    let Some(file) = dialog.pick_file().await else {
        return Ok(None);
    };
    if lock(&state)?.session.document.path.as_deref() != Some(current.as_str()) {
        return Err("Document changed while choosing an image.".into());
    }
    let path = fs::canonicalize(file.path()).map_err(|e| e.to_string())?;
    image_markdown(&path, &document).map(Some)
}
#[tauri::command]
fn checkpoint(
    text: String,
    cursor: usize,
    bookmarks: Vec<Bookmark>,
    preferences: serde_json::Value,
    state: State<Writer>,
) -> Result<(), String> {
    let mut writer = lock(&state)?;
    writer.session.document.text = text;
    writer.session.document.cursor = cursor;
    writer.session.document.bookmarks = bookmarks;
    writer.session.preferences = preferences;
    writer.keep_navigation();
    writer.persist()
}
#[tauri::command]
fn new_document(state: State<Writer>) -> Result<Snapshot, String> {
    let mut writer = lock(&state)?;
    writer.transition(|writer| {
        writer.keep_navigation();
        writer.session.document = Document::default();
        writer.saved_text = None;
    })
}
#[tauri::command]
async fn open_document(
    window: tauri::WebviewWindow,
    state: State<'_, Writer>,
) -> Result<Option<Snapshot>, String> {
    let chosen = file_dialog(&window)
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .pick_file()
        .await;
    match chosen {
        Some(file) => Ok(Some(lock(&state)?.open(file.path().into())?)),
        None => Ok(None),
    }
}
#[tauri::command]
fn open_requested(state: State<Writer>) -> Result<Snapshot, String> {
    let mut writer = lock(&state)?;
    let path = writer.pending_open.take().ok_or("No requested document.")?;
    writer.open(path)
}
#[tauri::command]
fn open_recent(path: String, state: State<Writer>) -> Result<Snapshot, String> {
    let mut writer = lock(&state)?;
    if !writer.session.recent.contains(&path) {
        return Err("This file is not in your recent files.".into());
    }
    writer.open(path.into())
}
#[tauri::command]
async fn save_document(
    save_as: bool,
    window: tauri::WebviewWindow,
    state: State<'_, Writer>,
) -> Result<Option<Snapshot>, String> {
    let current = lock(&state)?.session.document.path.clone();
    let chosen = if save_as || current.is_none() {
        let name = current
            .as_ref()
            .and_then(|p| Path::new(p).file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("Untitled.md");
        match file_dialog(&window)
            .add_filter("Markdown", &["md"])
            .set_file_name(name)
            .save_file()
            .await
        {
            Some(file) => Some(file.path().to_path_buf()),
            None => return Ok(None),
        }
    } else {
        current.clone().map(PathBuf::from)
    };
    let destination = chosen.ok_or("No destination selected.")?;
    let mut writer = lock(&state)?;
    Ok(Some(writer.save(&destination, save_as)?))
}
#[tauri::command]
async fn export_pdf(
    bytes: Vec<u8>,
    name: String,
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    if !bytes.starts_with(b"%PDF-") {
        return Err("Invalid PDF output.".into());
    }
    if let Some(file) = file_dialog(&window)
        .add_filter("PDF", &["pdf"])
        .set_file_name(&name)
        .save_file()
        .await
    {
        atomic_write(file.path(), &bytes)?;
        return Ok(true);
    }
    Ok(false)
}
#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only HTTP and HTTPS links can be opened.".into());
    }
    open::that(url).map_err(|e| e.to_string())
}

fn requested_path(args: impl Iterator<Item = std::ffi::OsString>, cwd: &Path) -> Option<PathBuf> {
    args.filter_map(|arg| {
        if arg.to_string_lossy().starts_with("file://") {
            tauri::Url::parse(&arg.to_string_lossy())
                .ok()?
                .to_file_path()
                .ok()
        } else {
            Some(PathBuf::from(arg))
        }
    })
    .find(|p| {
        p.extension().is_some_and(|extension| {
            matches!(
                extension.to_string_lossy().to_ascii_lowercase().as_str(),
                "md" | "markdown" | "txt"
            )
        })
    })
    .map(|path| {
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    })
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(path) =
                requested_path(args.into_iter().skip(1).map(Into::into), Path::new(&cwd))
            {
                if let Ok(mut writer) = lock(&app.state::<Writer>()) {
                    writer.pending_open = Some(path);
                }
                let _ = app.emit("open-requested", ());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            let store = dir.join("session-v2.json");
            let (session, navigation, saved_text) = if store.exists() {
                let value: serde_json::Value = serde_json::from_slice(&fs::read(&store)?)?;
                (
                    serde_json::from_value::<Session>(value["session"].clone())?,
                    serde_json::from_value(value["navigation"].clone())?,
                    serde_json::from_value::<Option<String>>(value["savedText"].clone())?,
                )
            } else {
                (Session::default(), HashMap::new(), None)
            };
            app.manage(Writer(Mutex::new(Runtime {
                session,
                saved_text,
                navigation,
                store,
                pending_open: requested_path(
                    std::env::args_os().skip(1),
                    &std::env::current_dir()?,
                ),
            })));
            let menu = tauri::menu::Menu::new(app.handle())?;
            #[cfg(target_os = "macos")]
            menu.append(&tauri::menu::Submenu::with_items(
                app.handle(),
                "Clean Writer",
                true,
                &[
                    &tauri::menu::PredefinedMenuItem::about(app.handle(), None, None)?,
                    &tauri::menu::PredefinedMenuItem::separator(app.handle())?,
                    &tauri::menu::PredefinedMenuItem::services(app.handle(), None)?,
                    &tauri::menu::PredefinedMenuItem::hide(app.handle(), None)?,
                    &tauri::menu::PredefinedMenuItem::hide_others(app.handle(), None)?,
                    &tauri::menu::PredefinedMenuItem::show_all(app.handle(), None)?,
                    &tauri::menu::PredefinedMenuItem::separator(app.handle())?,
                    &tauri::menu::MenuItem::with_id(
                        app.handle(),
                        "quit",
                        "Quit Clean Writer",
                        true,
                        Some("CmdOrCtrl+Q"),
                    )?,
                ],
            )?)?;
            let file = tauri::menu::Submenu::with_id_and_items(
                app.handle(),
                "file",
                "File",
                true,
                &[
                    &tauri::menu::MenuItem::with_id(
                        app.handle(),
                        "new",
                        "New",
                        true,
                        Some("CmdOrCtrl+N"),
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app.handle(),
                        "open",
                        "Open…",
                        true,
                        Some("CmdOrCtrl+O"),
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app.handle(),
                        "save",
                        "Save",
                        true,
                        Some("CmdOrCtrl+S"),
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app.handle(),
                        "save-as",
                        "Save As…",
                        true,
                        Some("CmdOrCtrl+Shift+S"),
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app.handle(),
                        "export",
                        "Export PDF…",
                        true,
                        Some("CmdOrCtrl+Shift+E"),
                    )?,
                ],
            )?;
            let recent = tauri::menu::Submenu::with_id_and_items(
                app.handle(),
                "recent",
                "Open Recent",
                true,
                &[],
            )?;
            file.insert(&recent, 2)?;
            menu.append(&file)?;
            menu.append(&tauri::menu::Submenu::with_items(
                app.handle(),
                "Edit",
                true,
                &[
                    &tauri::menu::MenuItem::with_id(
                        app.handle(),
                        "undo",
                        "Undo",
                        true,
                        Some("CmdOrCtrl+Z"),
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app.handle(),
                        "redo",
                        "Redo",
                        true,
                        Some("CmdOrCtrl+Shift+Z"),
                    )?,
                    &tauri::menu::PredefinedMenuItem::cut(app.handle(), None)?,
                    &tauri::menu::PredefinedMenuItem::copy(app.handle(), None)?,
                    &tauri::menu::MenuItem::with_id(
                        app.handle(),
                        "find",
                        "Find…",
                        true,
                        Some("CmdOrCtrl+F"),
                    )?,
                    &tauri::menu::PredefinedMenuItem::paste(app.handle(), None)?,
                    &tauri::menu::PredefinedMenuItem::select_all(app.handle(), None)?,
                ],
            )?)?;
            let insert = tauri::menu::Submenu::new(app.handle(), "Insert", true)?;
            let entries: Vec<InsertEntry> =
                serde_json::from_str(include_str!("../../src/insert-menu.json"))?;
            append_insert_items(app.handle(), &insert, &entries)?;
            menu.append(&insert)?;
            #[cfg(not(target_os = "macos"))]
            file.append(&tauri::menu::MenuItem::with_id(
                app.handle(),
                "quit",
                "Quit",
                true,
                Some("CmdOrCtrl+Q"),
            )?)?;
            #[cfg(target_os = "macos")]
            menu.append(&tauri::menu::Submenu::with_items(
                app.handle(),
                "Window",
                true,
                &[
                    &tauri::menu::PredefinedMenuItem::minimize(app.handle(), None)?,
                    &tauri::menu::PredefinedMenuItem::maximize(app.handle(), None)?,
                    &tauri::menu::PredefinedMenuItem::close_window(app.handle(), None)?,
                ],
            )?)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("file-action", event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            initial_state,
            update_recent_menu,
            render_markdown,
            load_image,
            pick_image,
            checkpoint,
            new_document,
            open_document,
            open_requested,
            open_recent,
            save_document,
            export_pdf,
            open_link
        ])
        .build(tauri::generate_context!())
        .expect("Could not start Clean Writer")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                if let Some(path) = urls.into_iter().find_map(|url| url.to_file_path().ok()) {
                    if let Ok(mut writer) = lock(&_app.state::<Writer>()) {
                        writer.pending_open = Some(path);
                    }
                    let _ = _app.emit("open-requested", ());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn writer(dir: &Path) -> Runtime {
        Runtime {
            session: Session::default(),
            saved_text: None,
            navigation: HashMap::new(),
            store: dir.join("session.json"),
            pending_open: None,
        }
    }
    #[test]
    fn picked_images_use_portable_relative_paths() {
        let root = tempfile::tempdir().unwrap();
        let document_folder = root.path().join("notes");
        let assets = root.path().join("assets");
        fs::create_dir_all(document_folder.join("images")).unwrap();
        fs::create_dir_all(&assets).unwrap();
        let document = document_folder.join("report.md");
        for (folder, name, expected) in [
            (document_folder.clone(), "photo.png", "photo.png"),
            (
                document_folder.join("images"),
                "photo.png",
                "images/photo.png",
            ),
            (assets, "photo.png", "../assets/photo.png"),
            (document_folder.clone(), "photo [one].png", ""),
        ] {
            let image = folder.join(name);
            fs::write(&image, []).unwrap();
            let markdown = image_markdown(&image, &document).unwrap();
            let source = markdown.split("](<").nth(1).unwrap().trim_end_matches(">)");
            assert!(!source.starts_with("file:"));
            if !expected.is_empty() {
                assert_eq!(source, expected);
            } else {
                assert!(source.contains("%20"));
                assert!(markdown.contains("\\[one\\]"));
            }
            assert_eq!(
                fs::canonicalize(images::local_path(source, Some(&document)).unwrap()).unwrap(),
                fs::canonicalize(image).unwrap()
            );
        }
    }

    #[test]
    fn insert_menu_catalog_has_unique_commands() {
        fn collect(entries: &[InsertEntry], ids: &mut std::collections::HashSet<String>) {
            for entry in entries {
                assert!(!entry.label.is_empty());
                if let Some(id) = &entry.id {
                    assert!(ids.insert(id.clone()));
                } else {
                    assert!(!entry.items.is_empty());
                    collect(&entry.items, ids);
                }
            }
        }
        let entries: Vec<InsertEntry> =
            serde_json::from_str(include_str!("../../src/insert-menu.json")).unwrap();
        let mut ids = std::collections::HashSet::new();
        collect(&entries, &mut ids);
        assert!(ids.contains("image") && ids.contains("heading-6") && ids.contains("todo"));
    }

    #[test]
    fn external_changes_are_never_silently_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("draft.md");
        atomic_write(&path, b"original").unwrap();
        let mut state = writer(dir.path());
        state.open(path.clone()).unwrap();
        state.session.document.text = "my edits".into();
        state.persist().unwrap();
        atomic_write(&path, b"external edit").unwrap();
        assert!(state.save(&path, false).is_err());
        assert_eq!(read_document(&path).unwrap(), "external edit");
        let alternate = dir.path().join("copy.md");
        state.save(&alternate, true).unwrap();
        assert_eq!(read_document(&alternate).unwrap(), "my edits");
    }
    #[test]
    fn recovery_persists_unsaved_text_and_original_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("draft.md");
        atomic_write(&path, b"saved").unwrap();
        let mut state = writer(dir.path());
        state.open(path).unwrap();
        state.session.document.text = "recovered 📝".into();
        state.persist().unwrap();
        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(&state.store).unwrap()).unwrap();
        assert_eq!(stored["session"]["document"]["text"], "recovered 📝");
        assert_eq!(stored["savedText"], "saved");
    }
    #[test]
    fn desktop_open_accepts_paths_and_file_urls() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes with spaces.MD");
        let url = tauri::Url::from_file_path(&path).unwrap().to_string();
        assert_eq!(
            requested_path(vec![url.into()].into_iter(), dir.path()),
            Some(path.clone())
        );
        assert_eq!(
            requested_path(vec!["notes with spaces.MD".into()].into_iter(), dir.path()),
            Some(path)
        );
    }
    #[test]
    fn failed_open_does_not_redirect_later_saves() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        atomic_write(&a, b"first").unwrap();
        atomic_write(&b, b"second").unwrap();
        let mut state = writer(dir.path());
        state.open(a).unwrap();
        let original = state.session.document.path.clone();
        state.store = dir.path().join("missing/session.json");
        assert!(state.open(b.clone()).is_err());
        assert_eq!(state.session.document.path, original);
        assert_eq!(state.session.document.text, "first");
        assert_eq!(state.saved_text.as_deref(), Some("first"));
        assert_eq!(read_document(&b).unwrap(), "second");
    }
    #[test]
    fn navigation_is_restored_per_file() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        atomic_write(&a, b"first document").unwrap();
        atomic_write(&b, b"second document").unwrap();
        let mut state = writer(dir.path());
        state.open(a.clone()).unwrap();
        state.session.document.cursor = 5;
        state.session.document.bookmarks.push(Bookmark {
            id: "mark".into(),
            offset: 3,
            title: "first".into(),
        });
        state.open(b).unwrap();
        assert!(state.session.document.bookmarks.is_empty());
        state.open(a).unwrap();
        assert_eq!(state.session.document.cursor, 5);
        assert_eq!(state.session.document.bookmarks.len(), 1);
    }
}
