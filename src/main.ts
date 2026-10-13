import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  EditorState,
  Compartment,
  StateField,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  Decoration,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  history,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
  undo,
  redo,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  search,
  searchKeymap,
  openSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  searchPanelOpen,
} from "@codemirror/search";
import {
  defaults,
  preferences,
  moveAnchors,
  fileName,
  bookmarkTitle,
  type Document,
  type Snapshot,
  type Preferences,
  type Rendered,
} from "./model";
import { paginate, stylePaper, fonts, type Page } from "./pages";
import { resolveImages, type LoadedImage } from "./images";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
<aside id="sidebar"><div class="sidebar-heading"><span class="brand">Clean Writer</span><span class="edition">FOCUSED WRITING</span></div><div class="sidebar-label">PAGES <span id="sidebar-count">1</span></div><nav id="thumbnails" aria-label="Document pages"></nav><div class="sidebar-label">BOOKMARKS <button id="bookmark-add" title="Bookmark cursor (Ctrl/⌘D)" aria-label="Add bookmark">＋</button></div><nav id="bookmarks" aria-label="Bookmarks"></nav><button id="add-page" class="add-page">＋ Add page break</button></aside>
<div class="workspace"><header class="toolbar"><button id="sidebar-toggle" title="Toggle sidebar" aria-label="Toggle sidebar">☰</button><div class="document-title"><strong id="filename">Untitled.md</strong><span id="save-state">Loading…</span></div><div class="toolbar-actions"><button id="new" title="New (Ctrl/⌘N)">New</button><button id="open" title="Open (Ctrl/⌘O)">Open</button><button id="save" title="Save (Ctrl/⌘S)">Save</button><button id="more" aria-label="More file actions" aria-expanded="false">···</button><span class="divider"></span><button id="preview" title="Toggle Markdown preview" aria-pressed="false">Preview</button><button id="theme" title="Toggle dark appearance" aria-label="Toggle dark appearance">◐</button><button id="settings" title="Typography" aria-label="Typography settings">⚙</button></div></header>
<div id="file-menu" class="popover" hidden><button id="save-as">Save As…</button><button id="export">Export PDF…</button><button id="insert-image">Insert image…</button><div class="menu-label">OPEN RECENT</div><div id="recent"></div></div>
<div id="settings-panel" class="popover settings-panel" hidden><h2>Typography</h2><label>Font<select id="font"><option>Serif</option><option>Sans</option><option>Mono</option></select></label><label>Size <output id="size-value"></output><input id="size" type="range" min="10" max="28" step="1"></label><label>Margins <output id="margin-value"></output><input id="margin" type="range" min="24" max="100" step="4"></label></div>
<div id="notice" role="status" hidden></div><main id="canvas" aria-label="Writing canvas"><div id="source-host"><article id="source-paper" class="paper source-paper"><div id="editor" aria-label="Markdown editor"></div><div class="source-caption">MARKDOWN SOURCE · CONTINUOUS EDITING</div></article></div><div id="preview-host" hidden></div></main>
<footer class="statusbar"><div><span id="word-count">0 words</span><span class="status-separator">·</span><span id="page-count">1 page</span><span id="search-count" class="search-count" hidden></span><span id="mode-status" class="mode-status">Source</span></div><div class="zoom-controls"><button id="zoom-out" aria-label="Zoom out">−</button><input id="zoom" type="range" min="50" max="200" step="5" aria-label="Zoom"><button id="zoom-value" title="Reset zoom">100%</button><button id="zoom-in" aria-label="Zoom in">＋</button></div></footer></div>
<dialog id="confirm-dialog"><form method="dialog"><h2>Keep your changes?</h2><p id="confirm-message">Save this document before continuing, or discard its unsaved changes.</p><div class="dialog-actions"><button value="cancel">Cancel</button><button value="discard">Discard</button><button value="save" class="primary">Save</button></div></form></dialog>
<dialog id="error-dialog"><form method="dialog"><h2>File operation failed</h2><p id="error-message"></p><div class="dialog-actions"><button class="primary">OK</button></div></form></dialog>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let doc: Document = { path: null, text: "", cursor: 0, bookmarks: [] };
let prefs: Preferences = { ...defaults },
  recent: string[] = [],
  savedText: string | null = null;
