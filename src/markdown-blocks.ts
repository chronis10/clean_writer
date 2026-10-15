import { markdownLanguage } from "@codemirror/lang-markdown";

export interface MarkdownBlock {
  from: number;
  to: number;
}
// Top-level syntax nodes include complete lists, tables, paragraphs, HTML and
// fenced/indented code. Their internal lines are never automatic page breaks.
export function markdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let previous = 0;
  for (
    let node = markdownLanguage.parser.parse(text).topNode.firstChild;
    node;
    node = node.nextSibling
  ) {
    const from = Math.max(previous, text.lastIndexOf("\n", node.from - 1) + 1);
    let to = node.to;
    if (text[to] === "\n") to++;
    for (let pos = previous; pos < from;) {
      const end = Math.min(from, text.indexOf("\n", pos) + 1 || from);
      blocks.push({ from: pos, to: end });
      pos = end;
    }
    blocks.push({ from, to });
    previous = to;
  }
  if (previous < text.length) blocks.push({ from: previous, to: text.length });
  return blocks;
}

// Repair old automatic boundaries once, without changing source characters or
// removing explicit page breaks. New independent page layouts remain stable.
export function repairPageStarts(text: string, starts?: number[]) {
  if (!starts) return starts;
  const blocks: MarkdownBlock[] = [];
  let offset = 0;
  for (const section of text.split("\f")) {
    blocks.push(
      ...markdownBlocks(section).map((b) => ({
        from: b.from + offset,
        to: b.to + offset,
      })),
    );
    offset += section.length + 1;
  }
  return [
    ...new Set(
      starts.map((start) => {
        const block = blocks.find((b) => start > b.from && start < b.to);
        return block?.from ?? start;
      }),
    ),
  ];
}
