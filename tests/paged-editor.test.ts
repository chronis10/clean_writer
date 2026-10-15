import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { defaults } from "../src/model";
import { pageRangesField, pageRangesEffect } from "../src/paged-editor";

describe("independent page boundaries", () => {
  it("keeps the next page's text intact after replacing the entire first page", () => {
    const field = pageRangesField(
      () => defaults,
      () => [0, 6],
    );
    const state = EditorState.create({
      doc: "First\fSecond",
      extensions: [field],
    });
    const next = state.update({
      changes: { from: 0, to: 5, insert: "Much longer first page" },
    }).state;
    const pages = next.field(field);
    expect(pages).toHaveLength(2);
    expect(next.doc.sliceString(pages[1].from, pages[1].to)).toBe("Second");
    expect(pages[0].key).toBe(state.field(field)[0].key);
    expect(pages[1].key).toBe(state.field(field)[1].key);
  });
  it("restores independent automatic boundaries without adding characters to Markdown", () => {
    const field = pageRangesField(
      () => defaults,
      () => [0, 3],
    );
    const state = EditorState.create({ doc: "abcdef", extensions: [field] });
    expect(
      state.field(field).map((p) => state.doc.sliceString(p.from, p.to)),
    ).toEqual(["abc", "def"]);
    expect(state.doc.toString()).toBe("abcdef");
  });
  it("restores the exact page containers alongside undo changes", () => {
    const field = pageRangesField(
      () => defaults,
      () => [0, 6],
    );
    const before = EditorState.create({
      doc: "First\fSecond",
      extensions: [field],
    });
    const ranges = before.field(field);
    const edited = before.update({
      changes: { from: 0, to: 5, insert: "Replacement" },
    }).state;
    const restored = edited.update({
      changes: { from: 0, to: 11, insert: "First" },
      effects: pageRangesEffect.of(ranges),
    }).state;
    expect(restored.doc.toString()).toBe(before.doc.toString());
    expect(restored.field(field)).toEqual(ranges);
  });
});

import { planPageRemoval } from "../src/paged-editor";
describe("page removal", () => {
  for (const [text, starts, index, expected] of [
    ["First\fSecond\fThird", [0, 6, 13], 0, "Second\fThird"],
    ["First\fSecond\fThird", [0, 6, 13], 1, "First\fThird"],
    ["First\fSecond\fThird", [0, 6, 13], 2, "First\fSecond"],
    ["\fFirst", [0, 1], 0, "First"],
    ["First\f\fSecond", [0, 6, 7], 1, "First\fSecond"],
    ["First\f", [0, 6], 1, "First"],
    ["Only page", [0], 0, ""],
    ["", [0], 0, ""],
    ["AAAABBBBCCCC", [0, 4, 8], 1, "AAAACCCC"],
  ] as const) {
    it(`removes page ${index + 1} from ${JSON.stringify(text)} and preserves its neighbours`, () => {
      const field = pageRangesField(
        () => defaults,
        () => [...starts],
      );
      const state = EditorState.create({ doc: text, extensions: [field] });
      const before = state.field(field);
      const plan = planPageRemoval(before, text, index);
      const next = state.update({
        changes: { from: plan.from, to: plan.to },
        effects: pageRangesEffect.of(plan.ranges),
      }).state;
      expect(next.doc.toString()).toBe(expected);
      expect(next.field(field)).toHaveLength(Math.max(1, before.length - 1));
      if (before.length > 1)
        expect(next.field(field).map((p) => p.key)).toEqual(
          before.filter((_, i) => i !== index).map((p) => p.key),
        );
      const oldNeighbours = before
        .filter((_, i) => i !== index)
        .map((p) => state.doc.sliceString(p.from, p.to));
      if (before.length > 1)
        expect(
          next.field(field).map((p) => next.doc.sliceString(p.from, p.to)),
        ).toEqual(oldNeighbours);
    });
  }
});
