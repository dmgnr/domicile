// The shell guard-webview-spellcheck.sh drives: one browser window showing a
// text field with two misspelled words, one per line. A module, because only
// a domicile:// document may ask for a guest.
//
// Logs, for each context menu in turn:
// - context-menu n=<n> misspelled=<word> suggestions=<a,b,...>
// Then acts on it, as a shell's menu would:
// - the first: replaces the word with "receive", its suggestion
// - the second: adds the word to the dictionary
// - the third: nothing; it shows whether the word is still misspelled
//
// The document Domicile writes calls `HostShell` once the module loads.

export const HostShell = (_root, desktop) => {
  const required = (parameters, name) => {
    const value = parameters.get(name);
    if (value === null) {
      throw new Error(`guard-webview-spellcheck: ?${name}= is required`);
    } else {
      return value;
    }
  };

  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  if (desktop === null || desktop === undefined) {
    throw new Error(
      "guard-webview-spellcheck: no desktop was handed to Shell, so this" +
        " document is not a shell the engine serves",
    );
  }

  const parameters = new URLSearchParams(location.search);

  // Sized rather than stretched between insets: see guard-webview-routed-link.js.
  const view = document.createElement("webview");
  view.style.position = "absolute";
  view.style.inset = "0";
  view.style.inlineSize = "100%";
  view.style.blockSize = "100%";
  view.style.border = "0";

  let menus = 0;
  view.addEventListener("domicile-context-menu", (event) => {
    menus += 1;
    say(
      `context-menu n=${menus} misspelled=${event.misspelledWord} suggestions=${event.spellingSuggestions.join(",")}`,
    );
    if (menus === 1 && event.spellingSuggestions.includes("receive")) {
      event.replaceMisspelling("receive");
    } else if (menus === 2 && event.misspelledWord !== "") {
      event.run("add-to-dictionary");
    }
  });

  let opened = false;
  desktop.addEventListener("browserwindowschanged", () => {
    const windows = desktop.browserWindows ?? [];
    if (!opened && windows.length > 0) {
      opened = true;
      view.setAttribute("window", windows[0].id);
      document.body.append(view);
    }
  });

  document.body.style.margin = "0";
  desktop.openBrowserWindow(required(parameters, "src"));

  say("shell-loaded");
};
