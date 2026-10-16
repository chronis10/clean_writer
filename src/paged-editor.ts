import {
  Annotation,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type StateCommand,
} from "@codemirror/state";
import {
  EditorView,
  Decoration,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  isolateHistory,
  undo,
  redo,
  deleteCharBackward,
  deleteCharForward,
} from "@codemirror/commands";
import { getSearchQuery, search, setSearchQuery } from "@codemirror/search";
import {
  markdown,
  markdownLanguage,
  insertNewlineContinueMarkup,
  deleteMarkupBackward,
} from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { markdownStyle } from "./syntax-theme";
import type { Preferences } from "./model";
import {
  sourcePagination,
  sourcePageAt,
  type SourcePage,
} from "./source-pages";

export interface PageRange extends SourcePage {
  key: string;
}
const originPage = Annotation.define<string>();
const pageSync = Annotation.define<boolean>();
const highlightEffect = StateEffect.define<DecorationSet>();
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(highlightEffect)) return effect.value;
    return value.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});
export const pageRangesEffect = StateEffect.define<PageRange[]>();
let nextKey = 0;
const pageKey = () => `source-page-${++nextKey}`;

function initialRanges(
  text: string,
  prefs: Preferences,
  starts?: number[],
): PageRange[] {
  const valid =
    starts?.length &&
    starts[0] === 0 &&
    starts.every(
      (n, i) =>
        Number.isInteger(n) &&
        n >= 0 &&
        n <= text.length &&
        (!i || n >= starts[i - 1]),
    );
  const ranges = valid
    ? starts!.map((from, index) => {
        const next = starts![index + 1] ?? text.length;
        return {
          from,
          to:
            index + 1 < starts!.length && text[next - 1] === "\f"
              ? next - 1
              : next,
          section: 0,
        };
      })
    : sourcePagination(text, prefs).pages;
  return splitSections(
    ranges.map((p) => ({ ...p, key: pageKey() })),
    text,
  );
}

function splitSections(ranges: PageRange[], text: string): PageRange[] {
  const result: PageRange[] = [];
  for (const page of ranges) {
    let from = page.from,
      key = page.key;
    for (
      let pos = text.indexOf("\f", from);
      pos >= 0 && pos < page.to;
      pos = text.indexOf("\f", from)
    ) {
      result.push({ from, to: pos, key, section: 0 });
      from = pos + 1;
      key = pageKey();
    }
    result.push({ ...page, from, key });
  }
  let section = 0,
    previous = 0;
  for (const page of result) {
    for (let i = previous; i < page.from; i++) if (text[i] === "\f") section++;
    page.section = section;
    previous = page.from;
  }
  return result;
}

export function pageRangesField(
  prefs: () => Preferences,
  starts: () => number[] | undefined,
) {
  return StateField.define<PageRange[]>({
    create: (state) => initialRanges(state.doc.toString(), prefs(), starts()),
    update(ranges, tr) {
      for (const effect of tr.effects)
        if (effect.is(pageRangesEffect)) return effect.value;
      if (!tr.docChanged) return ranges;
      const origin = tr.annotation(originPage);
      let replacement = false,
        breaksChanged = false;
      tr.changes.iterChanges((from, to, _a, _b, inserted) => {
        if (!origin && from === 0 && to === tr.startState.doc.length)
          replacement = true;
        if (
          inserted.toString().includes("\f") ||
          tr.startState.doc.sliceString(from, to).includes("\f")
        )
          breaksChanged = true;
      });
      if (replacement) return initialRanges(tr.newDoc.toString(), prefs());
      const active =
        origin ??
        ranges[sourcePageAt(ranges, tr.startState.selection.main.head)].key;
      const mapped = ranges.map((page) => ({
        ...page,
        from: tr.changes.mapPos(page.from, page.key === active ? -1 : 1),
        to: tr.changes.mapPos(page.to, page.key === active ? 1 : -1),
      }));
      return breaksChanged
        ? splitSections(mapped, tr.newDoc.toString())
        : mapped;
    },
  });
}

