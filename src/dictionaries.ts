export interface DictionaryInfo {
  code: string;
  name: string;
  installed: boolean;
  bundled: boolean;
}

export function dictionarySettings(
  host: HTMLElement,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  installed: () => void,
) {
  host.innerHTML = `<hr><h3>Spelling dictionaries</h3>
    <label>Language<select id="dictionary-language" disabled aria-describedby="dictionary-status"></select></label>
    <button id="dictionary-install" type="button" disabled>Install dictionary</button>
    <p id="dictionary-installed"></p>
    <p id="dictionary-status" role="status" aria-live="polite">Choose a language to add its spelling dictionary.</p>`;
  const select = host.querySelector<HTMLSelectElement>("select")!;
  const button = host.querySelector<HTMLButtonElement>("button")!;
  const status = host.querySelector<HTMLElement>("#dictionary-status")!;
  const summary = host.querySelector<HTMLElement>("#dictionary-installed")!;
  let languages: DictionaryInfo[] = [];
  let installing = false;
  let loading = false;
  function render() {
    const current = select.value;
    select.replaceChildren();
    for (const language of languages) {
      const option = new Option(
        `${language.name}${language.bundled ? " — Included" : language.installed ? " — Installed" : ""}`,
        language.code,
      );
      option.disabled = language.bundled;
      select.add(option);
    }
    const available = languages.find((language) => !language.installed);
    select.value = languages.some(
      (language) => language.code === current && !language.bundled,
    )
      ? current
      : (available?.code ??
        languages.find((language) => !language.bundled)?.code ??
        "");
    select.disabled = installing || !languages.length;
    button.disabled =
      installing ||
      !select.value ||
      !!languages.find((language) => language.code === select.value)?.installed;
    button.textContent = installing
      ? "Installing…"
      : languages.find((language) => language.code === select.value)?.installed
        ? "Installed"
        : "Install dictionary";
    summary.textContent = `Installed: ${languages
      .filter((language) => language.installed)
      .map((language) => language.name)
      .join(", ")}`;
  }
  select.onchange = () => {
    status.textContent =
      "Choose Install dictionary to download and enable this language.";
    render();
  };
  button.onclick = async () => {
    if (installing || button.disabled) return;
    const language = languages.find(
      (language) => language.code === select.value,
    )!;
    installing = true;
    status.textContent = `Installing ${language.name}…`;
    render();
    try {
      languages = await invoke<DictionaryInfo[]>(
        "install_spelling_dictionary",
        { code: language.code },
      );
      installed();
      status.textContent = `${language.name} installed. Spellchecking updated.`;
    } catch (error) {
      status.textContent = `Couldn’t install ${language.name}: ${String(error)}. You can try again.`;
    } finally {
      installing = false;
      render();
    }
  };
  return {
    async refresh() {
      if (loading || installing) return;
      loading = true;
      try {
        languages = await invoke<DictionaryInfo[]>("spelling_dictionaries");
        render();
        status.textContent =
          "Add a language for spelling checks and suggestions. Downloads are stored on this device and work offline.";
      } catch (error) {
        status.textContent = `Couldn’t load dictionaries: ${String(error)}. Reopen Settings to try again.`;
      } finally {
        loading = false;
      }
    },
  };
}
