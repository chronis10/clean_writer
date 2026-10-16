import {
  getSearchQuery,
  setSearchQuery,
  SearchQuery,
  findNext,
  findPrevious,
  closeSearchPanel,
} from "@codemirror/search";
import type { EditorView, Panel } from "@codemirror/view";
import { icon } from "./icons";
export function findPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-search native-find";
  dom.innerHTML = `${icon("search")}<input name="search" class="cm-textfield" placeholder="Find in document" aria-label="Find in document" main-field="true"><span class="find-results" aria-live="polite"></span><button type="button" class="match-case" aria-label="Match case" title="Match case">Aa</button><button type="button" class="previous-match" aria-label="Previous match" title="Previous match (⇧Ctrl/⌘G)">${icon("up")}</button><button type="button" class="next-match" aria-label="Next match" title="Next match (Ctrl/⌘G)">${icon("down")}</button><button type="button" class="close-find" aria-label="Close find" title="Close find (Escape)">${icon("close")}</button>`;
  const input = dom.querySelector<HTMLInputElement>("input")!;
  const caseButton = dom.querySelector<HTMLButtonElement>(".match-case")!;
  const count = dom.querySelector<HTMLElement>(".find-results")!;
  let countedDoc: typeof view.state.doc | undefined;
  let countedQuery: SearchQuery | undefined;
  let matches: { from: number; to: number }[] = [];
  function refresh() {
    const query = getSearchQuery(view.state);
    if (input.value !== query.search) input.value = query.search;
    caseButton.setAttribute("aria-pressed", String(query.caseSensitive));
    if (countedDoc !== view.state.doc || !countedQuery?.eq(query)) {
      countedDoc = view.state.doc;
      countedQuery = query;
      matches = [];
      if (query.valid) {
        const cursor = query.getCursor(view.state.doc);
        for (let next = cursor.next(); !next.done; next = cursor.next())
          matches.push({ from: next.value.from, to: next.value.to });
      }
    }
    const total = matches.length;
    let low = 0,
      high = total;
    const from = view.state.selection.main.from;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (matches[middle].from < from) low = middle + 1;
      else high = middle;
    }
    const active = matches[low]?.from === from ? low + 1 : 0;
    count.textContent = !query.search
      ? ""
      : total
        ? `${active || 1} of ${total}`
        : "No matches";
    for (const button of dom.querySelectorAll<HTMLButtonElement>(
      ".previous-match,.next-match",
    ))
      button.disabled = !total;
  }
  function change(caseSensitive = getSearchQuery(view.state).caseSensitive) {
    const query = new SearchQuery({
      search: input.value,
      caseSensitive,
      literal: true,
    });
    const first = query.valid
      ? query.getCursor(view.state.doc).next()
      : { done: true, value: undefined };
    view.dispatch({
      effects: setSearchQuery.of(query),
      ...(!first.value || first.done
        ? {}
        : {
            selection: { anchor: first.value.from, head: first.value.to },
            scrollIntoView: true,
          }),
    });
    input.focus();
  }
  input.oninput = () => change();
  caseButton.onclick = () => change(!getSearchQuery(view.state).caseSensitive);
  dom.querySelector<HTMLButtonElement>(".previous-match")!.onclick = () => {
    findPrevious(view);
    input.focus();
  };
  dom.querySelector<HTMLButtonElement>(".next-match")!.onclick = () => {
    findNext(view);
    input.focus();
  };
  dom.querySelector<HTMLButtonElement>(".close-find")!.onclick = () => {
    closeSearchPanel(view);
    view.focus();
  };
  dom.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.shiftKey ? findPrevious(view) : findNext(view);
      input.focus();
    }
  };
  refresh();
  return { dom, top: true, update: refresh, mount: () => input.focus() };
}