let busy = false,
  ready = false,
  exporting = false,
  autosaveTimer: ReturnType<typeof setTimeout> | undefined,
  recoveryTimer: ReturnType<typeof setTimeout> | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined,
  renderGeneration = 0,
  pages: Page[] = [],
  currentSection = 0,
  requestedOpen = false;
let recoveryFailed = false,
  autosaveBlocked = false;
let tail: Promise<unknown> = Promise.resolve();
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const next = tail.then(job, job);
  tail = next.catch(() => {});
  return next;
};
const dirty = () => doc.text !== (savedText ?? "");
const desktop = isTauri();
const theme = new Compartment(),
  editability = new Compartment();
const editorTheme = () =>
  EditorView.theme(
    {
      "&": {
        fontFamily: fonts[prefs.font],
        fontSize: `${prefs.size}pt`,
        backgroundColor: "transparent",
      },
      ".cm-content": {
        padding: "0",
        minHeight: "920px",
        caretColor: "var(--ink)",
      },
      ".cm-scroller": {
        overflow: "visible",
        fontFamily: "inherit",
        lineHeight: "1.6",
      },
      ".cm-line": { padding: "0" },
      ".cm-focused": { outline: "none" },
      ".cm-selectionBackground": { background: "var(--selection) !important" },
      ".cm-activeLine": { background: "transparent" },
    },
    { dark: prefs.dark },
  );
