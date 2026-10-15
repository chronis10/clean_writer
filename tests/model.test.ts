import { describe, it, expect } from "vitest";
import { moveAnchors, preferences, fileName } from "../src/model";
describe("document anchors use UTF-16 like the Swift app", () => {
  it("moves Unicode bookmarks after inserted text", () => {
    expect(
      moveAnchors("📝 abc", "📝 new abc", [
        { id: "a", offset: 3, title: "abc" },
      ])[0].offset,
    ).toBe(7);
  });
  it("clamps anchors inside deleted ranges", () => {
    expect(
      moveAnchors("hello world", "held", [
        { id: "a", offset: 8, title: "world" },
      ])[0].offset,
    ).toBe(3);
  });
  it("retains anchors before edits and handles manual page breaks", () => {
    expect(
      moveAnchors("abc", "ab\fc", [
        { id: "a", offset: 1, title: "a" },
        { id: "b", offset: 3, title: "end" },
      ]).map((b) => b.offset),
    ).toEqual([1, 4]);
  });
});
it("validates persisted preferences", () => {
  expect(
    preferences({ zoom: 100, size: NaN, margin: -10, font: "Missing" }),
  ).toMatchObject({ zoom: 2, size: 15, margin: 45, font: "Serif" });
});
it("recognizes filenames on every platform", () => {
  expect(fileName("C:\\Notes\\draft.md")).toBe("draft.md");
  expect(fileName("/notes/δοκιμή.md")).toBe("δοκιμή.md");
});

it("enables autosave by default and retains an explicit disabled choice", () => {
  expect(preferences({}).autosave).toBe(true);
  expect(preferences({ autosave: false }).autosave).toBe(false);
});

it("migrates the shared font and persists independent preview typography", () => {
  expect(preferences({ font: "Mono" })).toMatchObject({
    font: "Mono",
    previewFont: "Mono",
  });
  const independent = preferences({ font: "Sans", previewFont: "Serif" });
  expect(preferences(JSON.parse(JSON.stringify(independent)))).toMatchObject({
    font: "Sans",
    previewFont: "Serif",
  });
  expect(preferences({ previewFont: "Missing" }).previewFont).toBe("Serif");
});
