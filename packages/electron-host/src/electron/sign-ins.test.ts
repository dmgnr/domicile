import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";

import type { Certificate, IncomingSignIn, SignInMessage } from "./sign-ins";
import { createSignIns } from "./sign-ins";

const certificate = (commonName: string): Certificate => {
  const principal = {
    commonName,
    country: "",
    locality: "",
    organizations: [],
    organizationUnits: [],
    state: "",
  };
  return {
    data: "-----BEGIN CERTIFICATE-----\n...",
    fingerprint: `sha256/${commonName}`,
    issuer: principal,
    issuerName: commonName,
    serialNumber: "01",
    subject: principal,
    subjectName: commonName,
    validExpiry: 2,
    validStart: 1,
  };
};

const setUp = () => {
  const sent: SignInMessage[] = [];
  const app = new EventEmitter();
  const page = new EventEmitter();
  const signIns = createSignIns(
    (message) => sent.push(message),
    (window) => (window === 1 ? page : undefined),
    app,
  );
  return { app, page, sent, signIns };
};

type Login = Extract<IncomingSignIn, { type: "login" }>;

const login = (more: Partial<Login> = {}): Login => ({
  ask: 3,
  auth_info: {
    host: "proxy.test",
    is_proxy: true,
    port: 3128,
    realm: "office",
    scheme: "basic",
  },
  type: "login",
  url: "https://a.test/",
  window: 1,
  ...more,
});

type Callback = (...args: unknown[]) => void;

describe(createSignIns, () => {
  describe("login", () => {
    it("asks the app and then the page, and signs in with what the callback gives", () => {
      const { app, page, sent, signIns } = setUp();
      const heard: unknown[][] = [];
      app.on("login", (event, webContents, details, authInfo) => {
        heard.push(["app", webContents === page, details, authInfo]);
        event.preventDefault();
      });
      page.on("login", (_event, details, _authInfo, callback: Callback) => {
        heard.push(["page", details]);
        callback("me", "secret");
      });

      signIns.hear(login());

      expect(heard).toEqual([
        [
          "app",
          true,
          { url: "https://a.test/" },
          {
            host: "proxy.test",
            isProxy: true,
            port: 3128,
            realm: "office",
            scheme: "basic",
          },
        ],
        ["page", { url: "https://a.test/" }],
      ]);
      expect(sent).toEqual([
        {
          action: "sign_in",
          ask: 3,
          password: "secret",
          type: "login_answer",
          username: "me",
        },
      ]);
    });

    it("cancels when the callback gives nothing, even later", async () => {
      const { app, sent, signIns } = setUp();
      const later = new Promise<Callback>((resolve) => {
        app.on("login", (event, _webContents, _details, _info, callback) => {
          event.preventDefault();
          resolve(callback);
        });
      });

      signIns.hear(login({ window: undefined }));
      expect(sent).toEqual([]);
      const callback = await later;
      callback();
      callback("too", "late");

      expect(sent).toEqual([
        { action: "cancel", ask: 3, type: "login_answer" },
      ]);
    });

    it("leaves a sign-in no listener took to the desktop's prompt", () => {
      const { sent, signIns } = setUp();

      signIns.hear(login());

      expect(sent).toEqual([
        { action: "default", ask: 3, type: "login_answer" },
      ]);
    });
  });

  describe("certificate-error", () => {
    const error = (): IncomingSignIn => ({
      ask: 4,
      certificate: certificate("a.test"),
      error: "net::ERR_CERT_AUTHORITY_INVALID",
      is_main_frame: true,
      type: "certificate_error",
      url: "https://a.test/",
      window: 1,
    });

    it("trusts the certificate when the callback says so", () => {
      const { app, page, sent, signIns } = setUp();
      const heard: unknown[] = [];
      app.on(
        "certificate-error",
        (event, webContents, url, why, cert, callback: Callback, main) => {
          heard.push([webContents === page, url, why, cert, main]);
          event.preventDefault();
          callback(true);
        },
      );

      signIns.hear(error());

      expect(heard).toEqual([
        [
          true,
          "https://a.test/",
          "net::ERR_CERT_AUTHORITY_INVALID",
          certificate("a.test"),
          true,
        ],
      ]);
      expect(sent).toEqual([
        { allow: true, ask: 4, type: "certificate_answer" },
      ]);
    });

    it("refuses it when nothing takes the error, as Electron does", () => {
      const { sent, signIns } = setUp();

      signIns.hear(error());

      expect(sent).toEqual([
        { allow: false, ask: 4, type: "certificate_answer" },
      ]);
    });
  });

  describe("select-client-certificate", () => {
    const select = (): IncomingSignIn => ({
      ask: 5,
      certificates: [certificate("one"), certificate("two")],
      type: "select_client_certificate",
      url: "a.test:443",
      window: 1,
    });

    it("answers with the certificate the page's listener picks", () => {
      const { page, sent, signIns } = setUp();
      page.on(
        "select-client-certificate",
        (event, url, list: Certificate[], callback: Callback) => {
          expect(url).toBe("a.test:443");
          event.preventDefault();
          callback(list[1]);
        },
      );

      signIns.hear(select());

      expect(sent).toEqual([
        { ask: 5, certificate: 1, type: "client_certificate_answer" },
      ]);
    });

    it("goes on without one when the callback gives none", () => {
      const { app, sent, signIns } = setUp();
      app.on("select-client-certificate", (event, ...args) => {
        event.preventDefault();
        (args.at(-1) as Callback)();
      });

      signIns.hear(select());

      expect(sent).toEqual([{ ask: 5, type: "client_certificate_answer" }]);
    });

    it("takes the first certificate when nothing picks, as Electron does", () => {
      const { sent, signIns } = setUp();

      signIns.hear(select());

      expect(sent).toEqual([
        { ask: 5, certificate: 0, type: "client_certificate_answer" },
      ]);
    });

    it("throws on a certificate the engine never offered", () => {
      const { app, signIns } = setUp();
      app.on("select-client-certificate", (event, ...args) => {
        event.preventDefault();
        (args.at(-1) as Callback)(certificate("three"));
      });

      expect(() => signIns.hear(select())).toThrow(
        "select-client-certificate's callback was given a certificate the engine didn't offer",
      );
    });
  });
});
