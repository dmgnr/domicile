// Shell for guard-webview-upload.sh, guard-webview-download.sh,
// guard-webview-save-picker.sh, guard-webview-file-access.sh and
// guard-webview-page-picker.sh: one browser window that answers its
// `domicile-file-chooser`, `domicile-prompt` and `domicile-picker` events
// without drawing anything.
//
//   ?answer=choose&pick=<path>   choose <path>, absolute or relative to home
//   ?answer=cancel               cancel (the control)
//   ?hold=first                  never answer the first request, as a
//                                hidden window's picker; optional
//   ?prompt=accept               accept each prompt; optional
//   ?prompt=dismiss              dismiss each prompt (the control)
//   ?picker=choose&value=<value> choose <value> in each picker; optional
//   ?picker=cancel               cancel each picker (the control)
//
// Logs to the console, which the engine writes to its log:
//
//   GUARD shell-loaded           the module ran
//   GUARD chrome-mousedown       a press reached the shell's document
//   GUARD file-chooser mode=…    the element asked, and for what
//     suggested=…
//   GUARD held                   the first request was held unanswered
//   GUARD answered               the answer did not throw
//   GUARD prompt kind=… origin=… a prompt reached the shell, and what it
//     subject=… details=…        carries
//   GUARD prompt-answered        its answer did not throw
//   GUARD picker kind=… value=…  a picker reached the shell, and what it
//     options=… anchor=…         carries
//   GUARD picker-answered        its answer did not throw
//   GUARD downloads …            the desk's downloads changed: one
//                                <state>:<path>:<window> per download
//   GUARD download-removed       the finished download this page removed
//                                left the list
//
// Removes a finished download as soon as one is listed.
//
// The guest page logs what it received; see
// guard-webview-file-chooser-server.py. Domicile calls `HostShell` once the module
// loads.

export const HostShell = (_root, host) => {
  /**
   * Reads a required query parameter. No default, so a misconfigured run fails.
   */
  const required = (parameters, name) => {
    const value = parameters.get(name);
    if (value === null) {
      throw new Error(`guard-webview-file-chooser: ?${name}= is required`);
    } else {
      return value;
    }
  };

  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  const parameters = new URLSearchParams(location.search);
  const answer = required(parameters, "answer");

  // A shell strip above the element, so a click can hit the shell's document.
  const stripHeight = `${required(parameters, "strip")}px`;
  const strip = document.createElement("div");
  strip.style.position = "absolute";
  strip.style.insetBlockStart = "0";
  strip.style.insetInline = "0";
  strip.style.inlineSize = "100%";
  strip.style.blockSize = stripHeight;
  strip.style.background = "#204060";

  // Call `preventDefault()` in both runs so the control differs only in the
  // answer, not by falling back to the element's default cancel.
  const hold = parameters.get("hold");
  if (hold !== null && hold !== "first") {
    throw new Error(`guard-webview-file-chooser: ?hold=${hold} is not one`);
  }
  // The request held unanswered, kept so it is never collected.
  let held;
  document.addEventListener("domicile-file-chooser", (event) => {
    say(
      `file-chooser mode=${event.mode} suggested=${event.suggestedName} accept=${event.accept.join(",")} folder=${event.currentFolder}`,
    );
    event.preventDefault();
    if (hold === "first" && held === undefined) {
      held = event;
      say("held");
    } else {
      answerIt(event);
    }
  });

  // Prompts are answered only when `?prompt=` says how. Claimed in both runs,
  // as above.
  const prompt = parameters.get("prompt");
  if (prompt !== null) {
    document.addEventListener("domicile-prompt", (event) => {
      say(
        `prompt kind=${event.kind} origin=${event.origin} subject=${event.subject} details=${event.details.join(",")}`,
      );
      event.preventDefault();
      if (prompt === "accept") {
        event.accept();
      } else if (prompt === "dismiss") {
        event.dismiss();
      } else {
        throw new Error(
          `guard-webview-file-chooser: ?prompt=${prompt} is not one`,
        );
      }
      say("prompt-answered");
    });
  }

  // Pickers are answered only when `?picker=` says how. Claimed in both runs,
  // as above.
  const picker = parameters.get("picker");
  if (picker !== null) {
    document.addEventListener("domicile-picker", (event) => {
      say(
        `picker kind=${event.kind} value=${event.value} options=${event.options.join(",")} anchor=${event.anchorWidth}x${event.anchorHeight}`,
      );
      event.preventDefault();
      if (picker === "choose") {
        event.choose(required(parameters, "value"));
      } else if (picker === "cancel") {
        event.cancel();
      } else {
        throw new Error(
          `guard-webview-file-chooser: ?picker=${picker} is not one`,
        );
      }
      say("picker-answered");
    });
  }

  /** Answers `event` as `?answer=` says and logs it. */
  const answerIt = (event) => {
    switch (answer) {
      case "choose": {
        event.choose([required(parameters, "pick")]);
        break;
      }
      case "cancel": {
        event.cancel();
        break;
      }
      default: {
        throw new Error(
          `guard-webview-file-chooser: ?answer=${answer} is not one`,
        );
      }
    }
    say("answered");
  };

  // The finished download removeDownload() was called with.
  let removed;
  host.addEventListener("downloadschanged", () => {
    const listed = host.downloads;
    say(
      `downloads ${listed.map((download) => `${download.state}:${download.path}:${download.window}`).join(" ")}`,
    );
    if (removed === undefined) {
      const finished = listed.find((download) => download.state === "complete");
      if (finished !== undefined) {
        removed = finished.id;
        host.removeDownload(finished.id);
      }
    } else {
      if (!listed.some((download) => download.id === removed)) {
        say("download-removed");
      }
    }
  });

  // Shows the harness can deliver a click to this document.
  document.addEventListener("mousedown", (event) => {
    say(`chrome-mousedown target=${event.target.localName}`);
  });

  document.body.style.margin = "0";
  document.body.append(strip);

  // Explicit size: a replaced element between insets keeps its 300x150
  // intrinsic size.
  const view = document.createElement("webview");
  view.style.position = "absolute";
  view.style.insetBlockStart = stripHeight;
  view.style.insetInline = "0";
  view.style.inlineSize = "100%";
  view.style.blockSize = `calc(100% - ${stripHeight})`;
  view.style.border = "0";
  document.body.append(view);
  // Set `src` after attaching: it requests the guest, which needs a frame.
  view.setAttribute("src", required(parameters, "src"));

  say("shell-loaded");
};