class PageBreak extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.className = "manual-break";
    el.textContent = "— Page break —";
    return el;
  }
}
const breaks = StateField.define<DecorationSet>({
  create(state) {
    return breakDecorations(state);
  },
  update(value, transaction) {
    return transaction.docChanged ? breakDecorations(transaction.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
function breakDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const text = state.doc.toString();
  for (
    let position = text.indexOf("\f");
    position >= 0;
    position = text.indexOf("\f", position + 1)
  )
    builder.add(
      position,
      position + 1,
      Decoration.replace({ widget: new PageBreak() }),
    );
  return builder.finish();
}
function editorState() {
  return EditorState.create({
    doc: doc.text,
    selection: { anchor: doc.cursor },
    extensions: [
      history(),
      drawSelection(),
      markdown(),
      search({ top: true }),
      breaks,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        spellcheck: "true",
        "aria-label": "Markdown source",
      }),
      keymap.of([
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      theme.of(editorTheme()),
      editability.of([
        EditorState.readOnly.of(false),
        EditorView.editable.of(true),
      ]),
      EditorView.updateListener.of((update) => {
        if (!ready) return;
        updateSearchCount();
        if (update.docChanged) {
          const text = update.state.doc.toString();
          doc.bookmarks = moveAnchors(doc.text, text, doc.bookmarks);
          doc.text = text;
          autosaveBlocked = false;
          scheduleRender();
          scheduleSave();
          updateBookmarks();
          updateStatus();
        }
        if (update.selectionSet || update.docChanged) {
          doc.cursor = update.state.selection.main.head;
          scheduleRecovery();
        }
      }),
    ],
  });
}
const editor = new EditorView({ parent: $("editor"), state: editorState() });

function updateSearchCount() {
  const query = getSearchQuery(editor.state);
  const el = $("search-count");
  el.hidden = !searchPanelOpen(editor.state) || !query.search;
  if (el.hidden) return;
  let matches = 0;
  const cursor = query.getCursor(editor.state.doc);
  while (!cursor.next().done) matches++;
  el.textContent = `${matches} ${matches === 1 ? "match" : "matches"}`;
}
function notice(message: string, retry = false) {
  const el = $("notice");
  el.replaceChildren();
  el.hidden = !message;
  if (message) {
    el.append(document.createTextNode(message));
    if (retry) {
      const button = document.createElement("button");
      button.textContent = "Retry save";
      button.onclick = () => void run(() => save(false));
      el.append(button);
    }
  }
}
function error(value: unknown) {
  $("error-message").textContent = String(value);
  $<HTMLDialogElement>("error-dialog").showModal();
}
async function run(job: () => Promise<unknown>) {
  if (!ready || busy) return;
  busy = true;
  updateStatus();
  try {
    await serial(job);
  } catch (e) {
    error(e);
  } finally {
    busy = false;
    updateStatus();
    if (requestedOpen) {
      requestedOpen = false;
      void run(() => replaceDocument("open_requested"));
    }
  }
}
async function api<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (desktop) return invoke<T>(command, args);
  throw new Error(
    "Native file operations require the desktop app. Run npm run desktop.",
  );
}
async function checkpoint() {
  if (!desktop) {
    localStorage.setItem(
      "clean-writer-browser-session",
      JSON.stringify({
        session: { document: doc, recent, preferences: prefs },
        savedText,
      }),
    );
    return;
  }
  try {
    await api("checkpoint", {
      text: doc.text,
      cursor: doc.cursor,
      bookmarks: doc.bookmarks,
      preferences: prefs,
    });
    recoveryFailed = false;
  } catch (error) {
    recoveryFailed = true;
    throw error;
  }
}
function scheduleRecovery() {
  clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(
    () =>
      void serial(checkpoint).catch((e) => {
        recoveryFailed = true;
        notice(`Recovery could not be stored: ${e}`, true);
        updateStatus();
      }),
    200,
  );
}
function scheduleSave() {
  scheduleRecovery();
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (doc.path && dirty() && !busy && !autosaveBlocked)
      void run(() => save(false, true));
  }, 1000);
}
function updateStatus() {
  if (editor.state.facet(EditorState.readOnly) !== (busy || !ready))
    editor.dispatch({
      effects: editability.reconfigure([
        EditorState.readOnly.of(busy || !ready),
        EditorView.editable.of(!busy && ready),
      ]),
    });
  $("filename").textContent = fileName(doc.path);
  $("save-state").textContent = busy
    ? "Working…"
    : recoveryFailed
      ? "Recovery unavailable"
      : autosaveBlocked
        ? "Save failed"
        : dirty()
          ? doc.path
            ? "Unsaved changes"
            : "Recovered locally"
          : doc.path
            ? "Saved"
            : "Local draft";
  $("save-state").classList.toggle("unsaved", dirty());
  for (const id of ["new", "open", "save", "save-as", "export", "insert-image"])
    $<HTMLButtonElement>(id).disabled = busy || !ready;
  document.title = `${dirty() ? "• " : ""}${fileName(doc.path)} — Clean Writer`;
  if (desktop)
    void getCurrentWindow()
      .setTitle(document.title)
      .catch(() => {});
}
function updateSettings() {
  document.documentElement.dataset.theme = prefs.dark ? "dark" : "light";
  app.classList.toggle("hide-sidebar", !prefs.sidebar);
  $("preview").setAttribute("aria-pressed", String(prefs.preview));
  $("preview").textContent = prefs.preview ? "Source" : "Preview";
  $("source-host").hidden = prefs.preview;
  $("preview-host").hidden = !prefs.preview;
  $("mode-status").textContent = prefs.preview ? "Preview" : "Source";
  $<HTMLSelectElement>("font").value = prefs.font;
  $<HTMLInputElement>("size").value = String(prefs.size);
  $<HTMLInputElement>("margin").value = String(prefs.margin);
  $("size-value").textContent = `${prefs.size} pt`;
  $("margin-value").textContent = `${prefs.margin} pt`;
  $<HTMLInputElement>("zoom").value = String(Math.round(prefs.zoom * 100));
  $("zoom-value").textContent = `${Math.round(prefs.zoom * 100)}%`;
  for (const host of [$("source-host"), $("preview-host")]) {
    stylePaper(host, prefs);
    host.style.zoom = String(prefs.zoom);
  }
  editor.dispatch({ effects: theme.reconfigure(editorTheme()) });
}
function changeSettings(change: Partial<Preferences>, render = true) {
  if (change.preview === true) imageCache.clear();
  prefs = preferences({ ...prefs, ...change });
  updateSettings();
  scheduleRecovery();
  if (render) scheduleRender();
}
function applySnapshot(snapshot: Snapshot, replaceText = true) {
  if (replaceText) {
    ready = false;
    doc = snapshot.session.document;
    doc.cursor = Math.min(doc.text.length, Math.max(0, doc.cursor));
    doc.bookmarks = doc.bookmarks.map((b) => ({
      ...b,
      offset: Math.min(doc.text.length, Math.max(0, b.offset)),
    }));
    // Recreate using the established extension set below to reset undo history per document.
    resetEditor();
    ready = true;
  } else {
    doc.path = snapshot.session.document.path;
  }
  savedText = snapshot.savedText;
  recent = snapshot.session.recent;
  prefs = preferences(snapshot.session.preferences);
  autosaveBlocked = false;
  notice("");
  updateSettings();
  updateRecent();
  updateBookmarks();
  updateStatus();
  scheduleRender();
}
function resetEditor() {
  editor.setState(editorState());
}

