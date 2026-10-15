import { writeFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
function paragraphLines(lines: string[]) {
  return lines
    .map(
      (line, i) =>
        line + ((i + 1) % 10 === 0 && i < lines.length - 1 ? "\n" : ""),
    )
    .join("\n");
}
async function setup(
  page: Page,
  text = "# A quiet place\n\nWrite something worth keeping.\n\n> [!NOTE]\n> Every word has room to breathe.",
  path: string | null = null,
  autosave = false,
  pageStarts?: number[],
) {
  await page.addInitScript(
    ({ text, path, autosave, pageStarts }) => {
      const w = window as any;
      w.isTauri = true;
      const snapshot = {
        session: {
          document: { path, text, cursor: 0, bookmarks: [], pageStarts },
          recent: [],
          preferences: { autosave },
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
        dictionaryInstalls: [],
        dictionaries: [
          {
            code: "en_US",
            name: "English (US)",
            installed: true,
            bundled: true,
          },
          { code: "el_GR", name: "Greek", installed: true, bundled: true },
          { code: "fr_FR", name: "French", installed: false, bundled: false },
          { code: "de_DE", name: "German", installed: false, bundled: false },
        ],
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
          if (command === "spelling_dictionaries") {
            if (w.__TEST__.failDictionaryList)
              throw "Dictionary list unavailable";
            return structuredClone(w.__TEST__.dictionaries);
          }
          if (command === "install_spelling_dictionary") {
            w.__TEST__.dictionaryInstalls.push(args.code);
            if (w.__TEST__.dictionaryDelay)
              await new Promise((resolve) =>
                setTimeout(resolve, w.__TEST__.dictionaryDelay),
              );
            if (w.__TEST__.failDictionaryInstall) throw "Network unavailable";
            w.__TEST__.dictionaries.find(
              (language: any) => language.code === args.code,
            ).installed = true;
            if (args.code === "fr_FR") {
              delete w.__TEST__.spellingSuggestions.bonjour;
              w.__TEST__.spellingSuggestions.bonjor = ["bonjour"];
            }
            return structuredClone(w.__TEST__.dictionaries);
          }
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
              pageStarts: args.pageStarts,
              pageLayoutVersion: args.pageLayoutVersion,
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
            const result = structuredClone(snapshot);
            if (w.__TEST__.saveDelay)
              await new Promise((resolve) =>
                setTimeout(resolve, w.__TEST__.saveDelay),
              );
            return result;
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
    { text, path, autosave, pageStarts },
  );
  await page.goto("/");
  await expect(page.locator("#save-state")).not.toHaveText("Loading…");
}
test("autosave writes named files, can be disabled in Settings, and persists the choice", async ({
  page,
}) => {
  await setup(page, "Baseline", "/notes/example.md", true);
  await page.locator("#settings").click();
  const toggle = page.getByRole("switch", { name: "Autosave", exact: true });
  await expect(toggle).toBeChecked();
  await page.locator("#settings").click();
  await page.locator(".source-page .cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" saved automatically");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__TEST__.snapshot.savedText),
    )
    .toBe("Baseline saved automatically");
  await expect(page.locator("#dirty-dot")).toBeHidden();
  await page.locator("#settings").click();
  await toggle.uncheck();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.preferences.autosave,
      ),
    )
    .toBe(false);
  await page.locator("#settings").click();
  await page.locator(".source-page .cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" manual");
  await page.waitForTimeout(1300);
  expect(
    await page.evaluate(() => (window as any).__TEST__.snapshot.savedText),
  ).toBe("Baseline saved automatically");
  await page.locator("#settings").click();
  await toggle.check();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__TEST__.snapshot.savedText),
    )
    .toBe("Baseline saved automatically manual");
});

test("typing during autosave preserves new edits and saves them afterward", async ({
  page,
}) => {
  await setup(page, "Baseline", "/notes/example.md", true);
  await page.evaluate(() => ((window as any).__TEST__.saveDelay = 800));
  await page.locator(".source-page .cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" first");
  await expect
    .poll(() => page.evaluate(() => (window as any).__TEST__.saves))
    .toBe(1);
  await page.keyboard.type(" second");
  await expect(page.locator(".source-page .cm-content")).toHaveText(
    "Baseline first second",
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__TEST__.snapshot.savedText),
    )
    .toBe("Baseline first second");
  await expect(page.locator("#dirty-dot")).toBeHidden();
});

test("autosave failures retain edits and recovery without blocking typing", async ({
  page,
}) => {
  await setup(page, "Baseline", "/notes/example.md", true);
  await page.evaluate(() => ((window as any).__TEST__.failSave = true));
  await page.locator(".source-page .cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" retained");
  await expect(page.locator("#notice")).toContainText("Autosave failed");
  expect(
    await page.evaluate(() => (window as any).__TEST__.snapshot.savedText),
  ).toBe("Baseline");
  await page.keyboard.type(" still editable");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toBe("Baseline retained still editable");
});

test("autosave retains untitled drafts without opening a save dialog", async ({
  page,
}) => {
  await setup(page, "Draft", null, true);
  await page.locator(".source-page .cm-content").click();
  await page.keyboard.type("Edit ");
  await page.waitForTimeout(1300);
  expect(await page.evaluate(() => (window as any).__TEST__.saves)).toBe(0);
  await expect(page.locator("#confirm-dialog")).not.toBeVisible();
});

async function expectSourcePageBounds(page: Page) {
  await expect
    .poll(() =>
      page.locator("#source-host").evaluate((host) => {
        return [...host.querySelectorAll<HTMLElement>(".source-page")].flatMap(
          (paper) => {
            const box = paper.getBoundingClientRect(),
              scale = box.width / 595.28;
            const body = paper.querySelector<HTMLElement>(".source-page-body")!;
            const scroller = paper.querySelector<HTMLElement>(".cm-scroller")!;
            const rect = scroller.getBoundingClientRect();
            const margin = parseFloat(getComputedStyle(paper).paddingTop);
            const bad =
              rect.left < box.left + margin * scale - 1 ||
              rect.right > box.right - margin * scale + 1 ||
              rect.top < box.top + margin * scale - 1 ||
              rect.bottom > box.bottom - (margin + 42) * scale + 1;
            return bad ||
              getComputedStyle(paper).overflow !== "hidden" ||
              getComputedStyle(scroller).overflowY !== "clip" ||
              (!scroller.querySelector(".cm-gap") &&
                scroller.scrollHeight > scroller.clientHeight + 1) ||
              body.querySelectorAll(".cm-editor").length !== 1
              ? [
                  JSON.stringify({
                    index: paper.dataset.pageIndex,
                    scroll: scroller.scrollHeight,
                    client: scroller.clientHeight,
                    content: body
                      .querySelector(".cm-content")
                      ?.getBoundingClientRect().height,
                    lines: (body.querySelector(".cm-content") as any)?.cmTile
                      .root.view.state.doc.lines,
                    text: (
                      body.querySelector(".cm-content") as any
                    )?.cmTile.root.view.state.doc
                      .toString()
                      .slice(-50),
                  }),
                ]
              : [];
          },
        );
      }),
    )
    .toEqual([]);
}

async function expectPreviewPageBounds(page: Page) {
  await expect
    .poll(() =>
      page.locator(".preview-page").evaluateAll((papers) =>
        papers.flatMap((paper) => {
          const box = paper.getBoundingClientRect(),
            scale = box.width / 595.28;
          const body = paper.querySelector(".page-body")!;
          const rect = body.getBoundingClientRect();
          const margin = parseFloat(getComputedStyle(paper).paddingTop);
          return rect.top < box.top + margin * scale - 1 ||
            rect.bottom > box.bottom - (margin + 42) * scale + 1 ||
            rect.left < box.left + margin * scale - 1 ||
            rect.right > box.right - margin * scale + 1 ||
            Math.abs(box.height / scale - 841.89) > 1 ||
            getComputedStyle(paper).overflow !== "hidden" ||
            getComputedStyle(body).overflowY !== "clip" ||
            body.scrollHeight > body.clientHeight + 1
            ? [papers.indexOf(paper)]
            : [];
        }),
      ),
    )
    .toEqual([]);
}

for (const preview of [false, true]) {
  test(`repeated insertion preserves independent containers after the current page changes in ${preview ? "preview" : "editor"}`, async ({
    page,
  }) => {
    await setup(page, "First page\fSecond page\fThird page");
    if (preview) await page.locator("#preview").click();
    await page
      .getByRole("button", { name: "Go to page 2", exact: true })
      .click();
    await page
      .locator(preview ? ".preview-page" : ".source-page")
      .nth(2)
      .locator(preview ? ".page-body" : ".cm-content")
      .click({ position: { x: 30, y: 20 } });
    await expect(page.locator(".thumbnail").nth(2)).toHaveAttribute(
      "aria-current",
      "page",
    );
    for (let count = 4; count <= 5; count++) {
      await page.locator("#add-page").click();
      await expect(page.locator(".thumbnail")).toHaveCount(count);
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as any).__TEST__.snapshot.session.document.text,
          ),
        )
        .toBe("First page\fSecond page\fThird page" + "\f".repeat(count - 3));
      if (preview) {
        await expect(page.locator(".preview-page")).toHaveCount(count);
        await expectPreviewPageBounds(page);
      } else await expectSourcePageBounds(page);
    }
    if (preview) await page.locator("#preview").click();
    await page.locator(".source-page .cm-content").last().click();
    const inserted = "Long inserted content.\n".repeat(150);
    await page.keyboard.insertText(inserted);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__TEST__.snapshot.session.document.text,
        ),
      )
      .toBe("First page\fSecond page\fThird page\f\f" + inserted);
    await expect
      .poll(() => page.locator(".source-page").count())
      .toBeGreaterThan(5);
    await expectSourcePageBounds(page);
    await expect(
      page.locator(".source-page").nth(2).locator(".cm-content"),
    ).toHaveText("Third page");
    const count = await page.locator(".source-page").count();
    await page.locator("#preview").click();
    await expect(page.locator(".preview-page")).toHaveCount(count);
    await expectPreviewPageBounds(page);
    await expect(
      page.locator(".preview-page").nth(2).locator(".page-body"),
    ).toHaveText("Third page");
  });
}

