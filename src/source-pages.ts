import { markdownBlocks } from "./markdown-blocks";
import type { Preferences } from "./model";
import { PAGE_WIDTH, PAGE_HEIGHT, stylePaper } from "./pages";
export const PAGE_GAP = 24,
  FOOTER_SPACE = 42;
export interface SourcePage {
  from: number;
  to: number;
  section: number;
}

// Measure the actual wrapped source, including the final empty CodeMirror line.
// Explicit form feeds are hard boundaries; automatic boundaries change as text
// or typography changes and never add characters to the Markdown document.
export function sourceMeasurer(prefs: Preferences) {
  const measure = document.createElement("div");
  measure.className = "source-measure";
  stylePaper(measure, prefs, false);
  measure.style.width = `${PAGE_WIDTH - 2 * prefs.margin}px`;
  document.body.append(measure);
  const usable = PAGE_HEIGHT - 2 * prefs.margin - FOOTER_SPACE;
  return {
    fits(text: string) {
      measure.textContent = text + "\u200b";
      return measure.getBoundingClientRect().height <= usable + 0.1;
    },
    remove() {
      measure.remove();
    },
  };
}
export function wordBoundary(text: string, from: number, end: number) {
  if (end >= text.length || end <= from) return end;
  const word = /[\p{L}\p{M}\p{N}'’]/u;
  if (!word.test(text[end - 1]) || !word.test(text[end])) return end;
  const prefix = text.slice(Math.max(from, end - 128), end);
  const space = Math.max(
    prefix.lastIndexOf(" "),
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("\t"),
  );
  return space >= 0 ? end - prefix.length + space + 1 : end;
}
export function fitSourceEnd(
  text: string,
  from: number,
  to: number,
  fits: (text: string) => boolean,
) {
  let low = from,
    high = Math.min(to, from + 256);
  while (high < to && fits(text.slice(from, high))) {
    low = high;
    high = Math.min(to, from + (high - from) * 2);
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(from, middle))) low = middle;
    else high = middle - 1;
  }
  // Never divide a UTF-16 surrogate pair between independent page editors.
  if (low < to && low > from && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
  return wordBoundary(text, from, low);
}
export function blockBoundary(
  blocks: { from: number; to: number }[],
  from: number,
  end: number,
) {
  const block = blocks.find((b) => end > b.from && end < b.to);
  return block && block.from > from ? block.from : end;
}
export function sourcePagination(text: string, prefs: Preferences) {
  const measure = sourceMeasurer(prefs);
  const pages: SourcePage[] = [];
  let offset = 0;
  try {
    text.split("\f").forEach((section, index) => {
      const end = offset + section.length;
      const blocks = markdownBlocks(section).map((b) => ({
        from: b.from + offset,
        to: b.to + offset,
      }));
      let from = offset;
      do {
        let to = fitSourceEnd(text, from, end, measure.fits);
        to = blockBoundary(blocks, from, to);
        if (to <= from && from < end)
          to = from + (text.codePointAt(from)! > 0xffff ? 2 : 1);
        pages.push({ from, to, section: index });
        from = to;
      } while (from < end);
      offset = end + 1;
    });
  } finally {
    measure.remove();
  }
  return { pages };
}
export function sourcePageAt(pages: SourcePage[], offset: number) {
  let index = pages.length - 1;
  while (index > 0 && pages[index].from > offset) index--;
  return index;
}