async function save(saveAs = false, automatic = false): Promise<boolean> {
  clearTimeout(autosaveTimer);
  clearTimeout(recoveryTimer);
  try {
    await checkpoint();
    const snapshot = await api<Snapshot | null>("save_document", { saveAs });
    if (!snapshot) return false;
    // Keep editor history when a save changes the destination.
    applySnapshot(snapshot, false);
    if (dirty()) scheduleSave();
    return true;
  } catch (e) {
    autosaveBlocked = true;
    notice(
      `Save failed. ${recoveryFailed ? "Keep this window open until recovery or saving succeeds." : "Your recovery copy is retained."} ${e}`,
      true,
    );
    if (!automatic) throw e;
    return false;
  }
}
async function confirmReplacement(): Promise<boolean> {
  await checkpoint();
  if (!dirty()) return true;
  const dialog = $<HTMLDialogElement>("confirm-dialog");
  dialog.showModal();
  const choice = await new Promise<string>((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue), {
      once: true,
    }),
  );
  return choice === "discard" || (choice === "save" && (await save(false)));
}
async function replaceDocument(
  command: string,
  args: Record<string, unknown> = {},
) {
  if (!(await confirmReplacement())) return;
  clearTimeout(autosaveTimer);
  clearTimeout(recoveryTimer);
  const snapshot = await api<Snapshot | null>(command, args);
  if (snapshot) {
    applySnapshot(snapshot);
    editor.focus();
  }
}
function updateRecent() {
  $("recent").replaceChildren();
  if (!recent.length) {
    const label = document.createElement("span");
    label.className = "empty-label";
    label.textContent = "No recent files";
    $("recent").append(label);
  }
  for (const path of recent) {
    const button = document.createElement("button");
    button.textContent = fileName(path);
    button.title = path;
    button.onclick = () => {
      hidePopovers();
      void run(() => replaceDocument("open_recent", { path }));
    };
    $("recent").append(button);
  }
}
function updateBookmarks() {
  $("bookmarks").replaceChildren();
  if (!doc.bookmarks.length) {
    const el = document.createElement("p");
    el.className = "empty-label";
    el.textContent = "Mark a place to return to";
    $("bookmarks").append(el);
  }
  for (const mark of doc.bookmarks) {
    const row = document.createElement("div");
    row.className = "bookmark-row";
    const button = document.createElement("button");
    button.textContent = `◆ ${mark.title}`;
    button.title = "Jump to bookmark";
    button.onclick = () => jump(mark.offset);
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Remove bookmark";
    remove.setAttribute("aria-label", `Remove bookmark ${mark.title}`);
    remove.onclick = () => {
      doc.bookmarks = doc.bookmarks.filter((b) => b.id !== mark.id);
      updateBookmarks();
      scheduleRecovery();
    };
    row.append(button, remove);
    $("bookmarks").append(row);
  }
}
function jump(offset: number) {
  if (prefs.preview) changeSettings({ preview: false }, false);
  editor.dispatch({
    selection: { anchor: Math.min(doc.text.length, offset) },
    scrollIntoView: true,
  });
  editor.focus();
}
function bookmark() {
  const offset = editor.state.selection.main.head;
  const found = doc.bookmarks.find((b) => b.offset === offset);
  doc.bookmarks = found
    ? doc.bookmarks.filter((b) => b !== found)
    : [
        ...doc.bookmarks,
        {
          id: crypto.randomUUID(),
          offset,
          title: bookmarkTitle(doc.text, offset),
        },
      ].sort((a, b) => a.offset - b.offset);
  updateBookmarks();
  scheduleRecovery();
}
function addPage() {
  if (prefs.preview) changeSettings({ preview: false }, false);
  const selection = editor.state.selection.main;
  editor.dispatch({
    changes: { from: selection.from, to: selection.to, insert: "\n\f\n" },
    selection: { anchor: selection.from + 3 },
  });
  editor.focus();
}
function scheduleRender() {
  clearTimeout(renderTimer);
  const generation = ++renderGeneration;
  renderTimer = setTimeout(
    () => void render(generation).catch((e) => notice(`Preview failed: ${e}`)),
    180,
  );
}
const imageCache = new Map<
  string,
  { time: number; image: Promise<LoadedImage> }
