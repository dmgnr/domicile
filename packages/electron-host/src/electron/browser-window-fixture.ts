// The windows of a test app, on an engine that records what it is sent.

import { EventEmitter } from "node:events";
import type { Engine, EngineRequest, WindowEvent } from "../engine";
import { electronPaths } from "../paths";
import { createApp } from "./app";
import { createBrowserWindow } from "./browser-window";
import type { ContextMenuAsked } from "./context-menu";
import { createIpcMain } from "./ipc-main";
import { createMenu } from "./menu";
import { createPermissions } from "./permissions";
import { createProtocols } from "./protocol";
import { createSessions } from "./session";
import { createSessionCalls } from "./session-calls";
import { createWebRequests } from "./web-request";

export const setUp = ({ refuse }: { refuse?: (why: string) => never } = {}) => {
  const sent: EngineRequest[] = [];
  const events: Engine["events"] = new EventEmitter();
  const exits: number[] = [];
  const { app, sessionCreated } = createApp({
    appPath: "/cache/x/resources/app.asar",
    exit: (code) => exits.push(code),
    paths: electronPaths({
      env: {},
      execPath: "/bin/bun",
      home: "/home/me",
      productName: "Notes",
      temp: "/tmp",
      userDirs: undefined,
    }),
    pkg: {
      appId: "com.example.Notes",
      main: "/cache/x/resources/app.asar/main.js",
      name: "notes",
      productName: "Notes",
      version: "1.0.0",
    },
  });
  const { ipcMain, ...ipc } = createIpcMain();
  const sessions = createSessions(
    createProtocols((request) => sent.push(request)),
    createWebRequests(
      (message) => sent.push(message),
      () => undefined,
    ),
    createSessionCalls(
      (message) => sent.push(message),
      () => "Notes/1 Electron/45",
    ),
    createPermissions(
      (message) => sent.push(message),
      () => undefined,
      () => undefined,
    ),
    sessionCreated,
  );
  // The default session's file: handler, which every test would start with.
  sent.length = 0;
  const menus = createMenu<{ readonly id: number }>({
    appName: () => "Notes",
    focusedWindow: () => null,
    popup: (window, entries, at, closed): (() => void) => {
      const over = windows.BrowserWindow.fromId(window.id);
      if (over === null) {
        throw new Error(`no window ${window.id} to pop a menu up over`);
      }
      return over.popupMenu(entries, at, closed);
    },
    roles: {},
    setApplicationMenu: (menu) => {
      for (const window of windows.BrowserWindow.getAllWindows()) {
        window.setMenu(menu);
      }
    },
  });
  const windows = createBrowserWindow(
    {
      browser: { chromeVersion: "160.0.8155.0", userAgent: "Chrome/160" },
      events,
      schemes: [],
      send: (request) => sent.push(request),
    },
    app,
    ipc,
    sessions,
    {
      applicationMenu: menus.Menu.getApplicationMenu,
      click: (menu, command, window) => {
        menus.click(
          menu,
          command,
          undefined,
          windows.BrowserWindow.fromId(window),
        );
      },
      model: menus.model,
    },
    (path) => `source of ${path}`,
    refuse,
    () => ({ env: { HOME: "/home/me" } }),
  );
  const say = (event: WindowEvent) => events.emit("window", event);
  return { ...windows, app, exits, ipcMain, menus, say, sent, sessions };
};

/** A context menu over a misspelling, as the engine says it to `window`. */
export const contextMenuAt = (window: number): ContextMenuAsked => ({
  alt_text: "",
  dictionary_suggestions: ["the"],
  edit_flags: {
    can_copy: true,
    can_cut: false,
    can_delete: false,
    can_edit_richly: false,
    can_paste: true,
    can_redo: false,
    can_select_all: true,
    can_undo: false,
  },
  frame_charset: "UTF-8",
  frame_url: "",
  has_image_contents: false,
  is_editable: true,
  link_text: "",
  link_url: "",
  media_flags: {
    can_loop: false,
    can_print: false,
    can_rotate: false,
    can_save: false,
    can_show_picture_in_picture: false,
    can_toggle_controls: false,
    has_audio: false,
    in_error: false,
    is_controls_visible: false,
    is_looping: false,
    is_muted: false,
    is_paused: false,
    is_showing_picture_in_picture: false,
  },
  media_type: "none",
  misspelled_word: "teh",
  page_url: "https://a.test/",
  selection_text: "teh",
  spellcheck_enabled: true,
  src_url: "",
  suggested_filename: "",
  title_text: "",
  type: "context_menu",
  window,
  x: 10,
  y: 20,
});