test("editing, bookmarks, manual pages, and recovery", async ({ page }) => {
  await setup(page);
  await page.locator("#source-host .cm-content").first().click();
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
  await expect(page.locator("#source-host .cm-content").first()).toContainText(
    "Unsaved text",
  );
  await expect(page.locator("#new")).toBeEnabled();
  await page.evaluate(() => (window as any).__TEST__.menu("new"));
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.locator("#source-host .cm-content").first()).toHaveText("");
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
test("Settings installs dictionaries and refreshes spelling without editing the document", async ({
  page,
}) => {
  await setup(page, "bonjour bonjor\fbonjour second page");
  await page.evaluate(() =>
    Object.assign((window as any).__TEST__.spellingSuggestions, {
      bonjour: ["bonjours"],
      bonjor: ["old"],
    }),
  );
  // Trigger a recheck to populate the spelling cache in both independent pages.
  await page.locator("#theme").click();
  await expect(
    page.locator(".source-page").first().locator(".spelling-error"),
  ).toHaveCount(2);
  await page.locator("#settings").click();
  await expect(page.locator("#dictionary-installed")).toContainText(
    "English (US), Greek",
  );
  await expect(
    page.locator('#dictionary-language option[value="en_US"]'),
  ).toHaveJSProperty("disabled", true);
  await page.locator("#dictionary-language").selectOption("fr_FR");
  await page.evaluate(() => ((window as any).__TEST__.dictionaryDelay = 500));
  await page.locator("#dictionary-install").click();
  await expect(page.locator("#dictionary-install")).toHaveText("Installing…");
  await expect(page.locator("#dictionary-language")).toBeDisabled();
  await expect(page.locator("#dictionary-status")).toContainText(
    "French installed",
  );
  await expect(page.locator("#dictionary-install")).toBeDisabled();
  await expect(page.locator("#dictionary-installed")).toContainText("French");
  await page.locator("#settings").click();
  await expect(
    page.locator(".source-page").first().locator(".spelling-error"),
  ).toHaveCount(1);
  await expect(
    page.locator(".source-page").first().locator(".spelling-error"),
  ).toHaveText("bonjor");
  await page.locator(".spelling-error").hover();
  await expect(
    page.getByRole("button", { name: "bonjour", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).__TEST__.dictionaryInstalls),
  ).toEqual(["fr_FR"]);
  expect(
    await page.evaluate(
      () => (window as any).__TEST__.snapshot.session.document.text,
    ),
  ).toBe("bonjour bonjor\fbonjour second page");
  await page.locator("#settings").click();
  await expect(page.locator("#dictionary-install")).toHaveText("Installed");
});

test("dictionary installation errors can be retried in a small Settings menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await setup(page, "Unchanged text");
  await page.locator("#preview").click();
  await page.locator("#settings").click();
  await page.locator("#dictionary-language").selectOption("fr_FR");
  await page.evaluate(
    () => ((window as any).__TEST__.failDictionaryInstall = true),
  );
  await page.locator("#dictionary-install").click();
  await expect(page.locator("#dictionary-status")).toContainText(
    "Network unavailable",
  );
  await expect(page.locator("#dictionary-install")).toBeEnabled();
  await expect(page.locator("#dictionary-installed")).not.toContainText(
    "French",
  );
  await page.evaluate(
    () => ((window as any).__TEST__.failDictionaryInstall = false),
  );
  await page.locator("#dictionary-install").click();
  await expect(page.locator("#dictionary-status")).toContainText(
    "French installed",
  );
  const panel = await page.locator("#settings-panel").boundingBox();
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(560);
  await page.locator("#settings").click();
  await page.locator("#preview").click();
  await expect(page.locator(".source-page .cm-content")).toHaveText(
    "Unchanged text",
  );
});

test("dictionary catalog errors recover when Settings reopens", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(
    () => ((window as any).__TEST__.failDictionaryList = true),
  );
  await page.locator("#settings").click();
  await expect(page.locator("#dictionary-status")).toContainText(
    "Dictionary list unavailable",
  );
  await expect(page.locator("#dictionary-install")).toBeDisabled();
  await page.locator("#settings").click();
  await page.evaluate(
    () => ((window as any).__TEST__.failDictionaryList = false),
  );
  await page.locator("#settings").click();
  await expect(page.locator("#dictionary-install")).toBeEnabled();
});

test("editor and preview fonts can be changed independently and persist", async ({
  page,
}) => {
  await setup(page, "First page\fSecond page");
  await page.locator("#settings").click();
  await page
    .getByRole("combobox", { name: "Editor font", exact: true })
    .selectOption("Mono");
  await page
    .getByRole("combobox", { name: "Preview font", exact: true })
    .selectOption("Sans");
  const editorFont = () =>
    page
      .locator(".source-page .cm-scroller")
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
  await expect.poll(editorFont).toContain("Menlo");
  await page.locator("#settings").click();
  await page.locator("#preview").click();
  await expect(page.locator(".preview-page")).toHaveCount(2);
  const previewFont = () =>
    page
      .locator(".preview-page .page-body")
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
  await expect.poll(previewFont).toContain("Segoe UI");
  expect(await previewFont()).not.toContain("Menlo");
  await page.locator("#settings").click();
  await page
    .getByRole("combobox", { name: "Preview font", exact: true })
    .selectOption("Serif");
  await expect.poll(previewFont).toContain("Georgia");
  await expect.poll(editorFont).toContain("Menlo");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.preferences,
      ),
    )
    .toMatchObject({ font: "Mono", previewFont: "Serif" });
  await expectPreviewPageBounds(page);
  await page.locator("#settings").click();
  await page.locator("#preview").click();
  await expect.poll(editorFont).toContain("Menlo");
  await expectSourcePageBounds(page);
});

