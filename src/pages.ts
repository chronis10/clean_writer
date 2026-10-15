import DOMPurify from "dompurify";
import type { Preferences } from "./model";
export const PAGE_WIDTH = 595.28,
  PAGE_HEIGHT = 841.89;
export const fonts: Record<string, string> = {
  Serif: '"New York", Georgia, "Noto Serif", "Liberation Serif", serif',
  Sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  Mono: '"SFMono-Regular", Menlo, Consolas, monospace',
};
export interface Page {
  element: HTMLElement;
  section: number;
  excerpt: string;
}
export function stylePaper(
  element: HTMLElement,
  prefs: Preferences,
  preview = true,
) {
  element.style.setProperty(
    "--document-font",
    fonts[preview ? prefs.previewFont : prefs.font],
  );
  element.style.setProperty("--document-size", `${prefs.size}px`);
  element.style.setProperty("--document-margin", `${prefs.margin}px`);
}
function sanitizedContent(html: string) {
  // Only resolved PNGs are allowed into either preview or print containers.
  const imageSource = document.createElement("template");
  imageSource.innerHTML = DOMPurify.sanitize(html);
  imageSource.content
    .querySelectorAll<HTMLImageElement>("img")
    .forEach((img) => {
      if (!/^data:image\/png;base64,/.test(img.getAttribute("src") || ""))
        img.replaceWith(
          document.createTextNode(img.alt || "[Image unavailable]"),
        );
    });
  imageSource.content
    .querySelectorAll<HTMLElement>("[align], td[style], th[style]")
    .forEach((cell) => {
      const align = (
        cell.getAttribute("align") || cell.style.textAlign
      ).toLowerCase();
      if (["left", "center", "right"].includes(align))
        cell.dataset.align = align;
    });
  const parsed = document.createElement("template");
  parsed.innerHTML = DOMPurify.sanitize(imageSource.innerHTML, {
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "srcset"],
  });
  return parsed.content;
}

// One real preview container for each source page. Formatted content stays
// in its own bounded scroller rather than being redistributed among pages.
export function previewContainers(
  sections: string[],
  prefs: Preferences,
  host: HTMLElement,
): Page[] {
  stylePaper(host, prefs);
  return sections.map((html, index) => {
    const paper = document.createElement("article");
    paper.className = "paper preview-paper preview-page";
    paper.dataset.sourcePageIndex = String(index);
    paper.setAttribute("aria-label", `Preview page ${index + 1}`);
    const body = document.createElement("div");
    body.className = "page-body markdown";
    body.tabIndex = 0;
    body.setAttribute("aria-label", `Preview content for page ${index + 1}`);
    body.append(sanitizedContent(html));
    const footer = document.createElement("div");
    footer.className = "page-number";
    footer.textContent = String(index + 1);
    paper.append(body, footer);
    host.append(paper);
    return {
      element: paper,
      section: index,
      excerpt:
        body.textContent?.trim().slice(0, 160) ||
        body.querySelector<HTMLImageElement>("img")?.alt ||
        "Blank page",
    };
  });
}
// Clone a formatted block at a text offset, preserving its nested inline structure.
function fragments(
  element: HTMLElement,
  offset: number,
): [HTMLElement, HTMLElement] {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode(),
    remaining = offset;
  while (node && remaining > (node.textContent?.length ?? 0)) {
    remaining -= node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  if (!node)
    return [
      element.cloneNode(true) as HTMLElement,
      element.cloneNode(false) as HTMLElement,
    ];
  const before = document.createRange();
  before.selectNodeContents(element);
  before.setEnd(node, remaining);
  const after = document.createRange();
  after.selectNodeContents(element);
  after.setStart(node, remaining);
  const left = element.cloneNode(false) as HTMLElement,
    right = element.cloneNode(false) as HTMLElement;
  left.append(before.cloneContents());
  right.append(after.cloneContents());
  if (element.tagName === "OL") {
    const completed = left.querySelectorAll(":scope > li").length;
    right.setAttribute(
      "start",
      String(
        Number(element.getAttribute("start") || 1) + Math.max(0, completed - 1),
      ),
    );
  }
  return [left, right];
}
export function paginate(
  sections: string[],
  prefs: Preferences,
  host: HTMLElement,
): Page[] {
  stylePaper(host, prefs);
  const pages: Page[] = [];
  const make = (section: number) => {
    const paper = document.createElement("article");
    paper.className = "paper preview-paper";
    const body = document.createElement("div");
    body.className = "page-body markdown";
    paper.append(body);
    const footer = document.createElement("div");
    footer.className = "page-number";
    footer.textContent = String(pages.length + 1);
    paper.append(footer);
    host.append(paper);
    pages.push({ element: paper, section, excerpt: "" });
    return body;
  };
  sections.forEach((html, section) => {
    let body = make(section);
    const parsed = document.createElement("div");
    parsed.append(sanitizedContent(html));
    const queue = Array.from(parsed.children) as HTMLElement[];
    for (let block = queue.shift(); block; block = queue.shift()) {
      body.append(block);
      if (body.scrollHeight <= body.clientHeight + 1) continue;
      body.removeChild(block);
      const length = block.textContent?.length ?? 0;
      let low = 0,
        high = length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const [left] = fragments(block, mid);
        body.append(left);
        const fits = body.scrollHeight <= body.clientHeight + 1;
        left.remove();
        if (fits) low = mid;
        else high = mid - 1;
      }
      // Prefer a nearby word boundary rather than slicing a word between pages.
      if (low > 0 && low < length) {
        const prefix = block.textContent!.slice(0, low),
          boundary = Math.max(
            prefix.lastIndexOf(" "),
            prefix.lastIndexOf("\n"),
          );
        if (boundary > low * 0.7) low = boundary + 1;
      }
      if (low > 0 && low < length) {
        const [left, right] = fragments(block, low);
        body.append(left);
        queue.unshift(right);
        body = make(section);
      } else if (body.childNodes.length) {
        queue.unshift(block);
        body = make(section);
      } else {
        body.append(block);
        body.classList.add("oversized");
      } // exceptionally tall non-text content
    }
  });
  for (const page of pages)
    page.excerpt =
      page.element
        .querySelector(".page-body")
        ?.textContent?.trim()
        .slice(0, 160) ||
      page.element.querySelector<HTMLImageElement>("img")?.alt ||
      "Blank page";
  return pages;
}
