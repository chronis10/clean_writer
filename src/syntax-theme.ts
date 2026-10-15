import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// Colour only: Markdown stays literal and keeps the editor's font and metrics.
// CSS variables switch palettes immediately with the application appearance.
export const markdownHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading, color: "var(--syntax-heading)" },
    {
      tag: [tags.emphasis, tags.strong, tags.strikethrough],
      color: "var(--syntax-emphasis)",
    },
    { tag: [tags.link, tags.url], color: "var(--syntax-link)" },
    {
      tag: [tags.monospace, tags.labelName, tags.string],
      color: "var(--syntax-code)",
    },
    { tag: tags.quote, color: "var(--syntax-quote)" },
    {
      tag: [
        tags.processingInstruction,
        tags.list,
        tags.atom,
        tags.escape,
        tags.character,
      ],
      color: "var(--syntax-mark)",
    },
    { tag: tags.comment, color: "var(--syntax-comment)" },
  ]),
);