test("Markdown syntax has readable colours in both appearances without changing source", async ({
  page,
}) => {
  const text =
    "# Heading\n\nPlain text and **Bold** with *Italic* and `inline code`.\n\n[Link](https://example.com)\n\n> Quoted text\n\n```bash\ncommand --option\n```\f## Second heading";
  await setup(page, text);
  for (const dark of [false, true]) {
    if (dark) await page.locator("#theme").click();
    const result = await page
      .locator(".source-page")
      .first()
      .evaluate((el) => {
        const colour = (text: string) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent?.includes(text))
              return getComputedStyle(node.parentElement!).color;
          }
          throw new Error("Missing token: " + text);
        };
        const css = getComputedStyle(document.documentElement);
        const rgb = (colour: string) => {
          const c = document.createElement("span");
          c.style.color = colour;
          el.append(c);
          const value = getComputedStyle(c).color;
          c.remove();
          return value;
        };
        const expected = (name: string) => rgb(css.getPropertyValue(name));
        return {
          heading: colour("Heading"),
          headingExpected: expected("--syntax-heading"),
          mark: colour("#"),
          markExpected: expected("--syntax-mark"),
          code: colour("inline code"),
          codeExpected: expected("--syntax-code"),
          link: colour("Link"),
          linkExpected: expected("--syntax-link"),
          bold: colour("Bold"),
          boldExpected: expected("--syntax-emphasis"),
          plain: colour("Plain text"),
          ink: expected("--ink"),
          palette: [
            "heading",
            "mark",
            "code",
            "link",
            "emphasis",
            "quote",
            "comment",
          ].map((name) => expected("--syntax-" + name)),
          paper: expected("--paper"),
        };
      });
    expect(result.heading).toBe(result.headingExpected);
    expect(result.mark).toBe(result.markExpected);
    expect(result.code).toBe(result.codeExpected);
    expect(result.link).toBe(result.linkExpected);
    expect(result.bold).toBe(result.boldExpected);
    expect(result.plain).toBe(result.ink);
    const luminance = (rgb: string) =>
      rgb
        .match(/\d+/g)!
        .slice(0, 3)
        .map(Number)
        .map((n) => n / 255)
        .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
    const paper = luminance(result.paper);
    for (const colour of result.palette) {
      const ink = luminance(colour);
      expect(
        (Math.max(paper, ink) + 0.05) / (Math.min(paper, ink) + 0.05),
      ).toBeGreaterThanOrEqual(dark ? 4.5 : 7);
    }
    await expect(
      page
        .locator(".source-page")
        .nth(1)
        .locator(".cm-line span")
        .filter({ hasText: "Second heading" }),
    ).toHaveCSS("color", result.headingExpected);
    await expectSourcePageBounds(page);
  }
  expect(
    await page.evaluate(
      () => (window as any).__TEST__.snapshot.session.document.text,
    ),
  ).toBe(text);
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
test("print pagination retains long formatted content without overflow", async ({
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
  await expect(page.locator("#source-host .cm-content").first()).toContainText(
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
test("HTML image blocks render centered with width attributes in preview and export", async ({
  page,
}) => {
  const html =
    '<p align="center"> <img src="ssl-pretraining.png" alt="Raman self-supervised pretraining architecture" width="750"> </p>';
  await setup(page, html, "/notes/example.md");
  await page.evaluate(
    (html) =>
      ((window as any).__TEST__.renderedHTML = [
        html +
          '<script>window.__htmlExecuted=true</script><img src="missing.png" onerror="window.__htmlExecuted=true">',
      ]),
    html,
  );
  await page.locator("#preview").click();
  const image = page.getByRole("img", {
    name: "Raman self-supervised pretraining architecture",
    exact: true,
  });
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(image).toHaveAttribute("width", "465");
  await expect(image).toHaveAttribute("height", "310");
  await expect(page.locator(".preview-page .page-body")).not.toContainText(
    "<p align=",
  );
  expect(
    await image.evaluate((el) => getComputedStyle(el.parentElement!).textAlign),
  ).toBe("center");
  const geometry = await image.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      b = el.closest(".page-body")!.getBoundingClientRect();
    return {
      center: Math.abs(r.left + r.right - (b.left + b.right)),
      inside: r.left >= b.left && r.right <= b.right,
    };
  });
  expect(geometry.center).toBeLessThan(2);
  expect(geometry.inside).toBe(true);
  expect(
    await page.evaluate(() => (window as any).__htmlExecuted),
  ).toBeUndefined();
  await expect(
    page.locator("#preview-host script,#preview-host [onerror]"),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).__TEST__.imageSources),
  ).toContain("ssl-pretraining.png");
  await page.evaluate(() => (window as any).__TEST__.menu("export"));
  await expect(page.locator("#notice")).toHaveText("PDF exported.");
});

