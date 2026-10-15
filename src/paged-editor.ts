import {
  Annotation,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import {
  defaultKeymap,
  isolateHistory,
  undo,
  redo,
} from "@codemirror/commands";
import { getSearchQuery, search, setSearchQuery } from "@codemirror/search";
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
      const text = tr.newDoc.toString();
      const origin = tr.annotation(originPage);
      let replacement = false;
      tr.changes.iterChanges((from, to) => {
        if (!origin && from === 0 && to === tr.startState.doc.length)
          replacement = true;
      });
      if (replacement) return initialRanges(text, prefs());
      const active =
        origin ??
        ranges[sourcePageAt(ranges, tr.startState.selection.main.head)].key;
      return splitSections(
        ranges.map((page) => ({
          ...page,
          from: tr.changes.mapPos(page.from, page.key === active ? -1 : 1),
          to: tr.changes.mapPos(page.to, page.key === active ? 1 : -1),
        })),
        text,
      );
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
}
export class PagedEditor {
  readonly master: EditorView;
  private entries: PageEditor[] = [];
  private syncing = false;
  private pending = false;
  private wantsScroll = false;
  private wantsFocus = false;
  constructor(
    private host: HTMLElement,
    masterHost: HTMLElement,
    state: EditorState,
    readonly rangesField: StateField<PageRange[]>,
    private extensions: () => Extension[],
  ) {
    this.master = new EditorView({
      parent: masterHost,
      state,
      dispatchTransactions: (transactions, view) => {
        this.wantsFocus ||= this.entries.some((e) => e.view.hasFocus);
        this.wantsScroll ||= transactions.some((tr) => tr.scrollIntoView);
        view.update(transactions);
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
    return sourcePageAt(this.ranges, this.master.state.selection.main.head);
  }
  reset(state: EditorState) {
    for (const entry of this.entries) entry.view.destroy();
    this.entries = [];
    this.host.replaceChildren();
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
          search(),
          keymap.of([
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
              if (current)
                this.master.dispatch({
                  selection: {
                    anchor:
                      current.from + entry.view.state.selection.main.anchor,
                    head: current.from + entry.view.state.selection.main.head,
                  },
                  annotations: originPage.of(current.key),
                });
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
  sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const old = new Map(this.entries.map((e) => [e.range.key, e]));
      const next = this.ranges.map((range, index) => {
        const entry = old.get(range.key) ?? this.create(range);
        old.delete(range.key);
        entry.range = range;
        entry.paper.dataset.pageIndex = String(index);
        entry.paper.setAttribute("aria-label", `Source page ${index + 1}`);
        entry.paper.querySelector(".page-number")!.textContent = String(
          index + 1,
        );
        const text = this.master.state.doc.sliceString(range.from, range.to);
        if (text !== entry.view.state.doc.toString())
          entry.view.dispatch({
            changes: { from: 0, to: entry.view.state.doc.length, insert: text },
            annotations: pageSync.of(true),
          });
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
        if (this.wantsScroll) active.paper.scrollIntoView({ block: "nearest" });
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
  removePage(index: number, focus = true) {
    const plan = planPageRemoval(
      this.ranges,
      this.master.state.doc.toString(),
      index,
    );
    this.master.dispatch({
      changes: { from: plan.from, to: plan.to },
      selection: { anchor: plan.ranges[plan.index].from },
      effects: pageRangesEffect.of(plan.ranges),
      annotations: isolateHistory.of("full"),
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
