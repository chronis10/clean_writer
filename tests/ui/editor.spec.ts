import { writeFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
async function setup(
  page: Page,
  text = "# A quiet place\n\nWrite something worth keeping.\n\n> [!NOTE]\n> Every word has room to breathe.",
) {
  await page.addInitScript(
    ({ text }) => {
      const w = window as any;
      w.isTauri = true;
      const snapshot = {
        session: {
          document: { path: null, text, cursor: 0, bookmarks: [] },
          recent: [],
          preferences: {},
        },
        savedText: null,
      };
      let id = 1;
      const callbacks = new Map();
      w.__TEST__ = {
        snapshot,
        checkpoints: [],
        savedPDF: null,
        failSave: false,
      };
      const canvas = document.createElement("canvas");
      canvas.width = 120;
      canvas.height = 80;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#1268c4";
      context.fillRect(0, 0, 120, 80);
      w.__TEST__.image = {
        dataUrl: canvas.toDataURL("image/png"),
        width: 120,
        height: 80,
      };
      w.__TEST__.imageSources = [];
      w.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" } },
        transformCallback: (fn: any) => {
          callbacks.set(id, fn);
          return id++;
        },
        unregisterCallback: (key: number) => callbacks.delete(key),
        invoke: async (command: string, args: any) => {
          if (command === "plugin:event|listen") return id++;
          if (command.startsWith("plugin:")) return null;
          if (command === "load_image") {
            w.__TEST__.imageSources.push(args.source);
            if (args.source.includes("missing")) throw "Image not found";
            return w.__TEST__.image;
          }
          if (command === "pick_image") return "![example](images/example.png)";
          if (command === "initial_state") return structuredClone(snapshot);
          if (command === "checkpoint") {
            if (w.__TEST__.failCheckpoint) throw "Recovery storage unavailable";
            Object.assign(snapshot.session.document, {
              text: args.text,
              cursor: args.cursor,
              bookmarks: args.bookmarks,
            });
            snapshot.session.preferences = args.preferences;
            w.__TEST__.checkpoints.push(structuredClone(args));
            return null;
          }
          if (command === "render_markdown") {
            const escaped = args.text
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;");
            return {
              sections:
                w.__TEST__.renderedHTML ||
                escaped.split("\f").map((s: string) =>
                  s
                    .split("\n\n")
                    .map(
                      (p: string) =>
                        `<p>${p.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img data-image-source="$2" alt="$1">').replace(/\n/g, "<br>")}</p>`,
                    )
                    .join(""),
                ),
              words: args.text.trim().split(/\s+/).length,
            };
          }
          if (command === "save_document") {
            if (w.__TEST__.failSave) throw "Simulated disk failure";
            snapshot.session.document.path = "/notes/example.md";
            snapshot.savedText = snapshot.session.document.text;
            return structuredClone(snapshot);
          }
          if (command === "new_document") {
            snapshot.session.document = {
              path: null,
              text: "",
              cursor: 0,
              bookmarks: [],
            };
            snapshot.savedText = null;
            return structuredClone(snapshot);
          }
          if (command === "export_pdf") {
            w.__TEST__.savedPDF = args.bytes;
            return true;
          }
          throw new Error(command);
        },
      };
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    },
    { text },
  );
  await page.goto("/");
  await expect(page.locator("#save-state")).not.toHaveText("Loading…");
}
test("editing, bookmarks, manual pages, and recovery", async ({ page }) => {
  await setup(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" New words.");
  await page.locator("#bookmark-add").click();
  await expect(page.locator(".bookmark-row")).toHaveCount(1);
  await page.locator("#add-page").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__TEST__.snapshot.session.document.text.includes("\f"),
      ),
    )
    .toBe(true);
  await expect(page.locator(".thumbnail")).toHaveCount(2);
  await page.locator("#preview").click();
  await expect(page.locator("#preview-host")).toBeVisible();
  await page.locator(".bookmark-row button").first().click();
  await expect(page.locator("#source-host")).toBeVisible();
});
test("cancel and discard document replacement", async ({ page }) => {
  await setup(page, "Unsaved text");
  await page.locator("#new").click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("Unsaved text");
  await page.locator("#new").click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("");
});
test("failed save retains recovery and retry succeeds", async ({ page }) => {
  await setup(page, "Do not lose this 📝");
  await page.evaluate(() => ((window as any).__TEST__.failSave = true));
  await page.locator("#save").click();
  await expect(page.locator("#error-dialog")).toBeVisible();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.locator("#notice")).toContainText(
    "recovery copy is retained",
  );
  expect(
    await page.evaluate(
      () => (window as any).__TEST__.snapshot.session.document.text,
    ),
  ).toBe("Do not lose this 📝");
  await page.evaluate(() => ((window as any).__TEST__.failSave = false));
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.locator("#save-state")).toHaveText("Saved");
});
test("dark mode, typography, zoom, and source search", async ({ page }) => {
  await setup(page);
  await page.locator("#theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#settings").click();
  await page.locator("#font").selectOption("Mono");
  await page.locator("#size").fill("18");
  await page.locator("#zoom-in").click();
  await expect(page.locator("#zoom-value")).toHaveText("110%");
  await page.locator("#zoom-value").click();
  await page.keyboard.press("Control+f");
  await expect(page.locator(".cm-search")).toBeVisible();
  await page
    .locator('.cm-search input[name="search"]')
    .pressSequentially("quiet");
  await expect(page.locator(".cm-searchMatch")).toHaveCount(1);
});
test("pagination retains long formatted content without overflow", async ({
  page,
}) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { paginate } = await import("/src/pages.ts" as string);
    const { defaults } = await import("/src/model.ts" as string);
    const host = document.createElement("div");
    host.className = "measurement-host";
    document.body.append(host);
    const text = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(" ");
    const pages = paginate(
      [
        `<blockquote class="callout note"><p><strong>${text}</strong></p></blockquote>`,
        "<h1>Second section</h1>",
      ],
      defaults,
      host,
    );
    const recovered = pages
      .slice(0, -1)
      .map((p: any) => p.element.querySelector(".page-body").textContent)
      .join("");
    const overflow = pages.some((p: any) => {
      const b = p.element.querySelector(".page-body");
      return b.scrollHeight > b.clientHeight + 1;
    });
    const output = {
      count: pages.length,
      same: recovered === text,
      overflow,
      lastSection: pages.at(-1).section,
    };
    host.remove();
    return output;
  });
  expect(result.count).toBeGreaterThan(2);
  expect(result.same).toBe(true);
  expect(result.overflow).toBe(false);
  expect(result.lastSection).toBe(1);
});
test("exports a PDF with Unicode and multiple A4 pages", async ({ page }) => {
  await setup(page, "Ελληνικά 📝\n\nA4 export\f第二頁");
  await page.evaluate(
    () =>
      ((window as any).__TEST__.renderedHTML = [
        '<h1>Ελληνικά 📝</h1><p>A4 export with <strong>bold</strong> and <em>italic</em> text.</p><blockquote class="callout note"><p>Unicode and formatting are preserved.</p></blockquote><table><tr><th>Feature</th><th>Status</th></tr><tr><td>PDF</td><td>Ready</td></tr></table>',
        "<h1>第二頁</h1><p>A new manual section.</p>",
      ]),
  );
  await page.locator("#more").click();
  await page.locator("#export").click();
  await expect(page.locator("#notice")).toHaveText("PDF exported.", {
    timeout: 30000,
  });
  expect(
    await page.evaluate(() =>
      String.fromCharCode(...(window as any).__TEST__.savedPDF.slice(0, 8)),
    ),
  ).toMatch(/^%PDF-/);
  const bytes = await page.evaluate(() => (window as any).__TEST__.savedPDF);
  expect(bytes.length).toBeLessThan(2_000_000);
  await writeFile("test-results/unicode.pdf", Buffer.from(bytes));
});
test("visual appearance", async ({ page }) => {
  await setup(page);
  await page.evaluate(
    () =>
      ((window as any).__TEST__.renderedHTML = [
        '<h1>A quiet place</h1><p>Write something worth keeping.</p><blockquote class="callout note"><p><strong class="callout-label">NOTE</strong><br>Every word has room to breathe.</p></blockquote><h2>Room for your thoughts</h2><p>A focused space for notes, ideas, and the next page.</p><ul><li>Keep your documents in Markdown.</li><li>Return to the places you bookmark.</li><li>Enjoy the writing.</li></ul>',
      ]),
  );
  await page.locator("#settings").click();
  await page.locator("#font").selectOption("Serif");
  await page.locator("#preview").click();
  await expect(page.locator(".preview-paper")).toHaveCount(1);
  await page.screenshot({ path: "test-results/light-preview.png" });
  await page.locator("#theme").click();
  await page.screenshot({ path: "test-results/dark-preview.png" });
});

