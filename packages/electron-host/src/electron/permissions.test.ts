import { describe, expect, it } from "bun:test";

import type {
  IncomingPermissionRequest,
  PermissionMessage,
} from "./permissions";
import { createPermissions } from "./permissions";

const setUp = () => {
  const sent: PermissionMessage[] = [];
  const warned: string[] = [];
  const permissions = createPermissions(
    (message) => sent.push(message),
    (window) => (window === 1 ? { id: 1 } : undefined),
    (warning) => warned.push(warning),
  );
  return { permissions, sent, warned };
};

const incoming = (
  more: Partial<IncomingPermissionRequest> = {},
): IncomingPermissionRequest => ({
  ask: 3,
  permission: "notifications",
  requesting_url: "https://a.test/",
  session: "",
  window: 1,
  ...more,
});

describe(createPermissions, () => {
  it("tells the engine when a session's request handler comes and goes", () => {
    const { permissions, sent } = setUp();
    const session = permissions.forSession("persist:a");

    session.setPermissionRequestHandler(() => undefined);
    session.setPermissionRequestHandler(null);

    expect(sent).toEqual([
      { handle: true, session: "persist:a", type: "permission_handler" },
      { handle: false, session: "persist:a", type: "permission_handler" },
    ]);
  });

  it("asks the handler and answers with what it says", () => {
    const { permissions, sent } = setUp();
    const heard: unknown[] = [];
    permissions
      .forSession("")
      .setPermissionRequestHandler(
        (webContents, permission, callback, details) => {
          heard.push([webContents, permission, details]);
          callback(permission === "media");
        },
      );
    sent.length = 0;

    permissions.hear(incoming());
    permissions.hear(
      incoming({
        ask: 4,
        media_types: ["video", "audio"],
        permission: "media",
      }),
    );

    expect(heard).toEqual([
      [{ id: 1 }, "notifications", { requestingUrl: "https://a.test/" }],
      [
        { id: 1 },
        "media",
        { mediaTypes: ["video", "audio"], requestingUrl: "https://a.test/" },
      ],
    ]);
    expect(sent).toEqual([
      { ask: 3, granted: false, type: "permission_answer" },
      { ask: 4, granted: true, type: "permission_answer" },
    ]);
  });

  it("answers once, and later calls of the callback change nothing", () => {
    const { permissions, sent } = setUp();
    let later: ((granted: boolean) => void) | undefined;
    permissions
      .forSession("")
      .setPermissionRequestHandler((_, __, callback) => {
        later = callback;
      });
    sent.length = 0;

    permissions.hear(incoming());
    expect(sent).toEqual([]);
    later?.(true);
    later?.(false);

    expect(sent).toEqual([
      { ask: 3, granted: true, type: "permission_answer" },
    ]);
  });

  it("gives a page no window made a null webContents", () => {
    const { permissions } = setUp();
    const heard: unknown[] = [];
    permissions
      .forSession("")
      .setPermissionRequestHandler((webContents, _, callback) => {
        heard.push(webContents);
        callback(true);
      });

    permissions.hear(incoming({ window: undefined }));
    permissions.hear(incoming({ ask: 4, window: 9 }));

    expect(heard).toEqual([null, null]);
  });

  it("denies a request its session no longer has a handler for", () => {
    const { permissions, sent } = setUp();
    const session = permissions.forSession("");
    session.setPermissionRequestHandler(() => undefined);
    session.setPermissionRequestHandler(null);
    sent.length = 0;

    permissions.hear(incoming());

    expect(sent).toEqual([
      { ask: 3, granted: false, type: "permission_answer" },
    ]);
  });

  it("denies the request when the handler throws, and lets the throw go", () => {
    const { permissions, sent } = setUp();
    permissions.forSession("").setPermissionRequestHandler(() => {
      throw new Error("the app's bug");
    });
    sent.length = 0;

    expect(() => permissions.hear(incoming())).toThrow("the app's bug");
    expect(sent).toEqual([
      { ask: 3, granted: false, type: "permission_answer" },
    ]);
  });

  it("warns once that a check handler is not consulted", () => {
    const { permissions, sent, warned } = setUp();
    const session = permissions.forSession("");

    session.setPermissionCheckHandler(() => true);
    session.setPermissionCheckHandler(() => false);
    session.setPermissionCheckHandler(null);

    expect(sent).toEqual([]);
    expect(warned).toEqual([
      "setPermissionCheckHandler is not supported on Domicile's engine yet: permission checks answer from what this app's request handler and the user granted before",
    ]);
  });
});
