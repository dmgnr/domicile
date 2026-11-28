// A visit in Work must be suggested to another Work tab, but not to Default
// or Private. Use a unique URL so no other provider can supply the visit.

export const HostShell = async (_root, host) => {
  try {
    const visit = new URLSearchParams(location.search).get("visit");
    if (visit === null) {
      throw new Error("missing the local fixture URL");
    }
    if (typeof host.browserSuggestions !== "function") {
      throw new Error("the engine does not expose browserSuggestions");
    }

    if (host.browserWindows == null) {
      await new Promise((resolve) => {
        host.addEventListener("browserwindowschanged", resolve, { once: true });
      });
    }

    const open = (url, privateBrowsing, profile) =>
      new Promise((resolve) => {
        const before = new Set(host.browserWindows.map(({ id }) => id));
        const changed = () => {
          const tab = host.browserWindows.find(({ id }) => !before.has(id));
          if (tab?.profile === profile) {
            host.removeEventListener("browserwindowschanged", changed);
            resolve(tab.id);
          }
        };
        host.addEventListener("browserwindowschanged", changed);
        if (privateBrowsing) {
          host.openPrivateBrowserWindow(url);
        } else {
          host.openBrowserWindow(url, "", profile);
        }
      });

    const visited = await open(visit, false, "work");
    const view = document.createElement("webview");
    view.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
    view.setAttribute("window", visited);
    document.body.append(view);

    const work = await open("about:blank", false, "work");
    const normal = await open("about:blank", false, "default");
    const privateTab = await open("about:blank", true, "private");
    const query = "domicile-omnibox-profile-fixture";
    const hasVisit = async (id) =>
      JSON.parse(await host.browserSuggestions(id, query)).some(
        ({ url }) => url === visit,
      );

    // Chromium records history asynchronously after navigation.
    let found = false;
    for (let attempt = 0; attempt < 30 && !found; attempt += 1) {
      found = await hasVisit(work);
      if (!found) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!found || (await hasVisit(normal)) || (await hasVisit(privateTab))) {
      throw new Error("history suggestions did not stay in the visited profile");
    }
    console.log("OMNIBOX_GUARD passed");
  } catch (error) {
    console.error(`OMNIBOX_GUARD failed: ${error.message}`);
  }
};
