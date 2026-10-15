export interface Bookmark {
  id: string;
  offset: number;
  title: string;
}
export interface Document {
  path: string | null;
  text: string;
  cursor: number;
  bookmarks: Bookmark[];
  pageStarts?: number[];
  pageLayoutVersion?: number;
}
export interface Preferences {
  autosave: boolean;
  dark: boolean;
  preview: boolean;
  sidebar: boolean;
  font: string;
  previewFont: string;
  size: number;
  margin: number;
  zoom: number;
}
export interface Session {
  document: Document;
  recent: string[];
  preferences: Partial<Preferences>;
}
export interface Snapshot {
  session: Session;
  savedText: string | null;
  pendingOpen?: boolean;
}
export interface Rendered {
  flow?: string;
  sections: string[];
  words: number;
}
export const defaults: Preferences = {
  autosave: true,
  dark: false,
  preview: false,
  sidebar: true,
  font: "Serif",
  previewFont: "Serif",
  size: 15,
  margin: 64,
  zoom: 1,
};
export function preferences(value: Partial<Preferences>): Preferences {
  const number = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(max, Math.max(min, v))
      : fallback;
  return {
    autosave: value.autosave !== false,
    dark: value.dark === true,
    preview: value.preview === true,
    sidebar: value.sidebar !== false,
    font: ["Serif", "Sans", "Mono"].includes(value.font ?? "")
      ? value.font!
      : "Serif",
    previewFont: ["Serif", "Sans", "Mono"].includes(value.previewFont ?? "")
      ? value.previewFont!
      : ["Serif", "Sans", "Mono"].includes(value.font ?? "")
        ? value.font!
        : "Serif",
    size: number(value.size, 15, 11, 22),
    margin: [45, 64, 85].reduce(
      (nearest, candidate) =>
        Math.abs(candidate - number(value.margin, 64, 45, 85)) <
        Math.abs(nearest - number(value.margin, 64, 45, 85))
          ? candidate
          : nearest,
      64,
    ),
    zoom: number(value.zoom, 1, 0.5, 2),
  };
}
export function moveAnchors(
  oldText: string,
  text: string,
  bookmarks: Bookmark[],
): Bookmark[] {
  let start = 0,
    suffix = 0;
  while (
    start < Math.min(oldText.length, text.length) &&
    oldText[start] === text[start]
  )
    start++;
  while (
    suffix < Math.min(oldText.length, text.length) - start &&
    oldText[oldText.length - suffix - 1] === text[text.length - suffix - 1]
  )
    suffix++;
  const end = oldText.length - suffix,
    inserted = text.length - start - suffix;
  return bookmarks.map((mark) => ({
    ...mark,
    offset: Math.max(
      0,
      Math.min(
        text.length,
        mark.offset < start
          ? mark.offset
          : mark.offset >= end
            ? mark.offset + inserted - (end - start)
            : start + inserted,
      ),
    ),
  }));
}
export function fileName(path: string | null): string {
  return path?.split(/[\\/]/).pop() || "Untitled.md";
}
export function bookmarkTitle(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const end = text.indexOf("\n", offset);
  return (
    text
      .slice(start, end < 0 ? text.length : end)
      .trim()
      .slice(0, 48) || "Bookmark"
  );
}
