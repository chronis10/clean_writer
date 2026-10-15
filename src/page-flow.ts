import type { Preferences } from "./model";
import { markdownBlocks } from "./markdown-blocks";
import { sanitizedContent, previewContainers } from "./pages";
import {
  sourceMeasurer,
  fitSourceEnd,
  wordBoundary,
  blockBoundary,
  type SourcePage,
} from "./source-pages";

function textSlice(element: HTMLElement, from: number, to: number) {
  const clone = element.cloneNode(true) as HTMLElement;
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text);
  let offset = 0;
  for (const node of nodes) {
    const length = node.length;
    node.textContent = node.data.slice(
      Math.max(0, from - offset),
      Math.max(0, to - offset),
    );
    offset += length;
  }
  const fragment = document.createDocumentFragment();
  fragment.append(...clone.childNodes);
  return fragment;
}

function cut(text: string, at: number) {
  at = Math.max(0, Math.min(text.length, at));
  return at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1])
    ? at - 1
    : at;
}

// Parse Markdown once before splitting. Cloning its semantic DOM retains code
// fences, links, emphasis, lists and tables on every continuation page.
function sectionDOM(html: string, text: string, base: number) {
  const root = document.createElement("div");
  root.append(sanitizedContent(html));
  const source = markdownBlocks(text).filter((block) =>
    text.slice(block.from, block.to).trim(),
  );
  for (const [index, element] of [...root.children].entries()) {
    const block = element as HTMLElement;
    if (!block.classList.contains("source-block")) {
      block.classList.add("source-block");
      block.dataset.sourceFrom ??= String(base + (source[index]?.from ?? 0));
      block.dataset.sourceTo = String(
        base + (source[index]?.to ?? text.length),
      );
    }
    for (const label of block.querySelectorAll<HTMLElement>(".callout-label")) {
      label.classList.add("source-atom");
      label.dataset.sourceFrom = block.dataset.sourceFrom;
      label.dataset.sourceTo = String(Number(block.dataset.sourceFrom) + 7);
    }
    // Raw HTML and browser fixtures have no parser text annotations. Give their
    // text a deterministic mapping too, without interpreting the HTML again.
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest(".source-text,.source-atom"))
        nodes.push(node as Text);
    }
    const length = nodes.reduce((sum, node) => sum + node.length, 0);
    const start = Number(block.dataset.sourceFrom),
      end = Number(block.dataset.sourceTo);
    let offset = 0;
    for (const node of nodes) {
      const span = document.createElement("span");
      span.className = "source-text";
      span.dataset.sourceFrom = String(
        start + Math.round(((end - start) * offset) / Math.max(1, length)),
      );
      offset += node.length;
      span.dataset.sourceTo = String(
        start + Math.round(((end - start) * offset) / Math.max(1, length)),
      );
      node.replaceWith(span);
      span.append(node);
    }
    let newline = start - base;
    for (const br of block.querySelectorAll<HTMLElement>(
      "br:not(.source-break)",
    )) {
      newline = text.indexOf("\n", newline);
      const position = newline < 0 ? start : base + newline;
      br.classList.add("source-break");
      br.dataset.sourceFrom = String(position);
      br.dataset.sourceTo = String(position + 1);
      if (newline >= 0) newline++;
    }
    for (const img of block.querySelectorAll("img:not(.source-atom img)")) {
      const span = document.createElement("span");
      span.className = "source-atom";
      span.dataset.sourceFrom = String(start);
      span.dataset.sourceTo = String(end);
      img.replaceWith(span);
      span.append(img);
    }
  }
  return root;
}
export function pageFragment(root: HTMLElement, from: number, to: number) {
  const result = document.createElement("div");
  for (const original of root.children as HTMLCollectionOf<HTMLElement>) {
    const start = Number(original.dataset.sourceFrom),
      end = Number(original.dataset.sourceTo);
    if (end <= from || start >= to) continue;
    const block = original.cloneNode(true) as HTMLElement;
    for (const element of block.querySelectorAll<HTMLElement>(
      ".source-atom,.source-break",
    )) {
      const position = Number(element.dataset.sourceFrom);
      if (position < from || position >= to) element.remove();
    }
    for (const element of block.querySelectorAll<HTMLElement>(".source-text")) {
      const first = Number(element.dataset.sourceFrom),
        last = Number(element.dataset.sourceTo);
      const text = element.textContent ?? "";
      const map = (position: number) =>
        cut(
          text,
          Math.round(
            ((position - first) / Math.max(1, last - first)) * text.length,
          ),
        );
      const a = map(from),
        b = map(to);
      if (a >= b) element.remove();
      else if (a !== 0 || b !== text.length)
        element.replaceChildren(textSlice(element, a, b));
    }
    // Discard ancestors whose text belongs entirely to a different page.
    for (const element of [
      ...block.querySelectorAll<HTMLElement>(
        "li,p,pre,blockquote,thead,tbody,tr,ul,ol,table",
      ),
    ].reverse()) {
      if (
        !element.textContent?.trim() &&
        !element.querySelector("img,input,hr,svg")
      )
        element.remove();
    }
    // Continue ordered-list numbers when preceding items have moved off-page.
    const oldLists = original.matches("ol")
      ? [original, ...original.querySelectorAll("ol")]
      : [...original.querySelectorAll("ol")];
    const lists = block.matches("ol")
      ? [block, ...block.querySelectorAll("ol")]
      : [...block.querySelectorAll("ol")];
    lists.forEach((list, i) => {
      const previous = oldLists[i];
      const skipped = previous
        ? [...previous.children].filter((item) => {
            const last = [
              ...item.querySelectorAll<HTMLElement>(".source-text"),
            ].at(-1);
            return last && Number(last.dataset.sourceTo) <= from;
          }).length
        : 0;
      if (skipped)
        list.setAttribute(
          "start",
          String(Number(previous.getAttribute("start") || 1) + skipped),
        );
    });
    if (!block.textContent?.trim() && !block.querySelector("img,input,hr,svg"))
      continue;
    block.dataset.sourceFrom = String(Math.max(start, from) - from);
    block.dataset.sourceTo = String(Math.min(end, to) - from);
    result.append(block);
  }
  return result.innerHTML;
}

