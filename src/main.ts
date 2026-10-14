import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  EditorState,
  Compartment,
  StateField,
  StateEffect,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  panels,
  Decoration,
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
import { icon } from "./icons";
import { findPanel } from "./find-panel";
import {
  sourcePagination,
  sourcePageAt,
  PAGE_GAP,
  type SourcePage,
} from "./source-pages";
import { PAGE_HEIGHT } from "./pages";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
<aside id="sidebar"><div class="sidebar-label">PAGES</div><nav id="thumbnails" aria-label="Document pages"></nav><button id="add-page" class="add-page">${icon("plus")}<span>Add page</span></button></aside>
<div class="workspace"><header class="toolbar"><button id="sidebar-toggle" title="Hide page sidebar" aria-label="Toggle page sidebar">${icon("sidebar")}</button><div class="document-title"><strong id="filename">Untitled.md</strong><span id="dirty-dot" hidden aria-label="Unsaved changes"></span><span id="save-state" class="sr-only">Loading…</span></div><div class="toolbar-actions"><button id="bookmark-add" title="Bookmark this page (Ctrl/⌘D)" aria-label="Toggle bookmark">${icon("bookmark")}</button><button id="find" title="Find in document (Ctrl/⌘F)" aria-label="Find in document">${icon("search")}</button><button id="preview" title="Preview Markdown" aria-label="Markdown preview" aria-pressed="false">${icon("eye")}</button><button id="theme" title="Switch to dark appearance" aria-label="Switch to dark appearance">${icon("moon")}</button><button id="settings" title="Settings" aria-label="Settings">${icon("gear")}</button></div></header>
<div id="find-host"></div>
<div id="file-menu" class="popover" hidden><button id="new">New</button><button id="open">Open</button><div id="recent"></div><button id="save">Save</button><button id="save-as">Save As…</button><button id="export">Export PDF…</button><button id="insert-image">Insert image…</button></div>
<div id="bookmark-menu" class="popover" hidden></div>
<div id="settings-panel" class="popover settings-panel" hidden><h2>Settings</h2><h3>Typography</h3><label>Font<select id="font"><option value="Serif">Serif</option><option value="Sans">Sans Serif</option><option value="Mono">Monospaced</option></select></label><label>Size<input id="size" type="range" min="11" max="22" step="1"><output id="size-value"></output></label><h3>Page margins</h3><label>Margin<select id="margin"><option value="45">Narrow — 45 pt</option><option value="64">Normal — 64 pt</option><option value="85">Wide — 85 pt</option></select><output id="margin-value" hidden></output></label><hr><p>Named files save automatically after a typing pause. Untitled drafts are recovered automatically; use File → Save to choose a location.</p></div>
<div id="notice" role="status" hidden></div><main id="canvas" aria-label="Writing canvas"><div id="source-host"><article id="source-paper" class="source-paper"><div id="source-background" aria-hidden="true"></div><div id="editor" aria-label="Markdown editor"></div></article></div><div id="preview-host" hidden></div></main>
<footer class="statusbar"><div><span id="word-count">0 words</span><span class="status-separator">·</span><span id="page-count">1 page</span><span id="search-count" class="search-count sr-only" hidden></span></div><div class="zoom-controls"><button id="zoom-out" aria-label="Zoom out">${icon("minusZoom")}</button><input id="zoom" type="range" min="50" max="200" step="10" aria-label="Page zoom"><button id="zoom-in" aria-label="Zoom in">${icon("plusZoom")}</button><button id="zoom-value" title="Reset zoom to 100%">100%</button></div></footer></div>
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
let sourcePages: SourcePage[] = [{ from: 0, to: 0, section: 0 }];
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
        fontSize: `${prefs.size}px`,
        backgroundColor: "transparent",
      },
      ".cm-content": {
        padding: "0",
        minHeight: "0",
        caretColor: "var(--ink)",
      },
      ".cm-scroller": {
        overflow: "visible",
        fontFamily: "inherit",
        lineHeight: "1.2",
      },
      ".cm-line": { padding: "0" },
      ".cm-focused": { outline: "none" },
      ".cm-selectionBackground": { background: "var(--selection) !important" },
      ".cm-activeLine": { background: "transparent" },
    },
    { dark: prefs.dark },
  );
