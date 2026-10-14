import { writeFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
async function setup(
  page: Page,
  text = "# A quiet place\n\nWrite something worth keeping.\n\n> [!NOTE]\n> Every word has room to breathe.",
  path: string | null = null,
) {
  await page.addInitScript(
    ({ text, path }) => {
      const w = window as any;
      w.isTauri = true;
      const snapshot = {
        session: {
          document: { path, text, cursor: 0, bookmarks: [] },
          recent: [],
          preferences: {},
        },
        savedText: path ? text : null,
      };
      let id = 1;
      const callbacks = new Map();
      w.__TEST__ = {
        snapshot,
        checkpoints: [],
        savedPDF: null,
        failSave: false,
        pickImageCount: 0,
        cancelImage: false,
        cancelSave: false,
        spellingRequests: [],
        spellingSuggestions: { teh: ["the", "ten"] },
        destroyed: 0,
        saves: 0,
        discards: 0,
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
          if (command === "plugin:event|listen") {
            if (args.event === "file-action")
              w.__TEST__.menu = (action: string) =>
                callbacks.get(args.handler)({
                  event: "file-action",
                  id: 0,
                  payload: action,
                });
            if (args.event === "close-requested")
              w.__TEST__.requestClose = () => {
                void callbacks.get(args.handler)({
                  event: args.event,
                  id: 0,
                  payload: null,
                });
              };
            return id++;
          }
          if (command === "plugin:window|destroy") {
            w.__TEST__.destroyed++;
            return null;
          }
          if (command.startsWith("plugin:")) return null;
          if (command === "load_image") {
            w.__TEST__.imageSources.push(args.source);
            if (args.source.includes("missing")) throw "Image not found";
            return w.__TEST__.image;
          }
          if (command === "pick_image") {
            w.__TEST__.pickImageCount++;
            return w.__TEST__.cancelImage
              ? null
              : "![example](images/example.png)";
          }
          if (command === "update_recent_menu") return null;
          if (command === "spelling_misspellings") {
            return args.words.filter(
              (word: string) => w.__TEST__.spellingSuggestions[word]?.length,
            );
          }
          if (command === "spelling_suggestions") {
            w.__TEST__.spellingRequests.push(args.word);
            if (w.__TEST__.spellingDelay)
              await new Promise((resolve) =>
                setTimeout(resolve, w.__TEST__.spellingDelay),
              );
            return w.__TEST__.spellingSuggestions[args.word] || [];
          }
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
              words:
                w.__TEST__.renderedWords ??
                args.text.trim().split(/\s+/).length,
            };
          }
          if (command === "save_document") {
            w.__TEST__.saves++;
            if (w.__TEST__.cancelSave) return null;
            if (w.__TEST__.failSave) throw "Simulated disk failure";
            snapshot.session.document.path = "/notes/example.md";
            snapshot.savedText = snapshot.session.document.text;
            return structuredClone(snapshot);
          }
          if (command === "discard_changes") {
            if (w.__TEST__.failDiscard) throw "Could not update recovery";
            w.__TEST__.discards++;
            snapshot.session.document.text = snapshot.savedText ?? "";
            snapshot.session.document.cursor = 0;
            snapshot.session.document.bookmarks = [];
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
    { text, path },
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
  await expect(page.locator(".thumbnail-bookmark")).toHaveCount(1);
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
  await page.locator(".thumbnail-bookmark").click();
  await expect(page.locator("#preview")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator("#source-host")).toBeVisible();
});
test("cancel and discard document replacement", async ({ page }) => {
  await setup(page, "Unsaved text");
  await page.evaluate(() => (window as any).__TEST__.menu("new"));
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("Unsaved text");
  await expect(page.locator("#new")).toBeEnabled();
  await page.evaluate(() => (window as any).__TEST__.menu("new"));
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("");
});
test("failed save retains recovery and retry succeeds", async ({ page }) => {
  await setup(page, "Do not lose this 📝");
  await page.evaluate(() => ((window as any).__TEST__.failSave = true));
  await page.evaluate(() => (window as any).__TEST__.menu("save"));
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
  await expect(page.locator(".find-results")).toHaveText("1 of 1");
  await page.locator('.cm-search input[name="search"]').fill("Quiet");
  await page.getByRole("button", { name: "Match case", exact: true }).click();
  await expect(page.locator(".find-results")).toHaveText("No matches");
  await page.getByRole("button", { name: "Close find", exact: true }).click();
  await expect(page.locator(".cm-search")).toHaveCount(0);
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
  await page.evaluate(() => (window as any).__TEST__.menu("export"));
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
  await page.setViewportSize({ width: 1100, height: 1020 });
  await setup(
    page,
    "# A little room to write\n\nA focused space for **ideas**, notes, and the next small step.\n\n## Today's plan\n1. Capture the idea\n   - Keep it simple\n2. Shape the first draft\n\n> [!NOTE]\n> Good writing starts with a clear thought, not a perfect sentence.\n\n> [!TODO]\n> - [x] Make a little space\n> - [ ] Write the next paragraph\n\n## Keep track\n| Chapter | Status |\n| :--- | :--- |\n| Introduction | Drafting |\n| A new beginning | Next |",
    "/notes/Welcome.md",
  );
  await page.evaluate(() => ((window as any).__TEST__.renderedWords = 57));
  await page.evaluate(
    () =>
      ((window as any).__TEST__.renderedHTML = [
        `<h1>A little room to write</h1><p>A focused space for <strong>ideas</strong>, notes, and the next small step.</p><h2>Today's plan</h2><ol><li>Capture the idea<ul><li>Keep it simple</li></ul></li><li>Shape the first draft</li></ol><blockquote class="callout note"><p><strong class="callout-label">Note</strong><br>Good writing starts with a clear thought, not a perfect sentence.</p></blockquote><blockquote class="callout todo"><p><strong class="callout-label">To do</strong><br>☑ Make a little space<br>☐ Write the next paragraph</p></blockquote><h2>Keep track</h2><table><tr><th>Chapter</th><th>Status</th></tr><tr><td>Introduction</td><td>Drafting</td></tr><tr><td>A new beginning</td><td>Next</td></tr></table>`,
      ]),
  );
  await page.locator("#settings").click();
  await page.locator("#size").fill("13");
  await page.locator("#bookmark-add").click();
  await page.locator("#preview").click();
  await expect(page.locator(".preview-paper")).toHaveCount(1);
  await page.screenshot({ path: "test-results/light-preview.png" });
  await page.locator("#theme").click();
  await page.screenshot({ path: "test-results/dark-preview.png" });
  await page.locator("#theme").click();
  await page.locator("#preview").click();
  await page.screenshot({ path: "test-results/source-editor.png" });
});

test("recovery failure keeps edits in the window and reports the limitation", async ({
  page,
}) => {
  await setup(page, "A draft worth keeping");
  await page.evaluate(() => ((window as any).__TEST__.failCheckpoint = true));
  await page.evaluate(() => (window as any).__TEST__.menu("save"));
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
  await page.evaluate(() => (window as any).__TEST__.menu("export"));
  await expect(page.locator("#notice")).toHaveText("PDF exported.");
  await writeFile(
    "test-results/images.pdf",
    Buffer.from(await page.evaluate(() => (window as any).__TEST__.savedPDF)),
  );
});
test("image picker inserts ordinary Markdown", async ({ page }) => {
  await setup(page, "A photo");
  await page.evaluate(() => (window as any).__TEST__.menu("insert-image"));
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

test("matches native chrome and bookmark placement, and paginates the source", async ({
  page,
}) => {
  await setup(
    page,
    Array.from({ length: 90 }, (_, i) => `Line ${i + 1}: source content.`).join(
      "\n",
    ),
  );
  await expect(page.locator(".source-page-background")).toHaveCount(3);
  await expect(page.locator(".thumbnail")).toHaveCount(3);
  const geometry = await page.evaluate(() => ({
    sidebar: document.querySelector("#sidebar")!.getBoundingClientRect().width,
    toolbar: document.querySelector(".toolbar")!.getBoundingClientRect().height,
    footer: document.querySelector(".statusbar")!.getBoundingClientRect()
      .height,
    paper: document
      .querySelector(".source-page-background")!
      .getBoundingClientRect().width,
    color: getComputedStyle(document.documentElement)
      .getPropertyValue("--chrome")
      .trim(),
    scrollbars: getComputedStyle(document.querySelector("#canvas")!)
      .scrollbarWidth,
  }));
  expect(geometry).toMatchObject({
    sidebar: 192,
    toolbar: 48,
    footer: 40,
    color: "#f7f7f7",
    scrollbars: "none",
  });
  expect(geometry.paper).toBeCloseTo(595.28, 1);
  const overflow = await page.evaluate(() => {
    const top = document
      .querySelector("#source-paper")!
      .getBoundingClientRect().top;
    return [...document.querySelectorAll(".cm-line")].some((line) => {
      const r = line.getBoundingClientRect(),
        y = r.top - top;
      const pageY = y - Math.floor(y / 865.89) * 865.89;
      return pageY < 63 || pageY + r.height > 736.89;
    });
  });
  expect(overflow).toBe(false);
  await expect(
    page.locator(".brand,.bookmark-row,.source-caption"),
  ).toHaveCount(0);
  await expect(
    page.locator(".toolbar-actions").getByRole("button"),
  ).toHaveCount(5);
  await page.locator("#bookmark-add").click();
  await expect(page.locator(".thumbnail-bookmark")).toHaveCount(1);
  const marker = await page.locator(".thumbnail-bookmark").evaluate((el) => {
    const own = el.getBoundingClientRect(),
      paper = el.parentElement!.getBoundingClientRect();
    return { x: own.left - paper.left, y: own.top - paper.top };
  });
  expect(marker.x).toBeLessThan(10);
  expect(marker.y).toBeLessThan(10);
  await page.locator(".cm-content").click();
  await page.keyboard.press("ArrowDown");
  await page.locator("#bookmark-add").click();
  await expect(page.locator(".thumbnail-bookmark")).toHaveCount(0);
});
test("source page spaces keep long paragraphs and manual blank pages editable", async ({
  page,
}) => {
  const text = "Long paragraph words. ".repeat(500) + "\f\fFinal section";
  await setup(page, text);
  await expect
    .poll(() => page.locator(".source-page-background").count())
    .toBeGreaterThan(4);
  const source = await page.locator(".cm-content").textContent();
  expect(source).toContain("Final section");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Meta+End");
  // Wait for CodeMirror to materialize and reveal the distant final line.
  await expect(
    page.locator(".cm-line").filter({ hasText: "Final section" }),
  ).toBeInViewport();
  await page.keyboard.type(" added");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toBe(text + " added");
});

test("thumbnails refresh font, size, margins and page slices with typography", async ({
  page,
}) => {
  await setup(
    page,
    Array.from({ length: 90 }, (_, i) => `Line ${i + 1}: body text.`).join(
      "\n",
    ),
  );
  await expect(page.locator(".thumbnail")).toHaveCount(3);
  const previousText = await page.locator(".mini-text").first().textContent();
  await page.locator("#settings").click();
  await page.locator("#font").selectOption("Mono");
  await page.locator("#size").fill("22");
  await page.locator("#margin").selectOption("85");
  await expect(page.locator(".thumbnail")).toHaveCount(4);
  const typography = await page
    .locator(".mini-text")
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        size: parseFloat(style.fontSize),
        font: style.fontFamily,
        margin: parseFloat(style.paddingTop),
        text: el.textContent,
      };
    });
  expect(typography.size).toBeCloseTo((22 * 108) / 595.28, 2);
  expect(typography.font).toContain("Menlo");
  expect(typography.margin).toBeCloseTo((85 * 108) / 595.28, 2);
  expect(typography.text).not.toBe(previousText);
  await page.locator("#zoom-in").click();
  expect(
    await page
      .locator(".mini-text")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeCloseTo(typography.size, 2);
});

test("Insert menu commands insert editable Markdown and preserve undo", async ({
  page,
}) => {
  await setup(page, "", "/notes/example.md");
  await page.evaluate(() => (window as any).__TEST__.menu("insert-heading-2"));
  await expect(page.locator(".cm-content")).toContainText("## Heading");
  await page.keyboard.type("My heading");
  await expect(page.locator(".cm-content")).toContainText("## My heading");
  await page.evaluate(() => (window as any).__TEST__.menu("insert-bold"));
  await expect(page.locator(".cm-content")).toContainText("**bold text**");
  await page.evaluate(() => (window as any).__TEST__.menu("undo"));
  await expect(page.locator(".cm-content")).not.toContainText("**bold text**");
  await page.evaluate(() => (window as any).__TEST__.menu("insert-note"));
  await expect(page.locator(".cm-content")).toContainText("[!NOTE]");
  await page.evaluate(() => (window as any).__TEST__.menu("insert-table"));
  await expect(page.locator(".cm-content")).toContainText(
    "| :--- | :---: | ---: |",
  );
});
test("Insert Image saves an untitled document before the picker, and cancellation does not insert", async ({
  page,
}) => {
  await setup(page, "A draft");
  await page.evaluate(() => {
    (window as any).__TEST__.cancelSave = true;
    (window as any).__TEST__.menu("insert-image");
  });
  await expect(page.locator("#insert-image")).toBeEnabled();
  expect(
    await page.evaluate(() => (window as any).__TEST__.pickImageCount),
  ).toBe(0);
  await page.evaluate(() => {
    (window as any).__TEST__.cancelSave = false;
    (window as any).__TEST__.cancelImage = true;
    (window as any).__TEST__.menu("insert-image");
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__TEST__.pickImageCount))
    .toBe(1);
  await expect(page.locator(".cm-content")).toHaveText("A draft");
});

for (const zoom of [50, 100, 150]) {
  test(`clicking source text places the cursor at the clicked character at ${zoom}%`, async ({
    page,
  }) => {
    const lines = Array.from(
      { length: 90 },
      (_, i) => `Line ${i + 1}: source content for cursor placement.`,
    );
    const text = lines.join("\n");
    await setup(page, text);
    await expect(page.locator(".thumbnail")).toHaveCount(3);
    await page.locator("#zoom").fill(String(zoom));
    const line = page.locator(".cm-line").filter({ hasText: /^Line 45:/ });
    await line.scrollIntoViewIfNeeded();
    const point = await line.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode()!;
      const range = document.createRange();
      range.setStart(node, 12);
      range.setEnd(node, 13);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 0.5, y: (rect.top + rect.bottom) / 2 };
    });
    await page.mouse.click(point.x, point.y);
    await expect
      .poll(async () => {
        const caret = await page.locator(".cm-cursor-primary").boundingBox();
        return (
          !!caret &&
          Math.abs(caret.x - point.x) < 3 &&
          Math.abs(caret.y + caret.height / 2 - point.y) < 3
        );
      })
      .toBe(true);
    await page.keyboard.type("@");
    const offset = lines.slice(0, 44).join("\n").length + 1 + 12;
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__TEST__.snapshot.session.document.text,
        ),
      )
      .toBe(text.slice(0, offset) + "@" + text.slice(offset));
  });
}

