// The shell module guard-webview-video-picture-in-picture.sh loads. It opens
// `<site>/video` in a browser window and draws it in a `<webview window>`.
// Each video the desk lists in picture-in-picture it shows in an
// `<app picture-in-picture>`, sizes, and then closes, as the shell's close
// button does.
//
// It must be a domicile:// document: the browser binds WebViewGuestHost and
// PictureInPictureVideos only for the shell's origin.
//
// Console output, which the engine writes to its log:
//
//   GUARD shell-loaded                 this module ran
//   GUARD window id=…                  the browser window it drew
//   GUARD pip id=… ours=… size=…       a listed video; `ours` is whether its
//                                      window is the one drawn here
//   GUARD pip-closed id=…              it closed that video
//   GUARD pip-none                     the list emptied after a video
//
// The engine's document calls `HostShell` once the module loads.

export const HostShell = (_root, desktop) => {
  const say = (what) => {
    console.log(`GUARD ${what}`);
  };

  // Long enough for the video's surface to reach the element before it goes.
  const SHOWN_MS = 1000;

  const drawn = new Set();
  desktop.addEventListener("browserwindowschanged", () => {
    for (const window of desktop.browserWindows ?? []) {
      if (!drawn.has(window.id)) {
        drawn.add(window.id);
        const view = document.createElement("webview");
        view.style.inlineSize = "640px";
        view.style.blockSize = "360px";
        view.setAttribute("window", window.id);
        document.body.append(view);
        say(`window id=${window.id}`);
      }
    }
  });

  const shown = new Map();
  let listed = false;
  desktop.addEventListener("pictureinpicturevideoschanged", () => {
    const videos = desktop.pictureInPictureVideos ?? [];
    for (const video of videos) {
      say(
        `pip id=${video.id} ours=${drawn.has(video.window)} size=${video.width}x${video.height} playing=${video.playing}`,
      );
      if (!shown.has(video.id)) {
        const app = document.createElement("app");
        app.style.inlineSize = "320px";
        app.style.blockSize = "180px";
        app.setAttribute("picture-in-picture", video.id);
        document.body.append(app);
        shown.set(video.id, app);
        desktop.resizePictureInPictureVideo(video.id, 320, 180);
        setTimeout(() => {
          desktop.actOnPictureInPictureVideo(video.id, "close");
          say(`pip-closed id=${video.id}`);
        }, SHOWN_MS);
      }
    }
    if (videos.length > 0) {
      listed = true;
    } else if (listed) {
      for (const app of shown.values()) {
        app.remove();
      }
      say("pip-none");
    }
  });

  say("shell-loaded");
  desktop.openBrowserWindow(
    `${new URLSearchParams(location.search).get("site")}/video`,
  );
};