export function planPageRemoval(
  ranges: PageRange[],
  text: string,
  index: number,
) {
  const page = ranges[index];
  if (!page) throw new RangeError("Unknown page");
  const from =
    index === ranges.length - 1 && index > 0 ? ranges[index - 1].to : page.from;
  const to = ranges[index + 1]?.from ?? page.to;
  const nextText = text.slice(0, from) + text.slice(to);
  const next =
    ranges.length === 1
      ? [{ ...page, from: 0, to: 0, section: 0 }]
      : ranges
          .filter((_, i) => i !== index)
          .map((p, i) =>
            i >= index
              ? { ...p, from: p.from - (to - from), to: p.to - (to - from) }
              : { ...p },
          );
  return {
    from,
    to,
    ranges: splitSections(next, nextText),
    index: Math.min(index, next.length - 1),
  };
}

interface PageEditor {
  range: PageRange;
  paper: HTMLElement;
  view: EditorView;
  highlightKey?: string;
}
export class PagedEditor {
  readonly master: EditorView;
  private entries: PageEditor[] = [];
  private syncing = false;
  private pending = false;
  private wantsScroll = false;
  private wantsFocus = false;
  private activeKey: string | null = null;
  private flowInitialized = false;
  private flowTypography = "";
  private highlightText = "";
  private highlights: { from: number; to: number; classes: string }[] = [];
  constructor(
    private host: HTMLElement,
    masterHost: HTMLElement,
    state: EditorState,
    readonly rangesField: StateField<PageRange[]>,
    private extensions: () => Extension[],
    private preferences: () => Preferences,
  ) {
    this.master = new EditorView({
      parent: masterHost,
      state,
      dispatchTransactions: (transactions, view) => {
        const focused = this.entries.some((e) => e.view.hasFocus);
        this.wantsFocus ||= focused;
        this.wantsScroll ||=
          focused && transactions.some((tr) => tr.docChanged);
        if (
          transactions.some((tr) => tr.selection && !tr.annotation(originPage))
        )
          this.activeKey = null;
        this.wantsScroll ||= transactions.some((tr) => tr.scrollIntoView);
        view.update(transactions);
        const ranges = this.ranges;
        if (
          transactions.every(
            (tr) =>
              tr.annotation(originPage) && !tr.docChanged && !tr.effects.length,
          )
        ) {
          this.wantsFocus = this.wantsScroll = false;
          return;
        }
        if (
          transactions.every(
            (tr) => tr.annotation(originPage) && !tr.effects.length,
          ) &&
          ranges.length === this.entries.length &&
          ranges.every((range, i) => range.key === this.entries[i].range.key)
        ) {
          // The visible editor already applied this edit. Only its absolute
          // offsets changed; don't reparse or visit every page's document.
          this.entries.forEach((entry, i) => {
            entry.range = ranges[i];
          });
          this.wantsFocus = this.wantsScroll = false;
          if (transactions.some((tr) => tr.docChanged)) this.checkOverflow();
          return;
        }
        this.scheduleSync();
      },
    });
    this.master.focus = () => this.focus();
    this.sync();
  }
  get ranges() {
    return this.master.state.field(this.rangesField);
  }
  get views() {
    return this.entries.map((e) => e.view);
  }
  get activeIndex() {
    const head = this.master.state.selection.main.head;
    const preferred = this.ranges.findIndex(
      (p) => p.key === this.activeKey && head >= p.from && head <= p.to,
    );
    return preferred >= 0 ? preferred : sourcePageAt(this.ranges, head);
  }
  reset(state: EditorState) {
    for (const entry of this.entries) entry.view.destroy();
    this.entries = [];
    this.host.replaceChildren();
    this.flowInitialized = false;
    this.activeKey = null;
    this.master.setState(state);
    this.sync();
  }
  private scheduleSync() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.sync();
    });
  }
  private checkOverflow() {
    const entry = this.entries[this.activeIndex];
    if (!entry) return;
    entry.view.requestMeasure({
      key: entry,
      read: () =>
        entry.view.contentHeight > entry.view.scrollDOM.clientHeight + 1,
      write: (overflow) => {
        if (!overflow || !this.entries.includes(entry)) return;
        const text = entry.view.state.doc.toString();
        const local = sourcePagination(text, this.preferences()).pages;
        if (local.length < 2) return;
        const index = this.entries.indexOf(entry);
        const ranges = [...this.ranges];
        ranges.splice(
          index,
          1,
          ...local.map((page, i) => ({
            ...page,
            from: entry.range.from + page.from,
            to: entry.range.from + page.to,
            section: entry.range.section,
            key: i === 0 ? entry.range.key : pageKey(),
          })),
        );
        this.master.dispatch({
          effects: pageRangesEffect.of(ranges),
          annotations: Transaction.addToHistory.of(false),
          scrollIntoView: true,
        });
        this.focus();
      },
    });
  }
  private pageUpdate(entry: PageEditor, update: ViewUpdate) {
    if (
      (!update.docChanged && !update.selectionSet) ||
      update.transactions.every((tr) => tr.annotation(pageSync))
    )
      return;
    const from = this.ranges.find((p) => p.key === entry.range.key)?.from;
    if (from === undefined) return;
    const changes: { from: number; to: number; insert: string }[] = [];
    update.changes.iterChanges((a, b, _c, _d, inserted) =>
      changes.push({
        from: from + a,
        to: from + b,
        insert: inserted.toString(),
      }),
    );
    this.activeKey = entry.range.key;
    const annotations = [originPage.of(entry.range.key)];
    for (const tr of update.transactions) {
      const event = tr.annotation(Transaction.userEvent);
      // Pointer selection belongs to the visible page. Propagating its
      // special flag would make CodeMirror write the hidden master's DOM
      // selection and steal the browser's insertion point from that page.
      if (event)
        annotations.push(
          Transaction.userEvent.of(
            event.startsWith("select.pointer") ? "select" : event,
          ),
        );
      const isolation = tr.annotation(isolateHistory);
      if (isolation) annotations.push(isolateHistory.of(isolation));
    }
    const selection = update.state.selection.main;
    this.master.dispatch({
      changes,
      selection: {
        anchor: from + selection.anchor,
        head: from + selection.head,
      },
      annotations,
    });
  }
  private create(range: PageRange): PageEditor {
    const paper = document.createElement("article");
    paper.className = "paper source-paper source-page";
    paper.dataset.pageKey = range.key;
    const body = document.createElement("div");
    body.className = "source-page-body";
    const footer = document.createElement("div");
    footer.className = "page-number";
    paper.append(body, footer);
    const entry = { range, paper } as PageEditor;
    entry.view = new EditorView({
      parent: body,
      state: EditorState.create({
        doc: this.master.state.doc.sliceString(range.from, range.to),
        extensions: [
          ...this.extensions(),
          highlightField,
          search(),
          keymap.of([
            {
              key: "Enter",
              run: () => this.markdownCommand(insertNewlineContinueMarkup),
            },
            {
              key: "Backspace",
              run: () => this.markdownCommand(deleteMarkupBackward, true),
            },
            ...[
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Backspace",
              "Delete",
            ].map((key) => ({
              key,
              run: () => this.crossPage(entry, key),
            })),
            {
              key: "Mod-z",
              run: () => undo(this.master),
              preventDefault: true,
            },
            {
              key: "Mod-Shift-z",
              run: () => redo(this.master),
              preventDefault: true,
            },
            {
              key: "Mod-y",
              run: () => redo(this.master),
              preventDefault: true,
            },
            {
              key: "Ctrl-End",
              run: () => this.moveToDocumentEnd(),
              preventDefault: true,
            },
            {
              key: "Mod-End",
              run: () => this.moveToDocumentEnd(),
              preventDefault: true,
            },
            {
              key: "Ctrl-Home",
              run: () => this.moveToDocumentStart(),
              preventDefault: true,
            },
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) =>
            this.pageUpdate(entry, update),
          ),
          EditorView.domEventHandlers({
            focus: () => {
              if (this.syncing) return false;
              const current = this.ranges.find(
                (p) => p.key === entry.range.key,
              );
              if (current) {
                this.activeKey = current.key;
                this.master.dispatch({
                  selection: {
                    anchor:
                      current.from + entry.view.state.selection.main.anchor,
                    head: current.from + entry.view.state.selection.main.head,
                  },
                  annotations: originPage.of(current.key),
                });
              }
              return false;
            },
          }),
        ],
      }),
    });
    paper.addEventListener("click", (event) => {
      if (!(event.target as HTMLElement).closest(".cm-editor"))
        entry.view.focus();
    });
    return entry;
  }
  private markdownCommand(command: StateCommand, deleting = false) {
    const { doc, selection } = this.master.state;
    if (deleting) {
      if (!selection.main.empty) return false;
      const line = doc.lineAt(selection.main.head);
      const prefix = doc.sliceString(line.from, selection.main.head);
      // Markdown Backspace only changes list/quote prefixes or indentation.
      // Ordinary text deletion must not create a document-wide syntax tree.
      if (!prefix || !/^(?:\s|>|[-+*](?=\s)|\d+[.)](?=\s))*$/.test(prefix))
        return false;
    }
    // Keep the persistent document/history free of an eager language parser.
    // Commands that need Markdown context parse a temporary state on demand.
    const state = EditorState.create({
      doc,
      selection,
      extensions: [markdown({ addKeymap: false })],
    });
    ensureSyntaxTree(state, selection.main.head, 100);
    return command({
      state,
      dispatch: (transaction) =>
        this.master.dispatch({
          changes: transaction.changes,
          selection: transaction.selection,
          scrollIntoView: transaction.scrollIntoView,
          userEvent: transaction.annotation(Transaction.userEvent),
        }),
    });
  }
  private crossPage(entry: PageEditor, key: string) {
    const selection = entry.view.state.selection.main;
    if (!selection.empty) return false;
    const head = selection.head;
    const length = entry.view.state.doc.length;
    const first = head === 0,
      last = head === length;
    if (key === "Backspace" && length === 0 && this.ranges.length > 1) {
      this.removePage(this.entries.indexOf(entry), true, true);
      return true;
    }
    let atTop = false,
      atBottom = false;
    if (key === "ArrowUp" || key === "ArrowDown") {
      const line = entry.view.state.doc.lineAt(head);
      // Only a visual row on the first/last logical line can cross a page.
      // Let CodeMirror move within the page without duplicate geometry reads.
      if (key === "ArrowUp" ? line.from !== 0 : line.to !== length)
        return false;
      const position = entry.view.coordsAtPos(head);
      const edge = entry.view.coordsAtPos(key === "ArrowUp" ? 0 : length);
      atTop =
        key === "ArrowUp" && !!position && !!edge && position.top === edge.top;
      atBottom =
        key === "ArrowDown" &&
        !!position &&
        !!edge &&
        position.top === edge.top;
    } else if (key === "ArrowLeft" || key === "Backspace") {
      if (!first) return false;
    } else if (!last) return false;
    const index = this.entries.indexOf(entry);
    const backward =
      ((key === "ArrowLeft" || key === "Backspace") && first) ||
      (key === "ArrowUp" && atTop);
    const forward =
      ((key === "ArrowRight" || key === "Delete") && last) ||
      (key === "ArrowDown" && atBottom);
    const target = backward
      ? this.entries[index - 1]
      : forward
        ? this.entries[index + 1]
        : undefined;
    if (!target) return false;
    const absolute = entry.range.from + head;
    if (key === "Backspace" || key === "Delete") {
      const adjacent =
        key === "Backspace" ? target.range.to : target.range.from;
      if (adjacent === absolute) {
        // Automatic page boundaries contain no character to delete. Edit the
        // neighbouring page directly and keep its normal, local typing path.
        target.view.dispatch({
          selection: {
            anchor: key === "Backspace" ? target.view.state.doc.length : 0,
          },
        });
        const deleted = (
          key === "Backspace" ? deleteCharBackward : deleteCharForward
        )(target.view);
        if (deleted) target.view.focus();
        return deleted;
      }
      const from = key === "Backspace" ? absolute - 1 : absolute;
      const to = from + 1;
      this.activeKey = target.range.key;
      this.master.dispatch({
        changes: { from, to },
        selection: { anchor: from },
        scrollIntoView: true,
        userEvent: "delete",
        annotations: originPage.of(target.range.key),
      });
    } else {
      let offset = backward
        ? Math.min(target.range.to, absolute - 1)
        : Math.min(target.range.to, Math.max(target.range.from, absolute + 1));
      if (key === "ArrowUp" || key === "ArrowDown") {
        const column = head - entry.view.state.doc.lineAt(head).from;
        const line = backward
          ? target.view.state.doc.line(target.view.state.doc.lines)
          : target.view.state.doc.line(1);
        offset = target.range.from + Math.min(line.to, line.from + column);
      }
      target.view.dispatch({
        selection: { anchor: offset - target.range.from },
        scrollIntoView: true,
        userEvent: "select",
      });
      target.view.focus();
      return true;
    }
    this.focus();
    return true;
  }
  setFlowRanges(pages: SourcePage[]) {
    if (
      pages.length === this.ranges.length &&
      pages.every(
        (p, i) => p.from === this.ranges[i].from && p.to === this.ranges[i].to,
      )
    )
      return false;
    this.wantsScroll ||= this.entries.some((entry) => entry.view.hasFocus);
    const used = new Set<string>();
    const previous = this.ranges;
    const next = pages.map((p) => {
      const exact = previous.find(
        (old) => old.from === p.from && !used.has(old.key),
      );
      const key = exact?.key ?? pageKey();
      used.add(key);
      return { ...p, key };
    });
    this.master.dispatch({
      effects: pageRangesEffect.of(next),
      annotations: Transaction.addToHistory.of(false),
    });
    return true;
  }
  sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const text = this.master.state.doc.toString();
      const prefs = this.preferences();
      const typography = JSON.stringify([
        prefs.font,
        prefs.previewFont,
        prefs.size,
        prefs.margin,
      ]);
      // Keep mapped page boundaries while typing. The render pass computes a
      // single layout that fits source and preview; measuring source here too
      // would alternate two different layouts on every edit.
      if (!this.flowInitialized || typography !== this.flowTypography) {
        this.flowInitialized = true;
        this.flowTypography = typography;
        this.setFlowRanges(sourcePagination(text, prefs).pages);
      }
      const highlightsChanged = text !== this.highlightText;
      if (highlightsChanged) {
        this.highlightText = text;
        this.highlights = [];
        const contextual = text.replace(
          /\f+/g,
          (run) => "\n" + " ".repeat(run.length - 1),
        );
        highlightTree(
          markdownLanguage.parser.parse(contextual),
          markdownStyle,
          (from, to, classes) => this.highlights.push({ from, to, classes }),
        );
      }
      const old = new Map(this.entries.map((e) => [e.range.key, e]));
      const next = this.ranges.map((range, index) => {
        const entry = old.get(range.key) ?? this.create(range);
        old.delete(range.key);
        const rangeChanged =
          entry.range.from !== range.from || entry.range.to !== range.to;
        entry.range = range;
        if (entry.paper.dataset.pageIndex !== String(index)) {
          entry.paper.dataset.pageIndex = String(index);
          entry.paper.setAttribute("aria-label", `Source page ${index + 1}`);
          entry.paper.querySelector(".page-number")!.textContent = String(
            index + 1,
          );
        }
        const text = this.master.state.doc.sliceString(range.from, range.to);
        if (text !== entry.view.state.doc.toString()) {
          entry.highlightKey = undefined;
          entry.view.dispatch({
            changes: { from: 0, to: entry.view.state.doc.length, insert: text },
            annotations: pageSync.of(true),
          });
        }
        if (
          highlightsChanged ||
          rangeChanged ||
          entry.highlightKey === undefined
        ) {
          const marks = this.highlights
            .filter(
              (mark) =>
                range.to > range.from &&
                mark.to > range.from &&
                mark.from < range.to,
            )
            .map((mark) => ({
              from: Math.max(0, mark.from - range.from),
              to: Math.min(range.to, mark.to) - range.from,
              classes: mark.classes,
            }));
          const highlightKey = JSON.stringify(marks);
          if (highlightKey !== entry.highlightKey) {
            entry.highlightKey = highlightKey;
            entry.view.dispatch({
              effects: highlightEffect.of(
                Decoration.set(
                  marks.map((mark) =>
                    Decoration.mark({ class: mark.classes }).range(
                      mark.from,
                      mark.to,
                    ),
                  ),
                  true,
                ),
              ),
              annotations: pageSync.of(true),
            });
          }
        }
        const query = getSearchQuery(this.master.state);
        if (!getSearchQuery(entry.view.state).eq(query))
          entry.view.dispatch({
            effects: setSearchQuery.of(query),
            annotations: pageSync.of(true),
          });
        return entry;
      });
      for (const entry of old.values()) {
        entry.view.destroy();
        entry.paper.remove();
      }
      this.entries = next;
      // Reorder actual containers without detaching unchanged editors/focus.
      next.forEach((entry, index) => {
        const existing = this.host.children[index];
        if (existing !== entry.paper)
          this.host.insertBefore(entry.paper, existing ?? null);
      });
      const main = this.master.state.selection.main;
      const active = this.entries[this.activeIndex];
      if (active) {
        const limit = (pos: number) =>
          Math.max(
            0,
            Math.min(active.view.state.doc.length, pos - active.range.from),
          );
        const selection = EditorSelection.single(
          limit(main.anchor),
          limit(main.head),
        );
        if (!active.view.state.selection.eq(selection) || this.wantsScroll)
          active.view.dispatch({
            selection,
            scrollIntoView: this.wantsScroll,
            annotations: pageSync.of(true),
          });
        if (this.wantsFocus && !active.view.hasFocus) active.view.focus();
      }
      this.wantsScroll = this.wantsFocus = false;
    } finally {
      this.syncing = false;
    }
  }
  focus() {
    this.sync();
    const view = this.entries[this.activeIndex]?.view;
    if (view && !view.hasFocus) view.focus();
  }
  scrollTo(offset: number, pageStart = false) {
    this.sync();
    const entry = this.entries[sourcePageAt(this.ranges, offset)];
    entry?.paper.scrollIntoView({ block: pageStart ? "start" : "nearest" });
    if (entry)
      entry.view.dispatch({
        selection: {
          anchor: Math.max(
            0,
            Math.min(entry.view.state.doc.length, offset - entry.range.from),
          ),
        },
        scrollIntoView: true,
      });
  }
  private moveToDocumentEnd() {
    this.master.dispatch({
      selection: { anchor: this.master.state.doc.length },
      scrollIntoView: true,
    });
    this.focus();
    return true;
  }
  private moveToDocumentStart() {
    this.master.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
    this.focus();
    return true;
  }
  removePage(index: number, focus = true, backward = false) {
    const plan = planPageRemoval(
      this.ranges,
      this.master.state.doc.toString(),
      index,
    );
    if (backward) plan.index = Math.max(0, index - 1);
    const target = plan.ranges[plan.index];
    this.activeKey = target.key;
    this.master.dispatch({
      changes: { from: plan.from, to: plan.to },
      selection: { anchor: backward && index > 0 ? target.to : target.from },
      effects: pageRangesEffect.of(plan.ranges),
      annotations: [isolateHistory.of("full"), originPage.of(target.key)],
      scrollIntoView: focus,
    });
    if (focus) this.focus();
    else this.sync();
    return plan.index;
  }
  insertPage(index: number, focus = true) {
    const ranges = this.ranges;
    const page = ranges[index];
    const end = page.to;
    const insert =
      index === ranges.length - 1 ||
      this.master.state.doc.sliceString(end, end + 1) === "\f"
        ? "\f"
        : "\f\f";
    const next = ranges.map((p, i) =>
      i > index
        ? { ...p, from: p.from + insert.length, to: p.to + insert.length }
        : { ...p },
    );
    next.splice(index + 1, 0, {
      from: end + 1,
      to: end + 1,
      section: page.section + 1,
      key: pageKey(),
    });
    const text =
      this.master.state.doc.sliceString(0, end) +
      insert +
      this.master.state.doc.sliceString(end);
    this.master.dispatch({
      changes: { from: end, insert },
      selection: { anchor: end + 1 },
      effects: pageRangesEffect.of(splitSections(next, text)),
      annotations: isolateHistory.of("full"),
      scrollIntoView: focus,
    });
    if (focus) this.focus();
    else this.sync();
  }
}