test("sidebar page navigation reveals the selected page", async ({ page }) => {
  await setup(
    page,
    Array.from(
      { length: 150 },
      (_, i) => `Line ${i + 1}: source content.`,
    ).join("\n"),
  );
  await expect(page.locator(".thumbnail")).toHaveCount(5);
  await page.getByRole("button", { name: "Go to page 4", exact: true }).click();
  await expect(page.locator(".source-page-background").nth(3)).toBeInViewport();
  const top = await page
    .locator(".source-page-background")
    .nth(3)
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThan(0);
  expect(top).toBeLessThan(150);
});

test("clicking a paragraph continued across page breaks keeps its text position", async ({
  page,
}) => {
  const text = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(" ");
  await setup(page, text);
  await expect
    .poll(() => page.locator(".thumbnail").count())
    .toBeGreaterThan(3);
  await page.getByRole("button", { name: "Go to page 2", exact: true }).click();
  for (const word of ["word400", "word500", "word600"]) {
    const point = await page.locator(".cm-content").evaluate((el, word) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent!.indexOf(word + " ");
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index + 2);
        range.setEnd(node, index + 3);
        let rect = range.getBoundingClientRect();
        const canvas = document.querySelector("#canvas")!;
        canvas.scrollTop += rect.top - 300;
        rect = range.getBoundingClientRect();
        return { x: rect.left + 0.5, y: (rect.top + rect.bottom) / 2 };
      }
      throw new Error("Word not materialized: " + word);
    }, word);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.type("@");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__TEST__.snapshot.session.document.text,
        ),
      )
      .toContain(word.slice(0, 2) + "@" + word.slice(2));
  }
});

