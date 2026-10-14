import { Decoration, WidgetType } from "@codemirror/view";
import type { Preferences } from "./model";
import { PAGE_WIDTH, PAGE_HEIGHT, stylePaper } from "./pages";
export const PAGE_GAP = 24,
  FOOTER_SPACE = 42;
export interface SourcePage {
  from: number;
  to: number;
  section: number;
}
class PageSpace extends WidgetType {
  constructor(readonly height: number) {
    super();
  }
  eq(other: PageSpace) {
    return Math.abs(this.height - other.height) < 0.1;
  }
  get estimatedHeight() {
    return this.height;
  }
  toDOM() {
    const element = document.createElement("div");
    element.className = "source-page-space";
    element.style.height = `${this.height}px`;
    element.setAttribute("aria-hidden", "true");
    return element;
  }
  ignoreEvent() {
    return true;
  }
}
// Measure browser-wrapped source rows at print-point dimensions, then insert
// non-editable page spaces. One CodeMirror document keeps undo and cross-page selection.
export function sourcePagination(text: string, prefs: Preferences) {
  const measure = document.createElement("div");
  measure.className = "source-measure";
  stylePaper(measure, prefs);
  measure.style.width = `${PAGE_WIDTH - 2 * prefs.margin}px`;
  document.body.append(measure);
  const pages: SourcePage[] = [{ from: 0, to: text.length, section: 0 }];
  const decorations: { from: number; to: number; height: number }[] = [];
  const usable = PAGE_HEIGHT - 2 * prefs.margin - FOOTER_SPACE;
  let offset = 0,
    used = 0;
  const nextPage = (from: number, to: number, section: number) => {
    pages[pages.length - 1].to = from;
    decorations.push({ from, to, height: PAGE_HEIGHT + PAGE_GAP - used });
    pages.push({ from: to, to: text.length, section });
    used = 0;
  };
  try {
    text.split("\f").forEach((section, index) => {
      if (index) nextPage(offset - 1, offset, index);
      const node = document.createTextNode(section + "\u200b");
      measure.replaceChildren(node);
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].sort((a, b) => a.top - b.top);
      const rows: DOMRect[] = [];
      for (const rect of rects)
        if (
          !rows.length ||
          Math.abs(rect.top - rows[rows.length - 1].top) > 0.5
        )
          rows.push(rect);
      const lineHeight = prefs.size * 1.2;
      let previous = 0;
      rows.forEach((row, rowIndex) => {
        let low = previous,
          high = section.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          range.setStart(node, middle);
          range.setEnd(node, middle + 1);
          if (range.getBoundingClientRect().top < row.top - 0.5)
            low = middle + 1;
          else high = middle;
        }
        previous = low;
        if (used + lineHeight > usable + 0.5 && used > 0)
          nextPage(offset + low, offset + low, index);
        used += lineHeight;
        // Empty and final rows remain real insertion positions.
        if (rowIndex === rows.length - 1) previous = section.length;
      });
      offset += section.length + 1;
    });
  } finally {
    measure.remove();
  }
  return {
    pages,
    decorations: Decoration.set(
      decorations.map(({ from, to, height }) =>
        from === to
          ? Decoration.widget({
              widget: new PageSpace(height),
              block: true,
              side: -1,
            }).range(from)
          : Decoration.replace({
              widget: new PageSpace(height),
              block: true,
            }).range(from, to),
      ),
      true,
    ),
  };
}
export function sourcePageAt(pages: SourcePage[], offset: number) {
  let index = pages.length - 1;
  while (index > 0 && pages[index].from > offset) index--;
  return index;
}
