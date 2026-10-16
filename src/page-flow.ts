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
function sectionDOM(
  html: string,
  text: string,
  base: number,
  blocks?: ReturnType<typeof markdownBlocks>,
) {
  const root = document.createElement("div");
  root.append(sanitizedContent(html));
  let source: ReturnType<typeof markdownBlocks> | undefined;
  for (const [index, element] of [...root.children].entries()) {
    const block = element as HTMLElement;
    if (!block.classList.contains("source-block")) {
      source ??= (blocks ?? markdownBlocks(text)).filter((block) =>
        text.slice(block.from, block.to).trim(),
      );
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

export interface FlowLayout {
  text: string;
  typography: string;
  pages: SourcePage[];
  html: string[];
}

function layoutContent(html: string) {
  // Source coordinates move after an earlier edit, but do not affect geometry.
  return html.replace(/ data-source-(?:from|to)="[^"]*"/g, "");
}

function reusablePages(
  previous: FlowLayout | undefined,
  text: string,
  typography: string,
) {
  const pages = new Map<number, { to: number; html: string }>();
  if (!previous || previous.typography !== typography) return pages;
  const old = previous.text;
  let prefix = 0,
    suffix = 0;
  while (
    prefix < Math.min(old.length, text.length) &&
    old[prefix] === text[prefix]
  )
    prefix++;
  while (
    suffix < Math.min(old.length, text.length) - prefix &&
    old[old.length - suffix - 1] === text[text.length - suffix - 1]
  )
    suffix++;
  previous.pages.forEach((page, index) => {
    const shift =
      page.to < prefix || old === text
        ? 0
        : page.from >= old.length - suffix
          ? text.length - old.length
          : null;
    if (shift !== null)
      pages.set(page.from + shift, {
        to: page.to + shift,
        html: previous.html[index],
      });
  });
  return pages;
}

export async function flowingPages(
  text: string,
  sections: string[],
  prefs: Preferences,
  host: HTMLElement,
  continuous = false,
  pause: () => Promise<boolean> = async () => true,
  previous?: FlowLayout,
) {
  const typography = JSON.stringify([
    prefs.font,
    prefs.previewFont,
    prefs.size,
    prefs.margin,
  ]);
  const reusable = reusablePages(previous, text, typography);
  const continuousRoot = continuous ? sectionDOM(sections[0], text, 0) : null;
  const measure = sourceMeasurer(prefs);
  const paper = previewContainers([""], prefs, host)[0].element;
  // Measurement pages are not committed document pages while layout yields.
  paper.classList.remove("preview-page");
  const body = paper.querySelector<HTMLElement>(".page-body")!;
  const pages: SourcePage[] = [],
    html: string[] = [];
  let base = 0;
  try {
    if (!(await pause())) return null;
    for (const [index, section] of text.split("\f").entries()) {
      const end = base + section.length;
      const sourceBlocks = markdownBlocks(section);
      if (!(await pause())) return null;
      const root =
        continuousRoot ??
        sectionDOM(sections[index] ?? "", section, base, sourceBlocks);
      const blocks = sourceBlocks.map((b) => ({
        from: b.from + base,
        to: b.to + base,
      }));
      if (!(await pause())) return null;
      let from = base;
      do {
        const cached = reusable.get(from);
        if (
          cached &&
          (cached.to > from || from === end) &&
          cached.to <= end &&
          blockBoundary(blocks, from, cached.to) === cached.to &&
          wordBoundary(text, from, cached.to) === cached.to
        ) {
          const fragment = pageFragment(root, from, cached.to);
          if (layoutContent(fragment) === layoutContent(cached.html)) {
            pages.push({ from, to: cached.to, section: index });
            html.push(fragment);
            from = cached.to;
            if (!(await pause())) return null;
            continue;
          }
        }
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
        if (!(await pause())) return null;
      } while (from < end);
      base = end + 1;
    }
  } finally {
    measure.remove();
    paper.remove();
  }
  return { text, typography, pages, html };
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