test("wheel scrolling reaches distant pages and Ctrl-wheel still zooms", async ({
  page,
}) => {
  await setup(
    page,
    Array.from(
      { length: 300 },
      (_, i) => `Line ${i + 1}: scroll content.`,
    ).join("\n"),
  );
  await expect
    .poll(() => page.locator(".thumbnail").count())
    .toBeGreaterThan(5);
  const canvas = page.locator("#canvas");
  const wheelSteps = await canvas.evaluate((el) => {
    const send = (deltaY: number, deltaMode: number) => {
      el.scrollTop = 0;
      const event = new WheelEvent("wheel", {
        deltaY,
        deltaMode,
        cancelable: true,
        bubbles: true,
      });
      el.dispatchEvent(event);
      return { distance: el.scrollTop, handled: event.defaultPrevented };
    };
    const pixels = send(120, WheelEvent.DOM_DELTA_PIXEL);
    const lines = send(3, WheelEvent.DOM_DELTA_LINE);
    el.scrollTop = 0;
    return { pixels, lines };
  });
  expect(wheelSteps.pixels).toEqual({ distance: 240, handled: true });
  expect(wheelSteps.lines).toEqual({ distance: 108, handled: true });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.wheel(0, 5);
  await expect.poll(() => canvas.evaluate((el) => el.scrollTop)).toBe(5);
  await page.mouse.wheel(0, -5);
  await expect.poll(() => canvas.evaluate((el) => el.scrollTop)).toBe(0);
  await page.mouse.wheel(0, 2400);
  await expect
    .poll(() => canvas.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(2000);
  await expect(page.locator("#zoom-value")).toHaveText("100%");
  await page.mouse.wheel(0, -2400);
  await expect
    .poll(() => canvas.evaluate((el) => el.scrollTop))
    .toBeLessThan(10);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect
    .poll(async () =>
      parseInt((await page.locator("#zoom-value").textContent())!),
    )
    .toBeGreaterThan(100);
  const zoomed = await page.locator("#zoom-value").textContent();
  await page.mouse.wheel(0, 1800);
  await expect
    .poll(() => canvas.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(1500);
  await expect(page.locator("#zoom-value")).toHaveText(zoomed!);
  await page.locator("#preview").click();
  await expect
    .poll(() => page.locator("#preview-host .preview-paper").count())
    .toBeGreaterThan(5);
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => canvas.evaluate((el) => el.scrollTop)).toBe(0);
  await page.mouse.wheel(0, 2400);
  await expect
    .poll(() => canvas.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(2000);
});

test("preview sidebar follows rendered pages and navigates within sections without entering edit mode", async ({
  page,
}) => {
  await setup(page, "First source section\fSecond source section");
  await expect(page.locator(".thumbnail")).toHaveCount(2);
  await page.evaluate(() => {
    (window as any).__TEST__.renderedHTML = [80, 70].map((count, section) =>
      Array.from(
        { length: count },
        (_, index) =>
          `<p>Section ${section + 1}, preview paragraph ${index + 1}.</p>`,
      ).join(""),
    );
  });
  await page.locator("#preview").click();
  const papers = page.locator("#preview-host .preview-paper");
  await expect.poll(() => papers.count()).toBeGreaterThan(4);
  const count = await papers.count();
  await expect(page.locator(".thumbnail")).toHaveCount(count);
  await expect(page.locator("#page-count")).toHaveText(`${count} pages`);
  for (const index of [2, count - 1, 1]) {
    await page
      .getByRole("button", { name: `Go to page ${index + 1}`, exact: true })
      .click();
    await expect(page.locator("#preview")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect
      .poll(() =>
        papers.nth(index).evaluate((el) => el.getBoundingClientRect().top),
      )
      .toBeLessThan(100);
    await expect(page.locator(".thumbnail").nth(index)).toHaveClass(/active/);
    await expect(page.locator(".mini-text").nth(index)).toContainText(
      "preview paragraph",
    );
  }
  await page.locator("#preview").click();
  await expect(page.locator(".thumbnail")).toHaveCount(2);
  await expect(page.locator("#page-count")).toHaveText("2 pages");
});

test("clicking a bookmarked preview page stays in preview; its bookmark opens the source", async ({
  page,
}) => {
  await setup(page, "Bookmarked source text");
  await page.locator("#bookmark-add").click();
  await expect(page.locator(".thumbnail-bookmark")).toHaveCount(1);
  await page.locator("#preview").click();
  await expect(page.locator("#preview-host .preview-paper")).toHaveCount(1);
  await page.getByRole("button", { name: "Go to page 1", exact: true }).click();
  await expect(page.locator("#preview")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator(".thumbnail-bookmark").click();
  await expect(page.locator("#preview")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("native spelling corrections update the document and support undo", async ({
  page,
}) => {
  const text = "Keep teh word and teh second instance.";
  await setup(page, text);
  const content = page.locator(".cm-content");
  await expect(content).toHaveAttribute("spellcheck", "false");
  await expect(content).toHaveAttribute("autocorrect", "off");
  await page.locator(".cm-line").click();
  // Native spelling menus replace the selected word through the browser's
  // editing engine. Exercise that path rather than dispatching a CM transaction.
  const replaced = await content.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode()!;
    const from = node.textContent!.indexOf("teh");
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, from + 3);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return document.execCommand("insertText", false, "the");
  });
  expect(replaced).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toBe("Keep the word and teh second instance.");
  await page.keyboard.press("Control+z");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toBe(text);
});

async function hoverWord(page: Page, word: string) {
  const point = await page.locator(".cm-content").evaluate((el, word) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent!.indexOf(word);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index + 1);
      range.setEnd(node, index + 2);
      const rect = range.getBoundingClientRect();
      return {
        x: (rect.left + rect.right) / 2,
        y: (rect.top + rect.bottom) / 2,
      };
    }
    throw new Error(`Missing word: ${word}`);
  }, word);
  await page.mouse.move(point.x, point.y);
  return point;
}

for (const zoom of [100, 150]) {
  test(`hover spelling suggestions apply only on click and undo at ${zoom}%`, async ({
    page,
  }) => {
    const text = "Keep teh word and teh second instance.";
    await setup(page, text);
    await page.locator("#zoom").fill(String(zoom));
    const point = await hoverWord(page, "teh");
    const popup = page.getByRole("group", {
      name: "Spelling suggestions for teh",
    });
    await expect(popup).toBeVisible();
    await expect(page.locator(".cm-content")).toHaveText(text);
    const rect = (await popup.boundingBox())!;
    expect(Math.abs(rect.x - point.x)).toBeLessThan(70);
    expect(Math.abs(rect.y - point.y)).toBeLessThan(80);
    await page.screenshot({
      path: test.info().outputPath("spelling-popup.png"),
    });
    await popup.getByRole("button", { name: "the", exact: true }).click();
    await expect(popup).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__TEST__.snapshot.session.document.text,
        ),
      )
      .toBe("Keep the word and teh second instance.");
    await page.keyboard.press("Control+z");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__TEST__.snapshot.session.document.text,
        ),
      )
      .toBe(text);
  });
}