test("image picker inserts ordinary Markdown", async ({ page }) => {
  await setup(page, "A photo");
  await page.evaluate(() => (window as any).__TEST__.menu("insert-image"));
  await expect(page.locator("#source-host .cm-content").first()).toContainText(
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
    paragraphLines(
      Array.from({ length: 90 }, (_, i) => `Line ${i + 1}: source content.`),
    ),
  );
  await expect(page.locator(".source-page")).toHaveCount(3);
  await expect(page.locator(".thumbnail")).toHaveCount(3);
  const geometry = await page.evaluate(() => ({
    sidebar: document.querySelector("#sidebar")!.getBoundingClientRect().width,
    toolbar: document.querySelector(".toolbar")!.getBoundingClientRect().height,
    footer: document.querySelector(".statusbar")!.getBoundingClientRect()
      .height,
    paper: document.querySelector(".source-page")!.getBoundingClientRect()
      .width,
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
  await expectSourcePageBounds(page);
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
  await page.locator("#source-host .cm-content").first().click();
  await page.keyboard.press("ArrowDown");
  await page.locator("#bookmark-add").click();
  await expect(page.locator(".thumbnail-bookmark")).toHaveCount(0);
});
test("independent pages keep long paragraphs and manual blank pages editable", async ({
  page,
}) => {
  const text = "Long paragraph words. ".repeat(500) + "\f\fFinal section";
  await setup(page, text);
  await expect
    .poll(() => page.locator(".source-page").count())
    .toBeGreaterThan(3);
  const source = await page.locator("#source-host").textContent();
  expect(source).toContain("Final section");
  await page.locator("#source-host .cm-content").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Meta+End");
  // Wait for CodeMirror to materialize and reveal the distant final line.
  await expect(
    page.locator("#source-host .cm-line").filter({ hasText: "Final section" }),
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

test("thumbnails refresh typography and page flow without changing source", async ({
  page,
}) => {
  await setup(
    page,
    paragraphLines(
      Array.from({ length: 90 }, (_, i) => `Line ${i + 1}: body text.`),
    ),
  );
  await expect(page.locator(".thumbnail")).toHaveCount(3);
  const previousText = await page.locator(".mini-text").first().textContent();
  await page.locator("#settings").click();
  await page.locator("#font").selectOption("Mono");
  await page.locator("#size").fill("22");
  await page.locator("#margin").selectOption("85");
  await expect
    .poll(() => page.locator(".thumbnail").count())
    .toBeGreaterThan(3);
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
  expect(typography.text).toContain("Line 1:");
  expect(previousText).toContain("Line 1:");
  await expectSourcePageBounds(page);
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
  await expect(page.locator("#source-host .cm-content").first()).toContainText(
    "## Heading",
  );
  await page.keyboard.type("My heading");
  await expect(page.locator("#source-host .cm-content").first()).toContainText(
    "## My heading",
  );
  await page.evaluate(() => (window as any).__TEST__.menu("insert-bold"));
  await expect(page.locator("#source-host .cm-content").first()).toContainText(
    "**bold text**",
  );
  await page.evaluate(() => (window as any).__TEST__.menu("undo"));
  await expect(
    page.locator("#source-host .cm-content").first(),
  ).not.toContainText("**bold text**");
  await page.evaluate(() => (window as any).__TEST__.menu("insert-note"));
  await expect(page.locator("#source-host .cm-content").first()).toContainText(
    "[!NOTE]",
  );
  await page.evaluate(() => (window as any).__TEST__.menu("insert-table"));
  await expect(page.locator("#source-host .cm-content").first()).toContainText(
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
  await expect(page.locator("#source-host .cm-content").first()).toHaveText(
    "A draft",
  );
});

for (const zoom of [50, 100, 150]) {
  test(`clicking source text places the cursor at the clicked character at ${zoom}%`, async ({
    page,
  }) => {
    const lines = Array.from(
      { length: 90 },
      (_, i) => `Line ${i + 1}: source content for cursor placement.`,
    );
    const text = paragraphLines(lines);
    await setup(page, text);
    await expect(page.locator(".thumbnail")).toHaveCount(3);
    await page.locator("#zoom").fill(String(zoom));
    const line = page
      .locator("#source-host .cm-line")
      .filter({ hasText: /^Line 45:/ });
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
        const caret = await page.evaluate(() => {
          const selection = getSelection();
          if (!selection?.rangeCount || !selection.isCollapsed) return null;
          const rect = selection.getRangeAt(0).getBoundingClientRect();
          return { x: rect.x, y: rect.y, height: rect.height };
        });
        return (
          !!caret &&
          Math.abs(caret.x - point.x) < 3 &&
          Math.abs(caret.y + caret.height / 2 - point.y) < 3
        );
      })
      .toBe(true);
    await expect(page.locator(".cm-cursorLayer")).toHaveCount(0);
    expect(
      await line.evaluate((el) => getComputedStyle(el).caretColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
    await page.keyboard.type("@");
    const offset = text.indexOf("Line 45:") + 12;
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__TEST__.snapshot.session.document.text,
        ),
      )
      .toBe(text.slice(0, offset) + "@" + text.slice(offset));
  });
}

for (const preview of [false, true]) {
  test(`sidebar follows document scrolling in ${preview ? "preview" : "editor"} and updates the current-page indicator`, async ({
    page,
  }) => {
    await setup(
      page,
      Array.from(
        { length: 12 },
        (_, i) => `Page ${i + 1}\n` + "Reading content.\n".repeat(100),
      ).join("\f"),
    );
    if (preview) {
      await page.locator("#preview").click();
      await expect
        .poll(() => page.locator(".preview-page").count())
        .toBeGreaterThan(12);
    }
    const paper = page.locator(preview ? ".preview-page" : ".source-page");
    await paper.nth(9).evaluate((el) => el.scrollIntoView({ block: "start" }));
    const documentScroll = await page
      .locator("#canvas")
      .evaluate((el) => el.scrollTop);
    await expect(page.locator(".thumbnail").nth(9)).toBeInViewport();
    await expect
      .poll(() => page.locator("#thumbnails").evaluate((el) => el.scrollTop))
      .toBeGreaterThan(1000);
    expect(await page.locator("#canvas").evaluate((el) => el.scrollTop)).toBe(
      documentScroll,
    );
    await expect(page.locator(".thumbnail").nth(9)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await paper.first().evaluate((el) => el.scrollIntoView({ block: "start" }));
    await expect(page.locator(".thumbnail").first()).toBeInViewport();
    await expect
      .poll(() => page.locator("#thumbnails").evaluate((el) => el.scrollTop))
      .toBe(0);
    // Browsing the sidebar never scrolls the document or resets on a re-render.
    const sidebarScroll = await page.locator("#thumbnails").evaluate((el) => {
      el.scrollTop = 1500;
      return el.scrollTop;
    });
    await page.locator("#settings").click();
    await page.locator("#font").selectOption("Mono");
    await page.waitForTimeout(300);
    expect(
      await page.locator("#thumbnails").evaluate((el) => el.scrollTop),
    ).toBe(sidebarScroll);
    await page.locator("#settings").click();
    // Clicking the document follows its visible page without internal scrolling.
    await paper.first().click({ position: { x: 80, y: 100 } });
    await expect(page.locator(".thumbnail").first()).toBeInViewport();
    await expect
      .poll(() => page.locator("#thumbnails").evaluate((el) => el.scrollTop))
      .toBe(0);
  });
}

test("sidebar page navigation reveals the selected page", async ({ page }) => {
  await setup(
    page,
    paragraphLines(
      Array.from({ length: 150 }, (_, i) => `Line ${i + 1}: source content.`),
    ),
  );
  await expect
    .poll(() => page.locator(".thumbnail").count())
    .toBeGreaterThanOrEqual(5);
  await page.getByRole("button", { name: "Go to page 4", exact: true }).click();
  await expect(page.locator(".source-page").nth(3)).toBeInViewport();
  const top = await page
    .locator(".source-page")
    .nth(3)
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThan(0);
  expect(top).toBeLessThan(150);
});

test("clicking a long paragraph across flowing pages keeps its text position", async ({
  page,
}) => {
  const text = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(" ");
  await setup(page, text);
  await expect
    .poll(() => page.locator(".thumbnail").count())
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "Go to page 1", exact: true }).click();
  for (const word of ["word400", "word500", "word600"]) {
    const index = await page
      .locator(".source-page .cm-content")
      .evaluateAll(
        (elements, word) =>
          elements.findIndex((el) =>
            (el as any).cmTile.root.view.state.doc
              .toString()
              .includes(word + " "),
          ),
        word,
      );
    await page.locator(".thumbnail").nth(index).click();
    await page.waitForTimeout(100);
    const point = await page.locator("#source-host").evaluate((el, word) => {
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
    paragraphLines(
      Array.from({ length: 300 }, (_, i) => `Line ${i + 1}: scroll content.`),
    ),
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
  await page.mouse.move(box.x + 10, box.y + 200);
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
  await page.mouse.move(box.x + 10, box.y + 200);
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => canvas.evaluate((el) => el.scrollTop)).toBe(0);
  await page.mouse.wheel(0, 2400);
  await expect
    .poll(() => canvas.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(2000);
});

test("preview and source share flowing A4 containers with no hidden overflow", async ({
  page,
}) => {
  const sections = [80, 70].map((count, section) =>
    Array.from(
      { length: count },
      (_, i) => `Section ${section + 1}, preview paragraph ${i + 1}.`,
    ).join("\n\n"),
  );
  await setup(page, sections.join("\f"));
  await page.locator("#preview").click();
  const papers = page.locator(".preview-page");
  await expect.poll(() => papers.count()).toBeGreaterThan(2);
  await expect
    .poll(async () => [
      await papers.count(),
      await page.locator(".source-page").count(),
    ])
    .toEqual([await papers.count(), await papers.count()]);
  await expectPreviewPageBounds(page);
  const count = await papers.count();
  await expect(page.locator(".thumbnail")).toHaveCount(count);
  for (const index of [count - 1, 0]) {
    await page.locator(".thumbnail").nth(index).click();
    await expect(papers.nth(index)).toBeInViewport();
    await expect(page.locator(".thumbnail").nth(index)).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
  await page.locator("#preview").click();
  await expect(page.locator(".source-page")).toHaveCount(count);
  await expectSourcePageBounds(page);
});

for (const preview of [false, true]) {
  test(`bookmarks follow the current ${preview ? "preview" : "editor"} page after scrolling`, async ({
    page,
  }) => {
    const text = "First page\fSecond page\fThird page";
    await setup(page, text);
    if (preview) await page.locator("#preview").click();
    const papers = page.locator(preview ? ".preview-page" : ".source-page");
    const thumbnails = page.locator(".thumbnail");
    const button = page.locator("#bookmark-add");
    const go = async (index: number) => {
      await papers
        .nth(index)
        .evaluate((el) => el.scrollIntoView({ block: "start" }));
      await expect(thumbnails.nth(index)).toHaveAttribute(
        "aria-current",
        "page",
      );
    };
    await go(2);
    await button.click();
    await expect(thumbnails.nth(2).locator(".thumbnail-bookmark")).toHaveCount(
      1,
    );
    await expect(thumbnails.nth(0).locator(".thumbnail-bookmark")).toHaveCount(
      0,
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__TEST__.snapshot.session.document.bookmarks.map(
            (b: any) => b.offset,
          ),
        ),
      )
      .toEqual([text.indexOf("Third")]);
    await go(1);
    await expect(button).not.toHaveClass(/bookmarked/);
    await page.keyboard.press("Control+d");
    await expect(thumbnails.nth(1).locator(".thumbnail-bookmark")).toHaveCount(
      1,
    );
    await go(2);
    await expect(button).toHaveClass(/bookmarked/);
    await button.click();
    await expect(thumbnails.nth(2).locator(".thumbnail-bookmark")).toHaveCount(
      0,
    );
    await expect(thumbnails.nth(1).locator(".thumbnail-bookmark")).toHaveCount(
      1,
    );
  });
}

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
  await expect(page.locator("#source-host .cm-content").first()).toBeFocused();
});

test("native spelling corrections update the document and support undo", async ({
  page,
}) => {
  const text = "Keep teh word and teh second instance.";
  await setup(page, text);
  const content = page.locator("#source-host .cm-content").first();
  await expect(content).toHaveAttribute("spellcheck", "false");
  await expect(content).toHaveAttribute("autocorrect", "off");
  await page.locator("#source-host .cm-line").click();
  // Native spelling menus replace the selected word through the browser's
  // editing engine. Exercise that path rather than dispatching a CM transaction.
  const replaced = await content.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent?.includes("teh")) node = walker.nextNode();
    if (!node) throw new Error("Misspelled word not found");
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
  const point = await page
    .locator("#source-host .cm-content")
    .first()
    .evaluate((el, word) => {
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
    await expect(page.locator("#source-host .cm-content").first()).toHaveText(
      text,
    );
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
  await page.locator("#source-host .cm-line").click();
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
  await expect(page.locator("#source-host .cm-content").first()).toHaveText(
    "Keep teh word. Added.",
  );
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
    await expect(page.locator("#source-host .cm-content").first()).toHaveText(
      "Unsaved draft",
    );
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
  await expect(page.locator("#source-host .cm-content").first()).toHaveText(
    "Saved text changed",
  );
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
    await expect(page.locator("#source-host .cm-content").first()).toHaveText(
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

for (const [name, text] of [
  ["wrapped paragraph", "Long paragraph words. ".repeat(800)],
  ["blank lines", "hello\n\n\n".repeat(100)],
  ["manual breaks", "hello\n\f\n".repeat(30)],
  ["inline manual breaks", "hello\f\n".repeat(30)],
  ["long tokens", ("x".repeat(150) + " ").repeat(150)],
  ["trailing spaces", ("text" + " ".repeat(300) + "\n").repeat(80)],
  ["leading spaces", (" ".repeat(300) + "text\n").repeat(80)],
  [
    "Greek markdown",
    ("# Καλημέρα\n" + "**Κείμενο** ".repeat(100) + "\n").repeat(20),
  ],

  ["spaces and tabs", ("word   ".repeat(30) + "\tmore text\n").repeat(100)],
  [
    "large type",
    Array.from(
      { length: 150 },
      (_, i) => `Line ${i}: ${"words ".repeat(20)}`,
    ).join("\n"),
  ],
]) {
  test(`source text stays inside every A4 page: ${name}`, async ({ page }) => {
    await setup(page, text);
    if (name === "large type") {
      await page.locator("#settings").click();
      await page.locator("#size").fill("22");
    }
    await expect
      .poll(() => page.locator(".source-page").count())
      .toBeGreaterThanOrEqual(1);
    await expectSourcePageBounds(page);
    if (
      ["trailing spaces", "leading spaces", "spaces and tabs"].includes(name)
    ) {
      const count = await page.locator(".source-page").count();
      for (let index = 0; index < count; index++) {
        await page.locator(".thumbnail").nth(index).click();
        await page.waitForTimeout(50);
        await expect
          .poll(() =>
            page
              .locator(".source-page .cm-scroller")
              .nth(index)
              .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
          )
          .toBe(true);
      }
    }
  });
}

for (const [name, block] of [
  [
    "fenced command",
    "```bash\npython main.py fit \\\n  --config configs/mae/mae-config-base.yaml \\\n  --trainer.strategy auto\n  --trainer.devices 1\n  --trainer.accelerator gpu\n```\n",
  ],
  ["table", "| A | B |\n| - | - |\n" + "| x | y |\n".repeat(12)],
  ["nested list", "- first\n  - nested\n\n- second\n"],
  [
    "oversized fence",
    "```text\n" + "Code remains code.\n".repeat(100) + "```\n",
  ],
]) {
  test(`automatic page boundaries keep ${name} intact`, async ({ page }) => {
    const prefix = "Intro line.\n".repeat(33) + "\n";
    const text = prefix + block + "\nAfter the block.";
    await setup(page, text);
    const contents = await page
      .locator(".source-page .cm-content")
      .evaluateAll((elements) =>
        elements.map((el) => (el as any).cmTile.root.view.state.doc.toString()),
      );
    expect(contents.join("")).toBe(text);
    if (name === "oversized fence") {
      expect(contents.join("")).toContain(block);
      expect(contents.length).toBeGreaterThan(3);
    } else
      expect(
        contents.filter((content) => content.includes(block)),
      ).toHaveLength(1);
    expect(contents[0]).not.toContain(block);
    await expectSourcePageBounds(page);
    await page
      .getByRole("button", { name: "Go to page 1", exact: true })
      .click();
    await page.locator("#add-page").click();
    const inserted = await page
      .locator(".source-page .cm-content")
      .evaluateAll((elements) =>
        elements.map((el) => (el as any).cmTile.root.view.state.doc.toString()),
      );
    if (name === "oversized fence") expect(inserted.join("")).toContain(block);
    else
      expect(
        inserted.filter((content) => content.includes(block)),
      ).toHaveLength(1);
    await expectSourcePageBounds(page);
  });
}

test("old recovery boundaries move to the beginning of a split code block without editing text", async ({
  page,
}) => {
  const code =
    "```bash\npython main.py fit\n--trainer.strategy auto\n--trainer.devices 1\n```\n";
  const prefix = "Intro line.\n".repeat(33) + "\n";
  const text = prefix + code + "\nAfter.";
  await setup(page, text, null, false, [0, text.indexOf("--trainer.strategy")]);
  await expect(page.locator(".source-page")).toHaveCount(2);
  const contents = await page
    .locator(".source-page .cm-content")
    .evaluateAll((elements) =>
      elements.map((el) => (el as any).cmTile.root.view.state.doc.toString()),
    );
  expect(contents.join("")).toBe(text);
  expect(contents[0]).toBe(prefix);
  expect(contents[1]).toContain(code);
  await expectSourcePageBounds(page);
});

for (const preview of [false, true]) {
  for (const index of [0, 1, 2]) {
    test(`right-click removes page ${index + 1} in ${preview ? "preview" : "editor"}, preserves other pages and supports Undo`, async ({
      page,
    }) => {
      const original = "First page\fSecond page\fThird page";
      await setup(page, original);
      if (preview) {
        await page.locator("#preview").click();
        await expect(page.locator(".preview-page")).toHaveCount(3);
      }
      await page
        .getByRole("button", { name: `Go to page ${index + 1}`, exact: true })
        .click({ button: "right" });
      await page
        .getByRole("button", { name: "Remove page", exact: true })
        .click();
      await expect(page.locator("#delete-page-dialog")).toBeVisible();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.locator(".source-page")).toHaveCount(2);
      const expected = ["First page", "Second page", "Third page"].filter(
        (_, i) => i !== index,
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as any).__TEST__.snapshot.session.document.text,
          ),
        )
        .toBe(expected.join("\f"));
      if (preview) {
        await expect(page.locator(".preview-page")).toHaveCount(2);
        await expectPreviewPageBounds(page);
      } else await expectSourcePageBounds(page);
      const mode = page.locator(
        preview ? ".preview-page .page-body" : ".source-page .cm-content",
      );
      await expect(mode.nth(0)).toHaveText(expected[0]);
      await expect(mode.nth(1)).toHaveText(expected[1]);
      await expect(page.locator(".thumbnail[aria-current=page]")).toHaveCount(
        1,
      );
      await page.evaluate(() => (window as any).__TEST__.menu("undo"));
      await expect(page.locator(".source-page")).toHaveCount(3);
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as any).__TEST__.snapshot.session.document.text,
          ),
        )
        .toBe(original);
      if (preview) {
        await expect(page.locator(".preview-page")).toHaveCount(3);
        await expectPreviewPageBounds(page);
      } else await expectSourcePageBounds(page);
    });
  }
}

for (const preview of [false, true]) {
  test(`removing a full automatically paginated page requires confirmation in ${preview ? "preview" : "editor"}`, async ({
    page,
  }) => {
    const text = paragraphLines(
      Array.from(
        { length: 120 },
        (_, i) => `Line ${i + 1}: content filling the document.`,
      ),
    );
    await setup(page, text);
    if (preview) await page.locator("#preview").click();
    const contents = page.locator(".source-page .cm-content");
    await expect.poll(() => contents.count()).toBeGreaterThan(1);
    const count = await contents.count();
    const pageTexts = () =>
      contents.evaluateAll((elements) =>
        elements.map((el) => (el as any).cmTile.root.view.state.doc.toString()),
      );
    const before = await pageTexts();
    const openConfirmation = async () => {
      await page
        .getByRole("button", { name: "Go to page 1", exact: true })
        .click({ button: "right" });
      await page
        .getByRole("button", { name: "Remove page", exact: true })
        .click();
      await expect(page.locator("#delete-page-dialog")).toBeVisible();
      await expect(contents).toHaveCount(count);
      expect(await pageTexts()).toEqual(before);
    };
    await openConfirmation();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(contents).toHaveCount(count);
    await openConfirmation();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(contents).toHaveCount(count - 1);
    await page.evaluate(() => (window as any).__TEST__.menu("undo"));
    await expect(contents).toHaveCount(count);
    await expect.poll(pageTexts).toEqual(before);
  });
}

test("removing the only page leaves an editable blank page and Undo restores it", async ({
  page,
}) => {
  await setup(page, "Only page");
  await page
    .getByRole("button", { name: "Go to page 1", exact: true })
    .click({ button: "right" });
  await page.getByRole("button", { name: "Remove page", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator(".source-page")).toHaveCount(1);
  await expect(page.locator(".source-page .cm-content")).toHaveText("");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".source-page .cm-content")).toHaveText(
    "Only page",
  );
});

test("sidebar deletion can be cancelled with Cancel or Escape", async ({
  page,
}) => {
  await setup(page, "First\fSecond");
  for (const cancel of ["button", "escape"]) {
    await page
      .getByRole("button", { name: "Go to page 2", exact: true })
      .click({ button: "right" });
    await page
      .getByRole("button", { name: "Remove page", exact: true })
      .click();
    const dialog = page.locator("#delete-page-dialog");
    await expect(dialog).toContainText("Delete page 2?");
    await expect(page.locator(".source-page")).toHaveCount(2);
    if (cancel === "button")
      await dialog.getByRole("button", { name: "Cancel" }).click();
    else await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".source-page .cm-content").nth(1)).toHaveText(
      "Second",
    );
  }
});