export function flowingPages(
  text: string,
  sections: string[],
  prefs: Preferences,
  host: HTMLElement,
  continuous = false,
) {
  const continuousRoot = continuous ? sectionDOM(sections[0], text, 0) : null;
  const measure = sourceMeasurer(prefs);
  const paper = previewContainers([""], prefs, host)[0].element;
  const body = paper.querySelector<HTMLElement>(".page-body")!;
  const pages: SourcePage[] = [],
    html: string[] = [];
  let base = 0;
  try {
    text.split("\f").forEach((section, index) => {
      const end = base + section.length;
      const root =
        continuousRoot ?? sectionDOM(sections[index] ?? "", section, base);
      const blocks = markdownBlocks(section).map((b) => ({
        from: b.from + base,
        to: b.to + base,
      }));
      let from = base;
      do {
        let to = fitSourceEnd(text, from, end, measure.fits);
        to = blockBoundary(blocks, from, to);
        const fits = (candidate: number) => {
          body.innerHTML = pageFragment(root, from, candidate);
          return body.scrollHeight <= body.clientHeight + 0.5;
        };
        if (!fits(to)) {
          let low = from,
            high = to;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (fits(middle)) low = middle;
            else high = middle - 1;
          }
          to = wordBoundary(text, from, blockBoundary(blocks, from, low));
        }
        if (to > from && to < end && /[\uD800-\uDBFF]/.test(text[to - 1])) to--;
        if (to <= from && from < end)
          throw new Error(
            "A Markdown element could not fit within the page margins.",
          );
        pages.push({ from, to, section: index });
        html.push(pageFragment(root, from, to));
        from = to;
      } while (from < end);
      base = end + 1;
    });
  } finally {
    measure.remove();
    paper.remove();
  }
  return { pages, html };
}

// Keep explicit page breaks in exports while retaining Markdown context across
// them, such as a code fence continued after inserting a new blank page.
export function manualPreviewSections(text: string, html: string) {
  const root = sectionDOM(html, text, 0);
  let offset = 0;
  return text.split("\f").map((section) => {
    const from = offset;
    offset += section.length + 1;
    return pageFragment(root, from, offset - 1);
  });
}
