import { describe, expect, it } from "vitest";
import { markdownBlocks, repairPageStarts } from "../src/markdown-blocks";

describe("complete Markdown page units", () => {
  for (const [name, block] of [
    [
      "fenced code",
      "```bash\npython main.py fit \\\n  --trainer.strategy auto\n```\n",
    ],
    ["tilde fence", "~~~~python\nprint('hello')\n~~~\n~~~~\n"],
    ["list", "- first\n  - nested\n\n- second\n"],
    ["table", "| A | B |\n| - | - |\n| x | y |\n"],
    ["blockquote", "> first\n> second\n"],
    ["HTML", '<p align="center">\n<img src="image.png">\n</p>\n'],
    [
      "paragraph",
      "Paragraph with **bold\ncontinued** and [a link](example).\n",
    ],
    ["indented code", "    command one\n    command two\n"],
  ]) {
    it(`keeps ${name} indivisible`, () => {
      const text = "Intro.\n\n" + block + "\nAfter.\n";
      const blocks = markdownBlocks(text);
      expect(blocks.map((b) => text.slice(b.from, b.to))).toContain(block);
      expect(blocks.map((b) => text.slice(b.from, b.to)).join("")).toBe(text);
      expect(
        repairPageStarts(text, [0, 8, 10, text.indexOf("After.")]),
      ).toEqual([0, 8, text.indexOf("After.")]);
    });
  }
  it("retains explicit manual boundaries and empty pages", () => {
    expect(repairPageStarts("First\f\fSecond", [0, 6, 7])).toEqual([0, 6, 7]);
  });
});