for (const [text, index, expected] of [
  ["\fSecond", 0, "Second"],
  ["First\f\fThird", 1, "First\fThird"],
  ["First\f", 1, "First"],
] as const) {
  test(`Backspace removes empty page ${index + 1} from ${JSON.stringify(text)} and supports Undo`, async ({
    page,
  }) => {
    await setup(page, text);
    const contents = page.locator(".source-page .cm-content");
    const count = await contents.count();
    await contents.nth(index).click();
    await page.keyboard.press("Backspace");
    await expect(contents).toHaveCount(count - 1);
    await expect(page.locator("#delete-page-dialog")).not.toBeVisible();
    await expect(contents.nth(0)).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__TEST__.snapshot.session.document.text,
        ),
      )
      .toBe(expected);
    await page.keyboard.type("!");
    await expect(contents.nth(0)).toHaveText(
      index === 0 ? "!Second" : "First!",
    );
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await expect(contents).toHaveCount(count);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__TEST__.snapshot.session.document.text,
        ),
      )
      .toBe(text);
  });
}

test("Backspace keeps the only empty page editable", async ({ page }) => {
  await setup(page, "");
  const content = page.locator(".source-page .cm-content");
  await content.click();
  await page.keyboard.press("Backspace");
  await expect(content).toHaveCount(1);
  await page.keyboard.type("Still here");
  await expect(content).toHaveText("Still here");
});

