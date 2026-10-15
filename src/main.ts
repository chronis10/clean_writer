import { flowingPages, manualPreviewSections } from "./page-flow";
import { markdownBlocks } from "./markdown-blocks";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  panels,
  closeHoverTooltips,
} from "@codemirror/view";
import {
  history,
  invertedEffects,
  isolateHistory,
  indentWithTab,
  undo,
  redo,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { markdownHighlighting } from "./syntax-theme";
import {
  search,
  openSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  searchPanelOpen,
} from "@codemirror/search";
import {
  defaults,
  preferences,
  fileName,
  bookmarkTitle,
  type Document,
  type Snapshot,
  type Preferences,
  type Rendered,
} from "./model";
import {
  paginate,
  previewContainers,
  stylePaper,
  fonts,
  type Page,
} from "./pages";
import { resolveImages, type LoadedImage } from "./images";
import { icon } from "./icons";
import { findPanel } from "./find-panel";
import { spellingHover, resetSpelling } from "./spelling";
import { dictionarySettings } from "./dictionaries";
import { insertCommands, markdownInsertion } from "./insertions";
import {
  sourcePageAt,
  sourcePagination,
  type SourcePage,
} from "./source-pages";
import { PAGE_HEIGHT, PAGE_WIDTH } from "./pages";
import { PagedEditor, pageRangesField, pageRangesEffect } from "./paged-editor";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
<aside id="sidebar"><div class="sidebar-label">PAGES</div><nav id="thumbnails" aria-label="Document pages"></nav><button id="add-page" class="add-page">${icon("plus")}<span>Add page</span></button></aside>
<div class="workspace"><header class="toolbar"><button id="sidebar-toggle" title="Hide page sidebar" aria-label="Toggle page sidebar">${icon("sidebar")}</button><div class="document-title"><strong id="filename">Untitled.md</strong><span id="dirty-dot" hidden aria-label="Unsaved changes"></span><span id="save-state" class="sr-only">Loading…</span></div><div class="toolbar-actions"><button id="bookmark-add" title="Bookmark this page (Ctrl/⌘D)" aria-label="Toggle bookmark">${icon("bookmark")}</button><button id="find" title="Find in document (Ctrl/⌘F)" aria-label="Find in document">${icon("search")}</button><button id="preview" title="Preview Markdown" aria-label="Markdown preview" aria-pressed="false">${icon("eye")}</button><button id="theme" title="Switch to dark appearance" aria-label="Switch to dark appearance">${icon("moon")}</button><button id="settings" title="Settings" aria-label="Settings">${icon("gear")}</button></div></header>
<div id="find-host"></div>
<div id="file-menu" class="popover" hidden><button id="new">New</button><button id="open">Open</button><div id="recent"></div><button id="save">Save</button><button id="save-as">Save As…</button><button id="export">Export PDF…</button><button id="insert-image">Insert image…</button></div>
<div id="bookmark-menu" class="popover" hidden></div>
<div id="settings-panel" class="popover settings-panel" hidden><h2>Settings</h2><h3>Typography</h3><label>Editor font<select id="font"><option value="Serif">Serif</option><option value="Sans">Sans Serif</option><option value="Mono">Monospaced</option></select></label><label>Preview font<select id="preview-font"><option value="Serif">Serif</option><option value="Sans">Sans Serif</option><option value="Mono">Monospaced</option></select></label><label>Size<input id="size" type="range" min="11" max="22" step="1"><output id="size-value"></output></label><h3>Page margins</h3><label>Margin<select id="margin"><option value="45">Narrow — 45 pt</option><option value="64">Normal — 64 pt</option><option value="85">Wide — 85 pt</option></select><output id="margin-value" hidden></output></label><hr><h3>Saving</h3><label>Autosave<input id="autosave" type="checkbox" role="switch"></label><p>Save changes to your Markdown file automatically after one second of inactivity. Untitled documents keep automatic draft recovery until you choose File → Save.</p><div id="dictionary-settings"></div></div>
<div id="notice" role="status" hidden></div><main id="canvas" aria-label="Writing canvas"><div id="document-frame"><div id="source-host"></div><div id="preview-host" hidden></div></div></main>
<div id="document-state" hidden aria-hidden="true"></div><footer class="statusbar"><div><span id="word-count">0 words</span><span class="status-separator">·</span><span id="page-count">1 page</span><span id="search-count" class="search-count sr-only" hidden></span></div><div class="zoom-controls"><button id="zoom-out" aria-label="Zoom out">${icon("minusZoom")}</button><input id="zoom" type="range" min="50" max="200" step="10" aria-label="Page zoom"><button id="zoom-in" aria-label="Zoom in">${icon("plusZoom")}</button><button id="zoom-value" title="Reset zoom to 100%">100%</button></div></footer></div>
<dialog id="confirm-dialog"><form method="dialog"><h2>Keep your changes?</h2><p id="confirm-message">Save this document before continuing, or discard its unsaved changes.</p><div class="dialog-actions"><button value="cancel">Cancel</button><button value="discard">Discard</button><button value="save" class="primary">Save</button></div></form></dialog>
<dialog id="delete-page-dialog"><form method="dialog"><h2>Delete page?</h2><p id="delete-page-message"></p><div class="dialog-actions"><button value="cancel" autofocus>Cancel</button><button value="delete" class="primary">Delete</button></div></form></dialog>
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
  recoveryTimer: ReturnType<typeof setTimeout> | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined,
  renderGeneration = 0,
  pages: Page[] = [],
  currentPreviewPage = 0,
  requestedOpen = false;
let sourcePages: SourcePage[] = [{ from: 0, to: 0, section: 0 }];
let selectedSidebarPageKey: string | null = null;
let pendingPreviewJump = false;
interface ReadingPosition {
  key: string;
  canvasTop: number;
  fraction: number;
  sourceFrom?: number;
  blockFraction?: number;
  clip: number;
}
let pendingReadingPosition: ReadingPosition | null = null;
let toggleReadingPosition: ReadingPosition | null = null;
let lastRenderedGeneration = -1;
let readingPageKey: string | null = null;
let restoredCanvasTop: number | null = null;
let restoredBody: HTMLElement | null = null;
let restoredBodyTop = 0;
let restoredBodyHeight = 0;
let sidebarFollowFrame = 0;
let forceSidebarFollow = false;
let lastFollowedPageKey: string | null = null;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let autosaving = false;
let recoveryFailed = false,
  saveFailed = false;
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
        minHeight: "100%",
        caretColor: "var(--ink)",
      },
      ".cm-scroller": {
        overflow: "clip",
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
const rangesField = pageRangesField(
  () => prefs,
  () => doc.pageStarts,
);
function layoutSource() {
  pageEditor.sync();
  sourcePages = pageEditor.ranges;
  doc.pageStarts = sourcePages.map((page) => page.from);
  doc.pageLayoutVersion = 2;
}
function pageExtensions() {
  return [
    markdownHighlighting,
    spellingHover(
      (word: string) => api<string[]>("spelling_suggestions", { word }),
      (words: string[]) => api<string[]>("spelling_misspellings", { words }),
      () => desktop && !prefs.preview,
    ),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      spellcheck: "false",
      autocorrect: "off",
      "aria-label": "Markdown source",
    }),
    keymap.of([indentWithTab]),
    theme.of(editorTheme()),
    editability.of([
      EditorState.readOnly.of(busy || !ready),
      EditorView.editable.of(!busy && ready),
    ]),
  ];
}
function editorState() {
  return EditorState.create({
    doc: doc.text,
    selection: { anchor: doc.cursor },
    extensions: [
      history(),
      markdown(),
      rangesField,
      invertedEffects.of((tr) =>
        tr.docChanged
          ? [pageRangesEffect.of(tr.startState.field(rangesField))]
          : [],
      ),
      search({ top: true, createPanel: findPanel }),
      panels({ topContainer: $("find-host") }),
      editability.of([
        EditorState.readOnly.of(false),
        EditorView.editable.of(false),
      ]),
      EditorView.updateListener.of((update) => {
        if (!ready) return;
        sourcePages = update.state.field(rangesField);
        doc.pageStarts = sourcePages.map((page) => page.from);
        updateSearchCount();
        if (update.docChanged) {
          const text = update.state.doc.toString();
          doc.bookmarks = doc.bookmarks.map((mark) => ({
            ...mark,
            offset: update.changes.mapPos(mark.offset, 1),
          }));
          doc.text = text;
          saveFailed = false;
          scheduleAutosave();
          scheduleRender(true);
          scheduleRecovery();
          updateBookmarks();
          updateStatus();
        }
        const reflowed = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(pageRangesEffect)),
        );
        if (update.selectionSet || update.docChanged || reflowed) {
          doc.cursor = update.state.selection.main.head;
          if (
            !prefs.preview &&
            (update.selectionSet ||
              (reflowed && pageEditor.views.some((view) => view.hasFocus)))
          ) {
            readingPageKey =
              pageEditor.ranges[pageEditor.activeIndex]?.key ?? null;
            followVisiblePage(true);
          }
          updateBookmarks();
          scheduleRecovery();
        }
      }),
    ],
  });
}
const pageEditor = new PagedEditor(
  $("source-host"),
  $("document-state"),
  editorState(),
  rangesField,
  pageExtensions,
  () => prefs,
);
const editor = pageEditor.master;

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
      pageStarts: doc.pageStarts,
      pageLayoutVersion: doc.pageLayoutVersion,
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
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  if (!desktop || !prefs.autosave || !doc.path || !dirty() || saveFailed)
    return;
  autosaveTimer = setTimeout(() => {
    void serial(async () => {
      if (!ready || !prefs.autosave || !doc.path || !dirty() || saveFailed)
        return;
      if (busy) {
        scheduleAutosave();
        return;
      }
      autosaving = true;
      updateStatus();
      try {
        await checkpoint();
        const snapshot = await api<Snapshot | null>("save_document", {
          saveAs: false,
        });
        if (snapshot) savedText = snapshot.savedText;
        saveFailed = false;
      } catch (e) {
        saveFailed = true;
        notice(`Autosave failed. Your edits remain in the editor. ${e}`, true);
      } finally {
        autosaving = false;
        updateStatus();
        if (dirty() && !saveFailed) scheduleAutosave();
      }
    }).catch(error);
  }, 1000);
}
function updateStatus() {
  for (const view of [editor, ...pageEditor.views]) {
    if (view.state.facet(EditorState.readOnly) !== (busy || !ready))
      view.dispatch({
        effects: editability.reconfigure([
          EditorState.readOnly.of(busy || !ready),
          EditorView.editable.of(view !== editor && !busy && ready),
        ]),
      });
  }
  $("filename").textContent = fileName(doc.path);
  $("save-state").textContent = busy
    ? "Working…"
    : autosaving
      ? "Saving…"
      : recoveryFailed
        ? "Recovery unavailable"
        : saveFailed
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
  const title = `Clean Writer - ${fileName(doc.path)}`;
  const titleChanged = document.title !== title;
  if (titleChanged) document.title = title;
  if (desktop && titleChanged)
    void getCurrentWindow()
      .setTitle(title)
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

  $<HTMLInputElement>("autosave").checked = prefs.autosave;
  $<HTMLSelectElement>("font").value = prefs.font;
  $<HTMLSelectElement>("preview-font").value = prefs.previewFont;
  $<HTMLInputElement>("size").value = String(prefs.size);
  $<HTMLSelectElement>("margin").value = String(prefs.margin);
  $("size-value").textContent = `${prefs.size} pt`;
  $("margin-value").textContent = `${prefs.margin} pt`;
  $<HTMLInputElement>("zoom").value = String(Math.round(prefs.zoom * 100));
  $("zoom-value").textContent = `${Math.round(prefs.zoom * 100)}%`;
  // Thumbnails live outside the document hosts, so share typography explicitly.
  // Keep their scale fixed while the main document zooms independently.
  stylePaper($("thumbnails"), prefs, prefs.preview);
  for (const host of [$("source-host"), $("preview-host")]) {
    stylePaper(host, prefs, host.id === "preview-host");
    host.style.transform = `scale(${prefs.zoom})`;
  }
  updateDocumentFrame();
  for (const view of pageEditor.views) {
    view.dispatch({ effects: theme.reconfigure(editorTheme()) });
    if (prefs.preview) view.dispatch({ effects: closeHoverTooltips });
    view.requestMeasure();
  }
}
// Transforms keep browser text hit-testing and CodeMirror in the same coordinate
// system. Reserve the scaled bounds separately, since transforms do not affect flow.
function updateDocumentFrame() {
  const host = $(prefs.preview ? "preview-host" : "source-host");
  $("document-frame").style.width = `${PAGE_WIDTH * prefs.zoom}px`;
  $("document-frame").style.height = `${host.offsetHeight * prefs.zoom}px`;
}
const documentSizeObserver = new ResizeObserver(updateDocumentFrame);
documentSizeObserver.observe($("source-host"));
documentSizeObserver.observe($("preview-host"));