test("correct words have no hover popup and preview dismisses suggestions", async ({
  page,
}) => {
  await setup(page, "Keep teh word.");
  await hoverWord(page, "Keep");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__TEST__.spellingRequests.includes("Keep"),
      ),
    )
    .toBe(true);
  await expect(page.locator(".spelling-suggestions")).toHaveCount(0);
  await hoverWord(page, "teh");
  await expect(page.locator(".spelling-suggestions")).toBeVisible();
  await page.locator("#preview").click();
  await expect(page.locator(".spelling-suggestions")).toHaveCount(0);
});

test("late spelling responses cannot correct text that has changed", async ({
  page,
}) => {
  await setup(page, "Keep teh word.");
  await page.evaluate(() => {
    (window as any).__TEST__.spellingDelay = 700;
  });
  await page.locator(".cm-line").click();
  await page.keyboard.press("Control+End");
  await hoverWord(page, "teh");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__TEST__.spellingRequests.includes("teh"),
      ),
    )
    .toBe(true);
  await page.keyboard.type(" Added.");
  // Wait for the delayed dictionary response to finish before checking dismissal.
  await page.waitForTimeout(800);
  await expect(page.locator(".spelling-suggestions")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveText("Keep teh word. Added.");
});

test("Greek hover corrections handle accents and replace only the hovered word", async ({
  page,
}) => {
  const text = "καλημε\u0301ρρα κόσμε.";
  await setup(page, text);
  await page.evaluate(() => {
    (window as any).__TEST__.spellingSuggestions["καλημέρρα"] = ["καλημέρα"];
  });
  await hoverWord(page, "καλημε\u0301ρρα");
  const popup = page.getByRole("group", {
    name: "Spelling suggestions for καλημε\u0301ρρα",
  });
  await expect(popup).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__TEST__.spellingRequests.includes("καλημέρρα"),
      ),
    )
    .toBe(true);
  await popup.getByRole("button", { name: "καλημέρα", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toBe("καλημέρα κόσμε.");
  await page.keyboard.press("Control+z");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toBe(text);
});