for (const target of ["thumbnail", "text", "blank area"]) {
  test(`Add page follows the current indicator after clicks on ${target} and preserves later pages`, async ({
    page,
  }) => {
    const text = "First page\fSecond page\fThird page";
    await setup(page, text);
    await expect(page.locator(".thumbnail")).toHaveCount(3);
    await page
      .getByRole("button", { name: "Go to page 2", exact: true })
      .click();
    if (target !== "thumbnail") {
      await page
        .locator(".source-page")
        .nth(2)
        .locator(".cm-content")
        .click({
          position: { x: 30, y: target === "text" ? 10 : 200 },
        });
    }
    await expect(
      page.locator(".thumbnail").nth(target === "thumbnail" ? 1 : 2),
    ).toHaveAttribute("aria-current", "page");
    await page.locator("#add-page").click();
    await expect(page.locator(".thumbnail")).toHaveCount(4);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__TEST__.snapshot.session.document.text,
        ),
      )
      .toBe(
        target === "thumbnail"
          ? "First page\fSecond page\f\fThird page"
          : "First page\fSecond page\fThird page\f",
      );
    await page.keyboard.type("New page");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__TEST__.snapshot.session.document.text,
        ),
      )
      .toBe(
        target === "thumbnail"
          ? "First page\fSecond page\fNew page\fThird page"
          : "First page\fSecond page\fThird page\fNew page",
      );
    await expectSourcePageBounds(page);
    await page.keyboard.press("Control+z");
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

test("Add page uses the end of an automatically paginated block instead of replacing selected text", async ({
  page,
}) => {
  const lines = Array.from(
    { length: 90 },
    (_, i) => `Line ${i + 1}: source content.`,
  );
  const text = paragraphLines(lines);
  await setup(page, text);
  await expect(page.locator(".thumbnail")).toHaveCount(3);
  await page.getByRole("button", { name: "Go to page 1", exact: true }).click();
  await page.keyboard.press("Control+a");
  await page.locator("#add-page").click();
  await expect(page.locator(".thumbnail")).toHaveCount(4);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toContain("\f");
  const inserted = await page.evaluate(
    () => (window as any).__TEST__.snapshot.session.document.text,
  );
  expect(inserted.replace("\f\f", "")).toBe(text);
  expect(inserted.indexOf("\f")).toBe(text.indexOf("Line 31:"));
  await page.keyboard.type("Blank inserted page");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toContain("\fBlank inserted page\f");
});

test("each source page owns an independent editor and overflow flows ahead of the next explicit page", async ({
  page,
}) => {
  await setup(page, "First page\fSecond page");
  await expect(page.locator(".source-page")).toHaveCount(2);
  const first = page.locator(".source-page").nth(0),
    second = page.locator(".source-page").nth(1);
  await expect(first.locator(".cm-content")).toHaveText("First page");
  await expect(second.locator(".cm-content")).toHaveText("Second page");
  await expect(first.locator(".source-page-space")).toHaveCount(0);
  await first.locator(".cm-content").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("Independent content.\n".repeat(100));
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toBe("Independent content.\n".repeat(100) + "\fSecond page");
  await expect
    .poll(() => page.locator(".source-page").count())
    .toBeGreaterThan(2);
  await expect(page.locator(".source-page .cm-content").last()).toHaveText(
    "Second page",
  );
  const geometry = await page.locator("#source-host").evaluate((host) => {
    const papers = [...host.querySelectorAll(".source-page")];
    return {
      heights: papers.map((p) => p.getBoundingClientRect().height),
      gap:
        papers[1].getBoundingClientRect().top -
        papers[0].getBoundingClientRect().bottom,
      overflow: getComputedStyle(papers[0]).overflow,
      scroll: getComputedStyle(papers[0].querySelector(".cm-scroller")!)
        .overflowY,
    };
  });
  expect(geometry.heights.every((h) => Math.abs(h - 841.89) < 0.1)).toBe(true);
  expect(geometry.gap).toBeCloseTo(24, 1);
  expect(geometry.overflow).toBe("hidden");
  expect(geometry.scroll).toBe("clip");
  await page.keyboard.press("Control+z");
  await expect(first.locator(".cm-content")).toHaveText("First page");
  await page.locator(".thumbnail").nth(0).click();
  await page.locator("#add-page").click();
  await expect(page.locator(".source-page")).toHaveCount(3);
  await expect(
    page.locator(".source-page").nth(1).locator(".cm-content"),
  ).toHaveText("");
  await page.keyboard.type("New independent page");
  await expect(
    page.locator(".source-page").nth(1).locator(".cm-content"),
  ).toHaveText("New independent page");
  await expect(
    page.locator(".source-page").nth(2).locator(".cm-content"),
  ).toHaveText("Second page");
});

