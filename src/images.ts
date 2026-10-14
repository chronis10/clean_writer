import DOMPurify from "dompurify";
import type { Preferences } from "./model";
import { PAGE_WIDTH, PAGE_HEIGHT } from "./pages";
export interface LoadedImage {
  dataUrl: string;
  width: number;
  height: number;
}
export type ImageLoader = (source: string) => Promise<LoadedImage>;

// Resolve before inserting into the document: source URLs never become browser
// requests. Rust reads/downloads the image and returns a decoded PNG data URI.
export async function resolveImages(
  sections: string[],
  prefs: Preferences,
  load: ImageLoader,
): Promise<string[]> {
  const templates = sections.map((html) => {
    const template = document.createElement("template");
    template.innerHTML = DOMPurify.sanitize(html, { FORBID_ATTR: ["srcset"] });
    return template;
  });
  const images = templates.flatMap((t) =>
    Array.from(t.content.querySelectorAll<HTMLImageElement>("img")),
  );
  const maxWidth = PAGE_WIDTH - 2 * prefs.margin - 2;
  const maxHeight = PAGE_HEIGHT - 2 * prefs.margin - 2 * prefs.size * 1.2 - 60;
  const sources = images.map((img) => {
    const source =
      img.getAttribute("data-image-source") || img.getAttribute("src") || "";
    img.removeAttribute("src");
    img.removeAttribute("srcset");
    return source;
  });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, images.length) }, async () => {
      while (next < images.length) {
        const index = next++,
          img = images[index];
        try {
          const image = await load(sources[index]);
          if (
            !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl) ||
            !(image.width > 0 && image.height > 0)
          )
            throw new Error("Invalid image data.");
          const scale = Math.min(
            1,
            maxWidth / image.width,
            maxHeight / image.height,
          );
          img.width = Math.max(1, Math.floor(image.width * scale));
          img.height = Math.max(1, Math.floor(image.height * scale));
          img.src = image.dataUrl;
          img.className = "document-image";
          img.removeAttribute("data-image-source");
          const decoded = new Image();
          decoded.src = image.dataUrl;
          await decoded.decode();
        } catch (error) {
          const placeholder = document.createElement("span");
          placeholder.className = "image-error";
          placeholder.setAttribute("role", "img");
          placeholder.setAttribute(
            "aria-label",
            img.alt || "Unavailable image",
          );
          placeholder.textContent = `[Image unavailable: ${img.alt || sources[index] || "image"}]`;
          placeholder.title = String(error);
          img.replaceWith(placeholder);
        }
      }
    }),
  );
  return templates.map((t) => t.innerHTML);
}