test("bundled spellcheck marks English and Greek and right-click applies a correction", async ({
  page,
}) => {
  await setup(page, "Keep teh word. καλημέρρα κόσμε.");
  await page.evaluate(() => {
    (window as any).__TEST__.spellingSuggestions["καλημέρρα"] = ["καλημέρα"];
  });
  await expect(page.locator(".spelling-error")).toHaveCount(2);
  await expect(page.locator(".spelling-error").first()).toHaveText("teh");
  await expect(page.locator(".spelling-error").nth(1)).toHaveText("καλημέρρα");
  await page.locator(".spelling-error").nth(1).click({ button: "right" });
  const popup = page.getByRole("group", {
    name: "Spelling suggestions for καλημέρρα",
  });
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "καλημέρα", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toBe("Keep teh word. καλημέρα κόσμε.");
  await expect(page.locator(".spelling-error")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".spelling-error")).toHaveCount(2);
});

for (const via of ["window", "quit"] as const) {
  test(`closing an unsaved draft via ${via} asks and Cancel keeps it open`, async ({
    page,
  }) => {
    await setup(page, "Unsaved draft");
    await page.evaluate((via) => {
      const test = (window as any).__TEST__;
      if (via === "window") test.requestClose();
      else test.menu("quit");
    }, via);
    await expect(page.locator("#confirm-dialog")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Discard", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator("#confirm-dialog")).not.toBeVisible();
    await expect(page.locator(".cm-content")).toHaveText("Unsaved draft");
    expect(await page.evaluate(() => (window as any).__TEST__.destroyed)).toBe(
      0,
    );
  });
}

test("closing a changed named file waits for confirmation without silently autosaving", async ({
  page,
}) => {
  await setup(page, "Saved text", "/notes/saved.md");
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" changed");
  // Reproduce normal use: pause after typing before clicking the close button.
  // The previous disk-autosave timer incorrectly cleared dirty state here.
  await page.waitForTimeout(1300);
  expect(await page.evaluate(() => (window as any).__TEST__.saves)).toBe(0);
  expect(
    await page.evaluate(() => (window as any).__TEST__.snapshot.savedText),
  ).toBe("Saved text");
  await page.evaluate(() => (window as any).__TEST__.requestClose());
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  // Wait beyond the normal autosave interval to verify the modal freezes saving.
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => (window as any).__TEST__.saves)).toBe(0);
  expect(
    await page.evaluate(() => (window as any).__TEST__.snapshot.savedText),
  ).toBe("Saved text");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText("Saved text changed");
  expect(await page.evaluate(() => (window as any).__TEST__.destroyed)).toBe(0);
});

