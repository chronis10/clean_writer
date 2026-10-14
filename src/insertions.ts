import catalog from "./insert-menu.json";
export interface InsertEntry {
  label: string;
  id?: string;
  items?: InsertEntry[];
}
export const insertMenu: InsertEntry[] = catalog;
export const insertCommands = (entries: InsertEntry[] = insertMenu): string[] =>
  entries.flatMap((entry) =>
    entry.id ? [entry.id] : insertCommands(entry.items || []),
  );
export interface Insertion {
  from: number;
  to: number;
  text: string;
  anchor: number;
  head: number;
}
export function markdownInsertion(
  source: string,
  from: number,
  to: number,
  command: string,
): Insertion {
  const selected = source.slice(from, to);
  const result = (
    text: string,
    start = text.length,
    end = start,
  ): Insertion => ({ from, to, text, anchor: from + start, head: from + end });
  const inline: Record<string, [string, string]> = {
    bold: ["**", "bold text"],
    italic: ["*", "italic text"],
    "bold-italic": ["***", "bold italic text"],
    strike: ["~~", "removed text"],
  };
  if (inline[command]) {
    const [marker, placeholder] = inline[command],
      content = selected || placeholder;
    return result(
      marker + content + marker,
      marker.length,
      marker.length + content.length,
    );
  }
  if (command === "inline-code") {
    const content = selected || "code",
      runs = content.match(/`+/g) || [];
    const marker = "`".repeat(
      Math.max(0, ...runs.map((run) => run.length)) + 1,
    );
    const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
    return result(
      marker + padding + content + padding + marker,
      marker.length + padding.length,
      marker.length + padding.length + content.length,
    );
  }
  if (command === "escape") {
    const text = (selected || "*literal text*").replace(
      /[\\`*_{}\[\]()#+.!|>~-]/g,
      "\\$&",
    );
    return result(text, 0, text.length);
  }
  if (command === "line-break") return result("  \n");
  if (command === "autolink" || command === "email-link") {
    const text =
      selected ||
      (command === "autolink" ? "https://example.com" : "name@example.com");
    return result(`<${text}>`, 1, 1 + text.length);
  }
  if (command === "link") {
    const label = (selected || "link text").replace(/[\\\[\]]/g, "\\$&"),
      url = "https://example.com";
    return result(
      `[${label}](${url})`,
      label.length + 3,
      label.length + 3 + url.length,
    );
  }
  const block = (text: string, focus?: string): Insertion => {
    const before = source.slice(0, from),
      after = source.slice(to);
    const prefix =
      !before || before.endsWith("\n\n")
        ? ""
        : before.endsWith("\n")
          ? "\n"
          : "\n\n";
    const suffix =
      !after || after.startsWith("\n\n")
        ? ""
        : after.startsWith("\n")
          ? "\n"
          : "\n\n";
    const start = focus ? Math.max(0, text.indexOf(focus)) : text.length;
    return result(
      prefix + text + suffix,
      prefix.length + start,
      prefix.length + start + (focus?.length || 0),
    );
  };
  const headings = /^heading-([1-6])$/.exec(command);
  const prefixes: Record<string, (index: number) => string> = {
    bullet: () => "- ",
    numbered: (index) => `${index + 1}. `,
    task: () => "- [ ] ",
    "checked-task": () => "- [x] ",
    "nested-bullet": () => "  - ",
    "nested-numbered": (index) => `   ${index + 1}. `,
    quote: () => "> ",
    "nested-quote": () => "> > ",
    "indented-code": () => "    ",
  };
  if (headings || prefixes[command] || command.startsWith("setext-")) {
    // Formatting applies to whole selected lines, without touching adjacent pages.
    from =
      from === 0
        ? 0
        : Math.max(
            source.lastIndexOf("\n", from - 1),
            source.lastIndexOf("\f", from - 1),
          ) + 1;
    const end = to > from && source[to - 1] === "\n" ? to - 1 : to;
    const breaks = [
      source.indexOf("\n", end),
      source.indexOf("\f", end),
    ].filter((value) => value >= 0);
    to = breaks.length ? Math.min(...breaks) : source.length;
    const content =
      source.slice(from, to) ||
      (headings || command.startsWith("setext")
        ? "Heading"
        : command.includes("code")
          ? "code"
          : command.includes("quote")
            ? "Quote"
            : command.includes("task")
              ? "Task"
              : "List item");
    if (
      (command === "nested-bullet" || command === "nested-numbered") &&
      !selected &&
      !source.slice(from, to)
    ) {
      const text =
        command === "nested-bullet"
          ? "- List item\n  - Nested item"
          : "1. List item\n   1. Nested item";
      return block(text, "Nested item");
    }
    let text: string;
    if (headings)
      text = content
        .split("\n")
        .map(
          (line) =>
            "#".repeat(Number(headings[1])) +
            " " +
            line.replace(/^#{1,6}\s+/, ""),
        )
        .join("\n");
    else if (command.startsWith("setext"))
      text = content + "\n" + (command === "setext-1" ? "===" : "---");
    else
      text = content
        .split("\n")
        .map((line, index) => {
          if (
            [
              "bullet",
              "numbered",
              "task",
              "checked-task",
              "nested-bullet",
              "nested-numbered",
            ].includes(command)
          ) {
            line = line.replace(
              /^(\s*)(?:[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/,
              "$1",
            );
          }
          return prefixes[command](index) + line;
        })
        .join("\n");
    const placeholder =
      selected || source.slice(from, to) ? undefined : content;
    if (command === "indented-code" || command.startsWith("setext"))
      return block(text, placeholder);
    const start = placeholder ? text.indexOf(placeholder) : text.length;
    return result(text, start, start + (placeholder?.length || 0));
  }
  if (command === "note" || command === "todo") {
    const content =
      selected || (command === "note" ? "Your note" : "- [ ] Task");
    return block(
      `> [!${command.toUpperCase()}]\n` +
        content
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      selected ? undefined : command === "note" ? "Your note" : "Task",
    );
  }
  if (command === "code-block") {
    const content = selected || "code",
      runs = content.match(/`+/g) || [];
    const marker = "`".repeat(
      Math.max(3, ...runs.map((run) => run.length + 1)),
    );
    return block(
      `${marker}\n${content}\n${marker}`,
      selected ? undefined : "code",
    );
  }
  if (command === "reference-link")
    return block(
      `[${selected || "link text"}][reference]\n\n[reference]: https://example.com`,
      "https://example.com",
    );
  if (command === "table")
    return block(
      "| Column 1 | Column 2 | Column 3 |\n| :--- | :---: | ---: |\n| Cell | Cell | Cell |",
      "Cell",
    );
  if (command === "rule") return block("---");
  throw new Error(`Unknown insertion command: ${command}`);
}
