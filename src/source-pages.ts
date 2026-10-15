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
// Import an existing Markdown document into A4-sized page ranges. Once the
// independent editors are created, edits keep those boundaries stable.
export function sourcePagination(text: string, prefs: Preferences) {
  const measure = document.createElement("div");
  measure.className = "source-measure";
  stylePaper(measure, prefs, false);
  measure.style.width = `${PAGE_WIDTH - 2 * prefs.margin}px`;
  document.body.append(measure);
  const pages: SourcePage[] = [{ from: 0, to: text.length, section: 0 }];
  const usable = PAGE_HEIGHT - 2 * prefs.margin - FOOTER_SPACE;
  let offset = 0,
    used = 0;
  const sections = text.split("\f");
  const nextPage = (from: number, to: number, section: number) => {
    pages[pages.length - 1].to = from;
    pages.push({ from: to, to: text.length, section });
    used = 0;
  };
  try {
    sections.forEach((section, index) => {
      if (index) nextPage(offset - 1, offset, index);
      for (const block of markdownBlocks(section)) {
        const content = section.slice(block.from, block.to);
        const lines = content.split("\n");
        if (content.endsWith("\n")) lines.pop();
        let height = 0;
        for (const line of lines) {
          measure.textContent = line || "\u200b";
          height += measure.getBoundingClientRect().height;
        }
        if (used > 0 && used + height > usable + 0.5)
          nextPage(offset + block.from, offset + block.from, index);
        used += height;
      }
      offset += section.length + 1;
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