const pageLayoutEffect = StateEffect.define<DecorationSet>();
const breaks = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(pageLayoutEffect)) return effect.value;
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});
function layoutSource() {
  const layout = sourcePagination(doc.text, prefs);
  sourcePages = layout.pages;
  editor.dispatch({ effects: pageLayoutEffect.of(layout.decorations) });
  const backgrounds = sourcePages.map((_, index) => {
    const paper = document.createElement("div");
    paper.className = "paper source-page-background";
    paper.style.top = `${index * (PAGE_HEIGHT + PAGE_GAP)}px`;
    const number = document.createElement("div");
    number.className = "page-number";
    number.textContent = String(index + 1);
    paper.append(number);
    return paper;
  });
  $("source-background").replaceChildren(...backgrounds);
  $("source-paper").style.minHeight =
    `${sourcePages.length * PAGE_HEIGHT + (sourcePages.length - 1) * PAGE_GAP}px`;
}
function editorState() {
  return EditorState.create({
    doc: doc.text,
    selection: { anchor: doc.cursor },
    extensions: [
      history(),
      drawSelection(),
      markdown(),
      search({ top: true, createPanel: findPanel }),
      panels({ topContainer: $("find-host") }),
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
          updateBookmarks();
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
      let sourcePages: SourcePage[] = [{ from: 0, to: 0, section: 0 }];
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
  $("dirty-dot").hidden = !dirty();
  for (const id of ["new", "open", "save", "save-as", "export", "insert-image"])
    $<HTMLButtonElement>(id).disabled = busy || !ready;
  document.title = `Clean Writer - ${fileName(doc.path)}`;
  if (desktop)
    void getCurrentWindow()
      .setTitle(document.title)
      .catch(() => {});
}
function updateSettings() {
  document.documentElement.dataset.theme = prefs.dark ? "dark" : "light";
  app.classList.toggle("hide-sidebar", !prefs.sidebar);
  $("preview").setAttribute("aria-pressed", String(prefs.preview));
  $("preview").title = prefs.preview
    ? "Edit Markdown source"
    : "Preview Markdown";
  $("theme").innerHTML = icon(prefs.dark ? "sun" : "moon");
  $("theme").title = prefs.dark
    ? "Switch to light appearance"
    : "Switch to dark appearance";
  $("theme").setAttribute("aria-label", $("theme").title);
  $("sidebar-toggle").title = prefs.sidebar
    ? "Hide page sidebar"
    : "Show page sidebar";
  $("source-host").hidden = prefs.preview;
  $("preview-host").hidden = !prefs.preview;

  $<HTMLSelectElement>("font").value = prefs.font;
  $<HTMLInputElement>("size").value = String(prefs.size);
  $<HTMLSelectElement>("margin").value = String(prefs.margin);
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
let recentMenuUpdate: Promise<unknown> = Promise.resolve();
function updateRecent() {
  if (desktop) {
    const paths = [...recent];
    recentMenuUpdate = recentMenuUpdate
      .then(() => api("update_recent_menu", { paths }))
      .catch((error) => notice(`Open Recent could not be updated: ${error}`));
  }
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
  const index = sourcePageAt(sourcePages, doc.cursor);
  const marked = doc.bookmarks.some(
    (mark) => sourcePageAt(sourcePages, mark.offset) === index,
  );
  $("bookmark-add").classList.toggle("bookmarked", marked);
  $("bookmark-add").title = marked
    ? "Remove this page's bookmark (Ctrl/⌘D)"
    : "Bookmark this page at the cursor (Ctrl/⌘D)";
  $("thumbnails")
    .querySelectorAll<HTMLElement>(".thumbnail")
    .forEach((button, pageIndex) => {
      button.classList.toggle("active", pageIndex === index);
      button.querySelector(".thumbnail-bookmark")?.remove();
      if (
        doc.bookmarks.some(
          (mark) => sourcePageAt(sourcePages, mark.offset) === pageIndex,
        )
      ) {
        const marker = document.createElement("span");
        marker.className = "thumbnail-bookmark";
        marker.innerHTML = icon("bookmark");
        marker.title = "Bookmarked page";
        marker.setAttribute("aria-label", "Bookmarked page");
        button.querySelector(".mini-paper")?.append(marker);
      }
    });
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
  const pageIndex = sourcePageAt(sourcePages, offset);
  const found = doc.bookmarks.some(
    (b) => sourcePageAt(sourcePages, b.offset) === pageIndex,
  );
  doc.bookmarks = found
    ? doc.bookmarks.filter(
        (b) => sourcePageAt(sourcePages, b.offset) !== pageIndex,
      )
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
  layoutSource();
  updateThumbnails();
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
  updateThumbnails();
}
function updateThumbnails() {
  $("page-count").textContent =
    `${sourcePages.length} ${sourcePages.length === 1 ? "page" : "pages"}`;
  $("thumbnails").replaceChildren();
  sourcePages.forEach((page, index) => {
    const button = document.createElement("button");
    button.className = "thumbnail";
    button.setAttribute("aria-label", `Go to page ${index + 1}`);
    const mini = document.createElement("div");
    mini.className = "mini-paper";
    const excerpt = document.createElement("div");
    excerpt.className = "mini-text";
    excerpt.textContent = doc.text.slice(page.from, page.to) || " ";
    mini.append(excerpt);
    const badges = document.createElement("span");
    badges.className = "thumbnail-badges";
    const pageText = doc.text.slice(page.from, page.to);
    for (const kind of ["note", "todo"])
      if (new RegExp(`\\[!${kind.toUpperCase()}\\]`).test(pageText)) {
        const badge = document.createElement("span");
        badge.className = kind;
        badge.innerHTML = icon(kind);
        badge.title = kind === "note" ? "Contains notes" : "Contains to-dos";
        badges.append(badge);
      }
    if (badges.childNodes.length) mini.append(badges);
    const label = document.createElement("span");
    label.textContent = String(index + 1);
    button.append(mini, label);
    button.onclick = () => {
      currentSection = page.section;
      const mark = doc.bookmarks.find(
        (b) => sourcePageAt(sourcePages, b.offset) === index,
      );
      if (mark || !prefs.preview) jump(mark?.offset ?? page.from);
      else
        (
          pages.find((p) => p.section === page.section) || pages[index]
        )?.element.scrollIntoView({ block: "start" });
    };
    button.oncontextmenu = (event) => {
      const marks = doc.bookmarks.filter(
        (b) => sourcePageAt(sourcePages, b.offset) === index,
      );
      if (!marks.length) return;
      event.preventDefault();
      const menu = $("bookmark-menu");
      menu.replaceChildren();
      for (const mark of marks) {
        const remove = document.createElement("button");
        remove.textContent = "Remove Bookmark";
        remove.onclick = () => {
          doc.bookmarks = doc.bookmarks.filter((b) => b.id !== mark.id);
          menu.hidden = true;
          updateBookmarks();
          scheduleRecovery();
        };
        menu.append(remove);
      }
      menu.hidden = false;
    };
    $("thumbnails").append(button);
  });
  updateBookmarks();
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
  $("bookmark-menu").hidden = true;
  $("settings-panel").hidden = true;
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
$("find").onclick = () => {
  if (prefs.preview) changeSettings({ preview: false }, false);
  openSearchPanel(editor);
};
$("add-page").onclick = addPage;
$<HTMLSelectElement>("font").onchange = (e) =>
  changeSettings({ font: (e.target as HTMLSelectElement).value });
for (const key of ["size"] as const)
  $<HTMLInputElement>(key).oninput = (e) =>
    changeSettings({ [key]: Number((e.target as HTMLInputElement).value) });
$<HTMLInputElement>("zoom").oninput = (e) =>
  changeSettings(
    { zoom: Number((e.target as HTMLInputElement).value) / 100 },
    false,
  );
$<HTMLSelectElement>("margin").onchange = (e) =>
  changeSettings({ margin: Number((e.target as HTMLSelectElement).value) });
$("zoom-value").onclick = () => changeSettings({ zoom: 1 }, false);
$("zoom-in").onclick = () => changeSettings({ zoom: prefs.zoom + 0.1 }, false);
$("zoom-out").onclick = () => changeSettings({ zoom: prefs.zoom - 0.1 }, false);
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".popover,#settings,.thumbnail"))
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
    if (key === "s" && (e.altKey || (e.ctrlKey && e.metaKey))) {
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
        if (event.payload.startsWith("recent-")) {
          const path = recent[Number(event.payload.slice(7))];
          if (path) void run(() => replaceDocument("open_recent", { path }));
          return;
        }
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
