// The shell module guard-webview-video-picture-in-picture.sh loads. It opens
// `<site>/video` in a browser window and draws it in a `<webview window>` at
// the top left. A right click on the video runs the menu's
// "picture-in-picture".
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
//   GUARD menu media=… can=…           a right click's menu
//   GUARD menu-picture-in-picture      it ran the menu's picture-in-picture
//   GUARD pip id=… ours=… size=…       a listed video; `ours` is whether its
//         source=…                     window is the one drawn here, and
//                                      `source` where it was in its page
//                                      (x,y,widthxheight, or none)
//   GUARD pip-sized id=… source=…      the first list giving a video a
//                                      size, and its source then
//   GUARD pip-shown id=…               its element drew its first surface
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
        view.addEventListener("domicile-context-menu", (event) => {
          say(
            `menu media=${event.mediaType} can=${event.canPictureInPicture} in=${event.inPictureInPicture}`,
          );
          if (event.canPictureInPicture) {
            event.run("picture-in-picture");
            say("menu-picture-in-picture");
          }
        });
        document.body.append(view);
        say(`window id=${window.id}`);
      }
    }
  });

  const shown = new Map();
  const sized = new Set();
  let listed = false;
  desktop.addEventListener("pictureinpicturevideoschanged", () => {
    const videos = desktop.pictureInPictureVideos ?? [];
    for (const video of videos) {
      const source =
        video.source === null
          ? "none"
          : `${video.source.x},${video.source.y},${video.source.width}x${video.source.height}`;
      say(
        `pip id=${video.id} ours=${drawn.has(video.window)} size=${video.width}x${video.height} playing=${video.playing} source=${source}`,
      );
      if (!sized.has(video.id) && video.width > 0 && video.height > 0) {
        sized.add(video.id);
        say(`pip-sized id=${video.id} source=${source}`);
      }
      if (!shown.has(video.id)) {
        const app = document.createElement("app");
        app.style.inlineSize = "320px";
        app.style.blockSize = "180px";
        app.addEventListener("domicile-picture-in-picture-shown", () => {
          say(`pip-shown id=${video.id}`);
        });
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