function visiblePageIndex() {
  const canvas = $("canvas").getBoundingClientRect();
  const host = $(prefs.preview ? "preview-host" : "source-host");
  let fallback = -1;
  const readingTop = canvas.top + Math.min(80, canvas.height / 3);
  for (const paper of host.children as HTMLCollectionOf<HTMLElement>) {
    const rect = paper.getBoundingClientRect();
    if (rect.bottom <= canvas.top || rect.top >= canvas.bottom) continue;
    const index = prefs.preview
      ? pageEditor.ranges.findIndex((p) => p.key === paper.dataset.pageKey)
      : Number(paper.dataset.pageIndex);
    if (index < 0) continue;
    const key = pageEditor.ranges[index]?.key;
    if (key === readingPageKey) return index;
    if (fallback < 0 && rect.bottom > readingTop) fallback = index;
  }
  return fallback;
}
function followVisiblePage(force = false) {
  forceSidebarFollow ||= force;
  if (sidebarFollowFrame) return;
  sidebarFollowFrame = requestAnimationFrame(() => {
    sidebarFollowFrame = 0;
    const forced = forceSidebarFollow;
    forceSidebarFollow = false;
    if (!ready) return;
    const index = visiblePageIndex(),
      key = pageEditor.ranges[index]?.key;
    if (!key) return;
    if (selectedSidebarPageKey !== key) {
      selectedSidebarPageKey = key;
      updateBookmarks();
    }
    if (!prefs.sidebar || (!forced && key === lastFollowedPageKey)) return;
    const thumbnails = $("thumbnails");
    const thumbnail = thumbnails.children[index] as HTMLElement | undefined;
    if (!thumbnail) return;
    lastFollowedPageKey = key;
    const viewport = thumbnails.getBoundingClientRect(),
      rect = thumbnail.getBoundingClientRect();
    if (rect.top < viewport.top)
      thumbnails.scrollTop += rect.top - viewport.top;
    else if (rect.bottom > viewport.bottom)
      thumbnails.scrollTop += rect.bottom - viewport.bottom;
  });
}
function captureReadingPosition(): ReadingPosition | null {
  const canvas = $("canvas"),
    bounds = canvas.getBoundingClientRect();
  const host = $(prefs.preview ? "preview-host" : "source-host");
  let best: HTMLElement | null = null;
  const readingTop = bounds.top + Math.min(80, bounds.height / 3);
  for (const paper of host.children as HTMLCollectionOf<HTMLElement>) {
    const rect = paper.getBoundingClientRect();
    if (rect.bottom > readingTop && rect.top < bounds.bottom) {
      best = paper;
      break;
    }
  }
  const explicit = [...host.children].find((paper) => {
    const el = paper as HTMLElement;
    const index = prefs.preview
      ? pageEditor.ranges.findIndex((p) => p.key === el.dataset.pageKey)
      : Number(el.dataset.pageIndex);
    const key = pageEditor.ranges[index]?.key;
    const rect = el.getBoundingClientRect();
    return (
      key === readingPageKey &&
      rect.bottom > bounds.top &&
      rect.top < bounds.bottom
    );
  });
  if (explicit) best = explicit as HTMLElement;
  if (!best) return pendingReadingPosition;
  const index = prefs.preview
    ? pageEditor.ranges.findIndex((p) => p.key === best!.dataset.pageKey)
    : Number(best.dataset.pageIndex);
  const key = pageEditor.ranges[index]?.key;
  if (!key) return pendingReadingPosition;
  const body = best.querySelector<HTMLElement>(
    prefs.preview ? ".page-body" : ".cm-scroller",
  )!;
  const scale = best.getBoundingClientRect().width / PAGE_WIDTH;
  const visibleTop = Math.max(bounds.top + 8, body.getBoundingClientRect().top);
  const clip = (visibleTop - body.getBoundingClientRect().top) / scale;
  const position: ReadingPosition = {
    key,
    clip,
    canvasTop: canvas.scrollTop,
    fraction:
      body.scrollTop / Math.max(1, body.scrollHeight - body.clientHeight),
  };
  if (prefs.preview) {
    const blocks = [
      ...body.querySelectorAll<HTMLElement>(".source-block[data-source-from]"),
    ];
    const top = visibleTop;
    const block =
      blocks.find((el) => el.getBoundingClientRect().bottom > top + 1) ??
      blocks.at(-1);
    if (block) {
      const rect = block.getBoundingClientRect();
      position.sourceFrom = Number(block.dataset.sourceFrom);
      position.blockFraction = Math.max(
        0,
        Math.min(1, (top - rect.top) / Math.max(1, rect.height)),
      );
    }
  } else {
    const view = pageEditor.views[index],
      line = view.lineBlockAtHeight((body.scrollTop + clip) * view.scaleY);
    const text = view.state.doc.toString();
    const blocks = markdownBlocks(text).filter((block) =>
      text.slice(block.from, block.to).trim(),
    );
    const block =
      blocks.find((b) => line.from >= b.from && line.from < b.to) ??
      blocks.find((b) => b.from >= line.from) ??
      blocks.at(-1);
    if (block) {
      const first = view.lineBlockAt(block.from),
        last = view.lineBlockAt(Math.max(block.from, block.to - 1));
      position.sourceFrom = block.from;
      position.blockFraction = Math.max(
        0,
        Math.min(
          1,
          ((body.scrollTop + clip) * view.scaleY - first.top) /
            Math.max(1, last.bottom - first.top),
        ),
      );
    }
  }
  return position;
}
function restoreReadingPosition(position: ReadingPosition, focus = false) {
  const index = pageEditor.ranges.findIndex((p) => p.key === position.key);
  const host = $(prefs.preview ? "preview-host" : "source-host");
  const paper = host.children[index] as HTMLElement | undefined;
  if (!paper || (prefs.preview && paper.dataset.pageKey !== position.key))
    return false;
  const body = paper.querySelector<HTMLElement>(
    prefs.preview ? ".page-body" : ".cm-scroller",
  )!;
  if (focus && !prefs.preview && pageEditor.activeIndex === index)
    pageEditor.views[index].contentDOM.focus({ preventScroll: true });
  updateDocumentFrame();
  let mapped = false;
  let scroll =
    position.fraction * Math.max(0, body.scrollHeight - body.clientHeight);
  if (position.sourceFrom !== undefined) {
    if (prefs.preview) {
      const blocks = [
        ...body.querySelectorAll<HTMLElement>(
          ".source-block[data-source-from]",
        ),
      ];
      const block =
        blocks.find(
          (el) => Number(el.dataset.sourceFrom) === position.sourceFrom,
        ) ??
        blocks.find(
          (el) =>
            Number(el.dataset.sourceFrom) <= position.sourceFrom! &&
            Number(el.dataset.sourceTo) > position.sourceFrom!,
        );
      if (block) {
        mapped = true;
        const rect = block.getBoundingClientRect(),
          scale = paper.getBoundingClientRect().width / PAGE_WIDTH;
        scroll =
          body.scrollTop +
          (rect.top - body.getBoundingClientRect().top) / scale +
          ((position.blockFraction ?? 0) * rect.height) / scale -
          position.clip;
      }
    } else {
      const view = pageEditor.views[index],
        length = view.state.doc.length;
      const text = view.state.doc.toString();
      const blocks = markdownBlocks(text).filter((block) =>
        text.slice(block.from, block.to).trim(),
      );
      const block =
        blocks.find(
          (b) => position.sourceFrom! >= b.from && position.sourceFrom! < b.to,
        ) ??
        blocks.find((b) => b.from >= position.sourceFrom!) ??
        blocks.at(-1);
      if (block) {
        mapped = true;
        const first = view.lineBlockAt(Math.min(length, block.from)),
          last = view.lineBlockAt(
            Math.min(length, Math.max(block.from, block.to - 1)),
          );
        scroll =
          (first.top +
            (position.blockFraction ?? 0) * (last.bottom - first.top)) /
            view.scaleY -
          position.clip;
      }
    }
  }
  body.scrollTop = scroll;
  restoredBody = body;
  restoredBodyTop = body.scrollTop;
  restoredBodyHeight = body.scrollHeight;
  readingPageKey = position.key;
  const scale = paper.getBoundingClientRect().width / PAGE_WIDTH;
  restoredCanvasTop =
    position.canvasTop + (mapped ? (scroll - body.scrollTop) * scale : 0);
  $("canvas").scrollTop = restoredCanvasTop;
  currentPreviewPage = index;
  followVisiblePage(true);
  return true;
}
function changeSettings(change: Partial<Preferences>, render = true) {
  const switching =
    change.preview !== undefined && change.preview !== prefs.preview;
  const position = switching
    ? (toggleReadingPosition ??
      captureReadingPosition() ??
      pendingReadingPosition)
    : null;
  toggleReadingPosition = null;
  if (switching) {
    pendingPreviewJump = false;
    pendingReadingPosition = null;
  }
  if (change.preview === true) imageCache.clear();
  prefs = preferences({ ...prefs, ...change });
  updateSettings();
  if (switching) {
    restoredCanvasTop = $("canvas").scrollTop;
    restoredBody = null;
  }
  if (position) {
    restoreReadingPosition(position, !prefs.preview);
    pendingReadingPosition = position;
    requestAnimationFrame(() => {
      if (pendingReadingPosition !== position) return;
      restoreReadingPosition(position);
      if (prefs.preview && lastRenderedGeneration === renderGeneration)
        pendingReadingPosition = null;
    });
    if (!prefs.preview) {
      const index = pageEditor.ranges.findIndex(
        (page) => page.key === position.key,
      );
      pageEditor.views[index]?.requestMeasure({
        read: () => null,
        write: () =>
          requestAnimationFrame(() => {
            if (pendingReadingPosition === position && !prefs.preview) {
              restoreReadingPosition(position);
              pendingReadingPosition = null;
            }
          }),
      });
    }
  }
  if (change.preview !== undefined) updateThumbnails();
  if (
    change.preview !== undefined ||
    change.sidebar === true ||
    change.zoom !== undefined
  )
    followVisiblePage(true);
  scheduleRecovery();
  if (change.autosave !== undefined) scheduleAutosave();
  if (render) scheduleRender();
}
function applySnapshot(snapshot: Snapshot, replaceText = true) {
  if (replaceText) {
    ready = false;
    selectedSidebarPageKey = null;
    lastFollowedPageKey = null;
    pendingReadingPosition = null;
    toggleReadingPosition = null;
    readingPageKey = null;
    doc = snapshot.session.document;
    doc.cursor = Math.min(doc.text.length, Math.max(0, doc.cursor));
    doc.bookmarks = doc.bookmarks.map((b) => ({
      ...b,
      offset: Math.min(doc.text.length, Math.max(0, b.offset)),
    }));
    // Reset the page editors after loading this document's typography below.
    ready = true;
  } else {
    doc.path = snapshot.session.document.path;
  }
  savedText = snapshot.savedText;
  recent = snapshot.session.recent;
  prefs = preferences(snapshot.session.preferences);
  if (replaceText) {
    doc.pageStarts = undefined;
    resetEditor();
    layoutSource();
  }
  saveFailed = false;
  notice("");
  updateSettings();
  updateRecent();
  updateBookmarks();
  updateStatus();
  scheduleRender();
  scheduleAutosave();
}
function resetEditor() {
  pageEditor.reset(editorState());
  sourcePages = pageEditor.ranges;
}