test("preview tracks a code block after headings reflow onto more pages", async ({
  page,
}) => {
  const headings = Array.from(
    { length: 20 },
    (_, i) => `# Intro heading ${i}\n\n`,
  );
  const prefix = headings.join("");
  const code =
    "```bash\npython main.py fit\n--trainer.strategy auto\n--trainer.accelerator gpu\n```";
  const text = prefix + code + "\n\nAfter.\fLater page";
  await setup(page, text);
  await page.evaluate(
    ({ headings, prefix, code }) => {
      let offset = 0;
      const html = headings
        .map((heading, i) => {
          const from = offset;
          offset += heading.length;
          return `<div class="source-block" data-source-from="${from}" data-source-to="${offset}"><h1>Intro heading ${i}</h1></div>`;
        })
        .join("");
      (window as any).__TEST__.renderedHTML = [
        html +
          `<div class="source-block" data-source-from="${prefix.length}" data-source-to="${prefix.length + code.length}"><pre><code>python main.py fit\n--trainer.strategy auto\n--trainer.accelerator gpu\n</code></pre></div><p>After.</p>`,
        "<p>Later page</p>",
      ];
    },
    { headings, prefix, code },
  );
  await page.locator("#preview").click();
  await expect(page.locator(".preview-page pre")).toHaveCount(1);
  await page.locator("#preview").click();
  const source = page
    .locator(".source-page")
    .filter({ hasText: "python main.py fit" });
  await source.click({ position: { x: 80, y: 80 } });
  await source.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.locator("#preview").click();
  await expect(page.locator(".preview-page pre")).toBeInViewport();
  await expectPreviewPageBounds(page);
  await page.locator("#preview").click();
  await expect(source).toBeInViewport();
});

for (const zoom of [50, 100, 170]) {
  test(`mode switching preserves the current flowing page at ${zoom}%`, async ({
    page,
  }) => {
    const content = "Reading content with several words.\n".repeat(100);
    await setup(page, [content, content, content].join("\f"));
    await page.locator("#preview").click();
    await expect
      .poll(() => page.locator(".preview-page").count())
      .toBeGreaterThan(3);
    const count = await page.locator(".preview-page").count();
    await page.locator("#preview").click();
    await page.locator("#zoom").fill(String(zoom));
    await page
      .locator(".source-page")
      .nth(2)
      .locator(".cm-content")
      .click({ position: { x: 30, y: 20 } });
    const position = await page
      .locator(".source-page")
      .nth(2)
      .evaluate((paper) => {
        paper.scrollIntoView({ block: "start" });
        const canvas = document.querySelector("#canvas")!;
        canvas.scrollTop += 60;
        return canvas.scrollTop;
      });
    await page.locator("#preview").click();
    await expect(page.locator(".preview-page")).toHaveCount(count);
    await expect(page.locator(".thumbnail").nth(2)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect
      .poll(() =>
        page
          .locator("#canvas")
          .evaluate((el, p) => Math.abs(el.scrollTop - p), position),
      )
      .toBeLessThan(40);
    await page
      .locator(".preview-page")
      .nth(1)
      .locator(".page-body")
      .click({ position: { x: 30, y: 20 } });
    const reverse = await page
      .locator(".preview-page")
      .nth(1)
      .evaluate((paper) => {
        paper.scrollIntoView({ block: "start" });
        const canvas = document.querySelector("#canvas")!;
        canvas.scrollTop += 40;
        return canvas.scrollTop;
      });
    await page.locator("#preview").click();
    await expect(page.locator(".thumbnail").nth(1)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect
      .poll(() =>
        page
          .locator("#canvas")
          .evaluate((el, p) => Math.abs(el.scrollTop - p), reverse),
      )
      .toBeLessThan(40);
    await expectSourcePageBounds(page);
  });
}

test("flowing preview scrolls the document and still inserts a blank page after the current page", async ({
  page,
}) => {
  const content = "Independent content.\n".repeat(100);
  await setup(page, content + "\fSecond page");
  await page.locator("#preview").click();
  await expect
    .poll(() => page.locator(".preview-page").count())
    .toBeGreaterThan(2);
  const count = await page.locator(".preview-page").count();
  await expect(page.locator(".preview-page .page-body").last()).toHaveText(
    "Second page",
  );
  await expectPreviewPageBounds(page);
  const first = page.locator(".preview-page .page-body").first();
  await page.locator(".thumbnail").first().click();
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.wheel(0, 120);
  await expect
    .poll(() => page.locator("#canvas").evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  expect(await first.evaluate((el) => el.scrollTop)).toBe(0);
  await page.locator(".thumbnail").first().click();
  await first.click({ position: { x: 30, y: 30 } });
  await page.locator("#add-page").click();
  await expect
    .poll(() => page.locator(".preview-page").count())
    .toBeGreaterThan(count);
  await expect(page.locator(".preview-page .page-body").nth(1)).toHaveText("");
  await expect(page.locator(".preview-page .page-body").last()).toHaveText(
    "Second page",
  );
  await page.locator("#preview").click();
  await expect(page.locator(".source-page .cm-content").nth(1)).toBeFocused();
  await page.keyboard.type("Inserted page");
  await page.locator("#preview").click();
  await expect(page.locator(".preview-page .page-body").nth(1)).toHaveText(
    "Inserted page",
  );
  await page.locator("#settings").click();
  await page.locator("#size").fill("22");
  await page.locator("#margin").selectOption("85");
  await expect
    .poll(() => page.locator(".preview-page").count())
    .toBeGreaterThan(count + 1);
  await expect(page.locator(".preview-page .page-body").last()).toHaveText(
    "Second page",
  );
  await expectPreviewPageBounds(page);
});

for (const kind of ["paragraph", "fence", "list", "manual pages"]) {
  test(`flowing A4 pages fit source and preview without internal scrolling: ${kind}`, async ({
    page,
  }) => {
    const text =
      kind === "fence"
        ? "```bash\n" +
          Array.from({ length: 120 }, (_, i) => `command --line ${i}`).join(
            "\n",
          ) +
          "\n```"
        : kind === "list"
          ? Array.from(
              { length: 120 },
              (_, i) => `${i + 1}. List entry ${i}`,
            ).join("\n")
          : kind === "manual pages"
            ? "First explicit page\f" +
              "Wrapped words keep flowing onto another page. ".repeat(350) +
              "\fLast explicit page"
            : "Wrapped words keep flowing onto another page. ".repeat(500);
    await setup(page, text);
    await expect
      .poll(() => page.locator(".source-page").count())
      .toBeGreaterThan(2);
    await expectSourcePageBounds(page);
    await expect
      .poll(() =>
        page
          .locator(".source-page .cm-content")
          .evaluateAll((elements) =>
            elements
              .map((el) => (el as any).cmTile.root.view.state.doc.toString())
              .join(""),
          ),
      )
      .toBe(text.replace(/\f/g, ""));
    const sourceCount = await page.locator(".source-page").count();
    await page.locator("#preview").click();
    await expect(page.locator(".preview-page")).toHaveCount(sourceCount);
    await expectPreviewPageBounds(page);
    await expect(page.locator("#notice")).not.toContainText("Preview failed");
  });
}

test("typing fills the next page and deleting pulls text back without changing manual breaks", async ({
  page,
}) => {
  await setup(page, "Line of content.\n".repeat(30));
  const content = page.locator(".source-page .cm-content").first();
  await content.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("Additional flowing content.\n".repeat(70));
  await expect
    .poll(() => page.locator(".source-page").count())
    .toBeGreaterThan(2);
  await expectSourcePageBounds(page);
  const full =
    "Line of content.\n".repeat(30) +
    "Additional flowing content.\n".repeat(70);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toBe(full);
  await expect(page.locator(".source-page .cm-content").last()).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect(page.locator(".source-page")).toHaveCount(1);
  await expectSourcePageBounds(page);
  await page.keyboard.press("Control+Shift+z");
  await expect
    .poll(() => page.locator(".source-page").count())
    .toBeGreaterThan(2);
  await expectSourcePageBounds(page);
});

test("continued preview fragments retain nested code and link formatting", async ({
  page,
}) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const { pageFragment } = await import("/src/page-flow.ts" as string);
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="source-block" data-source-from="0" data-source-to="30"><p><a href="https://example.com"><span class="source-text" data-source-from="0" data-source-to="30"><code>012345678901234567890123456789</code></span></a></p></div>';
    const fragments = [0, 10, 20].map((from) => {
      const el = document.createElement("div");
      el.innerHTML = pageFragment(root, from, from + 10);
      return {
        text: el.textContent,
        code: !!el.querySelector("a code"),
        href: el.querySelector("a")?.getAttribute("href"),
      };
    });
    return fragments;
  });
  expect(result.map((fragment) => fragment.text).join("")).toBe(
    "012345678901234567890123456789",
  );
  expect(
    result.every(
      (fragment) => fragment.code && fragment.href === "https://example.com",
    ),
  ).toBe(true);
});

