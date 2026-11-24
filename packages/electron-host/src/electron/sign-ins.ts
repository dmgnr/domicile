// What a page's connection asks the app: a sign-in a site or a proxy wants
// (`login`), a certificate the engine couldn't verify (`certificate-error`)
// and a client certificate a site asks for (`select-client-certificate`).
// Each is emitted on `app` and then on the page's webContents with one
// event, as Electron's webContents hands them to `app` first. See
// "Requests" in docs/architecture/ELECTRON-APPS.md.

import type { EventEmitter } from "node:events";

/** Electron's `CertificatePrincipal`. */
export type CertificatePrincipal = {
  readonly commonName: string;
  readonly organizations: readonly string[];
  readonly organizationUnits: readonly string[];
  readonly locality: string;
  readonly state: string;
  readonly country: string;
};

/** Electron's `Certificate`, as the engine gives it. */
export type Certificate = {
  /** PEM. */
  readonly data: string;
  readonly issuer: CertificatePrincipal;
  readonly issuerName: string;
  readonly issuerCert?: Certificate;
  readonly subject: CertificatePrincipal;
  readonly subjectName: string;
  readonly serialNumber: string;
  /** Seconds since the epoch. */
  readonly validStart: number;
  readonly validExpiry: number;
  /** "sha256/" and the base64 of the DER's SHA-256. */
  readonly fingerprint: string;
};

/** A question of a page's connection, as the engine sends it. */
export type IncomingSignIn =
  | {
      readonly type: "login";
      readonly ask: number;
      readonly window?: number | undefined;
      readonly url: string;
      readonly auth_info: {
        readonly is_proxy: boolean;
        readonly scheme: string;
        readonly host: string;
        readonly port: number;
        readonly realm: string;
      };
    }
  | {
      readonly type: "certificate_error";
      readonly ask: number;
      readonly window?: number | undefined;
      readonly url: string;
      /** Chromium's name for it, "net::ERR_CERT_AUTHORITY_INVALID". */
      readonly error: string;
      readonly certificate: Certificate;
      readonly is_main_frame: boolean;
    }
  | {
      readonly type: "select_client_certificate";
      readonly ask: number;
      readonly window?: number | undefined;
      /** The site's host and port. */
      readonly url: string;
      readonly certificates: readonly Certificate[];
    };

/** The host's answer to each. */
export type SignInMessage =
  | {
      readonly type: "login_answer";
      readonly ask: number;
      readonly action: "sign_in";
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly type: "login_answer";
      readonly ask: number;
      /** `default`: no listener took it, and the desktop asks the user. */
      readonly action: "cancel" | "default";
    }
  | {
      readonly type: "certificate_answer";
      readonly ask: number;
      readonly allow: boolean;
    }
  | {
      readonly type: "client_certificate_answer";
      readonly ask: number;
      /** The index of the one chosen in what the engine offered; none for none. */
      readonly certificate?: number;
    };

/**
 * The questions of an app's pages' connections. `send` answers the engine,
 * `webContentsOf` finds a page by its window's number, and `app` hears each
 * first.
 */
export const createSignIns = (
  send: (message: SignInMessage) => void,
  webContentsOf: (window: number) => EventEmitter | undefined,
  app: EventEmitter,
) => {
  /** Asks `app` and then the page; `fallback` answers when no listener took it. */
  const ask = (
    window: number | undefined,
    name: string,
    args: readonly unknown[],
    answered: () => boolean,
    fallback: () => void,
  ) => {
    const event = eventObject();
    const webContents =
      window === undefined ? undefined : webContentsOf(window);
    app.emit(name, event, webContents ?? null, ...args);
    webContents?.emit(name, event, ...args);
    if (!event.defaultPrevented && !answered()) {
      fallback();
    }
  };

  const hear = (incoming: IncomingSignIn) => {
    const once = answerOnce(send);
    switch (incoming.type) {
      case "login": {
        const { auth_info: info } = incoming;
        ask(
          incoming.window,
          "login",
          [
            { url: incoming.url },
            {
              host: info.host,
              isProxy: info.is_proxy,
              port: info.port,
              realm: info.realm,
              scheme: info.scheme,
            },
            (username?: string, password?: string) => {
              once.answer(
                username === undefined
                  ? {
                      action: "cancel",
                      ask: incoming.ask,
                      type: "login_answer",
                    }
                  : {
                      action: "sign_in",
                      ask: incoming.ask,
                      password: password ?? "",
                      type: "login_answer",
                      username,
                    },
              );
            },
          ],
          once.answered,
          () => {
            // Electron cancels here; the desktop's own prompt asks the user
            // instead, as it does for a site in the browser.
            once.answer({
              action: "default",
              ask: incoming.ask,
              type: "login_answer",
            });
          },
        );
        break;
      }
      case "certificate_error": {
        const answer = (allow: boolean) => {
          once.answer({ allow, ask: incoming.ask, type: "certificate_answer" });
        };
        ask(
          incoming.window,
          "certificate-error",
          [
            incoming.url,
            incoming.error,
            incoming.certificate,
            (isTrusted: boolean) => {
              answer(isTrusted);
            },
            incoming.is_main_frame,
          ],
          once.answered,
          () => {
            answer(false);
          },
        );
        break;
      }
      case "select_client_certificate": {
        const answer = (certificate: number | undefined) => {
          once.answer({
            ask: incoming.ask,
            ...(certificate === undefined ? {} : { certificate }),
            type: "client_certificate_answer",
          });
        };
        ask(
          incoming.window,
          "select-client-certificate",
          [
            incoming.url,
            incoming.certificates,
            (certificate?: Certificate) => {
              answer(
                certificate === undefined
                  ? undefined
                  : offeredIndex(incoming.certificates, certificate),
              );
            },
          ],
          once.answered,
          () => {
            answer(incoming.certificates.length === 0 ? undefined : 0);
          },
        );
        break;
      }
    }
  };

  return { hear };
};

/** The event Electron passes first to each listener. */
const eventObject = () => {
  const event = {
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  return event;
};

/** Sends only the first answer, as Electron's callbacks take only the first. */
const answerOnce = (send: (message: SignInMessage) => void) => {
  let sent = false;
  return {
    answer: (message: SignInMessage) => {
      if (!sent) {
        sent = true;
        send(message);
      }
    },
    answered: () => sent,
  };
};

const offeredIndex = (
  offered: readonly Certificate[],
  certificate: Certificate,
) => {
  const index = offered.findIndex(
    ({ fingerprint }) => fingerprint === certificate.fingerprint,
  );
  if (index === -1) {
    throw new Error(
      "select-client-certificate's callback was given a certificate the engine didn't offer",
    );
  } else {
    return index;
  }
};
