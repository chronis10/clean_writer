import { StateEffect } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import {
  EditorView,
  ViewPlugin,
  Decoration,
  activateHover,
  closeHoverTooltips,
  hoverTooltip,
  tooltips,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

const refreshSpelling = StateEffect.define<null>();
export const resetSpelling = StateEffect.define<null>();
const wordPattern = () => /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
interface Word {
  word: string;
  normalized: string;
  from: number;
  to: number;
}
function wordsIn(text: string, offset: number): Word[] {
  return [...text.matchAll(wordPattern())]
    .filter((match) => match[0].length >= 2 && match[0].length <= 100)
    .map((match) => ({
      word: match[0],
      normalized: match[0].normalize("NFC"),
      from: offset + match.index!,
      to: offset + match.index! + match[0].length,
    }));
}
function wordAt(view: EditorView, pos: number, side = 0) {
  const line = view.state.doc.lineAt(pos);
  return wordsIn(line.text, line.from).find(
    ({ from, to }) =>
      pos >= from &&
      pos <= to &&
      !(pos === from && side < 0) &&
      !(pos === to && side > 0),
  );
}

export function spellingHover(
  suggest: (word: string) => Promise<string[]>,
  check: (words: string[]) => Promise<string[]>,
  enabled: () => boolean,
) {
  const cache = new Map<string, Promise<string[]>>();
  const correctness = new Map<string, boolean>();
  let revision = 0;
  const pointerDocuments = new WeakMap<
    EditorView,
    EditorView["state"]["doc"]
  >();
  const hover = hoverTooltip(
    async (view, pos, side) => {
      if (!enabled() || pointerDocuments.get(view) !== view.state.doc)
        return null;
      const doc = view.state.doc;
      const requestedRevision = revision;
      const found = wordAt(view, pos, side);
      if (!found) return null;
      const { word, normalized, from, to } = found;
      if (!cache.has(normalized)) {
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(
          normalized,
          suggest(normalized).catch(() => {
            cache.delete(normalized);
            return [];
          }),
        );
      }
      const suggestions = await cache.get(normalized)!;
      if (
        !enabled() ||
        view.state.doc !== doc ||
        requestedRevision !== revision ||
        !suggestions.length
      )
        return null;
      return {
        pos: from,
        end: to,
        above: false,
        create() {
          const dom = document.createElement("div");
          dom.className = "spelling-suggestions";
          dom.setAttribute("role", "group");
          dom.setAttribute("aria-label", `Spelling suggestions for ${word}`);
          dom.addEventListener("mousedown", (event) => event.preventDefault());
          for (const suggestion of [...new Set(suggestions)].slice(0, 5)) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = suggestion;
            button.onclick = () => {
              if (
                !enabled() ||
                view.state.doc !== doc ||
                view.state.sliceDoc(from, to) !== word
              )
                return;
              view.dispatch({
                changes: { from, to, insert: suggestion },
                selection: { anchor: from + suggestion.length },
                effects: closeHoverTooltips,
                annotations: [isolateHistory.of("full")],
                userEvent: "input.spelling",
              });
              view.focus();
            };
            dom.append(button);
          }
          return { dom };
        },
      };
    },
    { hoverTime: 450, hideOnChange: true },
  );

  const underline = Decoration.mark({ class: "spelling-error" });
  const checking = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      timer?: ReturnType<typeof setTimeout>;
      destroyed = false;
      constructor(readonly view: EditorView) {
        this.schedule();
      }
      visibleWords() {
        return this.view.visibleRanges.flatMap(({ from, to }) =>
          wordsIn(this.view.state.sliceDoc(from, to), from),
        );
      }
      rebuild() {
        this.decorations = enabled()
          ? Decoration.set(
              this.visibleWords()
                .filter(
                  ({ normalized }) => correctness.get(normalized) === false,
                )
                .map(({ from, to }) => underline.range(from, to)),
              true,
            )
          : Decoration.none;
      }
      schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.check(), 200);
      }
      async check() {
        if (!enabled() || this.destroyed) return;
        const requestedRevision = revision;
        const words = [
          ...new Set(this.visibleWords().map(({ normalized }) => normalized)),
        ]
          .filter((word) => !correctness.has(word))
          .slice(0, 512);
        if (!words.length) return;
        try {
          const incorrect = new Set(await check(words));
          if (this.destroyed || requestedRevision !== revision) return;
          if (correctness.size > 4096) correctness.clear();
          for (const word of words) correctness.set(word, !incorrect.has(word));
          this.view.dispatch({ effects: refreshSpelling.of(null) });
          this.schedule();
        } catch {
          /* Preserve typing and the native context menu if checking fails. */
        }
      }
      update(update: ViewUpdate) {
        if (
          update.transactions.some((tr) =>
            tr.effects.some((effect) => effect.is(resetSpelling)),
          )
        ) {
          revision++;
          cache.clear();
          correctness.clear();
          this.rebuild();
          this.schedule();
        }
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some((tr) => tr.reconfigured) ||
          update.transactions.some((tr) =>
            tr.effects.some((effect) => effect.is(refreshSpelling)),
          )
        )
          this.rebuild();
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some((tr) => tr.reconfigured)
        )
          this.schedule();
      }
      destroy() {
        this.destroyed = true;
        clearTimeout(this.timer);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  return [
    checking,
    EditorView.domEventObservers({
      mousemove(_event, view) {
        pointerDocuments.set(view, view.state.doc);
      },
    }),
    EditorView.domEventHandlers({
      contextmenu(event, view) {
        if (!enabled()) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const word = pos === null ? undefined : wordAt(view, pos);
        if (!word || correctness.get(word.normalized) !== false) return false;
        pointerDocuments.set(view, view.state.doc);
        activateHover(view, pos!, 1, {
          tooltip: hover,
          until: (tr) => tr.docChanged || !!tr.selection,
        });
        return true;
      },
      keydown(event, view) {
        if (event.key === "Escape")
          view.dispatch({ effects: closeHoverTooltips });
        return false;
      },
    }),
    tooltips({ parent: document.body }),
    hover,
  ];
}
