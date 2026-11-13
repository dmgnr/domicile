// JSX types for the engine's `<app>` element and `<webview>` attributes, which
// React does not know. A shell loads them with
// `/// <reference types="@domicile-desktop/react/elements" />`.
//
// Only `app-id`, `picture-in-picture`, `frame` and `resizing` are declared. `<app>` has no hyphen, so
// React treats it as a plain HTML element and will not set unknown properties
// or bind its custom event; use `addEventListener` for it.
//
// `HTMLAppElement` is the SDK's global, so React's `ref` type and
// `document.querySelector("app")` agree. An exported interface would be a
// different type.

// The SDK declares the elements' DOM types, `HTMLAppElement` and
// `HTMLWebViewElement`, as globals.
import type {} from "@domicile-desktop/sdk/app-element";
import type {} from "@domicile-desktop/sdk/webview-element";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  // `<webview>` attributes missing from React's Electron-era types: `window`
  // makes a view show a browser window (see `WEBVIEW_WINDOW_ATTRIBUTE`),
  // `extensionpopup`, by its presence, makes it an extension's action popup,
  // `private`, by its presence, makes its page private, and `resizing`, by its
  // presence, marks an interactive resize.
  interface WebViewHTMLAttributes<T> extends HTMLAttributes<T> {
    extensionpopup?: string | undefined;
    private?: string | undefined;
    resizing?: string | undefined;
    window?: string | undefined;
  }

  // biome-ignore lint/style/noNamespace: React declares its JSX types as a namespace; augmenting IntrinsicElements has to match that shape
  namespace JSX {
    // biome-ignore lint/style/useConsistentTypeDefinitions: declaration merging into IntrinsicElements requires an interface
    interface IntrinsicElements {
      /**
       * A Wayland client's window, or a video in picture-in-picture. `app-id`
       * is the host's ID for the window, and `picture-in-picture` the
       * video's (`DomicilePictureInPictureVideo.id`). `frame` is the synced
       * frame a window shows (`DomicileWindow.frame`). `resizing`, by its
       * presence, marks an interactive resize.
       */
      app: DetailedHTMLProps<HTMLAttributes<HTMLAppElement>, HTMLAppElement> &
        (
          | {
              "app-id": string;
              frame?: string | undefined;
              resizing?: string | undefined;
            }
          | { "picture-in-picture": string }
        );
    }
  }
}