>();
function imageLoader(documentPath: string | null, fresh = false) {
  return (source: string): Promise<LoadedImage> => {
    const key = JSON.stringify([documentPath, source]);
    const cached = imageCache.get(key);
    if (!fresh && cached && Date.now() - cached.time < 30_000)
      return cached.image;
    const image = api<LoadedImage>("load_image", { source, documentPath });
    if (imageCache.size >= 16)
      imageCache.delete(imageCache.keys().next().value!);
    imageCache.set(key, { time: Date.now(), image });
    void image.catch(() => {
      if (imageCache.get(key)?.image === image) imageCache.delete(key);
    });
    return image;
  };
}
async function insertImage() {
  const markdown = await api<string | null>("pick_image");
  if (!markdown) return;
  if (prefs.preview) changeSettings({ preview: false }, false);
  const selected = editor.state.selection.main;
  const insertion = `\n${markdown}\n`;
  editor.dispatch({
    changes: { from: selected.from, to: selected.to, insert: insertion },
    selection: { anchor: selected.from + insertion.length },
  });
  editor.focus();
}
async function render(generation: number) {
  if (!desktop) {
    $("word-count").textContent =
      `${doc.text.trim() ? doc.text.trim().split(/\s+/).length : 0} words`;
    return;
  }
  const documentPath = doc.path;
  const result = await api<Rendered>("render_markdown", { text: doc.text });
  const sections = await resolveImages(
    result.sections,
    prefs,
    imageLoader(documentPath),
  );
  if (generation !== renderGeneration) return;
  const host = document.createElement("div");
  host.className = "measurement-host";
  document.body.append(host);
  let next: Page[];
  try {
    next = paginate(sections, prefs, host);
  } catch (e) {
    host.remove();
    throw e;
  }
  if (generation !== renderGeneration) {
    host.remove();
    return;
  }
  $("preview-host").replaceChildren(...Array.from(host.children));
  host.remove();
  pages = next;
  $("word-count").textContent =
    `${result.words.toLocaleString()} ${result.words === 1 ? "word" : "words"}`;
  $("page-count").textContent =
    `${pages.length} ${pages.length === 1 ? "page" : "pages"}`;
  $("sidebar-count").textContent = String(pages.length);
  $("thumbnails").replaceChildren();
  pages.forEach((page, index) => {
    const button = document.createElement("button");
    button.className = "thumbnail";
    button.setAttribute("aria-label", `Go to page ${index + 1}`);
    const mini = document.createElement("div");
    mini.className = "mini-paper";
    mini.textContent = page.excerpt;
    const pageImage = page.element.querySelector<HTMLImageElement>("img");
    if (pageImage) {
      const thumbnail = pageImage.cloneNode() as HTMLImageElement;
      thumbnail.removeAttribute("width");
      thumbnail.removeAttribute("height");
      mini.prepend(thumbnail);
    }
    const label = document.createElement("span");
    label.textContent = String(index + 1);
    button.append(mini, label);
    const badges = document.createElement("span");
    badges.className = "thumbnail-badges";
    for (const kind of ["note", "todo"])
      if (page.element.querySelector(`.callout.${kind}`)) {
        const badge = document.createElement("span");
        badge.className = kind;
        badge.textContent = kind === "note" ? "Note" : "Todo";
        badges.append(badge);
      }
    if (badges.childNodes.length) button.append(badges);
    button.onclick = () => {
      currentSection = page.section;
      if (prefs.preview)
        page.element.scrollIntoView({ behavior: "smooth", block: "start" });
      else {
        const offset = doc.text
          .split("\f")
          .slice(0, currentSection)
          .reduce((n, s) => n + s.length + 1, 0);
        jump(offset);
      }
      $("thumbnails")
        .querySelectorAll(".active")
        .forEach((el) => el.classList.remove("active"));
      button.classList.add("active");
    };
    $("thumbnails").append(button);
  });
}
async function exportPDF() {
  if (exporting) return;
  exporting = true;
  notice("Preparing PDF…");
  const host = document.createElement("div");
  host.className = "measurement-host pdf-host";
  document.body.append(host);
  try {
    const rendered = await api<Rendered>("render_markdown", { text: doc.text });
    const printSections = await resolveImages(
      rendered.sections,
      prefs,
      imageLoader(doc.path, true),
    );
    const printPages = paginate(printSections, { ...prefs, dark: false }, host);
    await document.fonts.ready;
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
      import("html2canvas"),
      import("jspdf"),
    ]);
    const pdf = new jsPDF({
      orientation: "portrait",
      unit: "pt",
      format: "a4",
      compress: true,
    });
    for (let i = 0; i < printPages.length; i++) {
      notice(`Preparing PDF page ${i + 1} of ${printPages.length}…`);
      const canvas = await html2canvas(printPages[i].element, {
        scale: 2,
        backgroundColor: "#ffffff",
        logging: false,
      });
      if (i) pdf.addPage();
      pdf.addImage(
        canvas.toDataURL("image/jpeg", 0.95),
        "JPEG",
        0,
        0,
        595.28,
        841.89,
        undefined,
        "FAST",
      );
    }
    const done = await api<boolean>("export_pdf", {
      bytes: Array.from(new Uint8Array(pdf.output("arraybuffer"))),
      name: fileName(doc.path).replace(/\.[^.]+$/, "") + ".pdf",
    });
    notice(done ? "PDF exported." : "");
  } finally {
    host.remove();
    exporting = false;
  }
}
function hidePopovers() {
  $("file-menu").hidden = true;
  $("settings-panel").hidden = true;
  $("more").setAttribute("aria-expanded", "false");
}
async function closeApp() {
  await checkpoint();
  if (doc.path && dirty() && !autosaveBlocked && !(await save(false, true)))
    return;
  if (autosaveBlocked && !(await confirmReplacement())) return;
  await getCurrentWindow().destroy();
}
const actions: Record<string, () => Promise<unknown>> = {
  new: () => replaceDocument("new_document"),
  open: () => replaceDocument("open_document"),
  save: () => save(false),
  "save-as": () => save(true),
  export: exportPDF,
  "insert-image": insertImage,
};
const menuActions: Record<string, () => Promise<unknown>> = {
  ...actions,
  quit: closeApp,
  undo: async () => undo(editor),
  redo: async () => redo(editor),
  find: async () => {
    if (prefs.preview) changeSettings({ preview: false }, false);
    return openSearchPanel(editor);
  },
};
for (const [id, action] of Object.entries(actions))
  $(id).onclick = () => {
    hidePopovers();
    void run(action);
  };