test("Save on close saves the draft before destroying the window", async ({
  page,
}) => {
  await setup(page, "Draft to save");
  await page.evaluate(() => (window as any).__TEST__.requestClose());
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__TEST__.destroyed))
    .toBe(1);
  expect(
    await page.evaluate(() => (window as any).__TEST__.snapshot.savedText),
  ).toBe("Draft to save");
});

for (const failure of ["cancelSave", "failSave"] as const) {
  test(`${failure} during Save on close keeps unsaved text and the window open`, async ({
    page,
  }) => {
    await setup(page, "Do not lose this draft");
    await page.evaluate((failure) => {
      (window as any).__TEST__[failure] = true;
    }, failure);
    await page.evaluate(() => (window as any).__TEST__.requestClose());
    await expect(page.locator("#confirm-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#new")).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__TEST__.destroyed)).toBe(
      0,
    );
    expect(
      await page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    ).toBe("Do not lose this draft");
    await expect(page.locator(".cm-content")).toHaveText(
      "Do not lose this draft",
    );
  });
}

for (const path of [null, "/notes/saved.md"]) {
  test(`Discard on close clears discarded recovery for ${path ? "named files" : "drafts"}`, async ({
    page,
  }) => {
    await setup(page, path ? "Saved text" : "Unsaved draft", path);
    if (path) {
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" changed");
    }
    await page.evaluate(() => (window as any).__TEST__.requestClose());
    await expect(page.locator("#confirm-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__TEST__.destroyed))
      .toBe(1);
    expect(
      await page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    ).toBe(path ? "Saved text" : "");
    expect(await page.evaluate(() => (window as any).__TEST__.saves)).toBe(0);
  });
}

test("Escape on a reopened close prompt cancels even after an earlier Save choice", async ({
  page,
}) => {
  await setup(page, "Unsaved draft");
  await page.evaluate(() => {
    (window as any).__TEST__.cancelSave = true;
    (window as any).__TEST__.requestClose();
  });
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#new")).toBeEnabled();
  await page.evaluate(() => (window as any).__TEST__.requestClose());
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).__TEST__.saves)).toBe(1);
  expect(await page.evaluate(() => (window as any).__TEST__.destroyed)).toBe(0);
});

test("a clean saved document closes without asking", async ({ page }) => {
  await setup(page, "Saved text", "/notes/saved.md");
  await page.evaluate(() => (window as any).__TEST__.requestClose());
  await expect
    .poll(() => page.evaluate(() => (window as any).__TEST__.destroyed))
    .toBe(1);
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
});