test("recovery failure keeps edits in the window and reports the limitation", async ({
  page,
}) => {
  await setup(page, "A draft worth keeping");
  await page.evaluate(() => ((window as any).__TEST__.failCheckpoint = true));
  await page.locator("#save").click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Keep this window open");
  await expect(page.locator(".cm-content")).toContainText(
    "A draft worth keeping",
  );
  await page.evaluate(() => ((window as any).__TEST__.failCheckpoint = false));
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.locator("#save-state")).toHaveText("Saved");
});

test("local and remote images render and export, while missing images show a fallback", async ({
  page,
}) => {
  await setup(page, "Images");
  await page.evaluate(
    () =>
      ((window as any).__TEST__.renderedHTML = [
        '<p><img data-image-source="images/photo%20one.png" alt="Local photo"></p><p><img data-image-source="https://example.com/photo.jpg" alt="Remote photo"></p><p><img data-image-source="missing.png" alt="Missing photo"></p>',
      ]),
  );
  await page.locator("#preview").click();
  await expect(page.locator("#preview-host img")).toHaveCount(2);
  await expect(page.locator("#preview-host .image-error")).toContainText(
    "Missing photo",
  );
  expect(
    await page
      .locator("#preview-host img")
      .first()
      .evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as any).__TEST__.imageSources),
  ).toContain("images/photo%20one.png");
  await page.screenshot({ path: "test-results/image-preview.png" });
  await page.locator("#more").click();
  await page.locator("#export").click();
  await expect(page.locator("#notice")).toHaveText("PDF exported.");
  await writeFile(
    "test-results/images.pdf",
    Buffer.from(await page.evaluate(() => (window as any).__TEST__.savedPDF)),
  );
});
test("image picker inserts ordinary Markdown", async ({ page }) => {
  await setup(page, "A photo");
  await page.locator("#more").click();
  await page.locator("#insert-image").click();
  await expect(page.locator(".cm-content")).toContainText(
    "![example](images/example.png)",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toContain("![example](images/example.png)");
});
test("large images fit a page and remain intact when pagination moves them", async ({
  page,
}) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { resolveImages } = await import("/src/images.ts" as string);
    const { paginate } = await import("/src/pages.ts" as string);
    const { defaults } = await import("/src/model.ts" as string);
    const canvas = document.createElement("canvas");
    canvas.width = 60;
    canvas.height = 160;
    canvas.getContext("2d")!.fillRect(0, 0, 60, 160);
    const sections = await resolveImages(
      [
        "<p>" +
          "A full page of text. ".repeat(200) +
          '</p><p><img data-image-source="tall.png" alt="Tall photo"></p><p>After the image.</p>',
      ],
      defaults,
      async () => ({
        dataUrl: canvas.toDataURL("image/png"),
        width: 3000,
        height: 8000,
      }),
    );
    const host = document.createElement("div");
    host.className = "measurement-host";
    document.body.append(host);
    const pages = paginate(sections, defaults, host);
    const images = host.querySelectorAll("img");
    const img = images[0];
    const body = img.closest(".page-body") as HTMLElement;
    const result = {
      imageCount: images.length,
      height: img.height,
      fits: body.scrollHeight <= body.clientHeight + 1,
      text: host.textContent,
    };
    host.remove();
    return result;
  });
  expect(result.imageCount).toBe(1);
  expect(result.height).toBeLessThan(900);
  expect(result.fits).toBe(true);
  expect(result.text).toContain("After the image.");
});
