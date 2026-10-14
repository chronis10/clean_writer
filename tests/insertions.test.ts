import { describe, it, expect } from "vitest";
import { insertCommands, markdownInsertion } from "../src/insertions";
describe("Insert menu", () => {
  it("has an implementation for every text command and selects valid placeholders", () => {
    const ids = insertCommands();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids.filter(
      (id) => !["image", "page-break"].includes(id),
    )) {
      const result = markdownInsertion("", 0, 0, id);
      expect(result.text.length, id).toBeGreaterThan(0);
      expect(result.anchor, id).toBeGreaterThanOrEqual(0);
      expect(result.head, id).toBeLessThanOrEqual(result.text.length);
    }
  });
  it("wraps selected text and keeps its editable range", () => {
    const result = markdownInsertion("Hello world", 6, 11, "bold");
    expect(result).toMatchObject({
      from: 6,
      to: 11,
      text: "**world**",
      anchor: 8,
      head: 13,
    });
  });
  it("formats complete selected lines without changing a following page", () => {
    const result = markdownInsertion(
      "first\nsecond\fnext page",
      0,
      12,
      "numbered",
    );
    expect(result.text).toBe("1. first\n2. second");
    expect(result.to).toBe(12);
    const empty = markdownInsertion("\nNext", 0, 0, "heading-2");
    expect(empty.from).toBe(0);
    expect(empty.text).toBe("## Heading");
    expect(markdownInsertion("", 0, 0, "nested-quote").text).toBe("> > Quote");
    expect(markdownInsertion("", 0, 0, "nested-bullet").text).toBe(
      "- List item\n  - Nested item",
    );
    expect(markdownInsertion("- [ ] Task", 0, 10, "checked-task").text).toBe(
      "- [x] Task",
    );
  });
  it("adds block spacing, callouts, and code fences that cannot be closed by selected code", () => {
    expect(markdownInsertion("beforeafter", 6, 6, "note").text).toBe(
      "\n\n> [!NOTE]\n> Your note\n\n",
    );
    expect(markdownInsertion("```", 0, 3, "code-block").text).toBe(
      "````\n```\n````",
    );
    expect(markdownInsertion("`value`", 0, 7, "inline-code").text).toBe(
      "`` `value` ``",
    );
  });
  it("selects the URL placeholder and supplies aligned table syntax", () => {
    const link = markdownInsertion("label", 0, 5, "link");
    expect(link.text.slice(link.anchor, link.head)).toBe("https://example.com");
    expect(markdownInsertion("", 0, 0, "table").text).toContain(
      "| :--- | :---: | ---: |",
    );
  });
});