test("syntax highlighting uses the full Markdown context on continuation pages", async ({
  page,
}) => {
  const lines = Array.from({ length: 100 }, (_, i) =>
    i === 45 ? "## Still inside the code fence" : `command --line ${i}`,
  );
  await setup(page, "```bash\n" + lines.join("\n") + "\n```");
  const line = page
    .locator(".source-page .cm-line")
    .filter({ hasText: "## Still inside the code fence" });
  for (const dark of [false, true]) {
    if (dark) await page.locator("#theme").click();
    const colours = await line.evaluate((el) => {
      const span = el.querySelector("span")!;
      const reference = document.createElement("span");
      reference.style.color = "var(--syntax-code)";
      el.append(reference);
      const expected = getComputedStyle(reference).color;
      reference.remove();
      return { actual: getComputedStyle(span).color, expected };
    });
    expect(colours.actual).toBe(colours.expected);
  }
});

test("typing leaves document layout idle and updates only the active editor", async ({
  page,
}) => {
  await setup(
    page,
    paragraphLines(
      Array.from(
        { length: 300 },
        (_, i) => `Line ${i + 1}: content for a longer document.`,
      ),
    ),
  );
  await expect
    .poll(() => page.locator(".preview-page").count())
    .toBeGreaterThan(5);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  // Finish the initial spell-check before counting updates caused by typing.
  await page.clock.runFor(300);
  const before = await page
    .locator(".source-page .cm-content")
    .evaluateAll((elements) => {
      const views = elements.map((el) => (el as any).cmTile.root.view);
      const w = window as any;
      w.__TEST__.layoutMeasures = 0;
      w.__TEST__.neighbourUpdates = 0;
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (node instanceof HTMLElement && node.matches(".source-measure"))
              w.__TEST__.layoutMeasures++;
      }).observe(document.body, { childList: true });
      for (const view of views.slice(1)) {
        const dispatch = view.dispatch.bind(view);
        view.dispatch = (...args: any[]) => {
          // Spell-check replies are independent of typing. Count source and
          // syntax updates, which must stay local to the edited page.
          if (
            args.some(
              (arg) =>
                arg.changes ||
                [arg.effects]
                  .flat()
                  .some((effect) => typeof effect?.value?.iter === "function"),
            )
          )
            w.__TEST__.neighbourUpdates++;
          return dispatch(...args);
        };
      }
      views[0].dispatch({ selection: { anchor: 0 } });
      views[0].focus();
      return views.map((view) => view.state.doc.toString());
    });
  await page.keyboard.type("xyz");
  const expected = ["xyz" + before[0], ...before.slice(1)];
  const pageTexts = () =>
    page
      .locator(".source-page .cm-content")
      .evaluateAll((elements) =>
        elements.map((el) => (el as any).cmTile.root.view.state.doc.toString()),
      );
  expect(await pageTexts()).toEqual(expected);
  expect(
    await page.evaluate(() => (window as any).__TEST__.layoutMeasures),
  ).toBe(0);
  expect(
    await page.evaluate(() => (window as any).__TEST__.neighbourUpdates),
  ).toBe(0);
  await page.clock.runFor(500);
  expect(
    await page.evaluate(() => (window as any).__TEST__.layoutMeasures),
  ).toBe(0);
  // Keep typing faster than the idle delay: no document render may run.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.type("y");
    await page.clock.runFor(100);
  }
  expect(
    await page.evaluate(() => (window as any).__TEST__.layoutMeasures),
  ).toBe(0);
  expect(
    await page.evaluate(() => (window as any).__TEST__.neighbourUpdates),
  ).toBe(0);
  await page.clock.runFor(700);
  expect(
    await page.evaluate(() => (window as any).__TEST__.layoutMeasures),
  ).toBe(1);
  expect(await pageTexts()).toEqual([
    "xyzyyyyyy" + before[0],
    ...before.slice(1),
  ]);
  await expect(page.locator(".source-page .cm-content").first()).toBeFocused();
  await expectSourcePageBounds(page);
});

test("typing with a visible caret does not scroll to the page edges", async ({
  page,
}) => {
  await setup(
    page,
    paragraphLines(
      Array.from({ length: 150 }, (_, i) => `Line ${i + 1}: document content.`),
    ),
  );
  await expect
    .poll(() => page.locator(".preview-page").count())
    .toBeGreaterThan(2);
  const paper = page.locator(".source-page").nth(2);
  await paper.locator(".cm-content").evaluate((el) => {
    const view = (el as any).cmTile.root.view;
    view.dispatch({ selection: { anchor: view.state.doc.line(15).from } });
    view.focus();
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const before = await paper.evaluate((el) => {
    const canvas = document.querySelector("#canvas")!;
    canvas.scrollTop +=
      el.getBoundingClientRect().top - canvas.getBoundingClientRect().top + 140;
    return canvas.scrollTop;
  });
  await page.keyboard.type("xyz");
  await page.waitForTimeout(400);
  const after = await page.locator("#canvas").evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  await expect(paper.locator(".cm-content")).toBeFocused();
});

test("typing onto a new page at low zoom moves the current indicator with the caret", async ({
  page,
}) => {
  await setup(page, "A short starting line.\n");
  await page.locator("#zoom").fill("50");
  await page.locator(".source-page .cm-content").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(
    "A correctly spelled line of content.\n".repeat(42),
  );
  await expect
    .poll(() => page.locator(".source-page").count())
    .toBeGreaterThan(1);
  await expect(page.locator(".source-page .cm-content").last()).toBeFocused();
  const count = await page.locator(".source-page").count();
  await expect(page.locator(".thumbnail").nth(count - 1)).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expectSourcePageBounds(page);
});

test("Markdown list continuation still works through the document coordinator", async ({
  page,
}) => {
  const text = Array.from({ length: 75 }, (_, i) => `- List item ${i}`).join(
    "\n",
  );
  await setup(page, text);
  await page.locator(".source-page .cm-content").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Continued item");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__TEST__.snapshot.session.document.text,
      ),
    )
    .toBe(text + "\n- Continued item");
  await expectSourcePageBounds(page);
});

test("a blank page inserted inside long code has no empty syntax decorations", async ({
  page,
}) => {
  const text = "```bash\n" + "command --argument value\n".repeat(120) + "```";
  await setup(page, text);
  await expect
    .poll(() => page.locator(".source-page").count())
    .toBeGreaterThan(2);
  await page.locator(".thumbnail").first().click();
  await page.locator("#add-page").click();
  await expect(page.locator(".source-page .cm-content").nth(1)).toHaveText("");
  await expect(page.locator(".source-page .cm-content").nth(1)).toBeFocused();
  await expect(page.locator("#notice")).not.toContainText("Preview failed");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__TEST__.snapshot.session.document.text.replace(
          /\f/g,
          "",
        ),
      ),
    )
    .toBe(text);
  await page.keyboard.type("A code comment");
  await expect(page.locator(".source-page .cm-content").nth(1)).toHaveText(
    "A code comment",
  );
});