$("more").onclick = () => {
  const hidden = $("file-menu").hidden;
  hidePopovers();
  $("file-menu").hidden = !hidden;
  $("more").setAttribute("aria-expanded", String(hidden));
};
$("settings").onclick = () => {
  const hidden = $("settings-panel").hidden;
  hidePopovers();
  $("settings-panel").hidden = !hidden;
};
$("sidebar-toggle").onclick = () =>
  changeSettings({ sidebar: !prefs.sidebar }, false);
$("theme").onclick = () => changeSettings({ dark: !prefs.dark }, false);
$("preview").onclick = () => {
  changeSettings({ preview: !prefs.preview });
  if (!prefs.preview) editor.focus();
};
$("bookmark-add").onclick = bookmark;
$("add-page").onclick = addPage;
$<HTMLSelectElement>("font").onchange = (e) =>
  changeSettings({ font: (e.target as HTMLSelectElement).value });
for (const key of ["size", "margin"] as const)
  $<HTMLInputElement>(key).oninput = (e) =>
    changeSettings({ [key]: Number((e.target as HTMLInputElement).value) });
$<HTMLInputElement>("zoom").oninput = (e) =>
  changeSettings(
    { zoom: Number((e.target as HTMLInputElement).value) / 100 },
    false,
  );
$("zoom-value").onclick = () => changeSettings({ zoom: 1 }, false);
$("zoom-in").onclick = () => changeSettings({ zoom: prefs.zoom + 0.1 }, false);
$("zoom-out").onclick = () => changeSettings({ zoom: prefs.zoom - 0.1 }, false);
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".popover,#more,#settings"))
    hidePopovers();
});
$("preview-host").addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a");
  if (link) {
    e.preventDefault();
    void run(() => api("open_link", { url: link.href }));
  }
});
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape") {
      hidePopovers();
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === "s" && e.altKey) {
      e.preventDefault();
      changeSettings({ sidebar: !prefs.sidebar }, false);
      return;
    }
    const action =
      key === "s"
        ? e.ctrlKey && e.metaKey
          ? ""
          : e.shiftKey
            ? "save-as"
            : "save"
        : key === "n"
          ? "new"
          : key === "o"
            ? "open"
            : key === "e" && e.shiftKey
              ? "export"
              : null;
    // File accelerators are handled by the native menu in the desktop app.
    if (action) {
      e.preventDefault();
      if (!desktop) void run(actions[action]);
      return;
    }
    if (key === "d") {
      e.preventDefault();
      bookmark();
    }
    if (key === "f") {
      e.preventDefault();
      if (prefs.preview) changeSettings({ preview: false }, false);
      openSearchPanel(editor);
    }
    if (key === "g") {
      e.preventDefault();
      if (prefs.preview) changeSettings({ preview: false }, false);
      e.shiftKey ? findPrevious(editor) : findNext(editor);
    }
  },
  true,
);
$("canvas").addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      changeSettings({ zoom: prefs.zoom - e.deltaY * 0.002 }, false);
    }
  },
  { passive: false },
);
window.addEventListener("blur", () => {
  if (ready && !busy)
    void serial(async () => {
      await checkpoint();
      if (doc.path && dirty() && !autosaveBlocked) await save(false, true);
    }).catch((e) => notice(String(e), true));
});
async function start() {
  try {
    let snapshot: Snapshot;
    if (desktop) {
      await listen("open-requested", () => {
        if (busy) requestedOpen = true;
        else void run(() => replaceDocument("open_requested"));
      });
      await listen<string>("file-action", (event) => {
        const action = menuActions[event.payload];
        if (action) {
          if (actions[event.payload] || event.payload === "quit")
            void run(action);
          else void action().catch(error);
        }
      });
      await getCurrentWindow().onCloseRequested(async (e) => {
        e.preventDefault();
        if (busy) return;
        await run(closeApp);
      });
      snapshot = await api<Snapshot>("initial_state");
    } else {
      snapshot = JSON.parse(
        localStorage.getItem("clean-writer-browser-session") || "null",
      ) ?? {
        session: { document: doc, recent: [], preferences: defaults },
        savedText: null,
      };
    }
    applySnapshot(snapshot);
    ready = true;
    updateStatus();
    if (dirty()) notice("Your unsaved draft has been restored.");
    if (!desktop)
      notice(
        "Browser layout preview. Native files, Rust Markdown rendering, and PDF export are available in the desktop app.",
      );
    editor.focus();
    if (snapshot.pendingOpen) void run(() => replaceDocument("open_requested"));
  } catch (e) {
    notice(`Could not load your session: ${e}`);
    error(e);
  }
}
void start();