async function save(saveAs = false): Promise<boolean> {
  clearTimeout(autosaveTimer);
  clearTimeout(recoveryTimer);
  try {
    await checkpoint();
    const snapshot = await api<Snapshot | null>("save_document", { saveAs });
    if (!snapshot) return false;
    // Keep editor history when a save changes the destination.
    applySnapshot(snapshot, false);
    if (dirty()) scheduleRecovery();
    return true;
  } catch (e) {
    saveFailed = true;
    notice(
      `Save failed. ${recoveryFailed ? "Keep this window open until recovery or saving succeeds." : "Your recovery copy is retained."} ${e}`,
      true,
    );
    throw e;
  }
}
async function unsavedChoice(): Promise<string> {
  const dialog = $<HTMLDialogElement>("confirm-dialog");
  // Escape must always cancel, even if an earlier confirmation chose Save.
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise<string>((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue), {
      once: true,
    }),
  );
}
async function confirmReplacement(): Promise<boolean> {
  await checkpoint();
  if (!dirty()) return true;
  const choice = await unsavedChoice();
  return choice === "discard" || (choice === "save" && (await save(false)));
}
async function replaceDocument(
  command: string,
  args: Record<string, unknown> = {},
) {
  if (!(await confirmReplacement())) return;
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
function thumbnailBookmarkPage(offset: number) {
  // Editor and preview share the same independent page identities.
  return sourcePageAt(sourcePages, offset);
}
function selectedSidebarPageIndex() {
  let index = pageEditor.ranges.findIndex(
    (page) => page.key === selectedSidebarPageKey,
  );
  if (index < 0) {
    index = pageEditor.activeIndex;
    selectedSidebarPageKey = pageEditor.ranges[index]?.key ?? null;
  }
  return index;
}
function currentPageIndex() {
  const visible = visiblePageIndex();
  return visible >= 0 ? visible : selectedSidebarPageIndex();
}
let bookmarkFrame = 0;
function updateBookmarks() {
  if (bookmarkFrame) return;
  bookmarkFrame = requestAnimationFrame(() => {
    bookmarkFrame = 0;
    refreshBookmarks();
  });
}
function refreshBookmarks() {
  const index = currentPageIndex();
  const marked = doc.bookmarks.some(
    (mark) => sourcePageAt(sourcePages, mark.offset) === index,
  );
  $("bookmark-add").classList.toggle("bookmarked", marked);
  $("bookmark-add").title = marked
    ? "Remove this page's bookmark (Ctrl/⌘D)"
    : "Bookmark this page (Ctrl/⌘D)";
  $("thumbnails")
    .querySelectorAll<HTMLElement>(".thumbnail")
    .forEach((button, pageIndex) => {
      button.classList.toggle(
        "active",
        pageIndex === selectedSidebarPageIndex(),
      );
      if (pageIndex === selectedSidebarPageIndex())
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
      button.querySelector(".thumbnail-bookmark")?.remove();
      if (
        doc.bookmarks.some(
          (mark) => thumbnailBookmarkPage(mark.offset) === pageIndex,
        )
      ) {
        const marker = document.createElement("span");
        marker.className = "thumbnail-bookmark";
        marker.innerHTML = icon("bookmark");
        marker.title = prefs.preview
          ? "Open source bookmark in this section"
          : "Bookmarked page";
        marker.onclick = (event) => {
          event.stopPropagation();
          const mark = doc.bookmarks.find(
            (mark) => thumbnailBookmarkPage(mark.offset) === pageIndex,
          );
          if (mark) jump(mark.offset);
        };
        marker.setAttribute("aria-label", "Bookmarked page");
        button.querySelector(".mini-paper")?.append(marker);
      }
    });
}
function jump(offset: number, pageStart = false) {
  if (prefs.preview) changeSettings({ preview: false }, false);
  editor.dispatch({ selection: { anchor: Math.min(doc.text.length, offset) } });
  pageEditor.scrollTo(Math.min(doc.text.length, offset), pageStart);
  editor.focus();
}
function bookmark() {
  if (!ready || busy) return;
  const pageIndex = currentPageIndex();
  const page = pageEditor.ranges[pageIndex];
  if (!page) return;
  selectedSidebarPageKey = page.key;
  const cursor = editor.state.selection.main.head;
  const offset =
    sourcePageAt(sourcePages, cursor) === pageIndex ? cursor : page.from;
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
  if (!ready || busy) return;
  pendingReadingPosition = null;
  layoutSource();
  const visibleIndex = visiblePageIndex();
  const index = visibleIndex >= 0 ? visibleIndex : selectedSidebarPageIndex();
  pageEditor.insertPage(index, !prefs.preview);
  selectedSidebarPageKey = pageEditor.ranges[index + 1].key;
  if (prefs.preview) {
    currentPreviewPage = index + 1;
    pendingPreviewJump = true;
  }
  layoutSource();
  updateThumbnails();
  updateStatus();
}
async function removePage(key: string) {
  if (!ready || busy) return;
  let index = pageEditor.ranges.findIndex((page) => page.key === key);
  if (index < 0) return;
  hidePopovers();
  const dialog = $<HTMLDialogElement>("delete-page-dialog");
  if (dialog.open) return;
  $("delete-page-message").textContent =
    `Delete page ${index + 1}? You can undo this change.`;
  dialog.returnValue = "cancel";
  dialog.showModal();
  const choice = await new Promise<string>((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue), {
      once: true,
    }),
  );
  if (choice !== "delete" || !ready || busy) return;
  index = pageEditor.ranges.findIndex((page) => page.key === key);
  if (index < 0) return;
  pendingReadingPosition = null;
  pendingPreviewJump = false;
  const nextIndex = pageEditor.removePage(index, !prefs.preview);
  selectedSidebarPageKey = pageEditor.ranges[nextIndex].key;
  readingPageKey = selectedSidebarPageKey;
  currentPreviewPage = nextIndex;
  layoutSource();
  if (prefs.preview) {
    const keys = new Set(pageEditor.ranges.map((page) => page.key));
    pages = pages.filter((page) => {
      if (keys.has(page.element.dataset.pageKey!)) return true;
      page.element.remove();
      return false;
    });
    pages.forEach((page, i) => {
      page.element.dataset.sourcePageIndex = String(i);
      page.element.setAttribute("aria-label", `Preview page ${i + 1}`);
      page.element.querySelector(".page-number")!.textContent = String(i + 1);
    });
    pages[nextIndex]?.element.scrollIntoView({ block: "start" });
    pendingPreviewJump = true;
  } else pageEditor.scrollTo(pageEditor.ranges[nextIndex].from, true);
  updateThumbnails();
  updateStatus();
  scheduleRender();
  scheduleRecovery();
}
function scheduleRender(typing = false) {
  ++renderGeneration;
  // Full Markdown rendering and document layout wait until typing stops.
  // The active editor handles its own overflow without rebuilding preview.
  clearTimeout(renderTimer);
  renderTimer = setTimeout(
    () => {
      renderTimer = undefined;
      void render(renderGeneration).catch((e) =>
        notice(`Preview failed: ${e}`),
      );
    },
    typing ? 600 : 0,
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
function insertMarkdown(command: string) {
  if (!ready || busy) return;
  if (prefs.preview) changeSettings({ preview: false }, false);
  const selected = editor.state.selection.main;
  const insertion = markdownInsertion(
    doc.text,
    selected.from,
    selected.to,
    command,
  );
  editor.dispatch({
    changes: { from: insertion.from, to: insertion.to, insert: insertion.text },
    selection: { anchor: insertion.anchor, head: insertion.head },
    scrollIntoView: true,
    annotations: isolateHistory.of("full"),
  });
  editor.focus();
}
async function insertImage() {
  if (!doc.path) {
    notice("Save this Markdown file first so the image path can be relative.");
    if (!(await save(false))) return;
  }
  const markdown = await api<string | null>("pick_image");
  if (!markdown) return;
  if (prefs.preview) changeSettings({ preview: false }, false);
  const selected = editor.state.selection.main;
  const insertion = `\n${markdown}\n`;
  editor.dispatch({
    changes: { from: selected.from, to: selected.to, insert: insertion },
    selection: { anchor: selected.from + insertion.length },
    annotations: isolateHistory.of("full"),
  });
  editor.focus();
}
async function render(generation: number) {
  if (!desktop) {
    pageEditor.setFlowRanges(sourcePagination(doc.text, prefs).pages);
    layoutSource();
    updateThumbnails();
    $("word-count").textContent =
      `${doc.text.trim() ? doc.text.trim().split(/\s+/).length : 0} words`;
    return;
  }
  const documentPath = doc.path;
  const result = await api<Rendered>("render_markdown", { text: doc.text });
  if (generation !== renderGeneration) return;
  const sections = await resolveImages(
    result.flow ? [result.flow] : result.sections,
    prefs,
    imageLoader(documentPath),
  );
  if (generation !== renderGeneration) return;
  const host = document.createElement("div");
  host.className = "measurement-host";
  document.body.append(host);
  let next: Page[];
  let sourceKeys: string[];
  try {
    const flow = flowingPages(doc.text, sections, prefs, host, !!result.flow);
    pageEditor.setFlowRanges(flow.pages);
    layoutSource();
    sourceKeys = pageEditor.ranges.map((page) => page.key);
    next = previewContainers(flow.html, prefs, host);
  } catch (e) {
    host.remove();
    throw e;
  }
  if (generation !== renderGeneration) {
    host.remove();
    return;
  }
  const previewHost = $("preview-host");
  const existing = new Map(
    [...previewHost.children].map((element) => [
      (element as HTMLElement).dataset.pageKey,
      element as HTMLElement,
    ]),
  );
  next = next.map((page, index) => {
    const key = sourceKeys[index];
    const previous = existing.get(key);
    page.element.dataset.pageKey = key;
    if (!previous) return page;
    const body = previous.querySelector<HTMLElement>(".page-body")!;
    const nextBody = page.element.querySelector<HTMLElement>(".page-body")!;
    const scrollTop = body.scrollTop,
      scrollLeft = body.scrollLeft;
    if (body.innerHTML !== nextBody.innerHTML)
      body.replaceChildren(...nextBody.childNodes);
    body.setAttribute("aria-label", nextBody.getAttribute("aria-label")!);
    body.scrollTop = scrollTop;
    body.scrollLeft = scrollLeft;
    previous.dataset.sourcePageIndex = String(index);
    previous.setAttribute(
      "aria-label",
      page.element.getAttribute("aria-label")!,
    );
    previous.querySelector(".page-number")!.textContent = String(index + 1);
    return { ...page, element: previous };
  });
  const keep = new Set(next.map((page) => page.element));
  for (const element of [...previewHost.children])
    if (!keep.has(element as HTMLElement)) element.remove();
  next.forEach((page, index) => {
    const current = previewHost.children[index];
    if (current !== page.element)
      previewHost.insertBefore(page.element, current ?? null);
  });
  host.remove();
  pages = next;
  lastRenderedGeneration = generation;
  if (prefs.preview && pendingReadingPosition) {
    const position = pendingReadingPosition;
    requestAnimationFrame(() => {
      if (pendingReadingPosition === position && prefs.preview) {
        restoreReadingPosition(position);
        pendingReadingPosition = null;
      }
    });
  }
  if (prefs.preview && pendingPreviewJump) {
    pages[currentPreviewPage]?.element.scrollIntoView({ block: "start" });
    pendingPreviewJump = false;
  }
  $("word-count").textContent =
    `${result.words.toLocaleString()} ${result.words === 1 ? "word" : "words"}`;
  updateThumbnails();
}
function updateThumbnails() {
  followVisiblePage();
  const visiblePages = prefs.preview ? pages : sourcePages;
  currentPreviewPage = Math.min(
    currentPreviewPage,
    Math.max(0, sourcePages.length - 1),
  );
  $("page-count").textContent =
    `${visiblePages.length} ${visiblePages.length === 1 ? "page" : "pages"}`;
  const thumbnailScrollTop = $("thumbnails").scrollTop;
  $("thumbnails").replaceChildren();
  visiblePages.forEach((page, index) => {
    const pageText =
      "from" in page
        ? doc.text.slice(page.from, page.to)
        : page.element.querySelector(".page-body")?.textContent || "";
    const button = document.createElement("button");
    button.className = "thumbnail";
    button.setAttribute("aria-label", `Go to page ${index + 1}`);
    const mini = document.createElement("div");
    mini.className = "mini-paper";
    const excerpt = document.createElement("div");
    excerpt.className = "mini-text";
    excerpt.textContent = pageText || " ";
    mini.append(excerpt);
    const badges = document.createElement("span");
    badges.className = "thumbnail-badges";
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
      pendingReadingPosition = null;
      selectedSidebarPageKey = pageEditor.ranges[index].key;
      readingPageKey = selectedSidebarPageKey;
      if ("element" in page) {
        currentPreviewPage = index;
        page.element.scrollIntoView({ block: "start" });
        updateBookmarks();
      } else {
        const mark = doc.bookmarks.find(
          (b) => thumbnailBookmarkPage(b.offset) === index,
        );
        jump(mark?.offset ?? page.from, !mark);
        updateBookmarks();
      }
    };
    button.oncontextmenu = (event) => {
      const marks = doc.bookmarks.filter(
        (b) => thumbnailBookmarkPage(b.offset) === index,
      );
      event.preventDefault();
      hidePopovers();
      const pageKey = pageEditor.ranges[index].key;
      const menu = $("bookmark-menu");
      menu.replaceChildren();
      const remove = document.createElement("button");
      remove.textContent = "Remove page";
      remove.disabled = busy || !ready;
      remove.onclick = () => removePage(pageKey);
      menu.append(remove);
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
      menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8))}px`;
    };
    $("thumbnails").append(button);
  });
  $("thumbnails").scrollTop = thumbnailScrollTop;
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
      rendered.flow ? [rendered.flow] : rendered.sections,
      prefs,
      imageLoader(doc.path, true),
    );
    const printPages = paginate(
      rendered.flow
        ? manualPreviewSections(doc.text, printSections[0])
        : printSections,
      { ...prefs, dark: false },
      host,
    );
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
  clearTimeout(autosaveTimer);
  clearTimeout(recoveryTimer);
  let closed = false;
  try {
    if (dirty()) {
      const pendingChoice = unsavedChoice();
      // Keep recovery current while the modal is open, but do not let a
      // recovery failure bypass the user's Save / Discard / Cancel choice.
      try {
        await checkpoint();
      } catch (e) {
        notice(`Recovery could not be stored: ${e}`, true);
      }
      const choice = await pendingChoice;
      if (choice === "cancel") return;
      if (choice === "save") {
        if (!(await save(false))) return;
      } else if (choice === "discard") {
        applySnapshot(await api<Snapshot>("discard_changes"));
      } else return;
    } else await checkpoint();
    await getCurrentWindow().destroy();
    closed = true;
  } finally {
    // Resume draft recovery if closing was canceled or saving failed.
    if (!closed && dirty()) {
      scheduleRecovery();
      scheduleAutosave();
    }
  }
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
  ...Object.fromEntries(
    insertCommands()
      .filter((command) => command !== "image" && command !== "page-break")
      .map((command) => [
        `insert-${command}`,
        async () => insertMarkdown(command),
      ]),
  ),
  "insert-page-break": async () => {
    if (ready && !busy) addPage();
  },
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
const dictionaries = dictionarySettings($("dictionary-settings"), api, () => {
  for (const view of pageEditor.views)
    view.dispatch({ effects: [resetSpelling.of(null), closeHoverTooltips] });
});
$("settings").onclick = () => {
  const hidden = $("settings-panel").hidden;
  hidePopovers();
  $("settings-panel").hidden = !hidden;
  if (hidden) void dictionaries.refresh();
};
$<HTMLInputElement>("autosave").onchange = (e) =>
  changeSettings({ autosave: (e.target as HTMLInputElement).checked }, false);
$("sidebar-toggle").onclick = () =>
  changeSettings({ sidebar: !prefs.sidebar }, false);
$("theme").onclick = () => changeSettings({ dark: !prefs.dark }, false);
$("preview").addEventListener("pointerdown", () => {
  toggleReadingPosition = captureReadingPosition() ?? pendingReadingPosition;
});
$("preview").onclick = () => {
  changeSettings({ preview: !prefs.preview });
};
$("bookmark-add").onclick = bookmark;
$("find").onclick = () => {
  if (prefs.preview) changeSettings({ preview: false }, false);
  openSearchPanel(editor);
};
$("add-page").onclick = addPage;
$<HTMLSelectElement>("font").onchange = (e) =>
  changeSettings({ font: (e.target as HTMLSelectElement).value });
$<HTMLSelectElement>("preview-font").onchange = (e) =>
  changeSettings({ previewFont: (e.target as HTMLSelectElement).value });
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
for (const host of [$("source-host"), $("preview-host")])
  host.addEventListener("pointerdown", (event) => {
    pendingReadingPosition = null;
    const paper = (event.target as Element).closest<HTMLElement>(
      ".source-page,.preview-page",
    );
    if (paper)
      readingPageKey =
        paper.dataset.pageKey ??
        pageEditor.ranges[Number(paper.dataset.pageIndex)]?.key ??
        null;
    followVisiblePage(true);
  });
$("preview-host").addEventListener("click", (e) => {
  const paper = (e.target as HTMLElement).closest<HTMLElement>(".preview-page");
  if (paper) {
    currentPreviewPage = Number(paper.dataset.sourcePageIndex);
    updateBookmarks();
  }
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
  "scroll",
  () => {
    if (
      restoredCanvasTop === null ||
      Math.abs($("canvas").scrollTop - restoredCanvasTop) > 1
    ) {
      pendingReadingPosition = null;
    }
    followVisiblePage(true);
  },
  {
    passive: true,
  },
);
for (const host of [$("source-host"), $("preview-host")])
  host.addEventListener(
    "scroll",
    (event) => {
      if (host.hidden) return;
      const target = event.target as HTMLElement;
      if (
        pendingReadingPosition &&
        restoredBody &&
        host.contains(restoredBody) &&
        (target !== restoredBody ||
          (target.scrollHeight === restoredBodyHeight &&
            Math.abs(target.scrollTop - restoredBodyTop) > 1))
      )
        pendingReadingPosition = null;
      const paper = (event.target as Element).closest<HTMLElement>(
        ".source-page,.preview-page",
      );
      if (paper)
        readingPageKey =
          paper.dataset.pageKey ??
          pageEditor.ranges[Number(paper.dataset.pageIndex)]?.key ??
          null;
      followVisiblePage(true);
    },
    {
      capture: true,
      passive: true,
    },
  );
$("canvas").addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) {
      pendingReadingPosition = null;
      const paper = (e.target as Element).closest<HTMLElement>(
        ".source-page,.preview-page",
      );
      readingPageKey = paper
        ? (paper.dataset.pageKey ??
          pageEditor.ranges[Number(paper.dataset.pageIndex)]?.key ??
          null)
        : null;
    }
    if (e.ctrlKey) {
      e.preventDefault();
      changeSettings({ zoom: prefs.zoom - e.deltaY * 0.002 }, false);
    } else if (
      !e.shiftKey &&
      e.deltaX === 0 &&
      (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
        (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40))
    ) {
      // Mouse notches use lines or large pixel deltas. Leave small, precise
      // trackpad movements native, and keep wheel speed independent of zoom.
      e.preventDefault();
      if (!e.defaultPrevented) return;
      const canvas = $("canvas");
      const unit =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? prefs.size * 1.2
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? canvas.clientHeight
            : 1;
      canvas.scrollBy({ top: e.deltaY * unit * 2, behavior: "instant" });
    }
  },
  { passive: false },
);
window.addEventListener("blur", () => {
  if (ready && !busy)
    void serial(async () => {
      await checkpoint();
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
      await listen("close-requested", () => {
        if (!busy) void run(closeApp);
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
